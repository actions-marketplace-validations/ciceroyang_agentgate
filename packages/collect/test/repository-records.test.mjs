import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { assertUniqueIdentities, buildRepositoryRecords, repositoryIdentity, looksLikeServer, repositoryFindings } from "../src/repository-records.mjs"
import { validateScanExecution } from "../src/execution.mjs"

const entry = (over) => Object.assign({
  fullName: "acme/tool", repoUrl: "https://github.com/Acme/Tool", owner: "acme", name: "tool",
  stars: 12, forks: 1, archived: false, license: "MIT", pushedAt: "2026-08-01T00:00:00Z",
  createdAt: "2025-01-01T00:00:00Z", description: "a server", defaultBranch: "main",
}, over || {})

const server = { kind: "server-like", matched: "src/mcp_server.py" }

test("a repository that looks like a server becomes a record that cannot be clean", function () {
  const result = buildRepositoryRecords({
    repositories: [entry()], classification: { "acme/tool": server },
    knownUrls: new Set(), generatedAt: "2026-09-19T00:00:00.000Z", now: "2026-09-19T00:00:00.000Z",
  })
  assert.equal(result.records.length, 1)
  const record = result.records[0]
  assert.equal(record.server, "github.com/acme/tool")
  assert.equal(record.verdict, "incomplete", "a repository we never inspected must not be clean")
  assert.equal(record.packages.length, 0)
  assert.equal(record.evidence.repositoryMetadata.status, "clean")
  assert.equal(record.evidence.repositoryMetadata.provenance.content.algorithm, "sha256")
  assert.match(record.evidence.repositoryMetadata.provenance.content.scope, /no source code read/)
  assert.equal(record.scanExecution.scanner_execution.state, "incomplete")
  const components = record.scanExecution.scanner_execution.components
  assert.equal(components.find((c) => c.id === "packageManifest").status, "skipped")
  assert.deepEqual(validateScanExecution(record.scanExecution).problems, [], "the block has to satisfy its own validator")
})

test("a repository the registry already covers is not counted again", function () {
  const result = buildRepositoryRecords({
    repositories: [entry()], classification: { "acme/tool": server },
    knownUrls: new Set(["https://github.com/acme/tool"]),
  })
  assert.equal(result.records.length, 0)
  assert.equal(result.stats.alreadyRepresented, 1)
})

test("a repository that does not look like a server is not a record", function () {
  const result = buildRepositoryRecords({
    repositories: [entry()], classification: { "acme/tool": { kind: "library/orphan manifest", matched: "package.json" } },
    knownUrls: new Set(),
  })
  assert.equal(result.records.length, 0)
  assert.equal(result.stats.notAServer, 1)
  assert.equal(looksLikeServer({ kind: "descriptor-only" }), true)
  assert.equal(looksLikeServer({ matched: "src/mcp/server.ts" }), true)
  assert.equal(looksLikeServer({ matched: "src/server.ts" }), false, "a plain web server is not an MCP server")
})

test("an archived repository and a missing licence are findings with the field they came from", function () {
  const findings = repositoryFindings(entry({ archived: true, license: null }), { now: "2026-09-19T00:00:00.000Z" })
  const rules = findings.map((f) => f.rule).sort()
  assert.deepEqual(rules, ["repository-archived", "repository-license-missing"])
  for (const finding of findings) assert.ok(finding.evidence.length > 0, finding.rule + " has no evidence")
  const stale = repositoryFindings(entry({ pushedAt: "2024-01-01T00:00:00Z" }), { now: "2026-09-19T00:00:00.000Z" })
  assert.deepEqual(stale.map((f) => f.rule), ["repository-stale"])
})

test("the identity is one canonical form and two records may not share it", function () {
  assert.equal(repositoryIdentity("https://GitHub.com/Acme/Tool.git"), "github.com/acme/tool")
  assert.equal(repositoryIdentity("git@github.com:Acme/Tool"), "github.com/acme/tool")
  // The same repository twice is de-duplicated rather than recorded twice...
  const result = buildRepositoryRecords({
    repositories: [entry(), entry({ fullName: "Acme/Tool", repoUrl: "https://github.com/acme/tool/" })],
    classification: { "acme/tool": server, "Acme/Tool": server }, knownUrls: new Set(),
  })
  assert.equal(result.records.length, 1)
  assert.equal(result.stats.duplicate, 1)
  // ...and if a duplicate ever reaches the index anyway, that is an error, not a bigger count.
  assert.throws(function () {
    assertUniqueIdentities([{ server: "github.com/a/b", repository: "https://github.com/a/b" },
      { server: "GitHub.com/A/B", repository: "https://github.com/A/B" }])
  }, /identity check failed/)
})

test("the real census produces records whose coverage block and digest hold up", function () {
  const census = JSON.parse(readFileSync("/tmp/github-census.json", "utf8"))
  const classification = JSON.parse(readFileSync("/tmp/server-classify.json", "utf8")).results
  const sample = census.repos.slice(0, 200)
  const result = buildRepositoryRecords({
    repositories: sample, classification: classification, knownUrls: new Set(["https://github.com/n8n-io/n8n"]),
    generatedAt: "2026-09-19T00:00:00.000Z", now: "2026-09-19T00:00:00.000Z",
  })
  assert.ok(result.records.length > 0, "the sample should produce records")
  for (const record of result.records) {
    assert.equal(record.verdict, "incomplete")
    assert.deepEqual(validateScanExecution(record.scanExecution).problems, [])
    assert.match(record.evidence.repositoryMetadata.provenance.content.digest, /^[a-f0-9]{64}$/)
  }
})
