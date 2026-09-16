import { test } from "node:test"
import assert from "node:assert/strict"
import { deriveVerdict, buildIndex, RANK, UNMEASURED } from "../scripts/build-index.mjs"
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
