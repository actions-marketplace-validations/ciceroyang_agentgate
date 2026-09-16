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

const VERDICT = { CLEAN: "clean", FINDINGS: "findings", INCOMPLETE: "incomplete" }
// Every severity a rule may emit has to be in here or in UNMEASURED. The scan lives in
// packages/collect/test/index.test.mjs, so a rule that invents a severity fails a test rather
// than quietly ranking as zero.
export const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }
/** Severities that mean "the check ran and could not determine the answer". */
export const UNMEASURED = ["unknown"]

export function deriveVerdict(blocks, threshold) {
  const values = Object.keys(blocks).map(function (k) { return blocks[k] })
  if (values.some(function (b) { return b.status === "unmeasured" })) return VERDICT.INCOMPLETE
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

export function buildIndex(options) {
  const census = asJson(options.census)
  const guard = asJson(options.guard)
  const repos = asJson(options.repos)
  if (!census) throw new Error("a census artifact is required")
  const threshold = options.threshold || "medium"

  const guardByPackage = new Map()
  for (const r of (guard && guard.results) || []) guardByPackage.set(r.package, r)
  const repoBySlug = new Map()
  for (const r of (repos && repos.results) || []) {
    const slug = r.slug.toLowerCase()
    repoBySlug.set(slug, r)
    repoBySlug.set(slug.split("/").pop(), r)
  }

  const records = []
  const skipped = []
  for (const row of census.rows || []) {
    if (!row || typeof row !== "object" || typeof row.server !== "string") { skipped.push("a row without a server name"); continue }
    const blocks = {}
    blocks.registryDocument = {
      status: (row.findings || []).length > 0 ? "findings" : "clean",
      source: "mcp-census",
      findings: (row.findings || []).map(function (f) { return { rule: f.rule, severity: f.severity, evidence: f.evidence } }),
    }
    if (row.package && row.registryType === "npm") {
      const pkg = guardByPackage.get(row.package)
      if (pkg) {
        blocks.packageManifest = {
          status: pkg.status === "metadata-unavailable" ? "unmeasured" : (pkg.findings || []).length > 0 ? "findings" : "clean",
          source: "guard-scan",
          reason: pkg.status === "metadata-unavailable" ? "metadata-unavailable" : null,
          findings: (pkg.findings || []).map(function (f) { return { rule: f.rule, severity: f.severity, file: f.file, message: f.message } }),
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
        blocks.repository = {
          status: repo.status === "clean" || repo.status === "findings" ? repo.status : "unmeasured",
          source: "scan-repos",
          reason: repo.status === "fetch-failed" ? "fetch-failed" : null,
          findings: (repo.findings || []).map(function (f) { return { rule: f.rule, severity: f.severity, file: f.file, message: f.message } }),
        }
      }
    }
    records.push({
      server: row.server,
      title: row.title || null,
      repository: row.repository || null,
      packages: row.package ? [{ registry: row.registryType || "npm", name: row.package, version: row.version || null }] : [],
      evidence: blocks,
      verdict: deriveVerdict(blocks, threshold),
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
