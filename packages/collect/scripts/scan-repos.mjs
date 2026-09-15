#!/usr/bin/env node
/**
 * Point the scanner at the repositories the census resolved.
 *
 * Read-only: each repository is fetched as a tarball, extracted into a throwaway
 * directory, scanned, and deleted. Nothing is installed and nothing is executed.
 * Per-repository detail stays in the JSON so a finding can be checked by hand;
 * the Markdown summary is aggregate only, because naming a project is a
 * disclosure decision and not one this script should make on its own.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

function parse(argv) {
  const args = { census: null, max: 40, out: null, summary: null, work: "/tmp/reposcan", concurrency: 4, minSeverity: "medium" }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--census") args.census = argv[++i]
    else if (a === "--max") args.max = Number(argv[++i])
    else if (a === "--out") args.out = argv[++i]
    else if (a === "--summary") args.summary = argv[++i]
    else if (a === "--work") args.work = argv[++i]
    else if (a === "--concurrency") args.concurrency = Number(argv[++i])
    else if (a === "--min-severity") args.minSeverity = argv[++i]
    else { console.error("unknown option " + a); process.exit(2) }
  }
  if (!args.census) { console.error("--census <census.json> is required"); process.exit(2) }
  return args
}

const args = parse(process.argv.slice(2))
const agentGuardRoot = resolve(process.env.AGENT_GUARD || resolve(HERE, "..", "..", "guard"))
const guard = await import(pathToFileURL(join(agentGuardRoot, "src", "checks", "index.mjs")).href)
const engine = await import(pathToFileURL(join(agentGuardRoot, "src", "engine.mjs")).href)
const fsScan = await import(pathToFileURL(join(agentGuardRoot, "src", "fs-scan.mjs")).href)

function reposFromCensus(path) {
  const census = JSON.parse(readFileSync(path, "utf8"))
  const seen = new Map()
  for (const row of census.rows || []) {
    const url = row.repository
    if (!url || typeof url !== "string") continue
    const m = /^https?:\/\/github\.com\/([^\/]+)\/([^\/#?]+)/.exec(url)
    if (!m) continue
    const slug = m[1] + "/" + m[2].replace(/\.git$/, "")
    seen.set(slug, (seen.get(slug) || 0) + 1)
  }
  return Array.from(seen.entries())
    .sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]) })
    .map(function (e) { return { slug: e[0], servers: e[1] } })
}

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()
const work = resolve(args.work)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const corpus = resolve(HERE, "..", "..", "guard", "bin", "agent-guard.mjs")

function scanOne(job) {
  const dir = join(work, job.slug.replace("/", "__"))
  mkdirSync(dir, { recursive: true })
  const tar = dir + ".tar.gz"
  try {
    execFileSync("curl", ["-sLf", "-H", "Authorization: token " + token,
      "https://api.github.com/repos/" + job.slug + "/tarball/HEAD", "-o", tar], { timeout: 90000 })
    if (!existsSync(tar) || readFileSync(tar).length < 1024) { rmSync(tar, { force: true }); return { slug: job.slug, status: "fetch-failed" } }
    execFileSync("tar", ["xzf", tar, "-C", dir, "--strip-components=1"], { timeout: 90000 })
  } catch (error) {
    rmSync(tar, { force: true })
    rmSync(dir, { recursive: true, force: true })
    return { slug: job.slug, status: "fetch-failed" }
  }
  let result
  try {
    result = engine.runScan({ root: dir, checks: guard.ALL_CHECKS, readText: fsScan.makeReader(), exclude: ["node_modules", "vendor"] })
  } catch (error) {
    return { slug: job.slug, status: "scan-failed", error: String(error && error.message || error) }
  }
  const findings = result.findings.map(function (f) { return { rule: f.rule, severity: f.severity, file: f.file, line: f.line, message: f.message } })
  rmSync(dir, { recursive: true, force: true })
  rmSync(tar, { force: true })
  return { slug: job.slug, status: result.verdict, findings: findings }
}

const all = reposFromCensus(args.census).slice(0, args.max)
const results = []
let cursor = 0
function worker() {
  while (cursor < all.length) {
    const job = all[cursor]
    cursor += 1
    results.push(scanOne(job))
    process.stderr.write(".")
  }
}
await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker))
process.stderr.write("\n")

const rank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }
const min = rank[args.minSeverity] || 0
const byRule = {}
const byRepo = {}
const statuses = {}
for (const r of results) {
  statuses[r.status] = (statuses[r.status] || 0) + 1
  if (!r.findings) continue
  const notable = r.findings.filter(function (f) { return (rank[f.severity] || 0) >= min })
  if (notable.length > 0) byRepo[r.slug] = notable
  for (const f of notable) {
    byRule[f.rule] = byRule[f.rule] || { severity: f.severity, repos: 0, example: null }
    byRule[f.rule].repos += 1
    if (!byRule[f.rule].example) byRule[f.rule].example = { slug: r.slug, file: f.file, message: f.message }
  }
}
const payload = { generatedAt: new Date().toISOString(), minSeverity: args.minSeverity, requested: all.length, statuses: statuses, byRule: byRule, byRepo: byRepo, results: results }
if (args.out) writeFileSync(args.out, JSON.stringify(payload, null, 2) + "\n")

const lines = []
lines.push("# The scanned repositories")
lines.push("")
lines.push("The census resolves every server to a repository where one is declared. This run fetches the top " + all.length + " by number of registry entries, scans each in a throwaway directory, and deletes it. Read-only; nothing is installed or executed.")
lines.push("")
lines.push("- repositories requested: **" + all.length + "**")
lines.push("- outcome: " + Object.keys(statuses).sort().map(function (k) { return k + " **" + statuses[k] + "**" }).join(", "))
lines.push("- repositories with a finding at `" + args.minSeverity + "` or above: **" + Object.keys(byRepo).length + "**")
lines.push("")
lines.push("## Rules, by how many repositories they hit")
lines.push("")
lines.push("| rule | severity | repositories | example |")
lines.push("| --- | --- | --- | --- |")
for (const rule of Object.keys(byRule).sort(function (a, b) { return byRule[b].repos - byRule[a].repos })) {
  const x = byRule[rule]
  lines.push("| " + rule + " | " + x.severity + " | " + x.repos + " | " + x.example.file + ": " + String(x.example.message).slice(0, 80) + " |")
}
lines.push("")
lines.push("Repository names are deliberately not listed here. A finding may be a genuine weakness in someone else's project, and naming it is a disclosure decision rather than a summary statistic. Per-repository detail is in the JSON for hand-checking.")
lines.push("")
if (args.summary) writeFileSync(args.summary, lines.join("\n"))
else process.stdout.write(lines.join("\n"))
console.error("scan-repos: " + all.length + " | " + JSON.stringify(statuses) + " | repos with findings " + Object.keys(byRepo).length)
