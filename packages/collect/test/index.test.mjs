import { test } from "node:test"
import assert from "node:assert/strict"
import { aggregateVerdict, deriveVerdict, buildIndex, RANK, UNMEASURED } from "../scripts/build-index.mjs"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..", "..", "..")

test("an unmeasured block makes the verdict incomplete, never clean", function () {
  const blocks = {
    a: { status: "clean", findings: [] },
    b: { status: "unmeasured", reason: "fetch-failed", findings: [] },
  }
  assert.equal(deriveVerdict(blocks, "high"), "incomplete")
  assert.equal(deriveVerdict(blocks, "low"), "incomplete")
})

test("every severity a rule can emit is one the verdict logic knows", function () {
  // The scan is deliberately a source scan: the point is to catch a rule that invents a
  // severity, and reading the sources is the only way to see one that no corpus exercises.
  const files = [join(REPO, "packages", "collect", "mcp-audit.mjs")]
  const checksDir = join(REPO, "packages", "guard", "src", "checks")
  for (const name of readdirSync(checksDir)) if (name.endsWith(".mjs")) files.push(join(checksDir, name))

  const seen = new Set()
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    // Only the value of a severity field: a line can also carry a rule id or a note, and those
    // are not severities.
    for (const m of text.matchAll(/severity:\s*([^,}\n]+)/g)) {
      for (const q of m[1].matchAll(/["']([a-z]+)["']/g)) seen.add(q[1])
    }
    for (const m of text.matchAll(/\badd\(\s*'[^']*'\s*,\s*'([a-z]+)'/g)) seen.add(m[1])
  }

  assert.ok(seen.size >= 4, "the scan found almost nothing, so it proves nothing: " + JSON.stringify(Array.from(seen)))
  for (const severity of seen) {
    const known = Object.prototype.hasOwnProperty.call(RANK, severity) || UNMEASURED.indexOf(severity) !== -1
    assert.ok(known, "severity \"" + severity + "\" is neither ranked nor listed as unmeasured, so the verdict would treat it as information")
  }
})

test("a severity nobody registered is incomplete, not clean", function () {
  const odd = { a: { status: "findings", findings: [{ rule: "X", severity: "sevrity" }] } }
  assert.equal(deriveVerdict(odd, "low"), "incomplete", "a typo in a severity must not read as information")
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

test("findings survive an unfinished run: a finding is not a claim about work that ran", function () {
  const blocks = { a: { status: "findings", findings: [{ rule: "r", severity: "high", evidence: "e" }] } }
  const finished = { scanner_execution: { state: "complete" } }
  const unfinished = { scanner_execution: { state: "incomplete" } }
  assert.equal(aggregateVerdict(blocks, "medium", finished), "findings")
  assert.equal(aggregateVerdict(blocks, "medium", unfinished), "findings",
    "a high finding must not be downgraded to incomplete because another scanner did not finish")
})

test("clean still needs every required scanner to finish", function () {
  const blocks = { a: { status: "clean", findings: [] } }
  assert.equal(aggregateVerdict(blocks, "medium", { scanner_execution: { state: "complete" } }), "clean")
  assert.equal(aggregateVerdict(blocks, "medium", { scanner_execution: { state: "incomplete" } }), "incomplete",
    "an unfinished run can never be clean, however clean the findings look")
})

test("an unmeasured block is incomplete however the execution record reads", function () {
  const blocks = { a: { status: "unmeasured", findings: [] } }
  assert.equal(aggregateVerdict(blocks, "medium", { scanner_execution: { state: "complete" } }), "incomplete")
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
    { server: "a/one", package: "one", version: "1.0.0", status: "clean", findings: [] },
    { server: "a/two", package: "two", version: "2.0.0", status: "metadata-unavailable", findings: [] },
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
  assert.equal(index.records[0].verdict, "incomplete")
})

test("only completed, well-formed evidence blocks can be clean", function () {
  for (const status of ["check-failed", "fetch-failed", "pending", "future-state", null, undefined]) {
    assert.equal(deriveVerdict({ a: { status, findings: [] } }, "critical"), "incomplete", String(status))
  }
  for (const block of [null, { status: "clean" }, { status: "clean", findings: {} }, { status: "findings", findings: [] }]) {
    assert.equal(deriveVerdict({ a: block }, "medium"), "incomplete")
  }
  assert.equal(deriveVerdict({}, "medium"), "incomplete")
})

const npmRow = { server: "acme/server", package: "acme-mcp", version: "1.0.0", registryType: "npm", findings: [] }
function fromGuard(result, row = npmRow) {
  return buildIndex({ census: { rows: [row] }, guard: { results: [{ ...npmRow, ...result }] } }).records[0]
}

test("a failed manifest check remains incomplete and preserves the failure", function () {
  const record = fromGuard({ status: "check-failed", error: "scanner threw", findings: [] })
  assert.equal(record.verdict, "incomplete")
  assert.equal(record.evidence.packageManifest.status, "unmeasured")
  assert.equal(record.evidence.packageManifest.reason, "check-failed")
  assert.equal(record.evidence.packageManifest.error, "scanner threw")

  const withFinding = fromGuard({ status: "check-failed", findings: [{ rule: "R", severity: "critical" }] })
  assert.equal(withFinding.verdict, "incomplete", "failure outranks even critical findings")
})

test("unrecognised manifest states and invalid results fail closed", function () {
  for (const status of ["metadata-unavailable", "fetch-failed", "new-error", undefined]) {
    const record = fromGuard({ status, findings: [] })
    assert.equal(record.verdict, "incomplete", String(status))
    assert.equal(record.evidence.packageManifest.reason, status || "missing-status")
  }
  for (const result of [{ status: "clean" }, { status: "clean", findings: {} }, { status: "findings", findings: [] }]) {
    const record = fromGuard({ ...result, findings: result.findings })
    assert.equal(record.verdict, "incomplete")
    assert.equal(record.evidence.packageManifest.reason, "invalid-findings")
  }
})

test("a package result cannot be reused for another version or server", function () {
  for (const other of [{ version: "2.0.0" }, { server: "acme/other" }, { version: null }]) {
    const record = fromGuard({ status: "clean", findings: [], ...other })
    assert.equal(record.verdict, "incomplete")
    assert.equal(record.evidence.packageManifest.reason, "not-in-run")
  }
  assert.equal(fromGuard({ status: "clean", findings: [] }).verdict, "clean")
})

test("duplicate manifest results cannot overwrite a failure with success", function () {
  const good = { ...npmRow, status: "clean", findings: [] }
  const bad = { ...npmRow, status: "check-failed", findings: [] }
  for (const results of [[bad, good], [good, bad]]) {
    const record = buildIndex({ census: { rows: [npmRow] }, guard: { results } }).records[0]
    assert.equal(record.verdict, "incomplete")
    assert.equal(record.evidence.packageManifest.reason, "duplicate-results")
  }
})

test("source provenance survives the index join without being invented", function () {
  const provenance = { package: { registry: "npm", name: "acme-mcp", version: "1.0.0" }, content: { algorithm: "sha256", digest: "a".repeat(64), scope: "manifest" }, complete: true }
  const record = fromGuard({ status: "clean", findings: [], provenance }, { ...npmRow, provenance })
  assert.deepEqual(record.evidence.registryDocument.provenance, provenance)
  assert.deepEqual(record.evidence.packageManifest.provenance, provenance)
  const legacy = fromGuard({ status: "clean", findings: [] })
  assert.equal(legacy.evidence.registryDocument.provenance, null)
  assert.equal(legacy.evidence.packageManifest.provenance, null)
})

test("an explicitly unaudited census row cannot become clean", function () {
  for (const registryType of [null, "unsupported-registry"]) {
    const record = buildIndex({ census: { rows: [{ server: "acme/remote", registryType, audited: false, findings: [] }] } }).records[0]
    assert.equal(record.verdict, "incomplete")
    assert.equal(record.evidence.registryDocument.reason, "not-audited")
  }
})

const repoRow = { ...npmRow, repository: "https://github.com/acme/server" }
const cleanGuard = { results: [{ ...npmRow, status: "clean", findings: [] }] }

test("a requested repository scan cannot omit its missing coverage", function () {
  for (const repos of [{ results: [] }, "missing-repository-artifact.json"]) {
    const record = buildIndex({ census: { rows: [repoRow] }, guard: cleanGuard, repos }).records[0]
    assert.equal(record.verdict, "incomplete")
    assert.equal(record.evidence.repository.reason, "not-in-run")
  }
  const optional = buildIndex({ census: { rows: [repoRow] }, guard: cleanGuard }).records[0]
  assert.equal(optional.verdict, "clean", "repository checks are not silently made mandatory")
  assert.equal(optional.evidence.repository, undefined)
})

test("repository scan failures and duplicate results never become clean", function () {
  const good = { slug: "acme/server", status: "clean", findings: [] }
  const bad = { slug: "acme/server", status: "scan-failed", findings: [] }
  for (const results of [[bad], [bad, good], [good, bad]]) {
    const record = buildIndex({ census: { rows: [repoRow] }, guard: cleanGuard, repos: { results } }).records[0]
    assert.equal(record.verdict, "incomplete")
    assert.equal(record.evidence.repository.reason, results.length > 1 ? "duplicate-results" : "scan-failed")
  }
})
