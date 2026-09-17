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

test("a record whose scan execution is not complete is incomplete, whatever the policy says", function () {
  const policy = normalizePolicy(base({}))
  const records = [{
    server: "a/b",
    packages: [],
    evidence: {},
    scanExecution: { scanner_execution: { state: "incomplete", components: [{ id: "repository", required: true, status: "failed", reason: "not-in-run" }] } },
  }]
  const out = evaluate({ policy: policy, records: records })
  assert.equal(out.verdict, "incomplete")
  assert.deepEqual(out.coverage.executionIncomplete, [{ server: "a/b", state: "incomplete", failed: ["repository"] }])
  assert.equal(exitCodeFor(out), 2)
})

test("a complete scan execution does not by itself make a record clean", function () {
  const policy = normalizePolicy(base({ required: { measuredEvidence: ["packageManifest"] } }))
  const records = [{
    server: "a/b",
    packages: [],
    evidence: { packageManifest: { status: "unmeasured", reason: "metadata-unavailable" } },
    scanExecution: { scanner_execution: { state: "complete", components: [{ id: "packageManifest", required: true, status: "completed" }] } },
  }]
  const out = evaluate({ policy: policy, records: records })
  assert.equal(out.verdict, "incomplete")
  assert.equal(out.coverage.evidenceMissing.length, 1)
})

test("a policy can name the scanners it insists on", function () {
  const policy = normalizePolicy(base({ required: { scanners: ["packageManifest"] } }))
  assert.deepEqual(policy.requiredScanners, ["packageManifest"])
  const missing = evaluate({ policy: policy, records: [{ server: "a/b", packages: [], evidence: {}, scanExecution: { scanner_execution: { state: "complete", components: [{ id: "registryDocument", required: true, status: "completed" }] } } }] })
  assert.equal(missing.verdict, "incomplete")
  assert.deepEqual(missing.coverage.executionIncomplete, [{ server: "a/b", state: "complete", failed: ["packageManifest"] }])
  const present = evaluate({ policy: policy, records: [{ server: "a/b", packages: [], evidence: {}, scanExecution: { scanner_execution: { state: "complete", components: [{ id: "packageManifest", required: true, status: "completed" }] } } }] })
  assert.equal(present.verdict, "clean")
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

test("a forbidden severity fails the check even below the threshold", function () {
  // The field is documented as "regardless of the threshold", which only means anything when the
  // finding sits below it. This was the one documented policy field with no behavioural test: if
  // it stopped working, a policy saying "never let a low finding through" would quietly become a
  // policy that does, and every test would stay green.
  const scan = { findings: [{ rule: "AG-X", severity: "low", file: "f", message: "m" }], coverage: {} }

  const alone = evaluate({ policy: normalizePolicy({ threshold: "critical" }), scan: scan })
  assert.equal(alone.verdict, "clean", "a low finding under a critical threshold fails on its own")
  assert.equal(exitCodeFor(alone), 0)

  const refused = evaluate({ policy: normalizePolicy({ threshold: "critical", forbidden: { severities: ["low"] } }), scan: scan })
  assert.equal(refused.verdict, "findings", "the forbidden severity did nothing")
  assert.equal(refused.findings[0].reason, "forbidden by policy")
  assert.equal(exitCodeFor(refused), 1)
})

test("a forbidden rule fails the check even below the threshold", function () {
  const scan = { findings: [{ rule: "AG-SPECIAL", severity: "info", file: "f", message: "m" }], coverage: {} }
  assert.equal(evaluate({ policy: normalizePolicy({ threshold: "critical" }), scan: scan }).verdict, "clean")
  const refused = evaluate({ policy: normalizePolicy({ threshold: "critical", forbidden: { rules: ["AG-SPECIAL"] } }), scan: scan })
  assert.equal(refused.verdict, "findings")
  assert.equal(refused.findings[0].reason, "forbidden by policy")
})
