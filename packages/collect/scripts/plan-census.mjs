#!/usr/bin/env node
/**
 * What would a census cost, before running one.
 *
 * The census refuses to page past 1,000 results for a query, so it slices by star bucket and then
 * by push date. Which slices it ends up with depends on how the repositories are distributed, and
 * that is not something you can read off the total: a topic with 40,000 repositories might need 30
 * slices or 300.
 *
 * This asks the search API for *counts only* — one request per slice, no repository payload — and
 * walks the same tree the census would walk. It imports planSlices, splitByPushed, sliceQuery and
 * sliceKey from the census itself, so the plan cannot drift from the thing it is planning.
 *
 * It also reports what the census would refuse to do: a slice that overflows and whose date window
 * is already under three days cannot be split further, and the census marks the whole run truncated
 * rather than smoothing it over. Knowing that in advance is the difference between choosing the
 * input and discovering the input chose for you.
 *
 * Read-only. It writes nothing but the file you name with --out, if you name one.
 *
 *   node packages/collect/scripts/plan-census.mjs --topics mcp-server,mcp --min-stars 1
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { planSlices, splitByPushed, sliceQuery, sliceKey, defaultHttp, SEARCH } from "../github-census.mjs"

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const at = args.indexOf("--" + name)
  if (at === -1) return fallback
  if (at + 1 >= args.length || args[at + 1].indexOf("--") === 0) return true
  return args[at + 1]
}

export const DAY = 24 * 3600 * 1000

/**
 * The census stops splitting below three days and calls the run truncated. Anything the plan
 * produces at or under that width is a slice the census would have given up on.
 */
export function floorWidth() { return 3 * DAY }

/**
 * Walk one topic's slice tree using counts. Mirrors collectTopic's loop condition for condition:
 * a slice is fetched as min(ceil(total / perPage), cap / perPage) pages, and an overflowing slice
 * is split in half unless its window is already at the floor.
 */
export async function planTopic({ topic, minStars = 1, cap = 1000, perPage = 100, maxSlices = 600,
  from = "2015-01-01", to = new Date().toISOString().slice(0, 10), cache = {}, http = defaultHttp,
  token = null, delayMs = 2200, onSlice = null } = {}) {
  const headers = token
    ? { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "agentgate-census-plan" }
    : { Accept: "application/vnd.github+json", "User-Agent": "agentgate-census-plan" }
  const queue = planSlices({ minStars })
  const slices = []
  let queries = 0
  let cached = 0
  let truncated = false
  let wouldTruncateAt = null

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  while (queue.length > 0) {
    if (slices.length >= maxSlices) { truncated = true; wouldTruncateAt = slices.length; break }
    const slice = queue.shift()
    const query = sliceQuery(topic, slice)
    let total = cache[query]
    if (total === undefined) {
      if (queries > 0) await wait(delayMs)
      const res = await http(SEARCH + "?q=" + encodeURIComponent(query) + "&per_page=1", headers)
      queries += 1
      if (res.status !== 200) { slices.push({ query, key: sliceKey(slice), total: null, pages: 0, error: res.status }); truncated = true; break }
      total = Number(JSON.parse(res.text).total_count) || 0
      cache[query] = total
    } else {
      cached += 1
    }

    const pages = Math.max(1, Math.min(Math.ceil(total / perPage), cap / perPage))
    const record = { query, key: sliceKey(slice), total, pages, overflowed: total > cap, from: slice.from, to: slice.to }
    slices.push(record)
    if (onSlice) onSlice(record)

    if (record.overflowed) {
      const lower = slice.from || from
      const upper = slice.to || to
      if (Date.parse(upper) - Date.parse(lower) < 3 * DAY) {
        truncated = true
        record.atFloor = true
      } else {
        for (const next of splitByPushed(slice, from, to)) queue.push(next)
      }
    }
  }

  return { topic, minStars, slices, queries, cached, truncated, wouldTruncateAt,
    requests: slices.reduce((n, s) => n + s.pages, 0) }
}

const isMain = process.argv[1] && process.argv[1].endsWith("plan-census.mjs")
if (isMain) {
  const topics = String(argOf("topics", "mcp-server")).split(",").map((t) => t.trim()).filter(Boolean)
  const minStars = Number(argOf("min-stars", 1))
  const out = argOf("out", null)
  const cachePath = String(argOf("cache", "/tmp/census-plan-cache.json"))
  const token = process.env.GH_TOKEN || null
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {}

  const started = Date.now()
  const plans = []
  for (const topic of topics) {
    const plan = await planTopic({ topic, minStars, token, cache,
      onSlice: (s) => process.stderr.write("  " + (s.overflowed ? "OVER " : "     ") + String(s.total).padStart(7) + "  " + s.query + String.fromCharCode(10)) })
    plans.push(plan)
    writeFileSync(cachePath, JSON.stringify(cache))
    process.stderr.write(String.fromCharCode(10))
    process.stderr.write("[" + topic + "] slices " + plan.slices.length + "  pages " + plan.requests
      + "  queries " + plan.queries + " (cached " + plan.cached + ")"
      + "  truncated " + plan.truncated + String.fromCharCode(10))
  }

  const totalPages = plans.reduce((n, p) => n + p.requests, 0)
  // Fetched rows, not unique repositories: the topics overlap, so the same repo is paid for once
  // per topic it carries. That is the honest cost of a union built from separate queries.
  const rows = plans.reduce((n, p) => n + p.slices.reduce((m, s) => m + s.total, 0), 0)
  const summary = {
    topics, minStars, slices: plans.reduce((n, p) => n + p.slices.length, 0),
    pages: totalPages, rows,
    truncated: plans.some((p) => p.truncated),
    atFloor: plans.flatMap((p) => p.slices.filter((s) => s.atFloor).map((s) => s.query)),
    minutesAt2s: Math.round((totalPages * 2.2) / 60),
    seconds: Math.round((Date.now() - started) / 1000),
  }
  console.log(JSON.stringify(summary, null, 1))
  if (out) writeFileSync(String(out), JSON.stringify({ summary, plans }, null, 1))
}
