import test from "node:test"
import assert from "node:assert/strict"
import { syntheticServer, auditability } from "../scripts/audit-packages.mjs"

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