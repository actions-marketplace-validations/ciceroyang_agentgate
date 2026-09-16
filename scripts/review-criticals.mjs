#!/usr/bin/env node
/**
 * Every high or critical finding in the index has to have been reviewed by a person.
 *
 * The index rebuilds daily from other people's registrations, so a finding can appear
 * without anyone here having looked at it — and it is on a public page the moment it does.
 * This compares what the index says now against the set that has actually been read, and
 * fails when something is new or when its identity, package version, scanned-content
 * digest, or evidence changed under an old review. Legacy baselines require re-review.
 *
 *   node scripts/review-criticals.mjs             # list, exit 1 if anything is unreviewed
 *   node scripts/review-criticals.mjs --accept    # explicitly record completed human review
 *
 * --accept is a person's attestation after reviewing the exact scanned evidence. It
 * refuses incomplete evidence and does not inspect or certify third-party source code.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const argOf = function (name, fallback) { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const indexPath = resolve(argOf("--index", join(ROOT, "data", "index.json")))
const baselinePath = resolve(argOf("--baseline", join(ROOT, "data", "reviewed-criticals.json")))
const accept = args.indexOf("--accept") !== -1

if (!existsSync(indexPath)) { console.error("no index at " + indexPath + " -- run refresh first"); process.exit(2) }
const index = JSON.parse(readFileSync(indexPath, "utf8"))

const BASELINE_VERSION = 2
const nonempty = function (value) { return typeof value === "string" && value.trim().length > 0 }
const object = function (value) { return value !== null && typeof value === "object" && !Array.isArray(value) }

function validIndex(value) {
  if (!object(value) || !Array.isArray(value.records)) return false
  return value.records.every(function (r) {
    if (!object(r) || !nonempty(r.server) || !object(r.evidence) || Object.keys(r.evidence).length === 0) return false
    return Object.values(r.evidence).every(function (block) {
      return object(block) && Array.isArray(block.findings) && block.findings.every(function (f) {
        return object(f) && nonempty(f.rule) && ["critical", "high", "medium", "low", "info", "unknown"].includes(f.severity)
      })
    })
  })
}

if (!validIndex(index)) {
  console.error("invalid index structure: records must be an array of named records with evidence blocks and finding arrays; no reviews accepted")
  process.exit(2)
}

function exactVersion(value, registry) {
  if (!nonempty(value) || !/[0-9]/.test(value)) return false
  if (/[\s*^~<>=|,\[\](){}]/.test(value) || /(?:^|[.\-_/])x(?:$|[.\-_/])/i.test(value)) return false
  // npm's "1" and "1.2" are ranges. Other ecosystems may use precise non-semver versions.
  if (registry === "npm") return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  return true
}

/** Fixed field order makes property order irrelevant; only the agreed binding is stored. */
function normalizeProvenance(value) {
  if (!value || typeof value !== "object" || !value.package || !value.content) return null
  return {
    package: { registry: value.package.registry, name: value.package.name, version: value.package.version },
    content: {
      algorithm: value.content.algorithm,
      digest: typeof value.content.digest === "string" ? value.content.digest.toLowerCase() : value.content.digest,
      scope: value.content.scope,
    },
    complete: value.complete,
  }
}

function bindingProblems(provenance, packages) {
  if (!provenance) return ["missing scanned-content provenance"]
  const problems = []
  const pkg = provenance.package
  if (provenance.complete !== true) problems.push("scanned evidence is not complete")
  if (!nonempty(pkg.registry) || !nonempty(pkg.name) || !exactVersion(pkg.version, pkg.registry)) problems.push("missing exact package identity/version")
  if (!Array.isArray(packages) || !packages.some(function (p) {
    return p && p.registry === pkg.registry && p.name === pkg.name && p.version === pkg.version
  })) problems.push("provenance package does not match the index record")
  if (provenance.content.algorithm !== "sha256" || typeof provenance.content.digest !== "string" || !/^[a-f0-9]{64}$/.test(provenance.content.digest)) problems.push("missing valid sha256 scanned-content digest")
  if (!nonempty(provenance.content.scope)) problems.push("missing scanned-content scope")
  return problems
}

/** Every high or critical finding, retaining its complete location and severity. */
function reviewableFindingsOf(idx) {
  const out = []
  for (const r of idx.records || []) {
    for (const block of Object.keys(r.evidence || {})) {
      for (const f of ((r.evidence[block] || {}).findings) || []) {
        if (f.severity !== "critical" && f.severity !== "high") continue
        const provenance = normalizeProvenance((r.evidence[block] || {}).provenance)
        const finding = {
          server: r.server,
          rule: f.rule,
          block: block,
          file: f.file || null,
          severity: f.severity,
          evidence: String(f.evidence || f.message || ""),
          provenance: provenance,
        }
        finding.problems = bindingProblems(provenance, r.packages)
        if (!nonempty(finding.server) || !nonempty(finding.rule) || !nonempty(finding.block) || (finding.file !== null && !nonempty(finding.file))) finding.problems.push("missing finding identity")
        if (!nonempty(finding.evidence)) finding.problems.push("missing finding evidence text")
        out.push(finding)
      }
    }
  }
  return out
}

