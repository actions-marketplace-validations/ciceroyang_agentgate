#!/usr/bin/env node
// A minimal MCP-shaped stdio server for the gateway test. It answers tools/list and
// tools/call and does nothing else.
let buffer = ""
process.stdin.on("data", function (chunk) {
  buffer += chunk.toString()
  let at
  while ((at = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === "") continue
    let msg = null
    try { msg = JSON.parse(line) } catch (error) { continue }
    if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "read_file" }, { name: "delete_file" }, { name: "send_money" }] } }) + "\n")
    } else if (msg.method === "tools/call") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ran " + msg.params.name }] } }) + "\n")
    }
  }
})
