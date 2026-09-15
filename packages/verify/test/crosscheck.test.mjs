import { test } from "node:test"
import assert from "node:assert/strict"
import { extractClaims, splitSentences, urlsIn } from "../src/claims.mjs"
import { dateProblem, invalidMonthName, resolveUrl } from "../src/check.mjs"
import { report } from "../bin/crosscheck.mjs"

test("sentences are split and only checkable ones are kept", function () {
  const text = "我觉得这个想法不错。根据 2024-13 的报告,增长了 300%。请你自己判断。"
  const claims = extractClaims(text)
  assert.ok(claims.length >= 1)
  assert.ok(claims.every(function (c) { return c.kinds.length > 0 }))
})

test("an impossible month is contradicted", function () {
  assert.match(dateProblem("发布于 2024-13", new Date("2026-01-01")), /month 13/)
  assert.equal(dateProblem("发布于 2024-05", new Date("2026-01-01")), null)
})

test("a made-up month name is contradicted", function () {
  assert.match(invalidMonthName("Published Smarch 3, 2025"), /not a month/)
  assert.equal(invalidMonthName("Published March 3, 2025"), null)
})

test("a dead link is contradicted, a live one supported, an unreachable one unchecked", async function () {
  const dead = await resolveUrl("https://x.test/a", async function () { return { status: 404 } })
  const live = await resolveUrl("https://x.test/b", async function () { return { status: 200 } })
  const err = await resolveUrl("https://x.test/c", async function () { throw new Error("timed out") })
  assert.equal(dead.status, "contradicted")
  assert.equal(live.status, "supported")
  assert.equal(err.status, "unchecked")
})

test("an unchecked claim is never reported as supported", async function () {
  const r = await report("据统计,2025 年增长了 300%[1]。", { fetchHead: async function () { return { status: 0 } } })
  assert.ok(r.findings.length >= 1)
  assert.ok(r.findings.every(function (f) { return f.status !== "supported" }))
})

test("urls are found once each", function () {
  assert.equal(urlsIn("see https://a.test and https://a.test").length, 2)
})
