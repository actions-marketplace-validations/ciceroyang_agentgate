import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizePolicy } from "../src/policy.mjs"
import { evaluate, exitCodeFor } from "../src/evaluate.mjs"
import { toSarif } from "../src/sarif.mjs"

test("an array is not a policy", function () {
  assert.throws(function () { normalizePolicy([]) }, /must be an object/)
  assert.throws(function () { normalizePolicy("nope") }, /must be an object/)
})

test("a malformed finding makes the result incomplete, not crashing and not clean", function () {
  const out = evaluate({ policy: normalizePolicy({}), scan: { findings: [null, 3, "x"], coverage: {} } })
  assert.equal(out.verdict, "incomplete")
  assert.equal(exitCodeFor(out), 2)
  assert.equal(out.coverage.malformed.length, 3)
})

test("a record with no server name makes the result incomplete", function () {
  const out = evaluate({ policy: normalizePolicy({ forbidden: { servers: ["*"] } }), records: [{ evidence: {} }] })
  assert.equal(out.verdict, "incomplete")
  assert.match(out.coverage.malformed[0].detail, /no server name/)
})

test("malformed input reaches SARIF as an error rather than a silence", function () {
  const out = evaluate({ policy: normalizePolicy({}), scan: { findings: [null], coverage: {} } })
  const sarif = JSON.parse(toSarif(out, {}))
  assert.equal(sarif.runs[0].results[0].ruleId, "POLICY-MALFORMED-INPUT")
  assert.equal(sarif.runs[0].results[0].level, "error")
})

test("a policy with 50000 rules still evaluates", function () {
  const many = []
  for (let i = 0; i < 50000; i += 1) many.push("r" + i)
  const out = evaluate({ policy: normalizePolicy({ forbidden: { rules: many } }), scan: { findings: [{ rule: "r49999", severity: "low", file: "f", message: "m" }], coverage: {} } })
  assert.equal(out.verdict, "findings")
})
