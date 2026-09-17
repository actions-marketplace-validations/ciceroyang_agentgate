import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { scratchDir } from "./tmpdir.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(ROOT, "scripts", "review-criticals.mjs")

function indexWith(findings) {
  const pkg = { registry: "npm", name: "@acme/server", version: "1.2.3" }
  return { threshold: "medium", records: [{
    server: "acme/server",
    verdict: "findings",
    packages: [{ ...pkg }],
    evidence: { registryDocument: {
      status: "findings", source: "test", findings: findings,
      provenance: { package: { ...pkg }, content: { algorithm: "sha256", digest: "a".repeat(64), scope: "registry document and package metadata inspected by the census" }, complete: true },
    } },
  }] }
}
function run(dir, extra) {
  return spawnSync(process.execPath, [SCRIPT, "--index", join(dir, "index.json"), "--baseline", join(dir, "reviewed.json")].concat(extra || []), { encoding: "utf8" })
}
function seed(dir, findings) { writeFileSync(join(dir, "index.json"), JSON.stringify(indexWith(findings))) }

test("an unreviewed critical fails the check, and reading it clears the check", function () {
  const dir = scratchDir("ag-review-")
  seed(dir, [{ rule: "R", severity: "critical", evidence: "boom" }])

  const first = run(dir)
  assert.equal(first.status, 1, first.stdout + first.stderr)
  assert.match(first.stdout, /NEW\s+acme\/server \| R/)

  const accept = run(dir, ["--accept"])
  assert.equal(accept.status, 0, accept.stderr)
  assert.ok(existsSync(join(dir, "reviewed.json")), "accepting has to write the baseline")
  const baseline = JSON.parse(readFileSync(join(dir, "reviewed.json"), "utf8"))
  assert.equal(baseline.reviewed.length, 1)
  assert.equal(baseline.schemaVersion, 2)
  assert.equal(baseline.reviewed[0].evidence, "boom")
  assert.equal(baseline.reviewed[0].severity, "critical")
  assert.equal(baseline.reviewed[0].provenance.package.version, "1.2.3")
  assert.equal(baseline.reviewed[0].provenance.content.digest, "a".repeat(64))

  assert.equal(run(dir).status, 0, "a reviewed critical must not fail again")
})

test("changing the evidence voids the review", function () {
  const dir = scratchDir("ag-review2-")
  seed(dir, [{ rule: "R", severity: "critical", evidence: "boom" }])
  assert.equal(run(dir, ["--accept"]).status, 0)

  seed(dir, [{ rule: "R", severity: "critical", evidence: "boom, but different" }])
  const again = run(dir)
  assert.equal(again.status, 1, "a changed evidence string is a new thing to read")
  assert.match(again.stdout, /CHANGED/)
})

test("a critical that went away is reported and does not fail the check", function () {
  const dir = scratchDir("ag-review3-")
  seed(dir, [{ rule: "R", severity: "critical", evidence: "boom" }])
  assert.equal(run(dir, ["--accept"]).status, 0)

  seed(dir, [{ rule: "R", severity: "medium", evidence: "boom" }])
  const again = run(dir)
  assert.equal(again.status, 0)
  assert.match(again.stdout, /CLEARED/)
})

test("high findings need review while medium findings do not", function () {
  const dir = scratchDir("ag-review4-")
  seed(dir, [{ rule: "R", severity: "high", evidence: "x" }, { rule: "R2", severity: "medium", evidence: "y" }])
  const r = run(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /high\/critical findings: 1/)
  assert.equal(run(dir, ["--accept"]).status, 0)
  assert.equal(run(dir).status, 0)
  seed(dir, [{ rule: "R2", severity: "medium", evidence: "y" }])
  assert.equal(run(dir).status, 0)
})

