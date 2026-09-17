import test from "node:test"
import assert from "node:assert/strict"
import { buildMessage, checkDisk, checkHealth, checkLedger, checkUrls, decideAlert, renderText, runChecks } from "../src/healthcheck.mjs"

function healthy(overrides) {
  return Object.assign({
    ok: true, records: 2066, generatedAt: "2026-09-17T00:00:00.000Z",
    history: { captures: 5, ageHours: 1, stale: false, gaps: [] },
  }, overrides || {})
}

test("a healthy answer produces no problems", function () {
  assert.deepEqual(checkHealth(healthy(), { maxAgeHours: 26 }), [])
})

test("an unreachable service is a problem, and not five derived ones", function () {
  const problems = checkHealth({ ok: false, reason: "unreachable：fetch failed" }, { maxAgeHours: 26 })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].id, "health_not_ok")
})

test("a stale capture, the stale flag and a gap are each their own problem", function () {
  const stale = checkHealth(healthy({ history: { captures: 5, ageHours: 30, stale: true, gaps: ["2026-09-15"] } }), { maxAgeHours: 26 })
  assert.deepEqual(stale.map(function (p) { return p.id }), ["history_age", "history_stale", "history_gaps"])
})

test("an empty ledger and an absent history block are problems, not passes", function () {
  assert.deepEqual(checkHealth(healthy({ history: { captures: 0, ageHours: null, stale: false, gaps: [] } })).map(function (p) { return p.id }), ["history_empty"])
  assert.deepEqual(checkHealth(healthy({ history: null })).map(function (p) { return p.id }), ["history_absent"])
  assert.deepEqual(checkHealth(healthy({ history: null }), { requireHistory: false }), [])
})

test("an index with no records and an unparseable date are problems", function () {
  assert.deepEqual(checkHealth(healthy({ records: 0 })).map(function (p) { return p.id }), ["index_records"])
  assert.deepEqual(checkHealth(healthy({ generatedAt: "not a date" })).map(function (p) { return p.id }), ["index_generated_at"])
})

test("disk thresholds, including the unreadable case", function () {
  assert.deepEqual(checkDisk({ freeBytes: 2 * 1024 * 1024 * 1024 }), [])
  assert.deepEqual(checkDisk({ freeBytes: 10 }).map(function (p) { return p.id }), ["disk_low"])
  assert.deepEqual(checkDisk(null).map(function (p) { return p.id }), ["disk_unreadable"])
  assert.deepEqual(checkDisk({ freeBytes: Number.NaN }).map(function (p) { return p.id }), ["disk_low"])
})

test("ledger problems are accepted as strings or as objects", function () {
  assert.deepEqual(checkLedger({ ok: true, problems: [] }), [])
  assert.equal(checkLedger({ ok: false, problems: ["line 2: prev does not match the line before it"] })[0].detail, "line 2: prev does not match the line before it")
  assert.match(checkLedger({ ok: false, problems: [{ problem: "chain", detail: "第 2 行" }] })[0].detail, /chain/)
  assert.deepEqual(checkLedger(null).map(function (p) { return p.id }), ["ledger_unreadable"])
})

test("a URL that is not 200 is a problem", function () {
  assert.deepEqual(checkUrls([{ url: "https://a/", status: 200, ok: true }]), [])
  assert.deepEqual(checkUrls([{ url: "https://a/", status: 500, ok: false }]).map(function (p) { return p.id }), ["url"])
  assert.match(checkUrls([{ url: "https://a/", error: "ENOTFOUND", ok: false }])[0].detail, /ENOTFOUND/)
})

test("checking nothing is not a pass", function () {
  const result = runChecks({})
  assert.equal(result.ok, false)
  assert.deepEqual(result.checked, [])
  assert.equal(result.problems[0].id, "nothing_checked")
})

test("one problem anywhere makes the whole run fail", function () {
  const result = runChecks({ health: healthy(), disk: { freeBytes: 10 } })
  assert.equal(result.ok, false)
  assert.deepEqual(result.checked, ["health", "disk"])
})

test("the alert decision fires on the transition, repeats on a window, and recovers once", function () {
  const now = Date.parse("2026-09-17T12:00:00.000Z")
  assert.equal(decideAlert(null, "ok", now).action, "none")
  assert.equal(decideAlert(null, "fail", now).action, "alert")
  assert.equal(decideAlert({ status: "fail", lastAlertAt: "2026-09-17T11:00:00.000Z" }, "fail", now).action, "none")
  assert.equal(decideAlert({ status: "fail", lastAlertAt: "2026-09-17T05:00:00.000Z" }, "fail", now).action, "alert")
  assert.equal(decideAlert({ status: "fail", lastAlertAt: "2026-09-17T11:00:00.000Z" }, "ok", now).action, "recovery")
  assert.equal(decideAlert({ status: "ok", lastAlertAt: null }, "ok", now).action, "none")
})

test("the alert mail names the problems, carries the numbers, and promises nothing", function () {
  const message = buildMessage({
    from: "contact@example.com", to: "me@example.com", status: "fail",
    problems: [{ id: "history_age", detail: "最后一次采集是 30.0 小时前" }],
    facts: { index_records: 2066 }, nowMs: Date.parse("2026-09-17T12:00:00.000Z"),
  })
  assert.match(message, /^From: contact@example\.com$/m)
  assert.match(message, /Subject: \[agentgate\] 巡检异常：1 项/)
  assert.match(message, /history_age：最后一次采集是 30\.0 小时前/)
  assert.match(message, /index_records = 2066/)
  assert.match(message, /不是合规结论/)
})

test("the recovery mail says what recovered", function () {
  const message = buildMessage({ from: "a@b.c", to: "d@e.f", status: "recovery", problems: [], facts: {}, nowMs: 0 })
  assert.match(message, /Subject: \[agentgate\] 巡检已恢复/)
})

test("the text output names what was and was not checked", function () {
  const text = renderText(runChecks({}), null)
  assert.match(text, /PROBLEMS/)
  assert.match(text, /什么都没检查|无（什么都没检查/)
})
