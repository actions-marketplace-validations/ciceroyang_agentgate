/**
 * The Model Context Protocol, minus the transport.
 *
 * The transport is one JSON message per line over stdio, the same framing the gateway forwards,
 * so this module only decides what a message means and what to write back. A read-only tools
 * server has to answer four things -- initialize, ping, tools/list, tools/call -- and it answers
 * everything else with a JSON-RPC error rather than silence, because a client that gets no answer
 * waits forever.
 *
 * Nothing here touches the filesystem, the network or the clock.
 */

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
export const DEFAULT_PROTOCOL = PROTOCOL_VERSIONS[0]
export const SERVER_NAME = "agentgate"
export const MAX_LINE_BYTES = 8 * 1024 * 1024

export const ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
}

export function encodeMessage(message) {
  return JSON.stringify(message) + "\n"
}

export function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code: code, message: message } }
}

/**
 * Line framing for the stdio transport.
 *
 * A message is one line, so a chunk may hold half a message or three of them. Empty lines are
 * skipped and a byte-order mark is stripped: it is not part of the JSON, and a client that sends
 * one would otherwise get a parse error on a message it wrote correctly.
 */
export function createLineReader(options) {
  const maxBytes = (options && options.maxBytes) || MAX_LINE_BYTES
  let buffer = ""
  return {
    push(chunk) {
      buffer += chunk.toString()
      const out = []
      let at
      while ((at = buffer.indexOf("\n")) !== -1) {
        let raw = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
        if (raw.trim() === "") continue
        if (Buffer.byteLength(raw) > maxBytes) out.push({ tooLarge: true })
        else out.push({ text: raw })
      }
      // A single line that never ends must not grow the buffer without bound.
      if (Buffer.byteLength(buffer) > maxBytes) { out.push({ tooLarge: true }); buffer = "" }
      return out
    },
  }
}

function textResult(text, structured, isError) {
  const result = { content: [{ type: "text", text: text }] }
  if (structured !== undefined) result.structuredContent = structured
  if (isError) result.isError = true
  return result
}

/**
 * One message in, one response out (or null when the message is a notification).
 *
 * A tool that fails is a result with isError, because the request was valid and the client needs
 * the reason; a request that is malformed or names a tool that does not exist is a JSON-RPC error,
 * because the client asked for something this server cannot do at all.
 */
export async function handleMessage(message, context) {
  const tools = (context && context.tools) || []
  const callTool = context && context.callTool
  if (Array.isArray(message)) {
    return errorResponse(null, ERROR.INVALID_REQUEST, "batches are not part of this protocol version; send one message per line")
  }
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return errorResponse(message && message.id !== undefined ? message.id : null, ERROR.INVALID_REQUEST, "not a JSON-RPC 2.0 request")
  }
  if (message.id === undefined) return null // a notification is answered with silence
  const id = message.id
  switch (message.method) {
    case "initialize": {
      const requested = message.params && message.params.protocolVersion
      const protocolVersion = PROTOCOL_VERSIONS.indexOf(requested) === -1 ? DEFAULT_PROTOCOL : requested
      const result = {
        protocolVersion: protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: (context && context.version) || "0.0.0" },
      }
      if (context && context.instructions) result.instructions = context.instructions
      return { jsonrpc: "2.0", id: id, result: result }
    }
    case "ping":
      return { jsonrpc: "2.0", id: id, result: {} }
    case "tools/list":
      return { jsonrpc: "2.0", id: id, result: { tools: tools } }
    case "tools/call": {
      const name = message.params && message.params.name
      const args = (message.params && message.params.arguments) || {}
      if (typeof name !== "string" || name === "") return errorResponse(id, ERROR.INVALID_PARAMS, "tools/call needs a tool name")
      if (!tools.some(function (tool) { return tool.name === name })) {
        return errorResponse(id, ERROR.INVALID_PARAMS, "no such tool: " + name + " (this server has " + tools.map(function (t) { return t.name }).join(", ") + ")")
      }
      if (typeof callTool !== "function") return errorResponse(id, ERROR.INTERNAL, "this server has no tool handler")
      try {
        const out = await callTool(name, args)
        return { jsonrpc: "2.0", id: id, result: textResult(out.text, out.structured, out.isError === true) }
      } catch (error) {
        const reason = error && error.message ? error.message : String(error)
        return { jsonrpc: "2.0", id: id, result: textResult("agentgate could not answer: " + reason, { error: reason }, true) }
      }
    }
    default:
      return errorResponse(id, ERROR.METHOD_NOT_FOUND, "this server implements initialize, ping, tools/list and tools/call; " + message.method + " is not one of them")
  }
}
