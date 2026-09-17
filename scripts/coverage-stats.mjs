#!/usr/bin/env node
/**
 * How much of a collection is actually measured.
 *
 * Every record can carry a coverage block that says which scanners were required and whether
 * they finished. This script turns a whole index into the counts a person can quote: how many
 * records are fully measured, what stopped the rest, and how many findings came out of the work
 * that did run. It reuses the record's own definition of "complete" rather than restating it.
 *
 *   node scripts/coverage-stats.mjs --index data/index.json
 *   node scripts/coverage-stats.mjs --index data/index.json --json
 *
 * Exit 0 when the numbers are self-consistent, 1 when a record claims a verdict its coverage
 * block cannot support, and 2 on bad input. The checked invariant is the part that matters: a
 * `clean` record is a claim about work, so a clean record without a complete coverage block is a
 * contradiction, not a statistic.
 */
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { componentComplete } from "../packages/collect/src/execution.mjs"

const usage = "usage: node scripts/coverage-stats.mjs --index <path> [--json]"

function argOf(name) {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : process.argv[at + 1] || null
}

function executionOf(record) {
  const wrapper = record && record.scanExecution
  const exec = wrapper && wrapper.scanner_execution
  return exec && typeof exec === "object" ? exec : null
}

function tally(bag, key) {
  bag[key] = (bag[key] || 0) + 1
}

/** Pure: an index in, counts and any self-consistency problems out. */
export function computeCoverage(index) {
  const records = Array.isArray(index && index.records) ? index.records : []
  const stats = {
    generatedAt: index && typeof index.generatedAt === "string" ? index.generatedAt : null,
    scanner: index && typeof index.scanner === "string" ? index.scanner : null,
    total: records.length, states: { complete: 0, incomplete: 0, absent: 0 },
    verdicts: {}, cross: {}, perScanner: {}, reasons: {}, findings: {},
    findingsTotal: 0, requiredRuns: 0, completedRuns: 0,
    verdictIncompleteButComplete: 0, problems: [],
  }
  for (const record of records) {
    const verdict = record && typeof record.verdict === "string" ? record.verdict : "unknown"
    tally(stats.verdicts, verdict)
    for (const block of Object.values((record && record.evidence) || {})) {
      for (const finding of (block && block.findings) || []) {
        stats.findingsTotal += 1
        tally(stats.findings, finding && typeof finding.severity === "string" ? finding.severity : "unrecorded")
      }
    }
    const exec = executionOf(record)
    if (!exec) {
      stats.states.absent += 1
      if (verdict === "clean" || verdict === "findings") stats.problems.push(record.server + ": " + verdict + " without a coverage block")
      continue
    }
    const state = exec.state === "complete" ? "complete" : "incomplete"
    stats.states[state] += 1
    stats.cross[verdict] = stats.cross[verdict] || {}
    tally(stats.cross[verdict], state)
    const components = Array.isArray(exec.components) ? exec.components : []
    let allRequiredFinished = true
    for (const component of components) {
      const id = component && typeof component.id === "string" ? component.id : "unnamed"
      const counts = stats.perScanner[id] = stats.perScanner[id] || { completed: 0, failed: 0, skipped: 0 }
      tally(counts, component && typeof component.status === "string" ? component.status : "unrecorded")
      if (!component || component.required === false) continue
      stats.requiredRuns += 1
      if (componentComplete(component)) stats.completedRuns += 1
      else {
        allRequiredFinished = false
        tally(stats.reasons, id + " " + (component.reason || "no reason recorded"))
      }
    }
    if (state === "complete" && !allRequiredFinished) stats.problems.push(record.server + ": coverage says complete but a required scanner did not finish")
    if ((verdict === "clean" || verdict === "findings") && state !== "complete") {
      stats.problems.push(record.server + ": " + verdict + " with an incomplete coverage block")
    }
    if (verdict === "incomplete" && state === "complete") stats.verdictIncompleteButComplete += 1
  }
  return stats
}

export function renderCoverage(stats) {
  const percent = (n) => stats.total ? (n / stats.total * 100).toFixed(1) + "%" : "0.0%"
  const list = (bag) => Object.entries(bag).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, value]) => key + ": " + value).join(", ") || "(none)"
  const lines = []
  lines.push("index generated " + (stats.generatedAt || "unknown") + (stats.scanner ? " (scanner " + stats.scanner + ")" : ""))
  lines.push("records: " + stats.total)
  lines.push("fully measured: " + stats.states.complete + " (" + percent(stats.states.complete) + ")")
  lines.push("not fully measured: " + stats.states.incomplete + (stats.states.absent ? " + " + stats.states.absent + " with no coverage block" : ""))
  for (const [reason, count] of Object.entries(stats.reasons).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))) lines.push("  " + reason + ": " + count)
  lines.push("required scanner runs: " + stats.requiredRuns + ", completed " + stats.completedRuns + ", not completed " + (stats.requiredRuns - stats.completedRuns))
  lines.push("scanners: " + Object.entries(stats.perScanner).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([id, counts]) => id + " (" + Object.entries(counts).filter(([, n]) => n > 0).sort().map(([status, n]) => status + " " + n).join(", ") + ")").join("; "))
  lines.push("verdicts: " + list(stats.verdicts))
  lines.push("verdict x coverage: " + Object.entries(stats.cross).map(([verdict, states]) => verdict + " " + list(states)).join(" | "))
  lines.push("verdict incomplete while every required scanner ran: " + stats.verdictIncompleteButComplete)
  lines.push("findings: " + stats.findingsTotal + " (" + list(stats.findings) + ")")
  lines.push("problems: " + (stats.problems.length ? stats.problems.join("; ") : "none"))
  return lines.join("\n")
}

function main() {
  const indexPath = argOf("--index")
  if (!indexPath) { console.error(usage); process.exit(2) }
  let index
  try { index = JSON.parse(readFileSync(indexPath, "utf8")) } catch (error) { console.error("cannot read index " + indexPath + ": " + error.message); process.exit(2) }
  const stats = computeCoverage(index)
  if (process.argv.includes("--json")) console.log(JSON.stringify(stats, null, 2))
  else console.log(renderCoverage(stats))
  process.exit(stats.problems.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
