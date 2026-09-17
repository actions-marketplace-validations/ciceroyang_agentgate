import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { scratchDir } from "../../../test/tmpdir.mjs"
import { appendWatch, canonicalInput, diffProjections, keyOf, projectionOf, readWatch, summarize, verifyWatch, webhookPayload } from "../src/watch.mjs"

function item(name, state, version, findings) {
  return {
    input: { name: name, server: null, package: name, registry: "npm", version: version || null },
    state: state,
    label: state === "matched" ? "版本与证据对应" : "当前索引未找到",
    selected: state === "matched" ? { version: version } : null,
    findings: new Array(findings || 0).fill({ rule: "AG-MCP-010" }),
  }
}

function reportOf(items) {
  return {
    summary: {
      total: items.length,
      matched: items.filter(function (i) { return i.state === "matched" }).length,
      needsAttention: items.filter(function (i) { return i.state !== "matched" }).length,
    },
    items: items,
  }
}

function capture(archive, items) {
  return appendWatch(archive, { entries: items.map(function (i) { return i.input }), report: reportOf(items), capturedAt: "2026-09-17T00:00:00.000Z" })
}

test("the digest of a list does not depend on the order it was written in", function () {
  const a = canonicalInput([{ package: "b", version: "1.0.0" }, { package: "a", version: "2.0.0" }])
  const b = canonicalInput([{ package: "a", version: "2.0.0" }, { package: "b", version: "1.0.0" }])
  assert.equal(a, b)
})

test("a name is only a name, but server and package identify the tool", function () {
  assert.equal(keyOf({ name: "Filesystem", server: "acme/fs", package: "fs-pkg" }), "acme/fs")
  assert.equal(keyOf({ name: "Filesystem", package: "fs-pkg" }), "fs-pkg")
  assert.equal(keyOf({ name: "Filesystem" }), "Filesystem")
})

test("the first capture says it has nothing to compare against", function () {
  const dir = scratchDir("ag-watch-")
  const first = capture(dir, [item("a", "matched", "1.0.0")])
  assert.equal(first.firstRun, true)
  assert.equal(first.comparable, false)
  assert.equal(first.entry.prev, null)
  assert.match(first.summary, /第一次归档/)
  assert.equal(verifyWatch(dir).ok, true)
})

test("an unchanged list is recorded, and the second line chains to the first", function () {
  const dir = scratchDir("ag-watch-")
  const first = capture(dir, [item("a", "matched", "1.0.0")])
  const second = capture(dir, [item("a", "matched", "1.0.0")])
  assert.equal(second.entry.prev, first.hash)
  assert.equal(second.summary.indexOf("没有变化") !== -1, true)
  assert.equal(readWatch(dir).length, 2)
  assert.equal(verifyWatch(dir).ok, true)
})

test("an added tool and a removed tool are both reported", function () {
  const dir = scratchDir("ag-watch-")
  capture(dir, [item("a", "matched", "1.0.0"), item("b", "matched", "1.0.0")])
  const second = capture(dir, [item("a", "matched", "1.0.0"), item("c", "unmatched", null)])
  assert.deepEqual(second.diff.added, ["c"])
  assert.deepEqual(second.diff.removed, ["b"])
  assert.match(second.summary, /\+ c/)
  assert.match(second.summary, /- b/)
})

test("a version change is a change even when the label stays the same", function () {
  const dir = scratchDir("ag-watch-")
  capture(dir, [item("a", "matched", "1.0.0")])
  const second = capture(dir, [item("a", "matched", "2.0.0")])
  assert.equal(second.diff.changed.length, 1)
  assert.match(second.summary, /1\.0\.0 → 2\.0\.0/)
})

test("a rewritten line breaks the chain and verify says so", function () {
  const dir = scratchDir("ag-watch-")
  capture(dir, [item("a", "matched", "1.0.0")])
  capture(dir, [item("a", "matched", "1.0.0")])
  const path = join(dir, "watch.jsonl")
  const lines = readFileSync(path, "utf8").trim().split("\n")
  lines[0] = lines[0].replace('"items":1', '"items":9')
  writeFileSync(path, lines.join("\n") + "\n")
  const result = verifyWatch(dir)
  assert.equal(result.ok, false)
  assert.equal(result.problems.filter(function (p) { return p.problem === "chain" }).length, 1)
})

test("an edited snapshot is caught even when the chain is intact", function () {
  const dir = scratchDir("ag-watch-")
  const first = capture(dir, [item("a", "matched", "1.0.0")])
  writeFileSync(join(dir, first.entry.snapshot), JSON.stringify([{ key: "a", state: "matched" }]))
  const result = verifyWatch(dir)
  assert.equal(result.ok, false)
  assert.equal(result.problems[0].problem, "snapshot")
})

test("a pruned snapshot is reported, not treated as a broken record", function () {
  const dir = scratchDir("ag-watch-")
  const first = capture(dir, [item("a", "matched", "1.0.0")])
  rmSync(join(dir, first.entry.snapshot))
  const result = verifyWatch(dir)
  assert.equal(result.ok, true, "dropping bytes is a storage decision, not a mismatch")
  assert.equal(result.problems[0].problem, "pruned")
  const second = capture(dir, [item("a", "matched", "1.0.0")])
  assert.equal(second.comparable, false)
  assert.match(second.summary, /无法比较/)
})

test("every chat service gets the payload it expects", function () {
  const diff = { added: ["a"], removed: [], changed: [{ key: "b" }] }
  assert.equal(webhookPayload("wecom", "s", diff).msgtype, "text")
  assert.equal(webhookPayload("feishu", "s", diff).msg_type, "text")
  assert.equal(webhookPayload("slack", "s", diff).text, "s")
  const raw = webhookPayload("raw", "s", diff, "T")
  assert.deepEqual(raw.added, ["a"])
  assert.deepEqual(raw.changed, ["b"])
  assert.throws(function () { webhookPayload("telegram", "s", diff) }, /不认识的推送格式/)
})

test("the projection keeps what changed and drops the customer's material", function () {
  const rows = projectionOf(reportOf([item("a", "matched", "1.0.0", 2)]))
  assert.deepEqual(rows, [{ key: "a", state: "matched", label: "版本与证据对应", version: "1.0.0", evidence: "1.0.0", findings: 2 }])
})

test("a diff of two identical projections is empty rather than undefined", function () {
  const rows = projectionOf(reportOf([item("a", "matched", "1.0.0")]))
  assert.deepEqual(diffProjections(rows, rows), { added: [], removed: [], changed: [] })
})

test("summarize refuses to call a first run unchanged", function () {
  const text = summarize({ added: [], removed: [], changed: [] }, { firstRun: true, items: 3 })
  assert.match(text, /第一次归档/)
  assert.equal(text.indexOf("没有变化"), -1)
})
