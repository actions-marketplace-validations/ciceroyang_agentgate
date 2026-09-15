import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"

/**
 * "It does not phone home" is a claim a security tool gets asked, and the answer has to be
 * checkable. The preload marks fetch, DNS and every socket connect as a failure, so anything
 * that reaches out crashes the run instead of passing quietly.
 *
 * What this does not cover: refresh and the collection scripts do fetch, on purpose, from
 * public sources. The claim is about check and serve -- the two commands a customer runs on
 * their own code and their own machine.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const PRELOAD = join(ROOT, "test", "fixtures", "no-network.cjs")

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ag-offline-"))
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "pkg"] } } }))
  return dir
}

test("check reaches nothing, and still reports what it found", function () {
  const dir = fixture()
  const run = spawnSync(process.execPath, ["--require", PRELOAD, join(ROOT, "bin", "agentgate.mjs"), "check", "--root", dir], { encoding: "utf8", timeout: 60000 })
  const out = String(run.stdout || "") + String(run.stderr || "")
  assert.doesNotMatch(out, /network access attempted/, out.slice(0, 400))
  assert.equal(run.status, 1, "the fixture should still produce a finding: " + out.slice(0, 300))
  assert.match(out, /AG-MCP-010/)
  rmSync(dir, { recursive: true, force: true })
})

test("the verdict is the same with and without the network disabled", function () {
  const dir = fixture()
  const args = ["check", "--root", dir, "--format", "json"]
  const plain = spawnSync(process.execPath, [join(ROOT, "bin", "agentgate.mjs")].concat(args), { encoding: "utf8", timeout: 60000 })
  const offline = spawnSync(process.execPath, ["--require", PRELOAD, join(ROOT, "bin", "agentgate.mjs")].concat(args), { encoding: "utf8", timeout: 60000 })
  assert.equal(JSON.parse(offline.stdout).verdict, JSON.parse(plain.stdout).verdict)
  assert.equal(offline.status, plain.status)
  rmSync(dir, { recursive: true, force: true })
})

test("serve reaches nothing, and still answers", async function () {
  const dir = fixture()
  const port = 19000 + Math.floor(Math.random() * 900)
  const child = spawn(process.execPath, ["--require", PRELOAD, join(ROOT, "bin", "agentgate.mjs"), "serve", "--port", String(port), "--host", "127.0.0.1"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", function (d) { log += d })
  child.stderr.on("data", function (d) { log += d })
  try {
    let body = null
    for (let i = 0; i < 40; i += 1) {
      await new Promise(function (r) { setTimeout(r, 250) })
      try { const res = await fetch("http://127.0.0.1:" + port + "/health"); if (res.ok) { body = await res.json(); break } } catch (error) { /* not up yet */ }
    }
    assert.doesNotMatch(log, /network access attempted/, log.slice(0, 400))
    assert.ok(body, "the service never answered: " + log.slice(0, 300))
  } finally {
    child.kill("SIGKILL")
    rmSync(dir, { recursive: true, force: true })
  }
})
