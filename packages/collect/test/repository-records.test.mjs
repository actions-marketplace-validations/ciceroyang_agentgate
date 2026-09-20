import test from "node:test"
import assert from "node:assert/strict"
import { assertUniqueIdentities, buildRepositoryRecords, repositoryIdentity, looksLikeServer, repositoryFindings, packageReason } from "../src/repository-records.mjs"
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

test("the skipped component says what this build did, not what the repository contains", function () {
  // A classification written before it kept the manifest path carries no package data, so for
  // that entry this build never looked. The reason has to say that. The wording it replaced,
  // "no-package-declared-in-repository", read as a finding about the repository and was wrong for
  // repositories that do declare a package.json.
  const record = buildRepositoryRecords({
    repositories: [entry()], classification: { "acme/tool": server },
    knownUrls: new Set(), generatedAt: "2026-09-19T00:00:00.000Z",
  }).records[0]
  const reason = record.scanExecution.scanner_execution.components.find(function (c) { return c.id === "packageManifest" }).reason
  assert.equal(reason, "package-not-inspected")
  assert.doesNotMatch(reason, /^no[-_]|declared-in-repository/,
    "the reason must not assert anything about the repository: nobody looked")
})

test("the package reason distinguishes what was checked from what was not", function () {
  // Three states, and they are not interchangeable. The classification lists a repository's files,
  // so once it keeps the manifest path a null manifest is a checked absence. A classification from
  // before that field existed proves nothing either way, and must not borrow the checked wording.
  assert.equal(packageReason({ manifest: "package.json" }), "manifest-found-not-inspected")
  assert.equal(packageReason({ manifest: null }), "no-package-manifest-in-repository")
  assert.equal(packageReason({}), "package-not-inspected")
  assert.equal(packageReason({ kind: "server-like", matched: "src/mcp_server.py" }), "package-not-inspected",
    "a classification without the field cannot claim the tree was searched")

  const record = buildRepositoryRecords({
    repositories: [entry()],
    classification: { "acme/tool": { kind: "server-like", matched: "src/mcp_server.py", manifest: "pyproject.toml" } },
    knownUrls: new Set(), generatedAt: "2026-09-19T00:00:00.000Z",
  }).records[0]
  const component = record.scanExecution.scanner_execution.components.find(function (c) { return c.id === "packageManifest" })
  assert.equal(component.reason, "manifest-found-not-inspected")
  assert.equal(record.verdict, "incomplete", "a manifest we have not read cannot make a record clean")
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

test("a mixed census comes out with a verdict, a digest and no clean record", function () {
  // This used to read the census off the machine that produced it, which is a test that passes
  // here and fails everywhere else. The shape is what matters, so it is built here instead.
  const repositories = [
    entry({ fullName: "acme/server-a", repoUrl: "https://github.com/acme/server-a" }),
    entry({ fullName: "acme/server-b", repoUrl: "https://github.com/acme/server-b", archived: true, license: null, pushedAt: "2024-01-01T00:00:00Z" }),
    entry({ fullName: "acme/library", repoUrl: "https://github.com/acme/library" }),
    entry({ fullName: "registry/tool", repoUrl: "https://github.com/registry/tool" }),
  ]
  const classification = {
    "acme/server-a": { kind: "server-like", matched: "src/mcp_server.py" },
    "acme/server-b": { kind: "descriptor-only", matched: "mcp.json" },
    "acme/library": { kind: "library/orphan manifest", matched: "package.json" },
    "registry/tool": { kind: "server-like", matched: "server.ts" },
  }
  const result = buildRepositoryRecords({
    repositories: repositories, classification: classification,
    knownUrls: new Set(["https://github.com/registry/tool"]),
    generatedAt: "2026-09-19T00:00:00.000Z", now: "2026-09-19T00:00:00.000Z",
  })
  assert.deepEqual(result.records.map(function (r) { return r.server }),
    ["github.com/acme/server-a", "github.com/acme/server-b"],
    "the library is not a record and the registry row is not counted twice")
  assert.equal(result.stats.alreadyRepresented, 1)
  assert.equal(result.stats.notAServer, 1)
  for (const record of result.records) {
    assert.equal(record.verdict, "incomplete")
    assert.deepEqual(validateScanExecution(record.scanExecution).problems, [])
    assert.match(record.evidence.repositoryMetadata.provenance.content.digest, /^[a-f0-9]{64}$/)
  }
  const archived = result.records.find(function (r) { return r.server === "github.com/acme/server-b" })
  assert.deepEqual(archived.evidence.repositoryMetadata.findings.map(function (f) { return f.rule }).sort(),
    ["repository-archived", "repository-license-missing", "repository-stale"])
})
