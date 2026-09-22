import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { scratchDir } from "./tmpdir.mjs"
import { normalizePolicy } from "../packages/policy/src/policy.mjs"
import { evaluate } from "../packages/policy/src/evaluate.mjs"
import { coordinatesFrom, manifestCacheKey } from "../packages/collect/scripts/fetch-manifests.mjs"
import { auditCacheKey } from "../packages/collect/scripts/audit-packages.mjs"
import { reusable } from "../packages/collect/src/cache.mjs"
import { auditPackage, auditPypiPackage } from "../packages/collect/mcp-audit.mjs"
import { discover, renderText, renderInventory } from "../packages/guard/src/discover.mjs"
import { parseInventory, createInventoryReport } from "../packages/inventory/src/inventory.mjs"
import { appendWatch, projectionOf, diffProjections, verifyWatch } from "../packages/watch/src/watch.mjs"
import { evaluateClasses } from "../packages/pack/src/classes.mjs"
import { buildScanExecution, canBeClean, validateScanExecution } from "../packages/collect/src/execution.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
function run(script, args = [], options = {}) {
  return spawnSync(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, encoding: "utf8", timeout: 15000, ...options })
}
const policy = normalizePolicy({ required: { measuredEvidence: ["packageManifest"], scanners: ["packageManifest"] } })
const component = id => ({ id, required: true, status: "completed", output_present: true, output_parseable: true, semantic_consistency: "ok" })
function record() {
  const packages = [{ registry: "npm", name: "trust-fixture", version: "1.0.0" }]
  return {
    server: "test/tool", verdict: "clean", packages,
    evidence: { packageManifest: { status: "clean", source: "fixture", findings: [], provenance: {
      package: packages[0], complete: true, content: { algorithm: "sha256", digest: "a".repeat(64), scope: "fixture only" },
    } } },
    scanExecution: buildScanExecution({ subject: { server: "test/tool", packages }, components: [component("packageManifest")] }),
  }
}

test("required evidence cannot pass with absent, empty, malformed or invalid records", () => {
  for (const records of [undefined, [], {}, [null], [{ server: "a", evidence: { packageManifest: {} } }]]) {
    assert.equal(evaluate({ policy, records }).verdict, "incomplete")
  }
  assert.equal(evaluate({ policy, records: [record()] }).verdict, "clean")
})

test("adding required scanners never removes the global incompleteness gate", () => {
  const r = record()
  r.scanExecution.scanner_execution.state = "incomplete"
  r.scanExecution.scanner_execution.components.push({ id: "source", required: true, status: "failed" })
  for (const required of [{}, { scanners: ["packageManifest"] }, { scanners: ["packageManifest", "source"] }]) {
    assert.equal(evaluate({ policy: normalizePolicy({ required }), records: [r] }).verdict, "incomplete")
  }
})

test("a completed label with failed output or conflicting counts cannot satisfy a policy", () => {
  for (const mutate of [
    r => { r.scanExecution.scanner_execution.components[0].output_present = false },
    r => { r.scanExecution.scanner_execution.completed = 0 },
    r => { r.scanExecution.scanner_execution.components = [null] },
    r => { r.scanExecution = {} },
  ]) {
    const r = record()
    mutate(r)
    assert.equal(evaluate({ policy, records: [r] }).verdict, "incomplete")
  }
})

test("check rejects explicit bad indexes and never borrows another package version", () => {
  const dir = scratchDir("ag-trust-check-")
  const policyPath = join(dir, "policy.json"), indexPath = join(dir, "index.json")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "trust-fixture", version: "1.0.0" }))
  writeFileSync(policyPath, JSON.stringify({ required: { measuredEvidence: ["packageManifest"] } }))
  const args = ["check", "--root", dir, "--policy", policyPath, "--format", "json"]
  assert.equal(run("bin/agentgate.mjs", args, { env: { ...process.env, AGENTGATE_INDEX: "" } }).status, 2)
  assert.equal(run("bin/agentgate.mjs", [...args, "--index", indexPath]).status, 3)
  for (const bad of ["{bad", "{}", '{"records":null}', '{"snapshot":true,"records":[]}']) {
    writeFileSync(indexPath, bad)
    assert.equal(run("bin/agentgate.mjs", [...args, "--index", indexPath]).status, 3)
  }
  const r = record()
  r.packages[0].version = "2.0.0"
  writeFileSync(indexPath, JSON.stringify({ records: [r] }))
  assert.equal(run("bin/agentgate.mjs", [...args, "--index", indexPath]).status, 2)
})

