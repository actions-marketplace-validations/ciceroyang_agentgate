import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

/**
 * The daily history job, including the case that made it fail forever on a fresh server:
 * a first run with nothing to diff against.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(ROOT, "scripts", "daily-snapshot.mjs")

function run(args) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: "utf8", timeout: 30000 })
}

function indexWith(records) {
  return JSON.stringify({ generatedAt: new Date().toISOString(), count: records.length, records: records })
}

test("the first run seeds the snapshot and writes no diff", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-snap-"))
  const index = join(dir, "index.json")
  writeFileSync(index, indexWith([{ server: "a/b", verdict: "clean", packages: [], evidence: [] }]))
  const run1 = run(["--index", index, "--history", join(dir, "history"), "--date", "2026-09-15"])
  assert.equal(run1.status, 0, run1.stderr)
  assert.match(run1.stdout, /first snapshot/)
  assert.equal(existsSync(join(dir, "history", "diff-2026-09-15.md")), false, "a diff was invented")
  assert.equal(existsSync(join(dir, "history", "previous.json")), true, "the first run must seed previous.json")
  assert.equal(existsSync(join(dir, "history", "2026-09-15.json")), true)
  rmSync(dir, { recursive: true, force: true })
})

test("the second run produces a diff against the first", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-snap2-"))
  const history = join(dir, "history")
  const index = join(dir, "index.json")
  writeFileSync(index, indexWith([{ server: "a/b", verdict: "clean", packages: [], evidence: [] }]))
  assert.equal(run(["--index", index, "--history", history, "--date", "2026-09-15"]).status, 0)
  // a/b keeps the same packages but gains a finding: the silent category, which the page
  // promises to list by name rather than only count
  writeFileSync(index, indexWith([
    { server: "a/b", verdict: "findings", packages: [], evidence: { packageManifest: { status: "findings", findings: [{ rule: "AG-SUPPLY-002" }] } } },
    { server: "c/d", verdict: "clean", packages: [], evidence: [] }
  ]))
  const second = run(["--index", index, "--history", history, "--date", "2026-09-16"])
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /diff written for 2026-09-16/)
  const diff = readFileSync(join(history, "diff-2026-09-16.md"), "utf8")
  assert.match(diff, /added:\s+1/, "the added server was not counted")
  assert.match(diff, /silent \(no version move, different evidence\): 1/, "the silent change was not counted")
  assert.match(diff, /^\s+a\/b$/m, "the silent change is not named, and the page promises it is")
  assert.match(diff, /packageManifest:AG-SUPPLY-002/, "the evidence behind the silent change is missing")
  rmSync(dir, { recursive: true, force: true })
})

test("a missing index is an error, not a silent no-op", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-snap3-"))
  const out = run(["--index", join(dir, "nope.json"), "--history", join(dir, "history")])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /run refresh first/)
  rmSync(dir, { recursive: true, force: true })
})
