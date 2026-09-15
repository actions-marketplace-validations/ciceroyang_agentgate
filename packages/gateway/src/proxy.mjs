/**
 * A gateway in front of an MCP server over stdio.
 *
 * It spawns the real server, forwards the conversation, and intervenes in exactly two
 * places: a tool call the policy refuses is answered locally with a reason and never
 * reaches the server, and a forbidden tool is removed from the advertised list so a
 * client cannot ask for it in the first place. Everything, allowed or refused, is
 * appended to the log, because the log is what an audit reads.
 */
import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { decideToolCall, filterTools } from "./decide.mjs"

export function createProxy(options) {
  const child = spawn(options.command, options.args || [], { stdio: ["pipe", "pipe", "inherit"] })
  const logPath = options.logPath || null
  const policy = options.policy
  const out = options.out || process.stdout
  const log = function (entry) {
    if (!logPath) return
    try { appendFileSync(logPath, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + "\n") } catch (error) { /* never break the pipe for a log */ }
  }
  let clientBuffer = ""
  let serverBuffer = ""
  const stats = { allowed: 0, refused: 0, toolsRemoved: 0 }

  const handleClientLine = function (line) {
    // A byte-order mark is not part of the JSON. Without this the line is unparseable and
    // gets forwarded as-is, which is a fail-open path around the policy.
    const text = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line
    let msg = null
    try { msg = JSON.parse(text) } catch (error) { child.stdin.write(line + "\n"); return }
    if (Array.isArray(msg)) {
      // JSON-RPC allows a batch, and a batch has no .method, so a forbidden call inside one
      // was forwarded and executed. A batch that contains one is refused whole: a partial
      // answer would have to be assembled from two speakers, and guessing at the shape is
      // how this was missed in the first place.
      const refused = msg
        .filter(function (m) { return m && m.method === "tools/call" })
        .map(function (m) { return decideToolCall(policy, m.params && m.params.name) })
        .filter(function (d) { return !d.allowed })
      if (refused.length > 0) {
        stats.refused += 1
        log({ direction: "client", method: "batch", decision: "refused", reason: refused[0].reason })
        out.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "agentgate refused a batch containing a forbidden call: " + refused[0].reason } }) + "\n")
        return
      }
      child.stdin.write(line + "\n")
      return
    }
    if (msg && msg.method === "tools/call") {
      const name = msg.params && msg.params.name
      const decision = decideToolCall(policy, name)
      if (!decision.allowed) {
        stats.refused += 1
        log({ direction: "client", method: "tools/call", tool: name, decision: "refused", reason: decision.reason })
        out.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "agentgate refused: " + decision.reason } }) + "\n")
        return
      }
      stats.allowed += 1
      log({ direction: "client", method: "tools/call", tool: name, decision: "allowed" })
    }
    child.stdin.write(line + "\n")
  }

  /** Remove forbidden tools from one response, whichever shape it arrives in. */
  const filterMessage = function (message) {
    if (!message || !message.result || !Array.isArray(message.result.tools)) return message
    const filtered = filterTools(policy, message.result.tools)
    if (filtered.removed.length === 0) return message
    stats.toolsRemoved += filtered.removed.length
    for (const r of filtered.removed) log({ direction: "server", method: "tools/list", tool: r.name, decision: "removed", reason: r.reason })
    const copy = JSON.parse(JSON.stringify(message))
    copy.result.tools = filtered.kept
    return copy
  }

  const handleServerLine = function (line) {
    let msg = null
    try { msg = JSON.parse(line) } catch (error) { out.write(line + "\n"); return }
    // a server may answer a batch with a batch; every member gets the same filter
    out.write(JSON.stringify(Array.isArray(msg) ? msg.map(filterMessage) : filterMessage(msg)) + "\n")
  }

  const onClientData = function (chunk) {
    clientBuffer += chunk.toString()
    let at
    while ((at = clientBuffer.indexOf("\n")) !== -1) {
      const line = clientBuffer.slice(0, at)
      clientBuffer = clientBuffer.slice(at + 1)
      if (line.trim() !== "") handleClientLine(line)
    }
  }
  const onServerData = function (chunk) {
    serverBuffer += chunk.toString()
    let at
    while ((at = serverBuffer.indexOf("\n")) !== -1) {
      const line = serverBuffer.slice(0, at)
      serverBuffer = serverBuffer.slice(at + 1)
      if (line.trim() !== "") handleServerLine(line)
    }
  }

  if (options.input) options.input.on("data", onClientData)
  child.stdout.on("data", onServerData)
  child.on("exit", function (code) { log({ direction: "server", event: "exit", code: code }); if (options.onExit) options.onExit(code, stats) })
  return { child: child, stats: stats }
}
