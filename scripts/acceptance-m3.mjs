#!/usr/bin/env node
/**
 * M3 acceptance. The parts that can be checked here: a policy result reaches SARIF, a
 * failed or unmeasured result reaches SARIF as an error rather than a silence, and the
 * index diff names the changes that a version move would not explain.
 *
 * What cannot be checked here is GitHub itself running the action. The workflow and the
 * action are YAML-validated in CI for that reason, and the action is only ever a thin
 * wrapper around the commands verified below.
 */
import { writeFileSync, readFileSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { toSarif } from "../packages/policy/src/sarif.mjs"
import { diffIndex } from "../packages/history/src/diff.mjs"
import { scratchDir } from "./scratch-dir.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
let failures = 0
const check = function (name, ok, detail) {
  if (ok) { console.log("ok    " + name); return }
  failures += 1
  console.log("FAIL  " + name + (detail ? "  -> " + detail : ""))
}

const sarif = JSON.parse(toSarif({
  findings: [{ rule: "AG-MCP-010", severity: "medium", file: ".mcp.json", message: "m", reason: "at or above the policy threshold high" }],
  coverage: { checksFailed: [], evidenceMissing: [{ server: "a/b", block: "packageManifest", reason: "metadata-unavailable" }] },
}, { version: "0.1.0" }))
const ids = sarif.runs[0].results.map(function (r) { return r.ruleId })
check("a finding reaches SARIF", ids.indexOf("AG-MCP-010") !== -1, JSON.stringify(ids))
check("an unmeasured block reaches SARIF", ids.indexOf("POLICY-UNMEASURED") !== -1, JSON.stringify(ids))
const unmeasured = sarif.runs[0].results.filter(function (r) { return r.ruleId === "POLICY-UNMEASURED" })[0]
check("and it is an error, not a note", unmeasured.level === "error", unmeasured.level)

// the CLI writes the same SARIF when asked
const dir = scratchDir("ag-m3-")
writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "pkg"] } } }))
writeFileSync(join(dir, "agentgate.policy.json"), JSON.stringify({ version: "agentgate.policy/v1", forbidden: { rules: ["AG-MCP-010"] } }))
const run = spawnSync(process.execPath, [join(ROOT, "bin", "agentgate.mjs"), "check", "--root", dir, "--format", "sarif", "--out", join(dir, "out.sarif")], { encoding: "utf8" })
check("the check exits 1 on a forbidden rule", run.status === 1, "exit " + run.status)
let cliSarif = null
try { cliSarif = JSON.parse(readFileSync(join(dir, "out.sarif"), "utf8")) } catch (error) { /* reported below */ }
check("the CLI wrote a parseable SARIF file", cliSarif !== null && cliSarif.runs[0].results.length === 1, cliSarif ? String(cliSarif.runs[0].results.length) : "no file")

// the silent-change category
const before = { generatedAt: "T1", count: 1, records: [{ server: "a/one", verdict: "clean", packages: [{ name: "pkg", version: "1.0.0" }], evidence: { registryDocument: { status: "clean", findings: [] } } }] }
const after = { generatedAt: "T2", count: 1, records: [{ server: "a/one", verdict: "findings", packages: [{ name: "pkg", version: "1.0.0" }], evidence: { registryDocument: { status: "findings", findings: [{ rule: "r", severity: "high" }] } } }] }
const d = diffIndex(before, after)
check("a change with no version move is named", d.silent.length === 1, JSON.stringify(d.silent))
check("and it is not counted as a package change", d.packageChanged.length === 0)

console.log("")
console.log(failures === 0 ? "M3 acceptance: green" : "M3 acceptance: " + failures + " failure(s)")
process.exit(failures === 0 ? 0 : 1)
