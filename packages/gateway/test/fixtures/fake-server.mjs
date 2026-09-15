#!/usr/bin/env node
// A minimal MCP-shaped stdio server for the gateway test. It answers tools/list and
// tools/call, answers a batch with a batch, and can record every line it receives so a
// test can prove what did or did not get through the gateway.
import { appendFileSync } from "node:fs"
const record = process.env.AGENTGATE_RECORD
const reply = function (msg) {
  if (msg.method === "tools/list") return { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "read_file" }, { name: "delete_file" }, { name: "send_money" }] } }
  if (msg.method === "tools/call") return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ran " + msg.params.name }] } }
  return { jsonrpc: "2.0", id: msg.id, result: {} }
}
let buffer = ""
process.stdin.on("data", function (chunk) {
  buffer += chunk.toString()
  let at
  while ((at = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === "") continue
    if (record) appendFileSync(record, line + "\n")
    let msg = null
    try { msg = JSON.parse(line) } catch (error) { continue }
    process.stdout.write(JSON.stringify(Array.isArray(msg) ? msg.map(reply) : reply(msg)) + "\n")
  }
})
