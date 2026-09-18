#!/usr/bin/env node
/**
 * How much of a collection is actually measured.
 *
 *   node scripts/coverage-stats.mjs --index data/index.json
 *   node scripts/coverage-stats.mjs --index data/index.json --json
 *
 * Exit 0 when the numbers are self-consistent, 1 when a record claims a verdict its coverage
 * block cannot support, and 2 on bad input. The checked invariant is the part that matters: a
 * `clean` record is a claim about work, so a clean record without a complete coverage block is a
 * contradiction, not a statistic. The counting lives in packages/collect/src/coverage.mjs, because
 * the MCP server reports the same numbers and two implementations would drift.
 */
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { computeCoverage, renderCoverage } from "../packages/collect/src/coverage.mjs"

const usage = "usage: node scripts/coverage-stats.mjs --index <path> [--json]"

function argOf(name) {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : process.argv[at + 1] || null
}

export { computeCoverage, renderCoverage }

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
