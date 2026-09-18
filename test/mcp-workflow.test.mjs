import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { scratchDir } from "./tmpdir.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(ROOT, "bin", "agentgate.mjs")

const fixture = {
  generatedAt: "2026-09-17T00:00:00.000Z",
  scanner: "fixture",
  records: [{
    server: "acme/tools", verdict: "clean",
    packages: [{ registry: "npm", name: "@acme/tools", version: "1.0.0" }],
    evidence: { registryDocument: { status: "clean", source: "guard", reason: null, findings: [] } },
    scanExecution: { scanner_execution: { components: [{ id: "registryDocument", required: true, status: "completed", output_present: true, output_parseable: true, semantic_consistency: "ok", reason: null }], required: 1, completed: 1, failed: 0, state: "complete" } },
  }],
}

const request = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params })

function runMCP(lines, args) {
  return spawnSync(process.execPath, [CLI, "mcp"].concat(args || []), {
    cwd: ROOT, encoding: "utf8", timeout: 60000, input: lines.join("\n") + "\n",
  })
}

test("the mcp command answers on stdout and keeps every other word on stderr", function () {
  const dir = scratchDir("ag-mcp-")
  const indexPath = join(dir, "index.json")
  writeFileSync(indexPath, JSON.stringify(fixture))
  const run = runMCP([
    request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    request(2, "tools/list"),
    request(3, "tools/call", { name: "lookup_server", arguments: { server: "acme/tools" } }),
    request(4, "ping"),
    request(5, "tools/call", { name: "nope", arguments: {} }),
    "this is not json",
  ], ["--index", indexPath])
  assert.equal(run.status, 0, run.stderr)

  // stdout is the protocol channel: every line parses, and there are no banners in it.
  const lines = run.stdout.split("\n").filter(Boolean)
  const messages = lines.map(function (line) { return JSON.parse(line) })
  assert.equal(messages.length, 6)
  for (const message of messages) assert.equal(message.jsonrpc, "2.0")

  const byId = {}
  for (const message of messages) byId[message.id] = message
  assert.equal(byId[1].result.protocolVersion, "2025-06-18")
  assert.deepEqual(byId[1].result.capabilities, { tools: { listChanged: false } })
  assert.equal(byId[1].result.serverInfo.name, "agentgate")
  assert.equal(byId[2].result.tools.length, 4)
  for (const tool of byId[2].result.tools) assert.equal(tool.annotations.readOnlyHint, true, tool.name)
  assert.match(byId[3].result.content[0].text, /acme\/tools - verdict clean/)
  assert.equal(byId[3].result.structuredContent.record.coverage.state, "complete")
  assert.deepEqual(byId[4].result, {})
  assert.equal(byId[5].error.code, -32602)
  assert.equal(byId.null.error.code, -32700)

  // the operator-facing text is on stderr, where it cannot corrupt the stream
  assert.match(run.stderr, /agentgate mcp: index .*index\.json \(1 records\)/)
  assert.match(run.stderr, /4 read-only tools on stdio/)
})

test("without an index the server still speaks, and every answer says what is missing", function () {
  const dir = scratchDir("ag-mcp-empty-")
  const run = runMCP([
    request(1, "initialize", { protocolVersion: "2025-06-18" }),
    request(2, "tools/call", { name: "lookup_server", arguments: { server: "acme/tools" } }),
    request(3, "tools/call", { name: "coverage_report", arguments: {} }),
  ], ["--index", join(dir, "missing.json")])
  assert.equal(run.status, 0, run.stderr)
  const messages = run.stdout.split("\n").filter(Boolean).map(function (line) { return JSON.parse(line) })
  assert.equal(messages.length, 3)
  const lookup = messages[1]
  assert.equal(lookup.result.isError, true)
  assert.match(lookup.result.content[0].text, /no evidence index is loaded: no index at .*missing\.json/)
  assert.match(lookup.result.content[0].text, /agentgate refresh/)
  assert.equal(messages[2].result.isError, true)
  assert.match(run.stderr, /index none/)
})

test("server.json and package.json agree, because the MCP registry checks exactly that", function () {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"))
  assert.equal(server.name, pkg.mcpName)
  assert.match(server.name, /^io\.github\.ciceroyang\//)
  assert.equal(server.version, pkg.version)
  const entry = server.packages[0]
  assert.equal(entry.identifier, pkg.name)
  assert.equal(entry.version, pkg.version)
  assert.equal(entry.registryType, "npm")
  assert.equal(entry.transport.type, "stdio")
  assert.equal(entry.packageArguments[0].type, "positional")
  assert.equal(entry.packageArguments[0].value, "mcp")
  assert.equal(server.repository.url, "https://github.com/ciceroyang/agentgate")
})

