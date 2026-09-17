import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildScanExecution, canBeClean, emptyFindings, executionFromBlocks, validateScanExecution } from "../src/execution.mjs"
import { buildIndex } from "../scripts/build-index.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

function component(overrides) {
  return Object.assign({
    id: "guard",
    required: true,
    status: "completed",
    exit_code: 0,
    output_present: true,
    output_parseable: true,
    semantic_consistency: "ok",
    findings: emptyFindings(),
    reason: null,
  }, overrides || {})
}

function record(components, digest) {
  return buildScanExecution({ subject: { server: "a/one", packages: [] }, components: components, digest: digest, generatedAt: "2026-09-17T00:00:00.000Z" })
}

test("a completed required component is complete", function () {
  const built = record([component()])
  assert.equal(built.scanner_execution.state, "complete")
  assert.equal(canBeClean(built), true)
  assert.deepEqual(validateScanExecution(built), { ok: true, problems: [] })
})

test("nothing required is not a pass", function () {
  assert.equal(record([]).scanner_execution.state, "incomplete")
  assert.equal(record([component({ required: false })]).scanner_execution.state, "incomplete")
})

test("a required component that failed, was skipped, or has unreadable output is incomplete", function () {
  assert.equal(record([component({ status: "failed", reason: "boom" })]).scanner_execution.state, "incomplete")
  assert.equal(record([component({ status: "skipped" })]).scanner_execution.state, "incomplete")
  assert.equal(record([component({ output_parseable: false })]).scanner_execution.state, "incomplete")
  assert.equal(record([component({ output_present: false })]).scanner_execution.state, "incomplete")
  assert.equal(record([component({ semantic_consistency: "mismatch" })]).scanner_execution.state, "incomplete")
})

test("an optional component may fail without making the record incomplete", function () {
  const built = record([component(), component({ id: "optional", required: false, status: "failed" })])
  assert.equal(built.scanner_execution.state, "complete")
  assert.equal(built.scanner_execution.required, 1)
  assert.equal(built.scanner_execution.failed, 0)
})

test("a digest recorded as not matching makes the record incomplete", function () {
  const built = record([component()], { algorithm: "sha256", scope: "package contents", value: "a".repeat(64), matches: false })
  assert.equal(built.scanner_execution.state, "incomplete")
  assert.equal(canBeClean(built), false)
})

test("unknown statuses and consistencies are treated as the pessimistic value", function () {
  const built = record([component({ status: "exploded", semantic_consistency: "probably-fine" })])
  const c = built.scanner_execution.components[0]
  assert.equal(c.status, "failed")
  assert.equal(c.semantic_consistency, "unverified")
  assert.equal(built.scanner_execution.state, "incomplete")
})

test("the counts are derived, and the validator re-derives them", function () {
  const built = record([component(), component({ id: "second", status: "failed" })])
  assert.deepEqual(
    { required: built.scanner_execution.required, completed: built.scanner_execution.completed, failed: built.scanner_execution.failed },
    { required: 2, completed: 1, failed: 1 }
  )
  assert.equal(validateScanExecution(built).ok, true)

  const tampered = JSON.parse(JSON.stringify(built))
  tampered.scanner_execution.completed = 2
  tampered.scanner_execution.failed = 0
  const checked = validateScanExecution(tampered)
  assert.equal(checked.ok, false)
  assert.match(checked.problems.join(" "), /completed says 2/)
})

test("the validator refuses a record that claims complete while a required component failed", function () {
  const built = record([component()])
  const tampered = JSON.parse(JSON.stringify(built))
  tampered.scanner_execution.components[0].status = "failed"
  const checked = validateScanExecution(tampered)
  assert.equal(checked.ok, false)
  assert.match(checked.problems.join(" "), /state is complete but not every required component is/)
})

test("the validator refuses a missing subject and a malformed digest", function () {
  const built = record([component()])
  const noSubject = JSON.parse(JSON.stringify(built))
  noSubject.subject.server = ""
  assert.match(validateScanExecution(noSubject).problems.join(" "), /subject.server is missing/)
  const badDigest = JSON.parse(JSON.stringify(built))
  badDigest.digest = { algorithm: 7 }
  assert.match(validateScanExecution(badDigest).problems.join(" "), /digest needs algorithm and value/)
})

test("evidence blocks map onto the shape: measured is completed, unmeasured is failed with its reason", function () {
  const execution = executionFromBlocks({
    server: "a/one",
    packages: [{ registry: "npm", name: "thing", version: "1.0.0" }],
    blocks: {
      registryDocument: { status: "clean", findings: [] },
      packageManifest: { status: "findings", findings: [{ severity: "high" }, { severity: "info" }, { severity: "nonsense" }] },
      repository: { status: "unmeasured", reason: "not-in-run", findings: [] },
    },
    generatedAt: "2026-09-17T00:00:00.000Z",
  })
  assert.equal(execution.scanner_execution.required, 3)
  assert.equal(execution.scanner_execution.completed, 2)
  assert.equal(execution.scanner_execution.failed, 1)
  assert.equal(execution.scanner_execution.state, "incomplete")
  const byId = Object.fromEntries(execution.scanner_execution.components.map(function (c) { return [c.id, c] }))
  assert.equal(byId.registryDocument.status, "completed")
  assert.equal(byId.packageManifest.findings.high, 1)
  assert.equal(byId.packageManifest.findings.info, 1)
  assert.deepEqual(Object.values(byId.packageManifest.findings).reduce(function (a, b) { return a + b }, 0), 2, "an unknown severity is not counted as a finding")
  assert.equal(byId.repository.status, "failed")
  assert.equal(byId.repository.reason, "not-in-run")
  assert.equal(byId.repository.output_parseable, false)
})

test("the schema in the repository agrees with the validator about what is required", function () {
  const schema = JSON.parse(readFileSync(join(ROOT, "docs", "spec", "scan-execution-v1.schema.json"), "utf8"))
  assert.deepEqual(schema.required.sort(), ["generatedAt", "scanner_execution", "schemaVersion", "subject"])
  const component = schema.properties.scanner_execution.properties.components.items
  assert.deepEqual(component.required.sort(), ["exit_code", "findings", "id", "output_parseable", "output_present", "reason", "required", "semantic_consistency", "status"])
  assert.deepEqual(schema.properties.scanner_execution.required.sort(), ["completed", "components", "failed", "required", "state"])
  const example = JSON.parse(readFileSync(join(ROOT, "docs", "spec", "scan-execution-v1.example.json"), "utf8"))
  assert.deepEqual(validateScanExecution(example), { ok: true, problems: [] })
})

test("the index carries the record and will not call an unfinished scan clean", function () {
  const census = {
    rows: [
      { server: "a/remote-only", audited: true, findings: [] },
      { server: "b/not-audited", audited: false, findings: [] },
    ],
  }
  const index = buildIndex({ census: census, generatedAt: "2026-09-17T00:00:00.000Z" })
  const byName = Object.fromEntries(index.records.map(function (r) { return [r.server, r] }))
  assert.equal(byName["a/remote-only"].verdict, "clean")
  assert.equal(byName["a/remote-only"].scanExecution.scanner_execution.state, "complete")
  assert.equal(byName["b/not-audited"].verdict, "incomplete")
  assert.equal(byName["b/not-audited"].scanExecution.scanner_execution.state, "incomplete")
  assert.equal(byName["b/not-audited"].scanExecution.scanner_execution.components[0].reason, "not-audited")
})
