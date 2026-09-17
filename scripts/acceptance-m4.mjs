#!/usr/bin/env node
/**
 * M4 acceptance. A real server process is started through the gateway; the gateway must
 * let an allowed call through, refuse a forbidden one with a reason, keep the forbidden
 * tool out of the advertised list, and write both decisions to the log.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { scratchDir } from "./scratch-dir.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
let failures = 0
const check = function (name, ok, detail) {
  if (ok) { console.log("ok    " + name); return }
  failures += 1
  console.log("FAIL  " + name + (detail ? "  -> " + detail : ""))
}

const dir = scratchDir("ag-m4-")
const policyPath = join(dir, "policy.json")
const logPath = join(dir, "calls.jsonl")
writeFileSync(policyPath, JSON.stringify({ version: "agentgate.policy/v1", forbidden: { tools: ["delete_*", "send_money"] } }))

const child = spawn(process.execPath, [
  join(ROOT, "bin", "agentgate.mjs"), "proxy",
  "--policy", policyPath, "--log", logPath, "--",
  process.execPath, join(ROOT, "packages", "gateway", "test", "fixtures", "fake-server.mjs"),
], { stdio: ["pipe", "pipe", "pipe"] })

let out = ""
child.stdout.on("data", function (c) { out += c.toString() })
const requests = [
  { jsonrpc: "2.0", id: 1, method: "tools/list" },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file" } },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "delete_file" } },
]
for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n")

await new Promise(function (done) { setTimeout(done, 2500) })
child.kill()
await new Promise(function (done) { setTimeout(done, 200) })

const messages = out.split("\n").filter(Boolean).map(function (l) { return JSON.parse(l) })
const byId = function (id) { return messages.filter(function (m) { return m.id === id })[0] }
const log = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(function (l) { return JSON.parse(l) }) : []

check("the advertised list keeps only allowed tools", byId(1) && byId(1).result && byId(1).result.tools.length === 1 && byId(1).result.tools[0].name === "read_file", JSON.stringify(byId(1)))
check("an allowed call is served", byId(2) && byId(2).result && /ran read_file/.test(byId(2).result.content[0].text), JSON.stringify(byId(2)))
check("a forbidden call is refused", byId(3) && byId(3).error, JSON.stringify(byId(3)))
check("and the refusal says why", byId(3) && /forbidden pattern/.test(byId(3).error.message), byId(3) && byId(3).error.message)
check("and the server never answered it", byId(3) && !byId(3).result)
check("the allowed call is in the log", log.some(function (e) { return e.tool === "read_file" && e.decision === "allowed" }), JSON.stringify(log))
check("the refused call is in the log with its reason", log.some(function (e) { return e.tool === "delete_file" && e.decision === "refused" && e.reason }), JSON.stringify(log))
check("the removed tool is in the log", log.some(function (e) { return e.decision === "removed" }), JSON.stringify(log))

console.log("")
console.log(failures === 0 ? "M4 acceptance: green" : "M4 acceptance: " + failures + " failure(s)")
process.exit(failures === 0 ? 0 : 1)
