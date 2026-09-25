#!/usr/bin/env node
/**
 * The other census: repositories, not registrations.
 *
 * The registry census reads one endpoint, and that endpoint currently lists about two thousand
 * servers. GitHub has tens of thousands of repositories that call themselves MCP servers and never
 * appear in that registry — which is why a company can publish one, be asked about it by a
 * customer, and be absent from our index entirely.
 *
 * Three facts shape this collector. First, the search API will not page past 1,000 results for one
 * query, so the enumeration is sliced by star bucket and, when a slice is still full, split by push
 * date until every slice fits. Second, the search payload already carries every field recorded
 * here, so there is no per-repository request. Third, a crawl this long meets transient failures,
 * so a request is retried with backoff and each finished slice is checkpointed — a census that dies
 * at slice 300 and starts over is a census that never finishes.
 *
 * Static and read-only: it authenticates to GitHub, reads public repository metadata, and writes a
 * file. It never clones, never executes anything, and never sends credentials anywhere else.
 *
 *   node packages/collect/github-census.mjs --topic mcp-server --out data/github-census.json
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

export const SCHEMA = 'agentgate.github-census/v1'
export const SEARCH = 'https://api.github.com/search/repositories'

export function defaultHttp(url, headers) {
  return fetch(url, { headers: headers || {}, redirect: 'follow', signal: AbortSignal.timeout(30000) })
    .then(async (res) => ({ status: res.status, url: res.url, text: res.status === 200 ? await res.text() : '' }))
    .catch(() => ({ status: 0, text: '' }))
}

/** One canonical form per repository, so two sources can be compared without guessing. */
export function normalizeRepoUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const trimmed = value.trim().replace(/[#?].*$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  const match = /^(?:git@)?(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/]+)\/([^/]+)$/i.exec(trimmed.replace(/^git@github\.com:/, 'git@github.com/'))
  if (!match) return null
  return 'https://github.com/' + match[1].toLowerCase() + '/' + match[2].toLowerCase()
}

export function normalizeFullName(value) {
  if (typeof value !== 'string') return null
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim())
  if (!match) return null
  return (match[1] + '/' + match[2]).toLowerCase()
}

/** Star buckets, widest first. A bucket that still overflows is split by push date. */
export function planSlices({ minStars = 0 } = {}) {
  const buckets = ['>=1000', '500..999', '200..499', '100..199', '50..99', '20..49', '10..19', '5..9', '2..4', '1', '0']
  return buckets
    .filter((bucket) => {
      if (bucket === '0') return minStars <= 0
      const low = bucket.startsWith('>=') ? Number(bucket.slice(2)) : Number(bucket.split('..')[0])
      return minStars <= 0 || low >= minStars
    })
    .map((bucket) => ({ stars: bucket, from: null, to: null }))
}

/** Both children carry explicit bounds; a '>=' string is not a date and Date.parse would say NaN. */
export function splitByPushed(slice, overallFrom, overallTo) {
  const from = slice.from || overallFrom
  const to = slice.to || overallTo
  const mid = new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString().slice(0, 10)
  return [
    { stars: slice.stars, from: from, to: mid },
    { stars: slice.stars, from: mid, to: to },
  ]
}

export function sliceQuery(topic, slice) {
  const parts = ['topic:' + topic, 'stars:' + slice.stars]
  if (slice.from && slice.to) parts.push('pushed:' + slice.from + '..' + slice.to)
  return parts.join(' ')
}

export function sliceKey(slice) { return slice.stars + '|' + (slice.from || '') + '|' + (slice.to || '') }

export function searchUrl(query, page, perPage) {
  return SEARCH + '?q=' + encodeURIComponent(query) + '&per_page=' + perPage + '&page=' + page + '&sort=stars&order=desc'
}