test("the same server and rule in different files retain separate reviews", function () {
  const dir = scratchDir("ag-review-files-")
  seed(dir, [
    { rule: "R", severity: "high", file: "one.js", evidence: "one" },
    { rule: "R", severity: "high", file: "two.js", evidence: "two" },
  ])
  assert.equal(run(dir, ["--accept"]).status, 0)
  assert.equal(run(dir).status, 0, "accepting one file must not overwrite another file's identity")
  seed(dir, [
    { rule: "R", severity: "high", file: "one.js", evidence: "one" },
    { rule: "R", severity: "high", file: "three.js", evidence: "two" },
  ])
  assert.equal(run(dir).status, 1, "a different file needs its own review even when the message matches")
})

test("moving a finding to another evidence block needs a new review", function () {
  const dir = scratchDir("ag-review-block-")
  seed(dir, [{ rule: "R", severity: "high", evidence: "same" }])
  assert.equal(run(dir, ["--accept"]).status, 0)
  const index = indexWith([{ rule: "R", severity: "high", evidence: "same" }])
  index.records[0].evidence.packageManifest = index.records[0].evidence.registryDocument
  delete index.records[0].evidence.registryDocument
  writeFileSync(join(dir, "index.json"), JSON.stringify(index))
  assert.equal(run(dir).status, 1)
})

test("a severity change needs a new review", function () {
  const dir = scratchDir("ag-review-severity-")
  seed(dir, [{ rule: "R", severity: "high", evidence: "same" }])
  assert.equal(run(dir, ["--accept"]).status, 0)
  seed(dir, [{ rule: "R", severity: "critical", evidence: "same" }])
  assert.equal(run(dir).status, 1)
})

test("changing the exact package version voids review even when finding text is unchanged", function () {
  const dir = scratchDir("ag-review-version-")
  seed(dir, [{ rule: "R", severity: "high", evidence: "same" }])
  assert.equal(run(dir, ["--accept"]).status, 0)
  const next = indexWith([{ rule: "R", severity: "high", evidence: "same" }])
  next.records[0].packages[0].version = "1.2.4"
  next.records[0].evidence.registryDocument.provenance.package.version = "1.2.4"
  writeFileSync(join(dir, "index.json"), JSON.stringify(next))
  const result = run(dir)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /CHANGED/)
})

test("changing scanned-content digest voids review even when package and finding text are unchanged", function () {
  const dir = scratchDir("ag-review-content-")
  seed(dir, [{ rule: "R", severity: "high", evidence: "same" }])
  assert.equal(run(dir, ["--accept"]).status, 0)
  const next = indexWith([{ rule: "R", severity: "high", evidence: "same" }])
  next.records[0].evidence.registryDocument.provenance.content.digest = "b".repeat(64)
  writeFileSync(join(dir, "index.json"), JSON.stringify(next))
  const result = run(dir)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /CHANGED/)
})

test("provenance property order does not void a review", function () {
  const dir = scratchDir("ag-review-order-")
  seed(dir, [{ rule: "R", severity: "high", evidence: "same" }])
  assert.equal(run(dir, ["--accept"]).status, 0)
  const next = indexWith([{ rule: "R", severity: "high", evidence: "same" }])
  const p = next.records[0].evidence.registryDocument.provenance
  next.records[0].evidence.registryDocument.provenance = {
    complete: p.complete,
    content: { scope: p.content.scope, digest: p.content.digest, algorithm: p.content.algorithm },
    package: { version: p.package.version, name: p.package.name, registry: p.package.registry },
  }
  writeFileSync(join(dir, "index.json"), JSON.stringify(next))
  assert.equal(run(dir).status, 0)
})

test("legacy reviews require new human review and are not rewritten during checks", function () {
  const dir = scratchDir("ag-review-legacy-")
  seed(dir, [{ rule: "R", severity: "critical", evidence: "same" }])
  const legacy = JSON.stringify({ reviewed: [{ server: "acme/server", rule: "R", block: "registryDocument", file: null, evidence: "same", reviewedAt: "2026-01-01" }] })
  writeFileSync(join(dir, "reviewed.json"), legacy)
  const result = run(dir)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /LEGACY BASELINE.*human re-review is required/)
  assert.match(result.stdout, /reviewed: 0/)
  assert.equal(readFileSync(join(dir, "reviewed.json"), "utf8"), legacy)
})

