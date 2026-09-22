import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { scratchDir } from "../../../test/tmpdir.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

function runProxy(policy, requests, timeoutMs) {
  return new Promise(function (done) {
    const dir = scratchDir("ag-gw-")
    const policyPath = join(dir, "policy.json")
    const logPath = join(dir, "calls.jsonl")
    const recPath = join(dir, "reached.jsonl")
    writeFileSync(policyPath, JSON.stringify(policy))
    const child = spawn(process.execPath, [
      join(ROOT, "bin", "agentgate.mjs"), "proxy",
      "--policy", policyPath, "--log", logPath, "--",
      process.execPath, join(ROOT, "packages", "gateway", "test", "fixtures", "fake-server.mjs"),
    ], { stdio: ["pipe", "pipe", "pipe"], env: Object.assign({}, process.env, { AGENTGATE_RECORD: recPath }) })
    let out = ""
    child.stdout.on("data", function (c) { out += c.toString() })
    child.stderr.on("data", function () { /* diagnostics only */ })
    // a raw string goes out verbatim, so a test can send a byte-order mark
    for (const r of requests) child.stdin.write((typeof r === "string" ? r : JSON.stringify(r)) + "\n")
    const finish = function () { done({ out: out, log: readLog(logPath), reached: readLog(recPath) }) }
    const timer = setTimeout(function () { child.kill(); finish() }, timeoutMs || 4000)
    child.on("exit", function () { clearTimeout(timer); finish() })
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

// JSON-RPC allows a batch, and a batch has no top-level method. Looking only at .method
// meant a forbidden call inside one was forwarded and executed, and a forbidden tool came
// back in a batch tools/list. Both were reproduced against a recording server before the fix.

test("a forbidden call inside a batch never reaches the server", async function () {
  const res = await runProxy(POLICY, [[
    { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "delete_file" } },
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "read_file" } },
  ]])
  assert.deepEqual(res.reached, [], "the batch reached the server: " + JSON.stringify(res.reached))
  const lines = res.out.split("\n").filter(Boolean).map(function (l) { return JSON.parse(l) })
  const refusal = lines.filter(function (m) { return m.error })[0]
  assert.ok(refusal, "no refusal was sent: " + JSON.stringify(lines))
  assert.match(refusal.error.message, /batch containing a forbidden call/)
  assert.ok(res.log.some(function (e) { return e.method === "batch" && e.decision === "refused" }), JSON.stringify(res.log))
})

test("a batch with only allowed calls is forwarded and answered", async function () {
  const res = await runProxy(POLICY, [[{ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "read_file" } }]])
  assert.equal(res.reached.length, 1, "an allowed batch should reach the server")
  assert.match(res.out, /ran read_file/)
  assert.equal(res.log.filter(e => e.method === "tools/call" && e.decision === "allowed" && e.tool === "read_file").length, 1)
})

test("a forbidden tool is removed from a batch tools/list response", async function () {
  const res = await runProxy(POLICY, [[{ jsonrpc: "2.0", id: 20, method: "tools/list" }]])
  const lines = res.out.split("\n").filter(Boolean).map(function (l) { return JSON.parse(l) })
  const batch = lines.filter(Array.isArray)[0]
  assert.ok(batch, "the batch answer was not passed through: " + JSON.stringify(lines))
  const tools = batch[0].result.tools.map(function (t) { return t.name })
  assert.deepEqual(tools, ["read_file"], "a forbidden tool was advertised: " + JSON.stringify(tools))
})

test("a byte-order mark does not smuggle a call past the policy", async function () {
  const line = "\uFEFF" + JSON.stringify({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "delete_file" } })
  const res = await runProxy(POLICY, [line])
  assert.deepEqual(res.reached, [], "a BOM-prefixed call reached the server")
  assert.match(res.out, /agentgate refused/)
})
