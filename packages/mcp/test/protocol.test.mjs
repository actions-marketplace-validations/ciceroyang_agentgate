import { test } from "node:test"
import assert from "node:assert/strict"
import { createLineReader, encodeMessage, handleMessage, DEFAULT_PROTOCOL, ERROR } from "../src/protocol.mjs"

const tools = [{ name: "demo", description: "a demo tool", inputSchema: { type: "object" } }]
const context = {
  tools: tools,
  version: "9.9.9",
  callTool: async function (name, args) { return { text: "called " + name + " " + JSON.stringify(args), structured: { name: name, args: args } } },
}

test("initialize negotiates a known protocol version and advertises only tools", async function () {
  const known = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, context)
  assert.equal(known.result.protocolVersion, "2025-06-18")
  assert.deepEqual(known.result.capabilities, { tools: { listChanged: false } })
  assert.deepEqual(known.result.serverInfo, { name: "agentgate", version: "9.9.9" })
  const unknown = await handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, context)
  assert.equal(unknown.result.protocolVersion, DEFAULT_PROTOCOL)
})

test("a notification is answered with silence, an unknown method with an error", async function () {
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, context), null)
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "tools/list" }, context), null)
  const res = await handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, context)
  assert.equal(res.error.code, ERROR.METHOD_NOT_FOUND)
  assert.match(res.error.message, /resources\/list/)
})

test("tools/list returns the definitions; tools/call returns text and structured data", async function () {
  const list = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/list" }, context)
  assert.equal(list.result.tools.length, 1)
  const call = await handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "demo", arguments: { a: 1 } } }, context)
  assert.deepEqual(call.result.content, [{ type: "text", text: 'called demo {"a":1}' }])
  assert.deepEqual(call.result.structuredContent, { name: "demo", args: { a: 1 } })
  assert.equal(call.result.isError, undefined)
})

test("an unknown tool is a protocol error; a tool that fails is a result with isError", async function () {
  const missing = await handleMessage({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }, context)
  assert.equal(missing.error.code, ERROR.INVALID_PARAMS)
  assert.match(missing.error.message, /no such tool: nope .* demo/)
  const broken = { tools: tools, version: "0", callTool: async function () { throw new Error("no evidence index is loaded") } }
  const failing = await handleMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "demo" } }, broken)
  assert.equal(failing.result.isError, true)
  assert.match(failing.result.content[0].text, /no evidence index is loaded/)
  const nameless = await handleMessage({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} }, context)
  assert.equal(nameless.error.code, ERROR.INVALID_PARAMS)
})

test("malformed messages are refused with the right code instead of silence", async function () {
  assert.equal((await handleMessage([{ jsonrpc: "2.0", id: 1, method: "ping" }], context)).error.code, ERROR.INVALID_REQUEST)
  assert.equal((await handleMessage("hello", context)).error.code, ERROR.INVALID_REQUEST)
  assert.equal((await handleMessage({ id: 9, method: "ping" }, context)).error.code, ERROR.INVALID_REQUEST)
  const ping = await handleMessage({ jsonrpc: "2.0", id: 10, method: "ping" }, context)
  assert.deepEqual(ping.result, {})
  assert.equal(ping.error, undefined)
})

test("line framing survives split chunks, a BOM, blank lines and an oversized line", function () {
  const reader = createLineReader({ maxBytes: 20 })
  assert.deepEqual(reader.push('{"a"'), [])
  assert.deepEqual(reader.push(':1}\n\n'), [{ text: '{"a":1}' }])
  assert.deepEqual(reader.push("\ufeff{\"b\":2}\n"), [{ text: '{"b":2}' }])
  assert.deepEqual(reader.push("x".repeat(25) + "\n"), [{ tooLarge: true }])
  assert.equal(encodeMessage({ a: 1 }), '{"a":1}\n')
})
