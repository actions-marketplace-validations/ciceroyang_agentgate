import { test } from "node:test"
import assert from "node:assert/strict"
import { findServer, configSnippet, render } from "../bin/agent-add.mjs"

const index = { records: [
  { server: "acme/weather", repository: null, packages: [{ registry: "npm", name: "@acme/weather", version: "1.4.0" }],
    verdict: "clean", evidence: { registryDocument: { status: "clean", source: "mcp-census", findings: [] } } },
  { server: "acme/weather-pro", repository: null, packages: [{ registry: "npm", name: "@acme/weather-pro", version: "2.0.0" }],
    verdict: "incomplete", evidence: { packageManifest: { status: "unmeasured", source: "guard-scan", reason: "metadata-unavailable", findings: [] } } },
  { server: "remote/only", repository: null, packages: [], verdict: "clean", evidence: {} },
] }

test("an exact match wins over a prefix match", function () {
  const got = findServer(index, "acme/weather")
  assert.equal(got.length, 1)
  assert.equal(got[0].server, "acme/weather")
})

test("a partial query lists the candidates", function () {
  assert.equal(findServer(index, "acme").length, 2)
  assert.equal(findServer(index, "nothing").length, 0)
})

test("the snippet pins the declared version", function () {
  const snippet = configSnippet(index.records[0])
  assert.match(snippet, /@acme\/weather@1\.4\.0/)
  assert.match(snippet, /mcpServers/)
})

test("a remote-only server gets no fabricated snippet", function () {
  assert.match(configSnippet(index.records[2]), /no package is declared/)
})

test("render marks an incomplete record as not a pass", function () {
  const text = render(index.records[1])
  assert.match(text, /INCOMPLETE/)
  assert.match(text, /not a pass/)
  assert.match(text, /unmeasured \(metadata-unavailable\)/)
})
