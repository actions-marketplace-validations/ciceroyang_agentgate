import test from "node:test"
import assert from "node:assert/strict"
import { syntheticServer, auditability, auditOne } from "../scripts/audit-packages.mjs"
import { fetchFailureReason, fetchNpmDocumentOutcome, fetchPypiDocumentOutcome } from "../mcp-audit.mjs"

test("the server object carries the coordinates and nothing else", function () {
  const server = syntheticServer({ registry: "npm", name: "demo-mcp", version: "1.2.3" })
  assert.deepEqual(server.packages, [{ registryType: "npm", identifier: "demo-mcp", version: "1.2.3" }])
  // auditPackage adds a stdio finding when it sees a transport. We have not checked how this
  // package is run, so a transport here would be a finding about a guess.
  assert.equal(server.packages[0].transport, undefined)
})

test("a package is audited, or the reason it is not is named", function () {
  assert.equal(auditability({ status: "read", registry: "npm", name: "demo-mcp" }), "auditable")
  assert.equal(auditability({ status: "read", registry: "pypi", name: "demo" }), "auditable")
  assert.equal(auditability({ status: "unreadable", registry: "npm", name: null }), "manifest-not-read")
  assert.equal(auditability({ status: "read", registry: null, name: null }), "no-package-name-in-manifest")
  // Supported by fetch-manifests, not audited by this step. Naming it is the point: a registry
  // we cannot read yet must not look like a package we read and found nothing wrong with.
  assert.equal(auditability({ status: "read", registry: "crates.io", name: "demo" }), "unsupported-registry")
  assert.equal(auditability({ status: "read", registry: "go", name: "github.com/a/b" }), "unsupported-registry")
  assert.deepEqual([...new Set(["npm", "pypi"])].sort(), ["npm", "pypi"])
})
test("an empty metadata result says which of two different things happened", function () {
  // "the registry says this package does not exist" is a fact about the package.
  // "the registry did not answer us" is a fact about this run. Both leave us with
  // no metadata, and a record that merges them cannot be used to tell a wrong
  // coordinate from a failed fetch.
  assert.equal(fetchFailureReason(404), "package-not-found")
  assert.equal(fetchFailureReason(0), "registry-unreachable")
  assert.equal(fetchFailureReason(429), "registry-http-429")
  assert.equal(fetchFailureReason(503), "registry-http-503")
})

test("the fetch outcome carries the reason when there is no document", async function () {
  const at = (status, text = "") => async () => ({ status, text })
  assert.deepEqual(await fetchNpmDocumentOutcome("demo-mcp", at(404)), { doc: null, reason: "package-not-found" })
  assert.deepEqual(await fetchNpmDocumentOutcome("demo-mcp", at(0)), { doc: null, reason: "registry-unreachable" })
  assert.deepEqual(await fetchNpmDocumentOutcome("demo-mcp", at(429)), { doc: null, reason: "registry-http-429" })
  assert.deepEqual(await fetchNpmDocumentOutcome("demo-mcp", at(200, "not json")), { doc: null, reason: "metadata-not-json" })
  // A name this step will not send is never sent, so it must not be reported as absent from the
  // registry — and it must not be called an invalid npm name either: npm still serves legacy
  // packages whose names predate the lowercase rule.
  assert.deepEqual(await fetchNpmDocumentOutcome("bad name", at(404)), { doc: null, reason: "package-name-not-requested" })
  assert.deepEqual(await fetchNpmDocumentOutcome("JSONStream", at(200, "{}")), { doc: null, reason: "package-name-not-requested" })
  assert.deepEqual(await fetchPypiDocumentOutcome("demo", at(404)), { doc: null, reason: "package-not-found" })
  assert.deepEqual(await fetchPypiDocumentOutcome("demo", at(0)), { doc: null, reason: "registry-unreachable" })
  const ok = await fetchNpmDocumentOutcome("demo-mcp", at(200, JSON.stringify({ name: "demo-mcp" })))
  assert.equal(ok.reason, null)
  assert.equal(ok.doc.name, "demo-mcp")
})

test("a package whose metadata could not be fetched is written down with its reason", async function () {
  const coords = { registry: "npm", name: "demo-mcp", version: "1.0.0", status: "read" }
  const missing = await auditOne(coords, { http: async () => ({ status: 404, text: "" }) })
  assert.equal(missing.status, "metadata-unavailable")
  assert.equal(missing.reason, "package-not-found")
  assert.deepEqual(missing.findings, [])
  const offline = await auditOne(coords, { http: async () => ({ status: 0, text: "" }) })
  assert.equal(offline.reason, "registry-unreachable")
  // The two are different records. If they were the same string this test would pass
  // while the published file still could not tell them apart.
  assert.notEqual(missing.reason, offline.reason)
})