test("TOML identities come only from the supported package table", () => {
  const py = '[[tool.uv.index]]\nname="pytorch"\n[project]\nname="real-server"\nversion="1.2.3"\n'
  assert.deepEqual(coordinatesFrom("pyproject.toml", py), { registry: "pypi", name: "real-server", version: "1.2.3" })
  assert.equal(coordinatesFrom("Cargo.toml", '[workspace.package]\nversion="9.0.0"\n[package]\nname="real"\nversion.workspace=true').version, null)
  assert.equal(coordinatesFrom("pyproject.toml", '[tool.poetry]\nname="old"\nversion="9"\n[project]\nname="new"\ndynamic=["version"]').version, null)
  assert.equal(coordinatesFrom("pyproject.toml", '[tool.poetry]\nname="legacy"\nversion="1.2.3"').name, "legacy")
  for (const header of ["[ project ]", '[ "project" ]', "[ 'project' ]"]) {
    assert.equal(coordinatesFrom("pyproject.toml", '[tool.poetry]\nname="legacy"\nversion="9"\n' + header + '\nname="current"\nversion="1.2.3"').name, "current")
  }
  assert.equal(coordinatesFrom("pyproject.toml", '[project]\nname="a"\nname="b"\nversion="1"').name, null)
  assert.equal(coordinatesFrom("pyproject.toml", '[tool.other]\nname="wrong"\nversion="1"').name, null)
})

test("cache identity binds repository revision, manifest, coordinates, content and scanner", () => {
  const a = manifestCacheKey("a/b", "package.json", { defaultBranch: "main", pushedAt: "first" })
  for (const key of [manifestCacheKey("a/b", "other/package.json", { defaultBranch: "main", pushedAt: "first" }), manifestCacheKey("a/b", "package.json", { defaultBranch: "main", pushedAt: "second" })]) assert.notEqual(a, key)
  const c = { registry: "npm", name: "pkg", version: "1.0.0", digest: "old" }
  for (const patch of [{ version: "2.0.0" }, { digest: "new" }, { registry: "pypi" }, { cacheKey: "new-reader" }]) assert.notEqual(auditCacheKey(c), auditCacheKey({ ...c, ...patch }))
  const now = Date.now()
  const entry = { cacheKey: a, observedAt: new Date(now).toISOString() }
  assert.equal(reusable(entry, a, "observedAt", now), true)
  assert.equal(reusable(entry, "different-scanner", "observedAt", now), false)
  assert.equal(reusable(entry, a, "observedAt", now + 86400000), false)
  assert.equal(reusable(entry, a, "observedAt", now - 1), false)
  assert.equal(reusable({ cacheKey: a }, a, "observedAt", now), false)
})

