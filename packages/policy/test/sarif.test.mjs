import { test } from "node:test"
import assert from "node:assert/strict"
import { toSarif } from "../src/sarif.mjs"

test("a finding becomes a result with a location", function () {
  const sarif = JSON.parse(toSarif({ findings: [{ rule: "AG-MCP-010", severity: "medium", file: ".mcp.json", message: "m", reason: "at or above the threshold" }], coverage: { checksFailed: [], evidenceMissing: [] } }, {}))
  assert.equal(sarif.runs[0].results.length, 1)
  assert.equal(sarif.runs[0].results[0].ruleId, "AG-MCP-010")
  assert.equal(sarif.runs[0].results[0].level, "warning")
  assert.match(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, /mcp\.json/)
})

test("unmeasured evidence is an error in SARIF, not a silence", function () {
  const sarif = JSON.parse(toSarif({ findings: [], coverage: { checksFailed: [], evidenceMissing: [{ server: "a/b", block: "packageManifest", reason: "metadata-unavailable" }] } }, {}))
  assert.equal(sarif.runs[0].results.length, 1)
  assert.equal(sarif.runs[0].results[0].ruleId, "POLICY-UNMEASURED")
  assert.equal(sarif.runs[0].results[0].level, "error")
})

test("a failed check is an error in SARIF", function () {
  const sarif = JSON.parse(toSarif({ findings: [], coverage: { checksFailed: [{ id: "mcp-config", error: "boom" }], evidenceMissing: [] } }, {}))
  assert.equal(sarif.runs[0].results[0].ruleId, "AG-INTERNAL-CHECK-FAIL")
})

test("an incomplete run says so in the invocation, not only in the results", function () {
  const clean = JSON.parse(toSarif({ verdict: "clean", findings: [], coverage: { checksFailed: [], evidenceMissing: [] } }, {}))
  assert.equal(clean.runs[0].invocations[0].executionSuccessful, true)
  const partial = JSON.parse(toSarif({ verdict: "incomplete", findings: [], coverage: { checksFailed: [], evidenceMissing: [{ server: "a/b", block: "packageManifest", reason: "metadata-unavailable" }] } }, {}))
  assert.equal(partial.runs[0].invocations[0].executionSuccessful, false)
  assert.match(partial.runs[0].invocations[0].toolExecutionNotifications[0].message.text, /metadata-unavailable/)
})

test("an unfinished scan execution becomes a notification", function () {
  const sarif = JSON.parse(toSarif({ verdict: "incomplete", findings: [], coverage: { checksFailed: [], evidenceMissing: [], executionIncomplete: [{ server: "a/b", state: "incomplete", failed: ["repository"] }] } }, {}))
  assert.equal(sarif.runs[0].invocations[0].executionSuccessful, false)
  assert.match(JSON.stringify(sarif.runs[0].invocations[0].toolExecutionNotifications), /repository/)
})