function projectRepo(repo) {
  const fullName = normalizeFullName(repo.full_name || ((repo.owner && repo.owner.login ? repo.owner.login : '') + '/' + (repo.name || '')))
  if (!fullName) return null
  return {
    fullName,
    repoUrl: normalizeRepoUrl(repo.html_url || ('https://github.com/' + fullName)),
    owner: fullName.split('/')[0],
    name: fullName.split('/')[1],
    stars: Number.isInteger(repo.stargazers_count) ? repo.stargazers_count : null,
    forks: Number.isInteger(repo.forks_count) ? repo.forks_count : null,
    archived: repo.archived === true,
    license: repo.license && repo.license.spdx_id ? repo.license.spdx_id : null,
    pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null,
    createdAt: typeof repo.created_at === 'string' ? repo.created_at : null,
    description: typeof repo.description === 'string' ? repo.description : null,
    defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A transient failure must not end a crawl that is hundreds of requests long. */
async function fetchWithRetry(http, url, headers, { retries = 4, delayMs = 2100, onRetry = null } = {}) {
  let last = { status: 0, text: '' }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const backoff = delayMs * Math.pow(2, attempt)
      if (onRetry) onRetry({ attempt, status: last.status, waitMs: backoff })
      await wait(backoff)
    }
    last = await http(url, headers)
    if (last.status === 200) return last
    const retryable = last.status === 0 || last.status === 403 || last.status === 429 || last.status >= 500
    if (!retryable) return last
  }
  return last
}

/**
 * Enumerate a topic. Every slice that reports more than `cap` results is split by push date and
 * re-queued, because the API refuses to page past that cap and a silently truncated census is
 * exactly the kind of number this project exists to publish honestly.
 */
export async function collectTopic({
  topic = 'mcp-server', http = defaultHttp, token = null, headers = null,
  perPage = 100, cap = 1000, maxSlices = 600, minStars = 0, maxRepos = 40000,
  delayMs = 2100, retries = 4, since = null, from = '2015-01-01', to = new Date().toISOString().slice(0, 10),
  onPage = null, onSlice = null, done = null, seedRepos = null,
} = {}) {
  const auth = headers || (token ? { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'agentgate-github-census' } : { Accept: 'application/vnd.github+json', 'User-Agent': 'agentgate-github-census' })
  const finished = done instanceof Set ? done : new Set()
  // An incremental run only asks for what changed since the last one: same star buckets, but
  // every slice carries a push-date floor, so GitHub does the filtering for us.
  const queue = planSlices({ minStars })
    .map((slice) => (since ? { ...slice, from: since, to: to } : slice))
    .filter((slice) => !finished.has(sliceKey(slice)))
  const repos = new Map()
  for (const repo of seedRepos || []) repos.set(repo.fullName, repo)
  const slices = []
  let requests = 0
  let truncated = false
  while (queue.length > 0) {
    if (slices.length >= maxSlices || repos.size >= maxRepos) { truncated = queue.length > 0; break }
    const slice = queue.shift()
    const query = sliceQuery(topic, slice)
    let page = 1
    let total = null
    let fetched = 0
    let failed = null
    for (;;) {
      if (delayMs > 0 && requests > 0) await wait(delayMs)
      const res = await fetchWithRetry(http, searchUrl(query, page, perPage), auth, { retries, delayMs })
      requests += 1
      if (res.status !== 200) { failed = res.status; break }
      const json = JSON.parse(res.text)
      if (total === null) total = Number.isInteger(json.total_count) ? json.total_count : null
      const items = Array.isArray(json.items) ? json.items : []
      for (const item of items) {
        const repo = projectRepo(item)
        if (repo && !repos.has(repo.fullName) && repos.size < maxRepos) repos.set(repo.fullName, repo)
      }
      fetched += items.length
      if (onPage) onPage({ query, page, fetched, total, unique: repos.size })
      if (items.length < perPage || page >= cap / perPage) break
      page += 1
    }
    if (failed !== null) {
      slices.push({ query, key: sliceKey(slice), total, fetched, failed })
      truncated = true
      break
    }
    const overflowed = total !== null && total > cap
    const record = { query, key: sliceKey(slice), total, fetched, overflowed }
    slices.push(record)
    finished.add(sliceKey(slice))
    // The checkpoint has to include what has been collected, not only which slices are done:
    // a resume that skips work but restores no data is worse than no resume at all.
    if (onSlice) onSlice(record, [...repos.values()])
    if (overflowed) {
      const lower = slice.from || from
      const upper = slice.to || to
      if (Date.parse(upper) - Date.parse(lower) < 3 * 24 * 3600 * 1000) truncated = true
      else for (const next of splitByPushed(slice, from, to)) if (!finished.has(sliceKey(next))) queue.push(next)
    }
  }
  return { repos: [...repos.values()], slices, requests, truncated, done: [...finished] }
}

