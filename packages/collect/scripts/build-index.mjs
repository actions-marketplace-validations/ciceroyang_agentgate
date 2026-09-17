#!/usr/bin/env node
/**
 * Join the evidence pipelines into the trust index.
 *
 * This script does not scan anything. It reads the artifacts the pipelines publish
 * and assembles one record per server, with the verdict derived from the statuses
 * rather than asserted: an artifact with an unmeasured part is incomplete, never
 * clean.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { canBeClean, executionFromBlocks } from "../src/execution.mjs"

const VERDICT = { CLEAN: "clean", FINDINGS: "findings", INCOMPLETE: "incomplete" }
// Every severity a rule may emit has to be in here or in UNMEASURED. The scan lives in
// packages/collect/test/index.test.mjs, so a rule that invents a severity fails a test rather
// than quietly ranking as zero.
export const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }
/** Severities that mean "the check ran and could not determine the answer". */
export const UNMEASURED = ["unknown"]

export function deriveVerdict(blocks, threshold) {
  const values = Object.keys(blocks).map(function (k) { return blocks[k] })
  // Only known, completed states can support a verdict. New failure states must not
  // silently acquire the meaning of "clean" just because their findings are empty.
  if (values.length === 0 || values.some(function (b) {
    return !b || (b.status !== "clean" && b.status !== "findings") || !Array.isArray(b.findings)
      || (b.status === "findings" && b.findings.length === 0)
  })) return VERDICT.INCOMPLETE
  // "unknown" and any severity this code does not recognise mean the same thing: we cannot call
  // the record clean, because we do not know what the finding says. RANK has no entry for
  // either, and ranking an unrankable severity as 0 is how thirty-two records whose only finding
  // was "could not determine" were published as clean. Anything unranked is treated as
  // unmeasured rather than as information.
  const unranked = values.some(function (b) {
    return (b.findings || []).some(function (f) {
      return UNMEASURED.indexOf(f.severity) !== -1 || !Object.prototype.hasOwnProperty.call(RANK, f.severity)
    })
  })
  if (unranked) return VERDICT.INCOMPLETE
  const min = RANK[threshold] === undefined ? 2 : RANK[threshold]
  const notable = values.some(function (b) {
    return (b.findings || []).some(function (f) { return (RANK[f.severity] || 0) >= min })
  })
  return notable ? VERDICT.FINDINGS : VERDICT.CLEAN
}

/** Accept an already-parsed artifact or a path to one. */
function asJson(value) {
  if (!value) return null
  if (typeof value === "object") return value
  if (!existsSync(value)) return null
  try { return JSON.parse(readFileSync(value, "utf8")) } catch (error) { return null }
}

// A result belongs to the exact server/package/version that was scanned, not to
// every registration that happens to name the same package.
function packageKey(row) {
  if (!row || ![row.server, row.package, row.version].every(function (v) { return typeof v === "string" && v.length > 0 })) return null
  return JSON.stringify([row.server, row.package, row.version])
}

