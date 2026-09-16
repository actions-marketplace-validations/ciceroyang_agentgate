#!/usr/bin/env node
/**
 * Every critical in the index has to have been read by a person.
 *
 * The index rebuilds daily from other people's registrations, so a critical can appear
 * without anyone here having looked at it — and it is on a public page the moment it does.
 * This compares what the index says now against the set that has actually been read, and
 * fails when something is new or when its evidence changed under an old review.
 *
 *   node scripts/review-criticals.mjs             # list, exit 1 if anything is unreviewed
 *   node scripts/review-criticals.mjs --accept    # record the current set as read
 *
 * --accept prints everything it records. It does not read the code for you; the whole point
 * of the file it writes is that a person did.
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

/** Every critical finding in the index, with the evidence string that would have to change. */
function criticalsOf(idx) {
  const out = []
  for (const r of idx.records || []) {
    for (const block of Object.keys(r.evidence || {})) {
      for (const f of ((r.evidence[block] || {}).findings) || []) {
        if (f.severity !== "critical") continue
        out.push({
          server: r.server,
          rule: f.rule,
          block: block,
          file: f.file || null,
          evidence: String(f.evidence || f.message || ""),
        })
      }
    }
  }
  return out
}

const keyOf = function (e) { return e.server + "|" + e.rule }
const current = criticalsOf(index)
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : { reviewed: [] }
const prior = new Map((baseline.reviewed || []).map(function (e) { return [keyOf(e), e] }))

const fresh = []
const changed = []
for (const c of current) {
  const was = prior.get(keyOf(c))
  if (!was) fresh.push(c)
  else if (was.evidence !== c.evidence) changed.push({ now: c, was: was })
}
const live = new Set(current.map(keyOf))
const cleared = (baseline.reviewed || []).filter(function (e) { return !live.has(keyOf(e)) })

if (accept) {
  const today = new Date().toISOString().slice(0, 10)
  const next = current.map(function (c) {
    const was = prior.get(keyOf(c))
    if (was && was.evidence === c.evidence) return was
    console.log((was ? "re-accepted, evidence changed" : "accepted") + ": " + c.server + " | " + c.rule)
    console.log("    " + c.evidence.slice(0, 140))
    return { server: c.server, rule: c.rule, block: c.block, file: c.file, evidence: c.evidence, reviewedAt: today, note: (was && was.note) || "" }
  })
  writeFileSync(baselinePath, JSON.stringify({
    note: "Criticals a person has read. The evidence string is part of the key: if it changes, the review is void and the checker says so. Edited by scripts/review-criticals.mjs --accept.",
    reviewed: next,
  }, null, 1) + "\n")
  console.log("baseline now records " + next.length + " critical(s) in " + baselinePath)
  process.exit(0)
}

console.log("criticals: " + current.length + " | reviewed: " + (current.length - fresh.length - changed.length) + " | new: " + fresh.length + " | changed: " + changed.length + " | cleared: " + cleared.length)
for (const c of fresh) console.log("NEW      " + c.server + " | " + c.rule + " | " + c.evidence.slice(0, 120))
for (const c of changed) {
  console.log("CHANGED  " + c.now.server + " | " + c.now.rule)
  console.log("    was: " + c.was.evidence.slice(0, 110))
  console.log("    now: " + c.now.evidence.slice(0, 110))
}
for (const c of cleared) console.log("CLEARED  " + c.server + " | " + c.rule + " (no longer critical; the note stays in the file)")
if (fresh.length > 0 || changed.length > 0) {
  console.error("unreviewed critical(s): read the code, then run --accept")
  process.exit(1)
}
console.log("every critical in this index has been read")
