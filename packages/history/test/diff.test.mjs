import { test } from "node:test"
import assert from "node:assert/strict"
import { diffIndex, renderDiff } from "../src/diff.mjs"

const record = function (server, verdict, pkg, findings, status) {
  return { server: server, verdict: verdict, packages: pkg ? [{ registry: "npm", name: pkg, version: "1.0.0" }] : [], evidence: { registryDocument: { status: status || "clean", findings: findings || [] } } }
}
const index = function (records, at) { return { generatedAt: at || "T", count: records.length, records: records } }

test("added and removed servers", function () {
  const d = diffIndex(index([record("a/one", "clean")]), index([record("a/two", "clean")]))
  assert.deepEqual(d.added, ["a/two"])
  assert.deepEqual(d.removed, ["a/one"])
})

test("a verdict change is reported with both sides", function () {
  const d = diffIndex(index([record("a/one", "clean")]), index([record("a/one", "findings", null, [{ rule: "r", severity: "high" }], "findings")]))
  assert.equal(d.verdictChanged.length, 1)
  assert.deepEqual(d.verdictChanged[0], { server: "a/one", from: "clean", to: "findings" })
})

test("a version move is a package change, not a silent one", function () {
  const before = index([record("a/one", "clean", "pkg")])
  const after = index([{ server: "a/one", verdict: "clean", packages: [{ registry: "npm", name: "pkg", version: "2.0.0" }], evidence: {} }])
  const d = diffIndex(before, after)
  assert.equal(d.packageChanged.length, 1)
  assert.equal(d.silent.length, 0)
})

test("different evidence on the same version is the silent category", function () {
  const before = index([record("a/one", "clean", "pkg")])
  const after = index([record("a/one", "findings", "pkg", [{ rule: "AG-MCP-010", severity: "medium" }], "findings")])
  const d = diffIndex(before, after)
  assert.equal(d.silent.length, 1)
  assert.match(d.silent[0].to, /AG-MCP-010/)
  assert.equal(d.packageChanged.length, 0)
})

test("a record that stopped being measurable is reported as a coverage change", function () {
  const before = index([{ server: "a/one", verdict: "clean", packages: [], evidence: {}, scanExecution: { scanner_execution: { state: "complete", components: [] } } }])
  const after = index([{ server: "a/one", verdict: "incomplete", packages: [], evidence: {}, scanExecution: { scanner_execution: { state: "incomplete", components: [{ id: "repository", required: true, status: "failed" }] } } }])
  const d = diffIndex(before, after)
  assert.deepEqual(d.executionChanged, [{ server: "a/one", from: "complete", to: "incomplete[repository]" }])
  assert.match(renderDiff(d), /coverage changes/)
})

test("a record written before the block existed reads as absent, not as complete", function () {
  const before = index([{ server: "a/one", verdict: "clean", packages: [], evidence: {} }])
  const after = index([{ server: "a/one", verdict: "clean", packages: [], evidence: {}, scanExecution: { scanner_execution: { state: "complete", components: [] } } }])
  const d = diffIndex(before, after)
  assert.deepEqual(d.executionChanged, [{ server: "a/one", from: "absent", to: "complete" }])
})

test("an unchanged execution is not a change", function () {
  const rec = function () { return { server: "a/one", verdict: "clean", packages: [], evidence: {}, scanExecution: { scanner_execution: { state: "complete", components: [] } } } }
  assert.deepEqual(diffIndex(index([rec()]), index([rec()])).executionChanged, [])
})

test("the rendering names the silent category rather than burying it", function () {
  const d = diffIndex(index([record("a/one", "clean", "pkg")]), index([record("a/one", "findings", "pkg", [{ rule: "r", severity: "high" }], "findings")]))
  assert.match(renderDiff(d), /silent changes/)
})

test("a packages field that is not an array does not crash the diff", function () {
  const d = diffIndex({ records: [{ server: "a", packages: "x", evidence: {} }] }, { records: [{ server: "a", packages: "x", evidence: {} }] })
  assert.equal(d.packageChanged.length, 0)
  assert.equal(d.silent.length, 0)
})

test("records without a server name are ignored", function () {
  const d = diffIndex({ records: [null, {}] }, { records: [null, {}] })
  assert.deepEqual(d.added, [])
})
