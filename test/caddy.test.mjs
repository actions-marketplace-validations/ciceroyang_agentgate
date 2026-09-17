import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"
import { createServer } from "node:net"
import { scratchDir } from "./tmpdir.mjs"

/**
 * The append mechanism, checked against a real Caddy binary when one is available.
 *
 * The deployment target already runs Caddy for a site on the apex, so --with-caddy appends a
 * marked block instead of replacing the file. "It validates" is worth checking with caddy itself
 * rather than trusting the Caddyfile grammar by eye, but a 46MB binary does not belong in CI, so
 * this runs only when CADDY_BIN is set:  CADDY_BIN=/tmp/caddybin/caddy npm test
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CADDY = process.env.CADDY_BIN

test("appending our block to an existing Caddyfile validates, and a duplicate is rejected", { skip: CADDY ? false : "set CADDY_BIN to a caddy binary to run this" }, function () {
  assert.ok(existsSync(CADDY), "CADDY_BIN does not exist: " + CADDY)
  const work = scratchDir("ag-caddy-")
  mkdirSync(work, { recursive: true })
  mkdirSync(join(work, "site"), { recursive: true })
  writeFileSync(join(work, "site", "index.html"), "<title>existing site</title>")
  const existing = [
    "xn--5kvo87g.com, www.xn--5kvo87g.com {",
    "  root * \"" + join(work, "site") + "\"", // the path may contain spaces
    "  file_server",
    "}",
    "",
  ].join("\n")
  const block = ["# agentgate-managed-begin", readFileSync(join(ROOT, "deploy", "Caddyfile"), "utf8"), "# agentgate-managed-end", ""].join("\n")
  const merged = join(work, "merged.Caddyfile")
  const dup = join(work, "dup.Caddyfile")
  writeFileSync(merged, existing + "\n" + block)
  writeFileSync(dup, existing + "\napp.xn--5kvo87g.com {\n  respond \"already here\"\n}\n\n" + block)

  const ok = spawnSync(CADDY, ["validate", "--adapter", "caddyfile", "--config", merged], { encoding: "utf8" })
  assert.equal(ok.status, 0, "the appended config does not validate: " + (ok.stderr || ok.stdout))

  const bad = spawnSync(CADDY, ["validate", "--adapter", "caddyfile", "--config", dup], { encoding: "utf8" })
  assert.notEqual(bad.status, 0, "a duplicate site definition was accepted, so the rollback path is untested")
  assert.match(bad.stderr + bad.stdout, /ambiguous site definition/)
  rmSync(work, { recursive: true, force: true })
})

function freePort() {
  return new Promise(function (done, fail) {
    const s = createServer()
    s.on("error", fail)
    s.listen(0, "127.0.0.1", function () { const port = s.address().port; s.close(function () { done(port) }) })
  })
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

test("the Caddyfile routes the static site and the API on one host", { skip: CADDY ? false : "set CADDY_BIN to a caddy binary to run this" }, async function () {
  // The site block mixes file_server with reverse_proxy behind ordered handle directives. That
  // ordering and the path matchers are the part a first deploy would discover, so it is checked
  // against the real binary and the real service rather than read. Verified once by hand; this is
  // the same thing, repeatable.
  const work = scratchDir("ag-caddy-e2e-")
  const www = join(work, "www")
  mkdirSync(www, { recursive: true })
  const build = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"),
    "--index", join(ROOT, "data", "sample-index.json"), "--out", www, "--name", "evidence.html",
    "--pages", join(ROOT, "site")], { encoding: "utf8" })
  assert.equal(build.status, 0, build.stderr)

  const servicePort = await freePort()
  const sitePort = await freePort()
  let cfg = readFileSync(join(ROOT, "deploy", "Caddyfile"), "utf8")
  cfg = cfg.replace(/# 纯 API:[\s\S]*?\n}\n/, "")              // no TLS site in this test
  cfg = cfg.replace("app.xn--5kvo87g.com {", "http://127.0.0.1:" + sitePort + " {")
  cfg = cfg.replace(/root \* \/var\/www\/zhiliang/g, "root * " + www)
  cfg = cfg.replace(/127\.0\.0\.1:8080/g, "127.0.0.1:" + servicePort)
  const cfgPath = join(work, "Caddyfile")
  writeFileSync(cfgPath, cfg)

  const svc = spawn(process.execPath, [join(ROOT, "bin", "agentgate.mjs"), "serve", "--port", String(servicePort), "--host", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] })
  const caddy = spawn(CADDY, ["run", "--adapter", "caddyfile", "--config", cfgPath], { stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  caddy.stdout.on("data", function (d) { log += d })
  caddy.stderr.on("data", function (d) { log += d })
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i += 1) { await sleep(150); try { up = (await fetch("http://127.0.0.1:" + sitePort + "/")).ok } catch (error) { /* not yet */ } }
    assert.ok(up, "caddy never served the site: " + log.slice(0, 400))

    const expect = [
      ["/", "text/html"],
      ["/try.html", "text/html"],
      ["/evidence.html", "text/html"],
      ["/health", "application/json"],
      ["/v1/index/summary", "application/json"],
      ["/badge/anything.svg", "image/svg+xml"],
    ]
    for (const pair of expect) {
      const res = await fetch("http://127.0.0.1:" + sitePort + pair[0])
      assert.equal(res.status, 200, pair[0] + " returned " + res.status)
      assert.ok((res.headers.get("content-type") || "").indexOf(pair[1]) !== -1, pair[0] + " content-type was " + res.headers.get("content-type"))
    }
    // and the api site is not reachable as a path on the app site
    const missing = await fetch("http://127.0.0.1:" + sitePort + "/nope.html")
    assert.equal(missing.status, 404, "an unknown path should be a 404, not a proxy hit")
  } finally {
    caddy.kill("SIGKILL")
    svc.kill("SIGKILL")
    rmSync(work, { recursive: true, force: true })
  }
})
