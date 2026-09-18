/**
 * The stdio server loop.
 *
 * stdout is the protocol channel, so nothing else may be written there: a banner, a warning or a
 * stray console.log becomes a parse error on the client side and the connection dies with no
 * useful message. Everything a person needs to see goes to stderr.
 */
import { createLineReader, encodeMessage, errorResponse, handleMessage, ERROR } from "./protocol.mjs"

export function startMcpServer(options) {
  const opts = options || {}
  const input = opts.input || process.stdin
  const output = opts.output || process.stdout
  const log = opts.log || function (line) { process.stderr.write(line + "\n") }
  const reader = createLineReader(opts)
  const tools = opts.tools || []
  const context = { tools: tools, callTool: opts.callTool, version: opts.version, instructions: opts.instructions }
  let stopped = false

  const write = function (message) {
    if (!stopped) output.write(encodeMessage(message))
  }

  const answer = function (message) {
    Promise.resolve()
      .then(function () { return handleMessage(message, context) })
      .then(function (response) { if (response) write(response) })
      .catch(function (error) {
        const reason = error && error.message ? error.message : String(error)
        write(errorResponse(message && message.id !== undefined ? message.id : null, ERROR.INTERNAL, reason))
      })
  }

  const onData = function (chunk) {
    for (const item of reader.push(chunk)) {
      if (item.tooLarge) {
        write(errorResponse(null, ERROR.INVALID_REQUEST, "message is larger than the " + Math.round((opts.maxBytes || 8 * 1024 * 1024) / 1024 / 1024) + " MB limit"))
        continue
      }
      let message = null
      try {
        message = JSON.parse(item.text)
      } catch (error) {
        write(errorResponse(null, ERROR.PARSE, "that line is not JSON"))
        continue
      }
      answer(message)
    }
  }

  const stop = function () {
    if (stopped) return
    stopped = true
    input.removeListener("data", onData)
    input.removeListener("end", stop)
  }

  input.on("data", onData)
  input.on("end", stop)
  log("agentgate mcp: " + tools.length + " read-only tools on stdio; logs go to stderr")
  return { stop: stop, tools: tools.map(function (tool) { return tool.name }) }
}