test("manifest CLI re-reads changed inputs and preserves observation time on a cache hit", () => {
  const dir = scratchDir("ag-trust-cache-")
  const classification = join(dir, "classification.json"), census = join(dir, "census.json"), out = join(dir, "out.json")
  writeFileSync(classification, JSON.stringify({ results: { "a/b": { manifest: "package.json" } } }))
  writeFileSync(census, JSON.stringify({ repos: [{ fullName: "a/b", defaultBranch: "main", pushedAt: "old" }] }))
  const exec = version => {
    const mock = 'globalThis.fetch = async () => ({status:200,text:async()=>JSON.stringify({name:"pkg",version:' + JSON.stringify(version) + '})})'
    return spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(mock), join(ROOT, "packages/collect/scripts/fetch-manifests.mjs"), "--classification", classification, "--census", census, "--out", out, "--rate", "100000"], { encoding: "utf8", timeout: 15000 })
  }
  assert.equal(exec("1.0.0").status, 0)
  const first = JSON.parse(readFileSync(out)).results["a/b"]
  const cached = exec("2.0.0")
  assert.equal(cached.status, 0, cached.stderr)
  assert.match(cached.stdout, /"toFetch":0/)
  assert.equal(JSON.parse(readFileSync(out)).results["a/b"].observedAt, first.observedAt)
  writeFileSync(census, JSON.stringify({ repos: [{ fullName: "a/b", defaultBranch: "main", pushedAt: "new" }] }))
  const changed = exec("2.0.0")
  assert.equal(changed.status, 0, changed.stderr)
  assert.match(changed.stdout, /"toFetch":1/)
  assert.equal(JSON.parse(readFileSync(out)).results["a/b"].version, "2.0.0")
})

test("package audit CLI invalidates an old version, digest and scanner cache", () => {
  const dir = scratchDir("ag-trust-audit-cache-")
  const input = join(dir, "coordinates.json"), out = join(dir, "audit.json")
  const coords = { status: "read", registry: "npm", name: "pkg", version: "1.0.0", manifest: "package.json", digest: "first" }
  const save = () => writeFileSync(input, JSON.stringify({ results: { "a/b": coords } }))
  const mock = 'globalThis.fetch=async()=>({status:200,url:"https://registry.npmjs.org/pkg",text:async()=>JSON.stringify({name:"pkg",versions:{"1.0.0":{name:"pkg",version:"1.0.0"},"2.0.0":{name:"pkg",version:"2.0.0"}},"dist-tags":{latest:"2.0.0"}})})'
  const execute = () => spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(mock), join(ROOT, "packages/collect/scripts/audit-packages.mjs"), "--coordinates", input, "--out", out, "--rate", "100000"], { encoding: "utf8", timeout: 15000 })
  save()
  assert.equal(execute().status, 0)
  const first = JSON.parse(readFileSync(out)).results["a/b"]
  assert.equal(first.status, "audited")
  assert.match(execute().stdout, /"toAudit":0/)
  assert.equal(JSON.parse(readFileSync(out)).results["a/b"].auditedAt, first.auditedAt)
  coords.version = "2.0.0"; save()
  assert.match(execute().stdout, /"toAudit":1/)
  assert.equal(JSON.parse(readFileSync(out)).results["a/b"].version, "2.0.0")
  coords.digest = "changed-content"; save()
  assert.match(execute().stdout, /"toAudit":1/)
  const saved = JSON.parse(readFileSync(out)); saved.results["a/b"].cacheKey = "old-scanner"
  writeFileSync(out, JSON.stringify(saved))
  assert.match(execute().stdout, /"toAudit":1/)
  coords.status = "unreadable"; save()
  assert.equal(execute().status, 0)
  assert.equal(JSON.parse(readFileSync(out)).results["a/b"].status, "not-audited")
})

test("discovery retains alias conflicts and round-trips PyPI without turning it into npm", () => {
  const files = { "/work/a/.mcp.json": JSON.stringify({ mcpServers: { files: { command: "uvx", args: ["tool-a==1.2.3"] } } }), "/work/b/.mcp.json": JSON.stringify({ mcpServers: { files: { command: "npx", args: ["tool-b@2.0.0"] } } }) }
  const d = discover({ home: null, roots: ["/work/a", "/work/b"], platform: "linux", exists: p => Object.hasOwn(files, p), readFile: p => files[p] })
  assert.equal(d.servers.length, 2)
  assert.equal(d.incomplete, true)
  assert.deepEqual(d.conflicts, ["files"])
  for (const serialized of [renderText(d), renderInventory(d)]) {
    const entries = parseInventory(serialized)
    assert.equal(entries.find(e => e.package === "tool-a").registry, "pypi")
    assert.equal(entries.find(e => e.package === "tool-b").version, "2.0.0")
  }
})