export function buildIndex(options) {
  const census = asJson(options.census)
  const guard = asJson(options.guard)
  const repos = asJson(options.repos)
  if (!census) throw new Error("a census artifact is required")
  const threshold = options.threshold || "medium"

  const guardByPackage = new Map()
  for (const r of (guard && guard.results) || []) {
    const key = packageKey(r)
    if (!key) continue
    // Ambiguous duplicate input cannot establish which result is authoritative.
    guardByPackage.set(key, guardByPackage.has(key)
      ? { status: "duplicate-results", findings: [] }
      : r)
  }
  const repoBySlug = new Map()
  for (const r of (repos && repos.results) || []) {
    if (!r || typeof r.slug !== "string") continue
    const slug = r.slug.toLowerCase()
    repoBySlug.set(slug, repoBySlug.has(slug)
      ? { status: "duplicate-results", findings: [] }
      : r)
  }

  const records = []
  const skipped = []
  for (const row of census.rows || []) {
    if (!row || typeof row !== "object" || typeof row.server !== "string") { skipped.push("a row without a server name"); continue }
    const blocks = {}
    blocks.registryDocument = {
      status: row.audited === false ? "unmeasured" : (row.findings || []).length > 0 ? "findings" : "clean",
      source: "mcp-census",
      reason: row.audited === false ? "not-audited" : null,
      findings: (row.findings || []).map(function (f) { return { rule: f.rule, severity: f.severity, evidence: f.evidence } }),
      provenance: row.provenance || null,
    }
    if (row.package && row.registryType === "npm") {
      const pkg = guardByPackage.get(packageKey(row))
      if (pkg) {
        const knownStatus = pkg.status === "clean" || pkg.status === "findings"
        const validFindings = Array.isArray(pkg.findings) && (pkg.status !== "findings" || pkg.findings.length > 0)
        const complete = knownStatus && validFindings
        blocks.packageManifest = {
          status: !complete ? "unmeasured" : pkg.findings.length > 0 ? "findings" : "clean",
          source: "guard-scan",
          reason: !knownStatus ? (typeof pkg.status === "string" && pkg.status || "missing-status") : !validFindings ? "invalid-findings" : null,
          error: typeof pkg.error === "string" ? pkg.error : null,
          findings: (Array.isArray(pkg.findings) ? pkg.findings : []).map(function (f) { return { rule: f.rule, severity: f.severity, file: f.file, message: f.message } }),
          provenance: pkg.provenance || null,
        }
      } else {
        blocks.packageManifest = { status: "unmeasured", source: "guard-scan", reason: "not-in-run", findings: [] }
      }
    }
    if (row.repository && typeof row.repository === "string") {
      const m = /^https?:\/\/github\.com\/([^\/]+)\/([^\/#?]+)/.exec(row.repository)
      const slug = m ? (m[1] + "/" + m[2].replace(/\.git$/, "")).toLowerCase() : null
      const repo = slug ? repoBySlug.get(slug) : null
      if (repo) {
        const knownStatus = repo.status === "clean" || repo.status === "findings"
        const validFindings = Array.isArray(repo.findings) && (repo.status !== "findings" || repo.findings.length > 0)
        blocks.repository = {
          status: !knownStatus || !validFindings ? "unmeasured" : repo.findings.length > 0 ? "findings" : "clean",
          source: "scan-repos",
          reason: !knownStatus ? (typeof repo.status === "string" && repo.status || "missing-status") : !validFindings ? "invalid-findings" : null,
          findings: (Array.isArray(repo.findings) ? repo.findings : []).map(function (f) { return { rule: f.rule, severity: f.severity, file: f.file, message: f.message } }),
        }
      } else if (options.repos) {
        // Repository scanning is optional. Once requested, however, missing or
        // truncated results are missing coverage, not permission to omit the block.
        blocks.repository = { status: "unmeasured", source: "scan-repos", reason: slug ? "not-in-run" : "unsupported-repository", findings: [] }
      }
    }
    const packages = row.package ? [{ registry: row.registryType || "npm", name: row.package, version: row.version || null }] : []
    const execution = executionFromBlocks({
      server: row.server,
      packages: packages,
      blocks: blocks,
      generatedAt: options.generatedAt,
    })
    records.push({
      server: row.server,
      title: row.title || null,
      repository: row.repository || null,
      packages: packages,
      evidence: blocks,
      // The execution record says which scanners were required and which finished. If any of them
      // did not, the verdict is incomplete however clean the findings look: a verdict of clean is
      // a claim about work that ran, and this is where that claim is held to account.
      verdict: canBeClean(execution) ? deriveVerdict(blocks, threshold) : VERDICT.INCOMPLETE,
      scanExecution: execution,
      generatedAt: options.generatedAt || new Date().toISOString(),
    })
  }
  return {
    generatedAt: options.generatedAt || new Date().toISOString(),
    threshold: threshold,
    // Which build of the scanner produced this. A diff compares two snapshots, and without
    // this it cannot tell "their package changed" from "our rules changed" — so every rule fix
    // is reported as a silent change in someone else's package.
    scanner: options.scanner || null,
    count: records.length,
    skipped: skipped,
    records: records,
  }
}

function parse(argv) {
  const args = { census: null, guard: null, repos: null, out: null, threshold: "medium", scanner: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--census") args.census = argv[++i]
    else if (a === "--guard") args.guard = argv[++i]
    else if (a === "--repos") args.repos = argv[++i]
    else if (a === "--out") args.out = argv[++i]
    else if (a === "--threshold") args.threshold = argv[++i]
    else if (a === "--scanner") args.scanner = argv[++i]
    else { console.error("unknown option " + a); process.exit(2) }
  }
  if (!args.census) { console.error("--census <census.json> is required"); process.exit(2) }
  return args
}

const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href
if (isMain) {
  const args = parse(process.argv.slice(2))
  const index = buildIndex({ census: args.census, guard: args.guard, repos: args.repos, threshold: args.threshold, scanner: args.scanner })
  const counts = {}
  for (const r of index.records) counts[r.verdict] = (counts[r.verdict] || 0) + 1
  if (args.out) writeFileSync(args.out, JSON.stringify(index, null, 2) + "\n")
  else process.stdout.write(JSON.stringify(index, null, 2) + "\n")
  console.error("index: " + index.count + " records | " + JSON.stringify(counts))
}
