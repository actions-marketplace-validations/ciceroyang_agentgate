#!/usr/bin/env node
/**
 * Feed the census into agent-guard.
 *
 * The census enumerates the registry and reports per-server metadata findings.
 * It is deliberately shallow: registry documents, not package manifests. This
 * step takes the packages the census resolved, reads each published manifest
 * (read-only, from the npm registry), and runs agent-guard manifest checks over
 * it, so the catalogue supply-chain rules and the scanner share one implementation.
 *
 * Coverage is reported, never assumed: a manifest that could not be fetched is
 * counted as unmeasured, never as clean.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

function parse(argv) {
  const args = { census: null, out: null, summary: null, max: 0, concurrency: 8, agentGuard: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--census") args.census = argv[++i]
    else if (a === "--out") args.out = argv[++i]
    else if (a === "--summary") args.summary = argv[++i]
    else if (a === "--max") args.max = Number(argv[++i])
    else if (a === "--concurrency") args.concurrency = Number(argv[++i])
    else if (a === "--agent-guard") args.agentGuard = argv[++i]
    else { console.error("unknown option " + a); process.exit(2) }
  }
  if (!args.census) { console.error("--census <census.json> is required"); process.exit(2) }
  return args
}

const args = parse(process.argv.slice(2))
// resolve() first: a relative --agent-guard would otherwise become a file URL with a host.
const agentGuardRoot = resolve(args.agentGuard || process.env.AGENT_GUARD || resolve(HERE, "..", "..", "guard"))
let manifestFindings
try {
  const mod = await import(pathToFileURL(join(agentGuardRoot, "src", "api.mjs")).href)
  manifestFindings = mod.manifestFindings
} catch (error) {
  console.error("could not load agent-guard from " + agentGuardRoot + ": " + error.message)
  console.error("pass --agent-guard <path> or set AGENT_GUARD")
  process.exit(2)
}

const census = JSON.parse(readFileSync(args.census, "utf8"))
let rows = (census.rows || []).filter(function (r) { return r.registryType === "npm" && r.package && r.version })
if (args.max > 0) rows = rows.slice(0, args.max)

async function fetchManifest(name, version) {
  const url = "https://registry.npmjs.org/" + name.replace("/", "%2F") + "/" + version
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: "application/json" } })
      if (res.status === 200) return await res.json()
      if (res.status === 404) return null
    } catch (error) { /* retry */ }
    await new Promise(function (r) { setTimeout(r, 1500) })
  }
  return null
}

const results = []
let cursor = 0
async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor]
    cursor += 1
    const manifest = await fetchManifest(row.package, row.version)
    if (!manifest) {
      results.push({ server: row.server, package: row.package, version: row.version, status: "metadata-unavailable", findings: [] })
      continue
    }
    const text = JSON.stringify({
      scripts: manifest.scripts,
      dependencies: manifest.dependencies,
      devDependencies: manifest.devDependencies,
      optionalDependencies: manifest.optionalDependencies,
    })
    let findings = []
    try {
      findings = manifestFindings(text, "package.json")
    } catch (error) {
      results.push({ server: row.server, package: row.package, version: row.version, status: "check-failed", error: String(error && error.message || error), findings: [] })
      continue
    }
    results.push({ server: row.server, package: row.package, version: row.version, status: findings.length > 0 ? "findings" : "clean", findings: findings })
  }
}
await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker))
results.sort(function (a, b) { return a.package.localeCompare(b.package) })

const perRule = {}
const byStatus = {}
for (const r of results) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1
  for (const f of r.findings) {
    perRule[f.rule] = perRule[f.rule] || { count: 0, severity: f.severity, example: null }
    perRule[f.rule].count += 1
    if (!perRule[f.rule].example) perRule[f.rule].example = { package: r.package, version: r.version, message: f.message }
  }
}
const payload = {
  generatedAt: new Date().toISOString(),
  censusGeneratedAt: census.generatedAt || null,
  agentGuardRoot: agentGuardRoot,
  packagesConsidered: rows.length,
  byStatus: byStatus,
  perRule: perRule,
  results: results,
}
const lines = []
lines.push("# agent-guard over the census packages")
lines.push("")
lines.push("Feed the MCP registry census into the agent-guard manifest checks. Read-only: registry metadata plus the published npm manifest.")
lines.push("")
lines.push("- packages considered: **" + rows.length + "**")
lines.push("- status: " + Object.keys(byStatus).sort().map(function (k) { return k + " **" + byStatus[k] + "**" }).join(", "))
lines.push("")
lines.push("## Rules, by how many packages they hit")
lines.push("")
const ranked = Object.keys(perRule).sort(function (a, b) { return perRule[b].count - perRule[a].count })
lines.push("| rule | severity | packages | example |")
lines.push("| --- | --- | --- | --- |")
for (const rule of ranked) {
  const x = perRule[rule]
  lines.push("| " + rule + " | " + x.severity + " | " + x.count + " | " + x.example.package + "@" + x.example.version + ": " + String(x.example.message).slice(0, 90) + " |")
}
lines.push("")
lines.push("A package whose manifest could not be fetched is counted as `metadata-unavailable`; it is not reported as clean.")
lines.push("")
if (args.out) writeFileSync(args.out, JSON.stringify(payload, null, 2) + "\n")
if (args.summary) writeFileSync(args.summary, lines.join("\n"))
if (!args.summary) process.stdout.write(lines.join("\n"))
console.error("guard-scan: " + rows.length + " packages | " + JSON.stringify(byStatus))
