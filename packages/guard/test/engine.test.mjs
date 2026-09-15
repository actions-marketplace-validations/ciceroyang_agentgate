import { test } from "node:test"
import assert from "node:assert/strict"
import { runScan, exitCodeFor, severityRank } from "../src/engine.mjs"

const reader = function () { return "" }

function check(id, out) {
  return { id: id, run: function () { return out } }
}

test("clean when every check runs and finds nothing", function () {
  const r = runScan({ root: "/x", checks: [check("a", { findings: [], filesRead: ["f"] })], readText: reader })
  assert.equal(r.verdict, "clean")
  assert.equal(exitCodeFor(r, "medium"), 0)
  assert.deepEqual(r.coverage.checksRun, ["a"])
})

test("findings when a check reports one", function () {
  const r = runScan({ root: "/x", checks: [check("a", { findings: [{ rule: "R", severity: "high", file: "f", message: "m" }], filesRead: [] })], readText: reader })
  assert.equal(r.verdict, "findings")
  assert.equal(r.findings[0].check, "a")
  assert.equal(exitCodeFor(r, "medium"), 1)
  assert.equal(exitCodeFor(r, "critical"), 0)
})

test("a check that throws makes the scan incomplete and never clean", function () {
  const boom = { id: "boom", run: function () { throw new Error("kaboom") } }
  const r = runScan({ root: "/x", checks: [boom, check("ok", { findings: [], filesRead: [] })], readText: reader })
  assert.equal(r.verdict, "incomplete")
  assert.notEqual(r.verdict, "clean")
  assert.deepEqual(r.coverage.checksRun, ["ok"])
  assert.equal(r.coverage.checksFailed.length, 1)
  assert.equal(r.coverage.checksFailed[0].id, "boom")
  assert.match(r.coverage.checksFailed[0].error, /kaboom/)
})

test("an incomplete scan exits 2 at every fail-on level", function () {
  const boom = { id: "boom", run: function () { throw new Error("x") } }
  const r = runScan({ root: "/x", checks: [boom], readText: reader })
  for (const level of ["critical", "high", "medium", "low", "info"]) {
    assert.equal(exitCodeFor(r, level), 2, "fail-on " + level)
  }
})

test("coverage records what was requested, what ran, and what failed", function () {
  const boom = { id: "boom", run: function () { throw new Error("x") } }
  const r = runScan({ root: "/x", checks: [boom, check("b", { findings: [], filesRead: ["b.txt"] })], readText: reader })
  assert.deepEqual(r.coverage.checksRequested, ["boom", "b"])
  assert.deepEqual(r.coverage.checksRun, ["b"])
  assert.deepEqual(r.coverage.filesRead, ["b.txt"])
})

test("severityRank orders the five levels", function () {
  assert.ok(severityRank("critical") > severityRank("high"))
  assert.ok(severityRank("high") > severityRank("medium"))
  assert.ok(severityRank("medium") > severityRank("low"))
  assert.ok(severityRank("low") > severityRank("info"))
})

test("exclude drops findings and files under a prefix", function () {
  const out = {
    findings: [
      { rule: "R", severity: "high", file: "corpus/x/.mcp.json", message: "m" },
      { rule: "R2", severity: "high", file: "src/a.json", message: "m" },
    ],
    filesRead: ["corpus/x/.mcp.json", "src/a.json"],
  }
  const r = runScan({ root: "/x", checks: [check("c", out)], readText: reader, exclude: ["corpus"] })
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].file, "src/a.json")
  assert.deepEqual(r.coverage.filesRead, ["src/a.json"])
  assert.equal(r.verdict, "findings")
})

test("excluding everything a check found makes the scan clean", function () {
  const out = { findings: [{ rule: "R", severity: "high", file: "vendor/x.json", message: "m" }], filesRead: ["vendor/x.json"] }
  const r = runScan({ root: "/x", checks: [check("c", out)], readText: reader, exclude: ["vendor"] })
  assert.equal(r.verdict, "clean")
  assert.deepEqual(r.coverage.filesRead, [])
})

test("exclude does not turn a crashed check into a pass", function () {
  const boom = { id: "boom", run: function () { throw new Error("x") } }
  const r = runScan({ root: "/x", checks: [boom], readText: reader, exclude: ["everything"] })
  assert.equal(r.verdict, "incomplete")
  assert.equal(exitCodeFor(r, "critical"), 2)
})
