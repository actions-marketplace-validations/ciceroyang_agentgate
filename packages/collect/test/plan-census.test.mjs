import test from "node:test"
import assert from "node:assert/strict"
import { planTopic, DAY } from "../scripts/plan-census.mjs"

/**
 * The planner exists so a census can be costed before it runs, and its whole value is that it walks
 * the SAME tree the census walks — it imports planSlices, splitByPushed, sliceQuery and sliceKey
 * from github-census.mjs rather than re-deriving them. So these tests hold it to the census's own
 * arithmetic: pages are min(ceil(total/perPage), cap/perPage), an overflowing slice is split in
 * half, and a slice that overflows with a window already at the floor sets the truncated flag
 * instead of being smoothed over.
 */
function stubHttp(counts, seen) {
  return async function http(url) {
    const q = decodeURIComponent(new URL(url).searchParams.get("q"))
    if (seen) seen.push(q)
    const total = Object.prototype.hasOwnProperty.call(counts, q) ? counts[q] : 0
    return { status: 200, text: JSON.stringify({ total_count: total }) }
  }
}

test("pages follow the census's own formula, not the total divided by 100", async function () {
  // One bucket under the cap and nine empty ones: the empty slices still cost one request each,
  // because a census that skips them cannot tell an empty bucket from a missing one.
  const counts = { "topic:t stars:>=1000": 250, "topic:t stars:500..999": 1000 }
  const plan = await planTopic({ topic: "t", minStars: 0, http: stubHttp(counts), delayMs: 0 })
  const mega = plan.slices.find((s) => s.query === "topic:t stars:>=1000")
  const full = plan.slices.find((s) => s.query === "topic:t stars:500..999")
  assert.equal(mega.pages, 3, "250 results page out at 3 requests, not 2.5")
  assert.equal(full.pages, 10, "exactly 1,000 results still cost the full 10 pages, and do not overflow")
  assert.equal(full.overflowed, false, "the cap is 1000, so 1000 is not over it")
})

test("an overflowing slice is split in half and its children are planned too", async function () {
  const counts = { "topic:t stars:>=1000": 2500 }
  const plan = await planTopic({ topic: "t", minStars: 0, http: stubHttp(counts), delayMs: 0 })
  // sliceKey joins three fields with the separator, so a bucket with no date bounds is ">=1000||".
  const parent = plan.slices.find((s) => s.key === ">=1000||")
  assert.ok(parent, "the parent slice has to appear: it is the one that overflows")
  assert.equal(parent.overflowed, true)
  assert.equal(parent.pages, 10, "an overflowing slice is paged to the cap before anyone notices")
  const children = plan.slices.filter((s) => s.from && s.to).sort((a, b) => a.from.localeCompare(b.from))
  assert.equal(children.length, 2, "one split produces exactly two children")
  assert.notEqual(children[0].from, children[1].from, "the two children do not cover the same window")
  assert.equal(children[0].to, children[1].from, "they meet at the split point: no gap, no overlap")
  assert.equal(children[0].from, "2015-01-01", "the left child starts where the whole range starts")
})

test("a slice that overflows inside the three-day floor is reported, not hidden", async function () {
  // Every slice has 1,500 results and the whole range is two days wide, so nothing can be split:
  // this is the geometry that stopped the real mcp census, where one bucket held 1,492 repositories
  // pushed in the last two days. The split condition is width, not count.
  const plan = await planTopic({
    topic: "t", minStars: 1, from: "2026-09-19", to: "2026-09-21",
    http: async () => ({ status: 200, text: JSON.stringify({ total_count: 1500 }) }),
    delayMs: 0,
  })
  assert.equal(plan.truncated, true, "a floor slice has to set the flag; the census does")
  const floored = plan.slices.filter((s) => s.atFloor)
  assert.ok(floored.length > 0, "and the planner has to name which slice it was")
  assert.match(floored[0].query, /^topic:t stars:/, "the named slice is the one that could not split")
  assert.equal(plan.slices.filter((s) => s.from).length, 0, "nothing under three days wide is split")
})

test("the plan is count-only: it never asks for a page of repositories", async function () {
  const seen = []
  await planTopic({ topic: "t", minStars: 0, http: stubHttp({ "topic:t stars:>=1000": 50 }, seen), delayMs: 0 })
  assert.ok(seen.length > 0)
  for (const q of seen) assert.match(q, /^topic:t stars:/, "only search queries are issued")
  assert.ok(DAY === 24 * 3600 * 1000)
})