test("inventory to watch detects same-count risk changes and preserves a verifiable chain", () => {
  const dir = scratchDir("ag-trust-watch-")
  const entries = parseInventory("npm:trust-fixture@1.0.0")
  const r = record(), index = { generatedAt: new Date().toISOString(), scanner: "fixture", records: [r] }
  r.evidence.packageManifest.findings = [{ rule: "LOW", severity: "low", message: "private fixture" }]
  const first = appendWatch(dir, { entries, report: createInventoryReport(entries, index) })
  r.evidence.packageManifest.findings = [{ rule: "CRITICAL", severity: "critical", message: "private fixture" }]
  const second = appendWatch(dir, { entries, report: createInventoryReport(entries, index) })
  assert.notEqual(first.entry.reportDigest, second.entry.reportDigest)
  assert.equal(second.diff.changed.length, 1)
  assert.equal(verifyWatch(dir).ok, true)
  assert.doesNotMatch(readFileSync(join(dir, second.entry.snapshot), "utf8"), /private fixture|CRITICAL/)
})

test("the customer journey keeps evidence identity through discovery, policy, watch, pack and verification", () => {
  const dir = scratchDir("ag-trust-journey-")
  const config = JSON.stringify({ mcpServers: { fixture: { command: "npx", args: ["trust-fixture@1.0.0", "--token", "FAKE_PRIVATE_TOKEN"] } } })
  const discovered = discover({ home: null, roots: [dir], platform: "linux", exists: p => p === join(dir, ".mcp.json"), readFile: () => config })
  const input = join(dir, "tools.json"), indexPath = join(dir, "index.json"), policyPath = join(dir, "policy.json")
  const text = renderInventory(discovered)
  assert.doesNotMatch(text, /FAKE_PRIVATE_TOKEN/)
  writeFileSync(input, text)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "trust-fixture", version: "1.0.0" }))
  writeFileSync(policyPath, JSON.stringify({ required: { measuredEvidence: ["packageManifest"], scanners: ["packageManifest"] } }))
  const r = record(), index = { generatedAt: new Date().toISOString(), scanner: "journey-fixture", records: [r] }
  r.evidence.packageManifest.observedAt = index.generatedAt
  r.evidence.packageManifest.auditedAt = index.generatedAt
  r.evidence.packageManifest.scanner = "package-fixture"
  writeFileSync(indexPath, JSON.stringify(index))
  const checked = run("bin/agentgate.mjs", ["check", "--root", dir, "--policy", policyPath, "--index", indexPath, "--format", "json"])
  assert.equal(checked.status, 0, checked.stderr + checked.stdout)
  const entries = parseInventory(text), archive = join(dir, "archive")
  appendWatch(archive, { entries, report: createInventoryReport(entries, index) })
  r.evidence.packageManifest.findings = [{ rule: "changed-risk", severity: "critical", message: "fixture only" }]
  r.evidence.packageManifest.status = "findings"
  writeFileSync(indexPath, JSON.stringify(index))
  assert.equal(appendWatch(archive, { entries, report: createInventoryReport(entries, index) }).diff.changed.length, 1)
  const calls = join(dir, "calls.jsonl")
  const packArgs = ["pack", "--input", input, "--index", indexPath, "--archive", archive, "--calls", calls]
  writeFileSync(calls, JSON.stringify({ harmless: "not a decision" }) + "\n")
  const missingOut = join(dir, "pack-missing-calls")
  // The current questionnaire does not claim gateway decisions as an owned answer;
  // the class must remain unmeasured, while the overall exit still reports the critical risk.
  assert.equal(run("bin/agentgate.mjs", [...packArgs, "--out", missingOut]).status, 1)
  const missing = JSON.parse(readFileSync(join(missingOut, "pack.json")))
  assert.equal(missing.evidenceClasses.find(c => c.id === "gateway-decisions").state, "unmeasured")
  writeFileSync(calls, JSON.stringify({ at: index.generatedAt, direction: "client", method: "tools/call", tool: "fixture-read", decision: "allowed" }) + "\n")
  const out = join(dir, "pack")
  const packed = run("bin/agentgate.mjs", [...packArgs, "--out", out])
  assert.equal(packed.status, 1, packed.stderr + packed.stdout)
  const pack = JSON.parse(readFileSync(join(out, "pack.json")))
  assert.equal(pack.evidenceClasses.find(c => c.id === "content-digest").state, "measured")
  assert.equal(pack.items[0].evidence[0].observedAt, index.generatedAt)
  assert.equal(pack.items[0].evidence[0].scanner, "package-fixture")
  assert.equal(run("bin/agentgate.mjs", ["pack", "--verify", out]).status, 0)
  writeFileSync(join(out, "pack.json"), "{}")
  assert.equal(run("bin/agentgate.mjs", ["pack", "--verify", out]).status, 1)
})

