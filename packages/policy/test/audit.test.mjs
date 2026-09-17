import test from "node:test"
import assert from "node:assert/strict"
import { aggregateAudit, renderAudit } from "../src/audit.mjs"

function entry(root, verdict, exitCode, extra) {
  return Object.assign({ root: root, verdict: verdict, exitCode: exitCode, findings: 0, checksFailed: 0, evidenceMissing: 0, reason: null }, extra || {})
}

test("all clean is clean", function () {
  const aggregate = aggregateAudit([entry("/a", "clean", 0), entry("/b", "clean", 0)])
  assert.equal(aggregate.verdict, "clean")
  assert.equal(aggregate.exitCode, 0)
  assert.deepEqual(aggregate.counts, { clean: 2, findings: 0, incomplete: 0 })
})

test("findings in one directory is findings", function () {
  const aggregate = aggregateAudit([entry("/a", "clean", 0), entry("/b", "findings", 1, { findings: 2 })])
  assert.equal(aggregate.verdict, "findings")
  assert.equal(aggregate.exitCode, 1)
})

test("one incomplete directory outranks every clean and finding", function () {
  const aggregate = aggregateAudit([
    entry("/a", "clean", 0),
    entry("/b", "findings", 1, { findings: 3 }),
    entry("/c", "incomplete", 2, { checksFailed: 1 }),
  ])
  assert.equal(aggregate.verdict, "incomplete")
  assert.equal(aggregate.exitCode, 2)
  assert.deepEqual(aggregate.incomplete, ["/c"])
})

test("a directory with an unknown verdict is not counted out of existence", function () {
  const aggregate = aggregateAudit([entry("/a", "clean", 0), entry("/b", "weird", 2)])
  assert.equal(aggregate.total, 2)
  assert.equal(aggregate.verdict, "incomplete", "an exit code of 2 still forces incomplete")
})

test("an empty list is reported as empty rather than clean by accident", function () {
  const aggregate = aggregateAudit([])
  assert.equal(aggregate.verdict, "clean")
  assert.equal(aggregate.total, 0)
})

test("the text names every directory and says the whole is not a pass", function () {
  const entries = [entry("/a", "clean", 0), entry("/c", "incomplete", 2, { evidenceMissing: 4 })]
  const text = renderAudit(entries, aggregateAudit(entries))
  assert.match(text, /\/a/)
  assert.match(text, /\/c/)
  assert.match(text, /4 条证据未测到/)
  assert.match(text, /整体: INCOMPLETE/)
  assert.match(text, /不能算通过/)
})
