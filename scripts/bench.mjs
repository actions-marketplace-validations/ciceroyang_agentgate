#!/usr/bin/env node
/**
 * Measure the service against an index far larger than today's.
 *
 * Today the registry resolves about two thousand servers. This asks what happens at fifty
 * thousand, because the answer to "it works" should not depend on the corpus staying small.
 *
 *   node scripts/bench.mjs [records] [requests]
 */
import { writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { createService } from "../packages/service/src/server.mjs"
import { scratchDir } from "./scratch-dir.mjs"

const records = Number(process.argv[2] || 50000)
const requests = Number(process.argv[3] || 200)

const dir = scratchDir("ag-bench-")
const indexPath = join(dir, "index.json")
const made = []
for (let i = 0; i < records; i += 1) {
  made.push({
    server: "bench/server-" + i,
    verdict: i % 17 === 0 ? "incomplete" : i % 5 === 0 ? "findings" : "clean",
    packages: [{ registry: "npm", name: "pkg-" + i, version: "1.0." + (i % 9) }],
    evidence: { registryDocument: { status: "clean", source: "mcp-census", findings: [] } },
  })
}
writeFileSync(indexPath, JSON.stringify({ generatedAt: new Date().toISOString(), threshold: "medium", count: made.length, records: made }))
const size = statSync(indexPath).size
console.log("index: " + records + " records, " + (size / 1048576).toFixed(1) + " MB")

const service = createService({ indexPath: indexPath })
const first = process.hrtime.bigint()
service.handle("GET", "/health")
const cold = Number(process.hrtime.bigint() - first) / 1e6
console.log("cold /health: " + cold.toFixed(1) + " ms")

const timings = []
for (let i = 0; i < requests; i += 1) {
  const t0 = process.hrtime.bigint()
  const out = service.handle("GET", "/v1/servers/" + encodeURIComponent("bench/server-" + (i * 7 % records)))
  timings.push(Number(process.hrtime.bigint() - t0) / 1e6)
  if (out.status !== 200) { console.log("unexpected status " + out.status); process.exit(1) }
}
timings.sort(function (a, b) { return a - b })
const pick = function (p) { return timings[Math.min(timings.length - 1, Math.floor(timings.length * p))] }
console.log("warm lookups (" + requests + "): p50 " + pick(0.5).toFixed(1) + " ms, p95 " + pick(0.95).toFixed(1) + " ms, max " + timings[timings.length - 1].toFixed(1) + " ms")
const rss = process.memoryUsage().rss / 1048576
console.log("rss: " + rss.toFixed(0) + " MB")

const budget = 10
if (pick(0.5) > budget) { console.log("FAIL p50 above " + budget + " ms"); process.exit(1) }
console.log("within budget (" + budget + " ms p50). This budget exists because 50 ms did not catch a service that re-parsed the whole index on every request.")
