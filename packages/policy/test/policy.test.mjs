import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizePolicy, loadPolicy, matchesServer, severityRank, POLICY_VERSION } from "../src/policy.mjs"
import { evaluate, exitCodeFor } from "../src/evaluate.mjs"

const base = function (extra) { return Object.assign({ version: POLICY_VERSION, threshold: "high" }, extra || {}) }

test("an unknown threshold is an error, not a silent default", function () {
  assert.throws(function () { normalizePolicy({ threshold: "whatever" }) }, /unknown threshold/)
})

test("defaults are the strict reading", function () {
  const p = normalizePolicy({})
  assert.equal(p.threshold, "high")
  assert.equal(p.pinPackages, false)
  assert.deepEqual(p.measuredEvidence, [])
})

test("a glob matches whole segments only", function () {
  assert.equal(matchesServer("acme/*", "acme/thing"), true)
  assert.equal(matchesServer("acme/*", "acme/thing/extra"), true)
  assert.equal(matchesServer("acme/*", "other/thing"), false)
  assert.equal(matchesServer("acme/thing", "acme/thing"), true)
  assert.equal(matchesServer("a*c", "abc"), true)
  assert.equal(matchesServer("a*c", "abd"), false)
})

test("severity ranks order the five levels", function () {
  assert.ok(severityRank("critical") > severityRank("high"))
  assert.ok(severityRank("high") > severityRank("medium"))
  assert.equal(severityRank("nonsense"), 0)
})

test("a forbidden rule fails even below the threshold", function () {
  const policy = normalizePolicy(base({ forbidden: { rules: ["AG-MCP-010"] } }))
  const scan = { findings: [{ rule: "AG-MCP-010", severity: "low", file: "a", message: "m" }], coverage: { checksFailed: [] } }
  const out = evaluate({ policy: policy, scan: scan })
  assert.equal(out.verdict, "findings")
  assert.equal(exitCodeFor(out), 1)
  assert.match(out.findings[0].reason, /forbidden/)
})

test("a failed check makes the result incomplete, whatever the findings say", function () {
  const policy = normalizePolicy(base({}))
  const scan = { findings: [], coverage: { checksFailed: [{ id: "mcp-config", error: "boom" }] } }
  const out = evaluate({ policy: policy, scan: scan })
  assert.equal(out.verdict, "incomplete")
  assert.equal(exitCodeFor(out), 2)
})

test("required but unmeasured evidence is incomplete, never clean", function () {
  const policy = normalizePolicy(base({ required: { measuredEvidence: ["packageManifest"] } }))
  const records = [{ server: "a/b", packages: [], evidence: { packageManifest: { status: "unmeasured", reason: "metadata-unavailable" } } }]
  const out = evaluate({ policy: policy, records: records })
  assert.equal(out.verdict, "incomplete")
  assert.equal(out.coverage.evidenceMissing[0].reason, "metadata-unavailable")
  assert.equal(exitCodeFor(out), 2)
})

test("an unpinned package fails a pinning policy", function () {
  const policy = normalizePolicy(base({ required: { pinnedPackages: true } }))
  const records = [{ server: "a/b", packages: [{ registry: "npm", name: "x", version: null }], evidence: {} }]
  const out = evaluate({ policy: policy, records: records })
  assert.equal(out.verdict, "incomplete")
  assert.match(out.coverage.evidenceMissing[0].reason, /no pinned version/)
})

test("everything measured and nothing refused is clean", function () {
  const policy = normalizePolicy(base({}))
  const scan = { findings: [{ rule: "AG-MCP-010", severity: "medium", file: "a", message: "m" }], coverage: { checksFailed: [] } }
  const out = evaluate({ policy: policy, scan: scan })
  assert.equal(out.verdict, "clean")
  assert.equal(exitCodeFor(out), 0)
})

test("a forbidden server pattern is a finding from the index", function () {
  const policy = normalizePolicy(base({ forbidden: { servers: ["internal/*"] } }))
  const out = evaluate({ policy: policy, records: [{ server: "internal/thing", packages: [], evidence: {} }] })
  assert.equal(out.verdict, "findings")
  assert.equal(out.findings[0].rule, "POLICY-SERVER")
})

test("loadPolicy reads a file path or an object", function () {
  assert.equal(loadPolicy({ threshold: "medium" }).threshold, "medium")
  assert.throws(function () { loadPolicy("/no/such/policy.json") }, /could not be read/)
})