function argOf(name, fallback) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--' + name)
  if (at === -1) return fallback
  if (at + 1 >= argv.length || argv[at + 1].indexOf('--') === 0) return true
  return argv[at + 1]
}

if (process.argv[1] && process.argv[1].endsWith('github-census.mjs')) {
  const topic = String(argOf('topic', 'mcp-server'))
  const out = String(argOf('out', 'data/github-census.json'))
  const token = argOf('token', process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null)
  const minStars = Number(argOf('min-stars', 0))
  const maxRepos = Number(argOf('max-repos', 40000))
  const delayMs = Number(argOf('delay-ms', 2100))
  // Incremental mode: --since <date> asks only for repositories pushed since then, and the previous
  // output is loaded first so the new run unions with it instead of replacing it.
  const since = argOf('since', null)
  const partial = since === true ? out + '.partial.json' : (since ? out + '.since.partial.json' : out + '.partial.json')
  let seedRepos = []
  let done = new Set()
  if (since && since !== true && existsSync(out)) {
    try {
      const previous = JSON.parse(readFileSync(out, 'utf8'))
      seedRepos = previous.repos || []
      process.stderr.write('incremental: seeded ' + seedRepos.length + ' repos from ' + out + String.fromCharCode(10))
    } catch (error) { process.stderr.write('could not read ' + out + ': ' + error.message + String.fromCharCode(10)) }
  }
  if (existsSync(partial)) {
    try {
      const previous = JSON.parse(readFileSync(partial, 'utf8'))
      seedRepos = previous.repos || []
      done = new Set(previous.done || [])
      process.stderr.write('resuming: ' + seedRepos.length + ' repos, ' + done.size + ' slices already done' + String.fromCharCode(10))
    } catch (error) { process.stderr.write('could not read ' + partial + ': ' + error.message + String.fromCharCode(10)) }
  }
  const started = Date.now()
  const checkpoint = (result) => {
    writeFileSync(partial, JSON.stringify({ repos: result.repos, done: result.done }) )
  }
  const running = { repos: seedRepos, done: [...done] }
  collectTopic({ topic, token, minStars, maxRepos, delayMs, seedRepos, done, since: since === true ? null : since,
    onPage: (p) => { if (p.page === 1 || p.page % 5 === 0) process.stderr.write('[' + topic + '] ' + p.query + ' page ' + p.page + ' (' + p.unique + ' unique, total ' + p.total + ')' + String.fromCharCode(10)) },
    onSlice: (slice, repos) => {
      running.repos = repos
      running.done.push(slice.key)
      if (running.done.length % 5 === 1 || slice.overflowed) checkpoint(running)
    },
  }).then((result) => {
    const byOwner = new Map()
    for (const repo of result.repos) byOwner.set(repo.owner, (byOwner.get(repo.owner) || 0) + 1)
    const payload = {
      schemaVersion: SCHEMA,
      generatedAt: new Date().toISOString(),
      topic, source: SEARCH, minStars, since: since === true ? null : since,
      truncated: result.truncated,
      requests: result.requests,
      slices: result.slices,
      counts: { repos: result.repos.length, owners: byOwner.size, archived: result.repos.filter((r) => r.archived).length,
        withStars: result.repos.filter((r) => (r.stars || 0) > 0).length, multiRepoOwners: [...byOwner.values()].filter((n) => n >= 2).length },
      repos: result.repos,
    }
    writeFileSync(out, JSON.stringify(payload, null, 2) + String.fromCharCode(10))
    process.stderr.write('wrote ' + out + ' in ' + Math.round((Date.now() - started) / 1000) + 's' + String.fromCharCode(10))
    console.log(JSON.stringify({ topic, minStars, repos: payload.counts.repos, owners: payload.counts.owners, multiRepoOwners: payload.counts.multiRepoOwners, requests: result.requests, truncated: result.truncated, seconds: Math.round((Date.now() - started) / 1000) }))
  }).catch((error) => { console.error('github-census: ' + error.message); process.exit(2) })
}