test("a versioned baseline with a missing digest does not count as reviewed", function () {
  const dir = scratchDir("ag-review-partial-baseline-")
  seed(dir, [{ rule: "R", severity: "high", evidence: "same" }])
  assert.equal(run(dir, ["--accept"]).status, 0)
  const baseline = JSON.parse(readFileSync(join(dir, "reviewed.json"), "utf8"))
  delete baseline.reviewed[0].provenance.content.digest
  writeFileSync(join(dir, "reviewed.json"), JSON.stringify(baseline))
  const result = run(dir)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /reviewed: 0/)
})

for (const [name, invalidate] of [
  ["missing provenance", function (r) { delete r.evidence.registryDocument.provenance }],
  ["missing digest", function (r) { delete r.evidence.registryDocument.provenance.content.digest }],
  ["malformed digest", function (r) { r.evidence.registryDocument.provenance.content.digest = "not-a-digest" }],
  ["unsupported digest algorithm", function (r) { r.evidence.registryDocument.provenance.content.algorithm = "sha1" }],
  ["missing scan scope", function (r) { r.evidence.registryDocument.provenance.content.scope = "" }],
  ["incomplete scan", function (r) { r.evidence.registryDocument.provenance.complete = false }],
  ["missing completeness declaration", function (r) { delete r.evidence.registryDocument.provenance.complete }],
  ["package mismatch", function (r) { r.evidence.registryDocument.provenance.package.name = "other" }],
  ["registry mismatch", function (r) { r.evidence.registryDocument.provenance.package.registry = "pypi" }],
  ["version mismatch", function (r) { r.evidence.registryDocument.provenance.package.version = "2.0.0" }],
  ["missing recorded package", function (r) { delete r.packages }],
  ["missing evidence text", function (r) { delete r.evidence.registryDocument.findings[0].evidence }],
]) {
  test(name + " fails checks and --accept without overwriting a prior baseline", function () {
    const dir = scratchDir("ag-review-invalid-")
    seed(dir, [{ rule: "R", severity: "high", evidence: "same" }])
    assert.equal(run(dir, ["--accept"]).status, 0)
    const baseline = readFileSync(join(dir, "reviewed.json"), "utf8")
    const next = indexWith([{ rule: "R", severity: "high", evidence: "same" }])
    invalidate(next.records[0])
    writeFileSync(join(dir, "index.json"), JSON.stringify(next))
    const check = run(dir)
    assert.equal(check.status, 1, check.stdout + check.stderr)
    assert.match(check.stdout, /INCOMPLETE/)
    const accept = run(dir, ["--accept"])
    assert.equal(accept.status, 1, accept.stdout + accept.stderr)
    assert.match(accept.stderr, /cannot accept incomplete evidence/)
    assert.equal(readFileSync(join(dir, "reviewed.json"), "utf8"), baseline)
  })
}

test("an incomplete fresh index cannot create a review baseline", function () {
  const dir = scratchDir("ag-review-no-baseline-")
  const index = indexWith([{ rule: "R", severity: "critical", evidence: "same" }])
  delete index.records[0].evidence.registryDocument.provenance
  writeFileSync(join(dir, "index.json"), JSON.stringify(index))
  assert.equal(run(dir, ["--accept"]).status, 1)
  assert.equal(existsSync(join(dir, "reviewed.json")), false)
})

