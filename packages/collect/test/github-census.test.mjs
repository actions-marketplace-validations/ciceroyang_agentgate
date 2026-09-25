import test from "node:test"
import assert from "node:assert/strict"
import { normalizeRepoUrl, planSlices, sliceQuery, searchUrl, collectTopic } from "../github-census.mjs"

test("one canonical repository URL, whatever form the source used", function () {
  assert.equal(normalizeRepoUrl("https://github.com/Foo/Bar"), "https://github.com/foo/bar")
  assert.equal(normalizeRepoUrl("https://github.com/Foo/Bar.git"), "https://github.com/foo/bar")
  assert.equal(normalizeRepoUrl("https://www.github.com/Foo/Bar/"), "https://github.com/foo/bar")
  assert.equal(normalizeRepoUrl("git@github.com:Foo/Bar.git"), "https://github.com/foo/bar")
  assert.equal(normalizeRepoUrl("https://github.com/Foo/Bar#readme"), "https://github.com/foo/bar")
  assert.equal(normalizeRepoUrl("https://gitlab.com/Foo/Bar"), null)
  assert.equal(normalizeRepoUrl(""), null)
  assert.equal(normalizeRepoUrl(null), null)
})

test("star buckets, and the zero-star tail can be left out on purpose", function () {
  assert.equal(planSlices({}).length, 11)
  const noZero = planSlices({ minStars: 1 })
  assert.equal(noZero.some(function (s) { return s.stars === "0" }), false)
  assert.equal(noZero.length, 10)
  assert.equal(sliceQuery("mcp-server", { stars: "10..19", pushed: null }), "topic:mcp-server stars:10..19")
  assert.match(searchUrl("topic:mcp-server stars:1", 3, 100), /page=3&sort=stars/)
})

function stubHttp(pages) {
  const seen = []
  const http = async function (url) {
    const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)[1])
    const page = Number(/[?&]page=(\d+)/.exec(url)[1])
    seen.push({ q: q, page: page })
    const answer = pages(q, page)
    return { status: 200, url: url, text: JSON.stringify(answer) }
  }
  return { http: http, seen: seen }
}

function repo(fullName, stars) {
  const owner = fullName.split("/")[0]
  const name = fullName.split("/")[1]
  return { full_name: fullName, html_url: "https://github.com/" + fullName, stargazers_count: stars,
    forks_count: 1, archived: false, license: { spdx_id: "MIT" }, pushed_at: "2026-09-01T00:00:00Z",
    created_at: "2025-01-01T00:00:00Z", description: null, default_branch: "main", owner: { login: owner }, name: name }
}

test("a slice that overflows the API cap is split by push date instead of being truncated", async function () {
  const huge = Array.from({ length: 100 }, function (_, i) { return repo("big/repo" + i, 5) })
  const stub = stubHttp(function (q, page) {
    if (q.indexOf("pushed:") === -1 && q.indexOf("stars:>=1000") !== -1) {
      return { total_count: 1500, items: page === 1 ? huge : [] }
    }
    if (q.indexOf("pushed:") !== -1) return { total_count: 2, items: [repo("small/one", 1200)] }
    return { total_count: 0, items: [] }
  })
  const result = await collectTopic({ http: stub.http, delayMs: 0, perPage: 100, cap: 1000 })
  assert.equal(result.repos.length, 101, "the overflow slice plus the split result, de-duplicated")
  assert.equal(result.truncated, false)
  assert.ok(stub.seen.some(function (s) { return s.q.indexOf("pushed:") !== -1 }), "the overflowing slice has to be split")
  const first = result.slices[0]
  assert.equal(first.overflowed, true)
  assert.equal(first.total, 1500)
})

test("a slice too small to split further is reported as truncated, not smoothed over", async function () {
  const stub = stubHttp(function (q) {
    if (q.indexOf("pushed:") === -1 && q.indexOf("stars:>=1000") !== -1) {
    return { total_count: 5000, items: Array.from({ length: 100 }, function (_, i) { return repo("x/r" + i, 900) }) }
    }
    if (q.indexOf("pushed:") !== -1) return { total_count: 3000, items: Array.from({ length: 100 }, function (_, i) { return repo("y/s" + i, 800) }) }
    return { total_count: 0, items: [] }
  })
  const result = await collectTopic({ http: stub.http, delayMs: 0, perPage: 100, cap: 1000, from: "2026-09-15", to: "2026-09-16" })
  assert.equal(result.truncated, true, "a window that cannot be split any further must say so")
})

test("a finished slice is not fetched twice, and a resume keeps what it already has", async function () {
  const stub = stubHttp(function (q) {
    if (q.indexOf("stars:>=1000") !== -1 && q.indexOf("pushed:") === -1) return { total_count: 1, items: [repo("kept/one", 2000)] }
    return { total_count: 0, items: [] }
  })
  const done = new Set([">=1000||"])
  const result = await collectTopic({ http: stub.http, delayMs: 0, done: done, seedRepos: [repo("seeded/two", 10)].map(function (r) {
    return { fullName: "seeded/two", repoUrl: "https://github.com/seeded/two", owner: "seeded", name: "two", stars: 10, forks: 0, archived: false, license: null, pushedAt: null, createdAt: null, description: null, defaultBranch: null }
  }) })
  assert.equal(stub.seen.some(function (s) { return s.q.indexOf("stars:>=1000") !== -1 && s.q.indexOf("pushed:") === -1 }), false, "a slice already marked done must not be requested again")
  assert.equal(result.repos.length, 1)
  assert.equal(result.repos[0].fullName, "seeded/two")
})

test("a request that never succeeds is reported, not looped on forever", async function () {
  let calls = 0
  const http = async function () { calls += 1; return { status: 0, text: "" } }
  const result = await collectTopic({ http: http, delayMs: 0, retries: 1, maxSlices: 1 })
  assert.equal(result.truncated, true)
  assert.equal(result.slices[0].failed, 0)
  assert.ok(calls >= 2, "it has to retry before giving up")
})
test("the same repository twice is one repository", async function () {
  const stub = stubHttp(function (q) {
    if (q.indexOf("stars:>=1000") !== -1) return { total_count: 1, items: [repo("Dup/One", 2000)] }
    if (q.indexOf("stars:500..999") !== -1) return { total_count: 1, items: [repo("dup/one", 700)] }
    return { total_count: 0, items: [] }
  })
  const result = await collectTopic({ http: stub.http, delayMs: 0 })
  assert.equal(result.repos.length, 1)
  assert.equal(result.repos[0].fullName, "dup/one")
})