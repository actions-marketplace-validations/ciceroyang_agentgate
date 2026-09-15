#!/usr/bin/env node
/**
 * Verification against a real MCP server, run by hand rather than in CI.
 *
 * Everything else in this repository is tested against inputs written for the test. This
 * script exists because that is not the same as working, and it points the gateway at a
 * server published on npm: it starts through the gateway, asks for the tool list, and
 * reports how many tools the server advertises against how many the client is allowed to
 * see. Network and npx are required, so it is deliberately not part of `npm test`.
 *
 *   node scripts/verify-real-server.mjs [package] [directory]
 */
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = process.argv[2] || "@modelcontextprotocol/server-filesystem"
const target = process.argv[3] || process.env.TMPDIR || "/tmp"
const WINDOW_MS = Number(process.env.VERIFY_WINDOW_MS || 90000)

const dir = mkdtempSync(join(tmpdir(), "ag-verify-"))
const policyPath = join(dir, "policy.json")
const logPath = join(dir, "calls.jsonl")
writeFileSync(policyPath, JSON.stringify({ version: "agentgate.policy/v1", forbidden: { tools: ["write_*", "delete_*", "move_*", "edit_*"] } }))

const started = Date.now()
const at = function () { return ((Date.now() - started) / 1000).toFixed(1) + "s" }
const child = spawn(process.execPath, [
  join(ROOT, "bin", "agentgate.mjs"), "proxy", "--policy", policyPath, "--log", logPath, "--",
  "npx", "-y", pkg, target,
], { stdio: ["pipe", "pipe", "pipe"], cwd: ROOT })

let initialize = null
let tools = null
child.stdout.on("data", function (chunk) {
  for (const line of chunk.toString().split("\n").filter(Boolean)) {
    let msg = null
    try { msg = JSON.parse(line) } catch (error) { continue }
    if (msg.id === 1) initialize = (msg.result && msg.result.serverInfo) || msg.error
    if (msg.id === 2) tools = (msg.result && msg.result.tools) || []
  }
})
child.stderr.on("data", function () { /* npx and server diagnostics */ })
const send = function (m) { child.stdin.write(JSON.stringify(m) + "\n") }
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agentgate-verify", version: "1" } } })
setTimeout(function () { send({ jsonrpc: "2.0", method: "notifications/initialized" }) }, 3000)
setTimeout(function () { send({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }, 8000)

setTimeout(function () {
  child.kill()
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(function (l) { return JSON.parse(l) }) : []
  const removed = log.filter(function (e) { return e.decision === "removed" }).map(function (e) { return e.tool })
  console.log("")
  console.log("package:    " + pkg)
  console.log("initialized:" + (initialize ? " " + JSON.stringify(initialize) + " at " + at() : " NEVER - the server did not answer in " + WINDOW_MS + "ms"))
  if (!tools) {
    console.log("tools/list: NEVER")
    console.log("")
    console.log("A first run pays for the npx download, which can exceed a client handshake")
    console.log("timeout. Retry, or pre-install the package, before concluding anything.")
    process.exit(1)
  }
  console.log("tools seen: " + tools.length + " at " + at())
  console.log("  " + tools.map(function (t) { return t.name }).join(", "))
  console.log("removed by policy: " + removed.length + (removed.length ? "  (" + removed.join(", ") + ")" : ""))
  console.log("log: " + logPath)
  console.log("")
  const ok = initialize && tools.length > 0 && removed.length > 0 && !tools.some(function (t) { return /^(write|delete|move|edit)_/.test(t.name) })
  console.log(ok ? "real-server verification: green" : "real-server verification: the policy did not visibly apply")
  process.exit(ok ? 0 : 1)
}, WINDOW_MS)
