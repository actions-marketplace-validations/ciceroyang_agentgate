import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { appendCapture, readLedger, verifyLedger, coverageOf, backfill } from "../src/ledger.mjs"
import { scratchDir } from "../../../test/tmpdir.mjs"

function fixture(dir, name, index) {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(index))
  return path
}

function indexOf(clean, findings, incomplete) {
  const records = []
  for (let i = 0; i < clean; i += 1) records.push({ server: "c" + i + ".example/mcp", verdict: "clean" })
  for (let i = 0; i < findings; i += 1) records.push({ server: "f" + i + ".example/mcp", verdict: "findings" })
  for (let i = 0; i < incomplete; i += 1) records.push({ server: "i" + i + ".example/mcp", verdict: "incomplete" })
  return { generatedAt: "2026-01-01T00:00:00.000Z", scanner: "abc1234", records: records }
}

test("every capture appends one line and chains to the line before it", function () {
  const dir = scratchDir("ag-ledger-")
  const first = fixture(dir, "a.json", indexOf(2, 1, 0))
  appendCapture(dir, { index: JSON.parse(readFileSync(first, "utf8")), indexFile: first, scanner: "aaa", capturedAt: "2026-01-01T04:17:00.000Z" })
  const second = fixture(dir, "b.json", indexOf(1, 1, 1))
  appendCapture(dir, { index: JSON.parse(readFileSync(second, "utf8")), indexFile: second, scanner: "bbb", capturedAt: "2026-01-02T04:17:00.000Z" })

  const entries = readLedger(dir)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].prev, null, "the first line has nothing before it")
  assert.equal(entries[1].prev, entries[0].hash, "the second line does not chain to the first")
  assert.equal(entries[0].counts.clean, 2)
  assert.equal(entries[1].counts.incomplete, 1)
  assert.equal(entries[1].scanner, "bbb")

  const result = verifyLedger(dir)
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  assert.equal(result.coverage.captures, 2)
  assert.equal(result.coverage.days, 2)
})

test("an unchanged index is stored once but recorded every time", function () {
  const dir = scratchDir("ag-ledger-same-")
  const file = fixture(dir, "same.json", indexOf(3, 0, 0))
  const index = JSON.parse(readFileSync(file, "utf8"))
  appendCapture(dir, { index: index, indexFile: file, scanner: "aaa", capturedAt: "2026-01-01T04:17:00.000Z" })
  appendCapture(dir, { index: index, indexFile: file, scanner: "aaa", capturedAt: "2026-01-01T16:17:00.000Z" })

  const entries = readLedger(dir)
  assert.equal(entries.length, 2, "the second capture has to be recorded")
  assert.equal(entries[0].sha256, entries[1].sha256, "identical bytes must hash the same")
  assert.equal(entries[0].snapshot, entries[1].snapshot, "identical bytes must not be stored twice")
  assert.equal(verifyLedger(dir).ok, true)
})

test("the day archive is the first capture of that day and is never rewritten", function () {
  const dir = scratchDir("ag-ledger-day-")
  const morning = fixture(dir, "morning.json", indexOf(1, 0, 0))
  const evening = fixture(dir, "evening.json", indexOf(9, 0, 0))
  const first = appendCapture(dir, { index: JSON.parse(readFileSync(morning, "utf8")), indexFile: morning, scanner: "aaa", capturedAt: "2026-01-01T04:17:00.000Z" })
  const second = appendCapture(dir, { index: JSON.parse(readFileSync(evening, "utf8")), indexFile: evening, scanner: "aaa", capturedAt: "2026-01-01T20:00:00.000Z" })
  assert.equal(first.wroteDay, true)
  assert.equal(second.wroteDay, false)
  const day = JSON.parse(readFileSync(join(dir, "2026-01-01.json"), "utf8"))
  assert.equal(day.records.length, 1, "the day archive was rewritten by the later capture")
})