test("moving tags and version ranges cannot be accepted as exact package versions", function () {
  const dir = scratchDir("ag-review-ranges-")
  for (const version of ["latest", "stable", "next", "*", "1", "1.2", "1.x", "1.2.*", "^1.2.3", "~1.2", ">=1.0.0", "1.0.0 || 2.0.0", "1.0 - 2.0"]) {
    const index = indexWith([{ rule: "R", severity: "high", evidence: "same" }])
    index.records[0].packages[0].version = version
    index.records[0].evidence.registryDocument.provenance.package.version = version
    writeFileSync(join(dir, "index.json"), JSON.stringify(index))
    const result = run(dir, ["--accept"])
    assert.equal(result.status, 1, "version " + version + ": " + result.stdout + result.stderr)
    assert.equal(existsSync(join(dir, "reviewed.json")), false)
  }
})

test("exact versions outside npm semver remain reviewable", function () {
  const dir = scratchDir("ag-review-cross-ecosystem-")
  const index = indexWith([{ rule: "R", severity: "high", evidence: "same" }])
  const pkg = { registry: "pypi", name: "acme-server", version: "2026.9.post1" }
  index.records[0].packages = [{ ...pkg }]
  index.records[0].evidence.registryDocument.provenance.package = { ...pkg }
  writeFileSync(join(dir, "index.json"), JSON.stringify(index))
  const result = run(dir, ["--accept"])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(run(dir).status, 0)
})

test("multiple evidence items with the same identity retain separate reviews regardless of order", function () {
  const dir = scratchDir("ag-review-shared-identity-")
  const first = { rule: "R", severity: "high", evidence: "preinstall: one" }
  const second = { rule: "R", severity: "high", evidence: "postinstall: two" }
  seed(dir, [first, second])
  assert.equal(run(dir, ["--accept"]).status, 0)
  const baseline = JSON.parse(readFileSync(join(dir, "reviewed.json"), "utf8"))
  assert.equal(baseline.reviewed.length, 2)
  assert.equal(run(dir).status, 0)
  seed(dir, [second, first])
  assert.equal(run(dir).status, 0, "reordering evidence does not change what was reviewed")
  seed(dir, [{ ...first, evidence: "preinstall: changed" }, second])
  const changed = run(dir)
  assert.equal(changed.status, 1)
  assert.match(changed.stdout, /reviewed: 1 \| new: 0 \| changed: 1/)
  seed(dir, [first, second, { ...first, evidence: "install: three" }])
  const added = run(dir)
  assert.equal(added.status, 1)
  assert.match(added.stdout, /reviewed: 2 \| new: 1 \| changed: 0/)
})

for (const [name, invalid] of [
  ["missing records", {}],
  ["records object", { records: {} }],
  ["null record", { records: [null] }],
  ["unnamed record", { records: [{ evidence: {} }] }],
  ["missing evidence", { records: [{ server: "acme/server" }] }],
  ["empty evidence", { records: [{ server: "acme/server", evidence: {} }] }],
  ["null block", { records: [{ server: "acme/server", evidence: { registryDocument: null } }] }],
  ["missing findings", { records: [{ server: "acme/server", evidence: { registryDocument: {} } }] }],
  ["null finding", indexWith([null])],
  ["missing rule", indexWith([{ severity: "critical", evidence: "same" }])],
  ["invalid severity", indexWith([{ rule: "R", severity: "CRITICAL", evidence: "same" }])],
]) {
  test(name + " is a malformed index, never an all-reviewed result", function () {
    const dir = scratchDir("ag-review-malformed-")
    writeFileSync(join(dir, "index.json"), JSON.stringify(invalid))
    for (const extra of [[], ["--accept"]]) {
      const result = run(dir, extra)
      assert.equal(result.status, 2, result.stdout + result.stderr)
      assert.match(result.stderr, /invalid index structure/)
      assert.doesNotMatch(result.stdout, /every high\/critical finding matches/)
      assert.equal(existsSync(join(dir, "reviewed.json")), false)
    }
  })
}

test("a missing index is a usage error, not a pass", function () {
  const dir = scratchDir("ag-review5-")
  const r = run(dir)
  assert.equal(r.status, 2, "no index must not read as every critical reviewed")
  assert.match(r.stderr, /run refresh first/)
})