test("watch detects evidence/scanner changes but ignores observation-only time changes", () => {
  const r = record(), entries = parseInventory("trust-fixture@1.0.0")
  const index = { generatedAt: new Date().toISOString(), scanner: "first", records: [r] }
  const before = projectionOf(createInventoryReport(entries, index))
  r.evidence.packageManifest.auditedAt = new Date().toISOString()
  assert.deepEqual(diffProjections(before, projectionOf(createInventoryReport(entries, index))).changed, [])
  r.evidence.packageManifest.provenance.content.digest = "b".repeat(64)
  assert.equal(diffProjections(before, projectionOf(createInventoryReport(entries, index))).changed.length, 1)
  index.scanner = "second"
  assert.notDeepEqual(before, projectionOf(createInventoryReport(entries, index)))
})

test("watch preserves distinct registries and detects a changed member of a multi-version group", () => {
  const item = (registry, version, severity) => ({ input: { package: "tool", registry, version }, findings: [{ rule: "R", severity }] })
  const before = projectionOf({ items: [item("npm", "1.0.0", "low"), item("npm", "2.0.0", "low"), item("pypi", "1.0.0", "low")] })
  const after = projectionOf({ items: [item("npm", "1.0.0", "critical"), item("npm", "2.0.0", "low"), item("pypi", "1.0.0", "low")] })
  assert.equal(diffProjections(before, after).changed.length, 1)
  const reversed = projectionOf({ items: [item("pypi", "1.0.0", "low"), item("npm", "2.0.0", "low"), item("npm", "1.0.0", "low")] })
  assert.deepEqual(before, reversed)
})

test("PyPI yanking is decided by declared-version files, including partial yanks", () => {
  const server = { packages: [{ registryType: "pypi", identifier: "pkg", version: "1.0.0" }] }
  for (const [latestYanked, fileYanked, expected] of [[true, false, false], [false, true, true]]) {
    const doc = { info: { version: "2.0.0", yanked: latestYanked }, releases: { "1.0.0": [{ packagetype: "bdist_wheel", yanked: fileYanked }] } }
    assert.equal(auditPypiPackage(server, doc).some(f => f.rule === "package-yanked"), expected)
  }
  const findings = auditPypiPackage(server, { info: {}, releases: { "1.0.0": [{ yanked: true }, { yanked: false }] } })
  assert.match(findings.find(f => f.rule === "package-yanked").evidence, /some files/)
})

test("hook script findings stay associated with the hook that invokes them", () => {
  const server = { packages: [{ registryType: "npm", identifier: "pkg", version: "1.0.0" }] }
  const doc = { name: "pkg", versions: { "1.0.0": { name: "pkg", version: "1.0.0", scripts: { preinstall: "echo hello", postinstall: "node install.js" } } } }
  const findings = auditPackage(server, doc, {}, {}, { "install.js": "hook-script-not-published" })
  const missing = findings.filter(f => f.rule === "install-hook-script-missing-from-package")
  assert.equal(missing.length, 1)
  assert.match(missing[0].evidence, /postinstall/)
})

