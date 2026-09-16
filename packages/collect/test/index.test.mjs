import { test } from "node:test"
import assert from "node:assert/strict"
import { deriveVerdict, buildIndex } from "../scripts/build-index.mjs"

test("an unmeasured block makes the verdict incomplete, never clean", function () {
  const blocks = {
    a: { status: "clean", findings: [] },
    b: { status: "unmeasured", reason: "fetch-failed", findings: [] },
  }
  assert.equal(deriveVerdict(blocks, "high"), "incomplete")
  assert.equal(deriveVerdict(blocks, "low"), "incomplete")
})

test("a finding that says unknown is incomplete, not clean", function () {
  const only = { a: { status: "findings", findings: [{ rule: "X", severity: "unknown" }] } }
  assert.equal(deriveVerdict(only, "medium"), "incomplete")
  assert.equal(deriveVerdict(only, "high"), "incomplete")

  // It also outranks a real finding: "we could not measure part of this" is the dominant truth,
  // the same way an unmeasured block outranks findings.
  const mixed = { a: { status: "findings", findings: [{ rule: "X", severity: "unknown" }, { rule: "Y", severity: "medium" }] } }
  assert.equal(deriveVerdict(mixed, "medium"), "incomplete")
})

test("a finding at the threshold decides, below it does not", function () {
  const blocks = { a: { status: "findings", findings: [{ severity: "medium" }] } }
  assert.equal(deriveVerdict(blocks, "medium"), "findings")
  assert.equal(deriveVerdict(blocks, "high"), "clean")
})

test("all clean is clean", function () {
  assert.equal(deriveVerdict({ a: { status: "clean", findings: [] } }, "medium"), "clean")
})

test("buildIndex joins the artifacts and keeps provenance", function () {
  const root = "/tmp/index-test-" + process.pid
  const census = {
    rows: [
      { server: "a/one", package: "one", version: "1.0.0", registryType: "npm", repository: null, findings: [{ rule: "r", severity: "medium", evidence: "e" }] },
      { server: "a/two", package: "two", version: "2.0.0", registryType: "npm", repository: null, findings: [] },
    ],
  }
  const guard = { results: [
    { package: "one", status: "clean", findings: [] },
    { package: "two", status: "metadata-unavailable", findings: [] },
  ] }
  const index = buildIndex({ census: census, guard: guard, threshold: "medium", generatedAt: "T" })
  assert.equal(index.count, 2)
  const one = index.records.find(function (r) { return r.server === "a/one" })
  assert.equal(one.verdict, "findings")
  assert.equal(one.evidence.registryDocument.source, "mcp-census")
  assert.equal(one.evidence.packageManifest.source, "guard-scan")
  const two = index.records.find(function (r) { return r.server === "a/two" })
  assert.equal(two.verdict, "incomplete")
  assert.equal(two.evidence.packageManifest.reason, "metadata-unavailable")
})

test("census rows that are not rows are skipped, not fatal", function () {
  const index = buildIndex({ census: { rows: [null, 3, "x", {}, { server: "a/one" }] } })
  assert.equal(index.count, 1)
  assert.equal(index.skipped.length, 4)
})

test("a guard artifact that is not an artifact is ignored", function () {
  const index = buildIndex({ census: { rows: [{ server: "a/one", package: "p", registryType: "npm" }] }, guard: "nope" })
  assert.equal(index.count, 1)
})
