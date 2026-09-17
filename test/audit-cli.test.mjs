import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchDir } from "./tmpdir.mjs"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agentgate.mjs")

function run(args) {
  return spawnSync(process.execPath, [BIN].concat(args), { encoding: "utf8" })
}

/** Three repositories: one clean, one with a finding, one whose evidence could not be measured. */
function fixture() {
  const dir = scratchDir("ag-audit-")
  const clean = join(dir, "clean")
  const findings = join(dir, "findings")
  const unmeasured = join(dir, "unmeasured")
  for (const repo of [clean, findings, unmeasured]) mkdirSync(repo, { recursive: true })
  writeFileSync(join(findings, ".mcp.json"), JSON.stringify({
    mcpServers: { loose: { command: "npx", args: ["-y", "loose-tool", "/data"] } },
  }))
  writeFileSync(join(unmeasured, "package.json"), JSON.stringify({ name: "unmeasured-demo", version: "1.0.0" }))
  const policy = join(dir, "policy.json")
  writeFileSync(policy, JSON.stringify({ version: "1", threshold: "medium", required: { measuredEvidence: ["packageManifest"], pinnedPackages: false } }))
  const index = join(dir, "index.json")
  writeFileSync(index, JSON.stringify({
    records: [{ server: "demo/unmeasured", packages: [{ name: "unmeasured-demo", version: "1.0.0" }], evidence: { packageManifest: { status: "unmeasured", reason: "metadata-unavailable" } } }],
  }))
  return { dir: dir, clean: clean, findings: findings, unmeasured: unmeasured, index: index, policy: policy }
}

test("three repositories produce one verdict, and an unmeasured one makes it incomplete", function () {
  const f = fixture()
  const out = run(["audit", "--roots", [f.clean, f.findings, f.unmeasured].join(","), "--index", f.index, "--policy", f.policy])
  assert.equal(out.status, 2, out.stdout + out.stderr)
  assert.match(out.stdout, /FINDINGS/)
  assert.match(out.stdout, /INCOMPLETE/)
  assert.match(out.stdout, /整体: INCOMPLETE/)
})

test("a single clean repository exits 0", function () {
  const f = fixture()
  const out = run(["audit", "--roots", f.clean])
  assert.equal(out.status, 0, out.stdout + out.stderr)
  assert.match(out.stdout, /整体: CLEAN/)
})

test("a single repository with a finding exits 1", function () {
  const f = fixture()
  const out = run(["audit", "--roots", f.findings])
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.match(out.stdout, /AG-MCP-/)
})

test("a directory that does not exist is an unmeasured repository, not a skipped one", function () {
  const f = fixture()
  const missing = join(f.dir, "gone")
  const out = run(["audit", "--roots", [f.clean, missing].join(",")])
  assert.equal(out.status, 2)
  assert.match(out.stdout, /目录不存在/)
  assert.match(out.stdout, /整体: INCOMPLETE/)
})

test("audit without --roots refuses instead of auditing nothing", function () {
  const out = run(["audit"])
  assert.equal(out.status, 3)
  assert.match(out.stderr, /usage: agentgate audit/)
})

test("--format json carries the aggregate and every entry", function () {
  const f = fixture()
  const out = run(["audit", "--roots", [f.clean, f.findings].join(","), "--format", "json"])
  const body = JSON.parse(out.stdout)
  assert.equal(body.schemaVersion, 1)
  assert.equal(body.entries.length, 2)
  assert.equal(body.aggregate.verdict, "findings")
})