test("empty execution, archives and parseable non-decisions do not become measured evidence", () => {
  const execution = buildScanExecution({ subject: { server: "a" }, components: [] })
  execution.scanner_execution.state = "complete"
  assert.equal(validateScanExecution(execution).ok, false)
  assert.equal(canBeClean(execution), false)
  const item = { id: "tool-1", selected: {}, evidence: [] }
  for (const calls of [{ provided: true, parsed: true, count: 0 }, { provided: true, parsed: true, count: 2, decisionCount: 0 }]) {
    const classes = evaluateClasses([item], { archive: { present: true, verified: true, entries: [] }, calls })
    assert.equal(classes.find(c => c.id === "archive-integrity").state, "unmeasured")
    assert.equal(classes.find(c => c.id === "gateway-decisions").state, "unmeasured")
  }
  assert.equal(evaluateClasses([item], { calls: { provided: true, parsed: true, decisionCount: 1 } }).find(c => c.id === "gateway-decisions").state, "measured")
})

test("proxy diagnostics omit secret-bearing command arguments", () => {
  const dir = scratchDir("ag-trust-secret-")
  const path = join(dir, "policy.json")
  writeFileSync(path, "{}")
  const secret = "AUDIT_FAKE_SECRET_DO_NOT_USE"
  const result = run("bin/agentgate.mjs", ["proxy", "--policy", path, "--log", join(dir, "calls.jsonl"), "--", process.execPath, "-e", "process.exit(0)", "--", secret])
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, new RegExp(secret))
})

test("refresh help never starts a collection", () => {
  const result = run("bin/agentgate.mjs", ["refresh", "--help"])
  assert.equal(result.status, 0)
  assert.doesNotMatch(result.stderr, /\[refresh\]/)
  assert.match(result.stdout, /agentgate <command>/)
})

test("Pages build supports a subpath and labels samples without a mismatched live diff", () => {
  const dir = scratchDir("ag-trust-site-")
  const diff = join(dir, "diff.md")
  writeFileSync(diff, "UNRELATED LIVE DIFF")
  const result = run("scripts/build-site.mjs", ["--index", "data/sample-index.json", "--out", dir, "--base-path", "/agentgate", "--diff", diff])
  assert.equal(result.status, 0, result.stderr)
  const html = readFileSync(join(dir, "evidence.html"), "utf8")
  assert.match(html, /历史样本：只供演示/)
  assert.doesNotMatch(html, /UNRELATED LIVE DIFF/)
  assert.match(html, /href="pack\/pack.html"/)
  assert.doesNotMatch(html, /href=\\"\/s\//)
  assert.match(readFileSync(join(dir, "history.html"), "utf8"), /href="\/agentgate\/"/)
  assert.ok(existsSync(join(dir, "pack", "pack.html")))
})

test("live diff renders only when explicitly bound to the exact index bytes", () => {
  const dir = scratchDir("ag-trust-diff-")
  const indexPath = join(dir, "index.json"), diff = join(dir, "diff.md")
  const index = JSON.stringify({ generatedAt: new Date().toISOString(), records: [record()] })
  writeFileSync(indexPath, index)
  writeFileSync(diff, "BOUND DIFF")
  const args = ["--index", indexPath, "--out", dir, "--diff", diff]
  assert.equal(run("scripts/build-site.mjs", args).status, 0)
  assert.doesNotMatch(readFileSync(join(dir, "evidence.html"), "utf8"), /BOUND DIFF/)
  assert.equal(run("scripts/build-site.mjs", [...args, "--diff-index-sha256", createHash("sha256").update(index).digest("hex")]).status, 0)
  assert.match(readFileSync(join(dir, "evidence.html"), "utf8"), /BOUND DIFF/)
})
