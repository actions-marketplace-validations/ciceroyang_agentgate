import { runScan, exitCodeFor } from "../src/engine.mjs"

const boom = { id: "boom", run: function () { throw new Error("simulated failure") } }
const ok = { id: "ok", run: function () { return { findings: [], filesRead: [] } } }
const result = runScan({ root: ".", checks: [boom, ok], readText: function () { return "" } })
if (result.verdict !== "incomplete") {
  console.error("FAIL: a crashed check produced verdict " + result.verdict)
  process.exit(1)
}
for (const level of ["critical", "high", "medium", "low", "info"]) {
  if (exitCodeFor(result, level) !== 2) {
    console.error("FAIL: incomplete scan did not exit 2 at --fail-on " + level)
    process.exit(1)
  }
}
console.log("invariant holds: a crashed check can never yield clean, and exits 2 at every threshold")
