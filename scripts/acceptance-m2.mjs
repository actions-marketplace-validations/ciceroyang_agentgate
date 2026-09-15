#!/usr/bin/env node
/**
 * M2 acceptance. Three things must hold, and the third is the one that matters most:
 *
 *   1. a repository that breaks the policy fails
 *   2. a repository that satisfies it passes
 *   3. an artefact nobody could measure exits 2, never 0
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadPolicy, normalizePolicy } from "../packages/policy/src/policy.mjs"
import { evaluate, exitCodeFor } from "../packages/policy/src/evaluate.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
let failures = 0
const check = function (name, ok, detail) {
  if (ok) { console.log("ok    " + name); return }
  failures += 1
  console.log("FAIL  " + name + (detail ? "  -> " + detail : ""))
}

// 1. a repository that breaks the policy fails, and the CLI agrees about the exit code
const bad = mkdtempSync(join(tmpdir(), "ag-m2-bad-"))
writeFileSync(join(bad, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "pkg"] } } }))
writeFileSync(join(bad, "agentgate.policy.json"), JSON.stringify({ version: "agentgate.policy/v1", threshold: "high", forbidden: { rules: ["AG-MCP-010"] } }))
const badRun = spawnSync(process.execPath, [join(ROOT, "bin", "agentgate.mjs"), "check", "--root", bad], { encoding: "utf8" })
check("a forbidden rule fails the check (exit 1)", badRun.status === 1, "exit " + badRun.status)
check("and the report says why", /forbidden by policy/.test(badRun.stdout || ""), (badRun.stdout || "").slice(0, 120))

// 2. the same repository passes when the policy does not refuse it
const okDir = mkdtempSync(join(tmpdir(), "ag-m2-ok-"))
writeFileSync(join(okDir, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "/usr/local/bin/node", args: ["/opt/server/index.js", "/home/me/projects"] } } }))
writeFileSync(join(okDir, "agentgate.policy.json"), JSON.stringify({ version: "agentgate.policy/v1", threshold: "high" }))
const okRun = spawnSync(process.execPath, [join(ROOT, "bin", "agentgate.mjs"), "check", "--root", okDir], { encoding: "utf8" })
check("a compliant repository passes (exit 0)", okRun.status === 0, "exit " + okRun.status + " " + (okRun.stdout || "").slice(0, 120))

// 3. unmeasured evidence is incomplete, at every threshold
const policy = normalizePolicy({ threshold: "info", required: { measuredEvidence: ["packageManifest"] } })
const records = [{ server: "a/b", packages: [], evidence: { packageManifest: { status: "unmeasured", reason: "metadata-unavailable" } } }]
const result = evaluate({ policy: policy, records: records })
check("unmeasured evidence is incomplete", result.verdict === "incomplete", result.verdict)
check("and exits 2 rather than 0", exitCodeFor(result) === 2, String(exitCodeFor(result)))

// 3b. the same record with a measured block is clean, so the rule is not just always-fail
const measured = normalizePolicy({ threshold: "info", required: { measuredEvidence: ["packageManifest"] } })
const cleanResult = evaluate({ policy: measured, records: [{ server: "a/b", packages: [], evidence: { packageManifest: { status: "clean", findings: [] } } }] })
check("a measured block lets the same policy pass", cleanResult.verdict === "clean", cleanResult.verdict)

console.log("")
console.log(failures === 0 ? "M2 acceptance: green" : "M2 acceptance: " + failures + " failure(s)")
process.exit(failures === 0 ? 0 : 1)