test("a rewritten snapshot or an edited line is reported, not accepted", function () {
  const dir = scratchDir("ag-ledger-tamper-")
  const one = fixture(dir, "1.json", indexOf(1, 0, 0))
  const two = fixture(dir, "2.json", indexOf(1, 1, 0))
  appendCapture(dir, { index: JSON.parse(readFileSync(one, "utf8")), indexFile: one, scanner: "aaa", capturedAt: "2026-01-01T04:17:00.000Z" })
  appendCapture(dir, { index: JSON.parse(readFileSync(two, "utf8")), indexFile: two, scanner: "aaa", capturedAt: "2026-01-02T04:17:00.000Z" })
  assert.equal(verifyLedger(dir).ok, true)

  // Rewriting the evidence behind a capture is the thing this file exists to catch.
  const snapshot = join(dir, readLedger(dir)[0].snapshot)
  writeFileSync(snapshot, JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z", scanner: "abc1234", records: [] }))
  const rewritten = verifyLedger(dir)
  assert.equal(rewritten.ok, false)
  assert.match(rewritten.problems.join(" "), /snapshot .* is /)
  assert.deepEqual(rewritten.notRetained, [])

  // Editing an old line also breaks the chain at the line after it.
  writeFileSync(snapshot, JSON.stringify(indexOf(1, 0, 0)))
  const ledgerPath = join(dir, "ledger.jsonl")
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n")
  const edited = JSON.parse(lines[0])
  edited.records = 999
  lines[0] = JSON.stringify(edited)
  writeFileSync(ledgerPath, lines.join("\n") + "\n")
  const chained = verifyLedger(dir)
  assert.equal(chained.ok, false)
  assert.match(chained.problems.join(" "), /prev does not match/)
})

test("the numbers on a line are checked against the evidence it points at", function () {
  const dir = scratchDir("ag-ledger-numbers-")
  const file = fixture(dir, "n.json", indexOf(4, 1, 0))
  appendCapture(dir, { index: JSON.parse(readFileSync(file, "utf8")), indexFile: file, scanner: "aaa", capturedAt: "2026-01-01T04:17:00.000Z" })
  assert.equal(verifyLedger(dir).ok, true)

  // The last line has no successor to break, so its own numbers have to be checkable.
  const ledgerPath = join(dir, "ledger.jsonl")
  const entry = JSON.parse(readFileSync(ledgerPath, "utf8").trim())
  entry.records = 999
  entry.counts.clean = 999
  writeFileSync(ledgerPath, JSON.stringify(entry) + "\n")
  const result = verifyLedger(dir)
  assert.equal(result.ok, false)
  assert.match(result.problems.join(" "), /records says 999, the snapshot has 5/)
  assert.match(result.problems.join(" "), /counts.clean says 999, the snapshot has 4/)
})

test("a lost ledger is rebuilt from the day archives, and backfilling twice changes nothing", function () {
  const dir = scratchDir("ag-ledger-backfill-")
  // Two days that were archived by the job before this file existed.
  writeFileSync(join(dir, "2026-01-01.json"), JSON.stringify(Object.assign(indexOf(1, 0, 0), { generatedAt: "2026-01-01T04:17:00.000Z", scanner: "aaa" })))
  writeFileSync(join(dir, "2026-01-02.json"), JSON.stringify(Object.assign(indexOf(2, 0, 0), { generatedAt: "2026-01-02T04:17:00.000Z", scanner: "bbb" })))

  const added = backfill(dir)
  assert.equal(added.length, 2)
  assert.equal(added[0].day, "2026-01-01")
  assert.equal(added[1].prev, added[0].hash)
  assert.equal(verifyLedger(dir).ok, true)

  assert.deepEqual(backfill(dir), [], "a second backfill must not append the same days again")
  assert.equal(readLedger(dir).length, 2)
})

test("a day with no capture is reported as a gap", function () {
  const entries = [
    { day: "2026-01-01", hash: "a" },
    { day: "2026-01-03", hash: "b" },
  ]
  const coverage = coverageOf(entries)
  assert.equal(coverage.days, 2)
  assert.deepEqual(coverage.gaps, ["2026-01-02"], "a missing day has to be visible, not smoothed over")
  assert.equal(coverage.first, "2026-01-01")
  assert.equal(coverage.last, "2026-01-03")
})

test("a pruned snapshot is reported as not retained, not as tampering", function () {
  const dir = scratchDir("ag-ledger-pruned-")
  const file = fixture(dir, "p.json", indexOf(1, 0, 0))
  appendCapture(dir, { index: JSON.parse(readFileSync(file, "utf8")), indexFile: file, scanner: "aaa", capturedAt: "2026-01-01T04:17:00.000Z" })
  const entry = readLedger(dir)[0]
  const result = verifyLedger(dir)
  assert.equal(result.ok, true)
  assert.equal(result.notRetained.length, 0)
  assert.ok(existsSync(join(dir, entry.snapshot)))
})
