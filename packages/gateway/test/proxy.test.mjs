import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

function runProxy(policy, requests, timeoutMs) {
  return new Promise(function (done) {
    const dir = mkdtempSync(join(tmpdir(), "ag-gw-"))
    const policyPath = join(dir, "policy.json")
    const logPath = join(dir, "calls.jsonl")
    writeFileSync(policyPath, JSON.stringify(policy))
    const child = spawn(process.execPath, [
      join(ROOT, "bin", "agentgate.mjs"), "proxy",
      "--policy", policyPath, "--log", logPath, "--",
      process.execPath, join(ROOT, "packages", "gateway", "test", "fixtures", "fake-server.mjs"),
    ], { stdio: ["pipe", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", function (c) { out += c.toString() })
    child.stderr.on("data", function () { /* diagnostics only */ })
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n")
    const timer = setTimeout(function () { child.kill(); done({ out: out, log: readLog(logPath) }) }, timeoutMs || 4000)
    child.on("exit", function () { clearTimeout(timer); done({ out: out, log: readLog(logPath) }) })
  })
}

function readLog(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(function (l) { return JSON.parse(l) })
}

const POLICY = { version: "agentgate.policy/v1", forbidden: { tools: ["delete_*", "send_money"] } }

test("an allowed call reaches the server and is logged", async function () {
  const res = await runProxy(POLICY, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } }])
  const lines = res.out.split("\n").filter(Boolean).map(function (l) { return JSON.parse(l) })
  const result = lines.filter(function (m) { return m.id === 1 })[0]
  assert.ok(result.result, JSON.stringify(lines))
  assert.match(result.result.content[0].text, /ran read_file/)
  assert.ok(res.log.some(function (e) { return e.tool === "read_file" && e.decision === "allowed" }), JSON.stringify(res.log))
})

test("a forbidden call is refused locally and never reaches the server", async function () {
  const res = await runProxy(POLICY, [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_file" } }])
  const lines = res.out.split("\n").filter(Boolean).map(function (l) { return JSON.parse(l) })
  const result = lines.filter(function (m) { return m.id === 2 })[0]
  assert.ok(result.error, JSON.stringify(lines))
  assert.match(result.error.message, /agentgate refused/)
  assert.ok(!result.result, "the server must not have answered")
  const entry = res.log.filter(function (e) { return e.tool === "delete_file" })[0]
  assert.equal(entry.decision, "refused")
  assert.match(entry.reason, /forbidden/)
})

test("forbidden tools are removed from the advertised list", async function () {
  const res = await runProxy(POLICY, [{ jsonrpc: "2.0", id: 3, method: "tools/list" }])
  const lines = res.out.split("\n").filter(Boolean).map(function (l) { return JSON.parse(l) })
  const result = lines.filter(function (m) { return m.id === 3 })[0]
  assert.deepEqual(result.result.tools.map(function (t) { return t.name }), ["read_file"])
  assert.ok(res.log.some(function (e) { return e.decision === "removed" }))
})
