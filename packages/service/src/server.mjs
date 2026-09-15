/**
 * The service layer, zero dependencies.
 *
 * It serves the evidence index and nothing else. If the index is missing it says so
 * with a 503 rather than serving an empty, reassuring answer: a control plane that
 * cannot answer must not look like one that answered "nothing wrong".
 */
import { readFileSync, existsSync, statSync } from "node:fs"

const COLORS = { clean: "#2ea043", findings: "#d29922", incomplete: "#8b949e" }

/**
 * The parsed index is cached and revalidated by modification time and size.
 *
 * Without this, every request re-read and re-parsed the whole file: 30ms per lookup on a
 * nine-megabyte index, which does not get better as the registry grows. The revalidation
 * is the load-bearing part - the runbook promises that a refresh takes effect without a
 * restart, and a cache without it would quietly break that promise.
 */
const cache = new Map()

export function clearIndexCache() { cache.clear() }

export function loadIndex(paths) {
  const candidates = paths.filter(Boolean)
  for (const p of candidates) {
    if (!existsSync(p)) continue
    let stat
    try { stat = statSync(p) } catch (error) { continue }
    const hit = cache.get(p)
    if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) {
      return { path: p, mtime: stat.mtimeMs, data: hit.data }
    }
    let data
    try { data = JSON.parse(readFileSync(p, "utf8")) } catch (error) { cache.delete(p); continue }
    if (!data || !Array.isArray(data.records)) { cache.delete(p); continue }
    cache.set(p, { mtime: stat.mtimeMs, size: stat.size, data: data })
    return { path: p, mtime: stat.mtimeMs, data: data }
  }
  return null
}

export function matchRecords(records, query) {
  const usable = (records || []).filter(function (r) { return r && typeof r.server === "string" })
  const q = String(query).toLowerCase()
  const exact = usable.filter(function (r) { return r.server.toLowerCase() === q })
  if (exact.length > 0) return exact
  return usable.filter(function (r) { return r.server.toLowerCase().indexOf(q) !== -1 })
}

function svg(text, color, right) {
  const left = "agentgate"
  const w1 = 78
  const w2 = Math.max(46, 8 * right.length)
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + (w1 + w2) + '" height="20" role="img" aria-label="' + left + ": " + right + '">',
    '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>',
    '<clipPath id="r"><rect width="' + (w1 + w2) + '" height="20" rx="3" fill="#fff"/></clipPath>',
    '<g clip-path="url(#r)"><rect width="' + w1 + '" height="20" fill="#555"/><rect x="' + w1 + '" width="' + w2 + '" height="20" fill="' + color + '"/><rect width="' + (w1 + w2) + '" height="20" fill="url(#s)"/></g>',
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">',
    '<text x="' + (w1 / 2) + '" y="15" fill="#010101" fill-opacity=".3">' + left + '</text>',
    '<text x="' + (w1 / 2) + '" y="14">' + left + '</text>',
    '<text x="' + (w1 + w2 / 2) + '" y="15" fill="#010101" fill-opacity=".3">' + right + '</text>',
    '<text x="' + (w1 + w2 / 2) + '" y="14">' + right + '</text>',
    '</g></svg>',
  ].join("")
}

export function createService(options) {
  const opts = options || {}
  const load = function () { return loadIndex([opts.indexPath, opts.samplePath]) }
  const json = function (status, body) { return { status: status, type: "application/json; charset=utf-8", body: JSON.stringify(body, null, 2) + "\n" } }
  return {
    handle: function (method, rawPath) {
      const url = new URL(rawPath, "http://localhost")
      const path = url.pathname
      if (method !== "GET") return json(405, { error: "only GET is served" })
      if (path === "/health") {
        const loaded = load()
        if (!loaded) return json(503, { ok: false, reason: "no usable index is present", hint: "run: node bin/agentgate.mjs refresh" })
        return json(200, { ok: true, index: loaded.path, generatedAt: loaded.data.generatedAt, records: loaded.data.count, threshold: loaded.data.threshold })
      }
      const loaded = load()
      if (!loaded) return json(503, { error: "no usable index is present; a file without a records array is not an index", hint: "run: node bin/agentgate.mjs refresh" })
      const index = loaded.data
      const records = index.records || []
      if (path === "/v1/index/summary") {
        const verdicts = {}
        for (const r of records) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1
        return json(200, { generatedAt: index.generatedAt, threshold: index.threshold, count: index.count, verdicts: verdicts, source: loaded.path })
      }
      if (path === "/v1/servers") {
        const q = url.searchParams.get("q")
        const verdict = url.searchParams.get("verdict")
        const limit = Math.min(Number(url.searchParams.get("limit") || 50) || 50, 500)
        let out = q ? matchRecords(records, q) : records.slice()
        if (verdict) out = out.filter(function (r) { return r.verdict === verdict })
        return json(200, { count: out.length, returned: Math.min(out.length, limit), records: out.slice(0, limit).map(function (r) { return { server: r.server, verdict: r.verdict, packages: r.packages } }) })
      }
      const serverMatch = /^\/v1\/servers\/(.+)$/.exec(path)
      if (serverMatch) {
        const name = decodeURIComponent(serverMatch[1])
        const found = matchRecords(records, name)
        if (found.length === 0) return json(404, { error: "no server matches " + name, known: records.length })
        if (found.length > 1) return json(300, { error: "ambiguous", matches: found.slice(0, 25).map(function (r) { return r.server }) })
        return json(200, found[0])
      }
      const badgeMatch = /^\/badge\/(.+)\.svg$/.exec(path)
      if (badgeMatch) {
        const name = decodeURIComponent(badgeMatch[1])
        const found = matchRecords(records, name)
        if (found.length !== 1) return { status: 200, type: "image/svg+xml", body: svg("badge", "#8b949e", "unknown") }
        const record = found[0]
        return { status: 200, type: "image/svg+xml", body: svg("badge", COLORS[record.verdict] || "#8b949e", record.verdict) }
      }
      return json(404, { error: "no such route", routes: ["/health", "/v1/index/summary", "/v1/servers", "/v1/servers/:name", "/badge/:name.svg"] })
    },
  }
}