const keyOf = function (e) { return JSON.stringify([e.server, e.block, e.rule, e.file || null, e.severity]) }
const labelOf = function (e) { return e.server + " | " + e.rule + " | " + e.block + " | " + (e.file || "(no file)") + " | " + e.severity }
const current = reviewableFindingsOf(index)
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : { reviewed: [] }
const oldEntries = Array.isArray(baseline.reviewed) ? baseline.reviewed.filter(function (e) { return e && typeof e === "object" }) : []
const legacy = existsSync(baselinePath) && baseline.schemaVersion !== BASELINE_VERSION
const prior = new Map()
for (const entry of legacy ? [] : oldEntries) {
  const key = keyOf(entry)
  if (!prior.has(key)) prior.set(key, [])
  prior.get(key).push(entry)
}

function matchesReview(now, was) {
  if (!was || now.problems.length > 0 || !nonempty(was.reviewedAt) || was.evidence !== now.evidence) return false
  const provenance = normalizeProvenance(was.provenance)
  if (bindingProblems(provenance, provenance ? [provenance.package] : []).length > 0) return false
  return JSON.stringify(provenance) === JSON.stringify(now.provenance)
}

const fresh = []
const changed = []
const matchedReviews = new Map()
const previousReviews = new Map()
const used = new Set()
// Match every unchanged occurrence before assigning changed ones. A rule can report
// multiple hooks at the same location, and their ordering must not erase a review.
for (const c of current) {
  const was = (prior.get(keyOf(c)) || []).find(function (entry) { return !used.has(entry) && matchesReview(c, entry) })
  if (was) { used.add(was); matchedReviews.set(c, was); previousReviews.set(c, was) }
}
for (const c of current) {
  if (matchedReviews.has(c)) continue
  const was = (prior.get(keyOf(c)) || []).find(function (entry) { return !used.has(entry) })
  if (!was) fresh.push(c)
  else { used.add(was); previousReviews.set(c, was); changed.push({ now: c, was: was }) }
}
const cleared = (legacy ? [] : oldEntries).filter(function (e) { return !used.has(e) })
const incomplete = current.filter(function (c) { return c.problems.length > 0 })

if (legacy) console.log("LEGACY BASELINE: previous reviews lack the required identity/version/content binding; human re-review is required. The old baseline is unchanged unless --accept succeeds.")
for (const c of incomplete) console.log("INCOMPLETE " + labelOf(c) + " | " + c.problems.join("; "))

if (accept) {
  if (incomplete.length > 0) {
    console.error("cannot accept incomplete evidence; obtain complete provenance for every high/critical finding, then review the exact scanned evidence. Baseline unchanged.")
    process.exit(1)
  }
  const today = new Date().toISOString().slice(0, 10)
  const next = current.map(function (c) {
    const was = previousReviews.get(c)
    console.log((matchedReviews.has(c) ? "retained recorded review" : was ? "recorded renewed human review" : "recorded human review") + ": " + labelOf(c))
    console.log("    " + c.evidence.slice(0, 140))
    console.log("    " + c.provenance.package.name + "@" + c.provenance.package.version + " | sha256:" + c.provenance.content.digest + " | " + c.provenance.content.scope)
    return { server: c.server, rule: c.rule, block: c.block, file: c.file, severity: c.severity, evidence: c.evidence, provenance: c.provenance, reviewedAt: matchedReviews.has(c) ? was.reviewedAt : today, note: (was && was.note) || "" }
  })
  writeFileSync(baselinePath, JSON.stringify({
    schemaVersion: BASELINE_VERSION,
    note: "Explicit human review attestations for high/critical findings, bound to server/block/rule/file/severity, evidence text, exact package version and complete scanned-content provenance. Changed or missing bindings require human re-review. Written only by scripts/review-criticals.mjs --accept; this command does not inspect third-party source code.",
    reviewed: next,
  }, null, 1) + "\n")
  console.log("baseline now records " + next.length + " high/critical finding(s) in " + baselinePath)
  process.exit(0)
}

console.log("high/critical findings: " + current.length + " | reviewed: " + (current.length - fresh.length - changed.length) + " | new: " + fresh.length + " | changed: " + changed.length + " | cleared: " + cleared.length)
for (const c of fresh) console.log("NEW      " + labelOf(c) + " | " + c.evidence.slice(0, 120))
for (const c of changed) {
  console.log("CHANGED  " + labelOf(c.now) + " | evidence or provenance changed/missing; human re-review required")
  console.log("    was: " + String(c.was.evidence || "").slice(0, 110))
  console.log("    now: " + c.now.evidence.slice(0, 110))
}
for (const c of cleared) console.log("CLEARED  " + labelOf(c) + " (not present in current high/critical evidence; the baseline stays unchanged)")
if (fresh.length > 0 || changed.length > 0) {
  console.error("unreviewed high/critical finding(s): review the scanned evidence, then run --accept")
  process.exit(1)
}
console.log("every high/critical finding matches a recorded human-review baseline")
