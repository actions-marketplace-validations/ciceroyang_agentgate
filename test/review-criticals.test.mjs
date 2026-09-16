import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(ROOT, "scripts", "review-criticals.mjs")

function indexWith(findings) {
  return { threshold: "medium", records: [{ server: "acme/server", verdict: "findings", evidence: { registryDocument: { status: "findings", source: "test", findings: findings } } }] }
}
function run(dir, extra) {
  return spawnSync(process.execPath, [SCRIPT, "--index", join(dir, "index.json"), "--baseline", join(dir, "reviewed.json")].concat(extra || []), { encoding: "utf8" })
}
function seed(dir, findings) { writeFileSync(join(dir, "index.json"), JSON.stringify(indexWith(findings))) }

test("an unreviewed critical fails the check, and reading it clears the check", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-review-"))
  seed(dir, [{ rule: "R", severity: "critical", evidence: "boom" }])

  const first = run(dir)
  assert.equal(first.status, 1, first.stdout + first.stderr)
  assert.match(first.stdout, /NEW\s+acme\/server \| R/)

  const accept = run(dir, ["--accept"])
  assert.equal(accept.status, 0, accept.stderr)
  assert.ok(existsSync(join(dir, "reviewed.json")), "accepting has to write the baseline")
  const baseline = JSON.parse(readFileSync(join(dir, "reviewed.json"), "utf8"))
  assert.equal(baseline.reviewed.length, 1)
  assert.equal(baseline.reviewed[0].evidence, "boom")

  assert.equal(run(dir).status, 0, "a reviewed critical must not fail again")
})

test("changing the evidence voids the review", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-review2-"))
  seed(dir, [{ rule: "R", severity: "critical", evidence: "boom" }])
  assert.equal(run(dir, ["--accept"]).status, 0)

  seed(dir, [{ rule: "R", severity: "critical", evidence: "boom, but different" }])
  const again = run(dir)
  assert.equal(again.status, 1, "a changed evidence string is a new thing to read")
  assert.match(again.stdout, /CHANGED/)
})

test("a critical that went away is reported and does not fail the check", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-review3-"))
  seed(dir, [{ rule: "R", severity: "critical", evidence: "boom" }])
  assert.equal(run(dir, ["--accept"]).status, 0)

  seed(dir, [{ rule: "R", severity: "medium", evidence: "boom" }])
  const again = run(dir)
  assert.equal(again.status, 0)
  assert.match(again.stdout, /CLEARED/)
})

test("high and medium are not this check's business", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-review4-"))
  seed(dir, [{ rule: "R", severity: "high", evidence: "x" }, { rule: "R2", severity: "medium", evidence: "y" }])
  const r = run(dir)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /criticals: 0/)
})

test("a missing index is a usage error, not a pass", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-review5-"))
  const r = run(dir)
  assert.equal(r.status, 2, "no index must not read as every critical reviewed")
  assert.match(r.stderr, /run refresh first/)
})
