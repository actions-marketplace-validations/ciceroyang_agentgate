import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

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
  const work = mkdtempSync(join(tmpdir(), "ag-caddy-"))
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
