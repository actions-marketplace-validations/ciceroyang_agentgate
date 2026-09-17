/**
 * The service layer, zero dependencies.
 *
 * It serves the evidence index and nothing else. If the index is missing it says so
 * with a 503 rather than serving an empty, reassuring answer: a control plane that
 * cannot answer must not look like one that answered "nothing wrong".
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { inventoryResource } from "../../inventory/src/web.mjs"
import { summarize } from "../../history/src/ledger.mjs"

const COLORS = { clean: "#2ea043", findings: "#d29922", incomplete: "#8b949e" }

/** The three verdicts and nothing else. A record whose verdict is something else is
 *  rendered as unknown rather than echoed: the badge is an XML document served from this
 *  origin, and the index is an input like any other. */
const VERDICTS = { clean: "clean", findings: "findings", incomplete: "incomplete" }

/** Text going into an SVG document. A server is free to put anything in a registry
 *  entry; the badge must not become markup because of it. */
function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

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
  color = xml(color)
  right = xml(right)
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
  // How far back the record goes, and whether the last capture is recent. A daily job that stops
  // running is the one failure this project cannot recover from, so it belongs where anything
  // watching the service can see it, not only in a log on the same machine.
  const history = function () {
    if (!opts.historyPath) return null
    try {
      const s = summarize(opts.historyPath)
      const age = s.lastCapturedAt ? (Date.now() - Date.parse(s.lastCapturedAt)) / 3600000 : null
      return Object.assign({}, s, { ageHours: age === null ? null : Math.round(age * 10) / 10, stale: age === null || age > 26 })
    } catch (error) {
      return { error: "the ledger could not be read: " + String((error && error.message) || error) }
    }
  }
  return {
    handle: function (method, rawPath) {
      const url = new URL(rawPath, "http://localhost")
      const path = url.pathname
      if (method !== "GET") return json(405, { error: "only GET is served" })
      const inventory = inventoryResource(path, load)
      if (inventory) return inventory
      if (path === "/health") {
        const loaded = load()
        if (!loaded) return json(503, { ok: false, reason: "no usable index is present", hint: "run: node bin/agentgate.mjs refresh" })
        return json(200, { ok: true, index: loaded.path, generatedAt: loaded.data.generatedAt, records: loaded.data.count, threshold: loaded.data.threshold, history: history() })
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
      // The ledger itself, so the record can be mirrored somewhere other than this machine.
      // It is the raw JSONL: whoever mirrors it can check the chain without trusting this route.
      if (path === "/v1/history") {
        const ledgerPath = opts.historyPath ? join(opts.historyPath, "ledger.jsonl") : null
        if (!ledgerPath || !existsSync(ledgerPath)) return json(404, { error: "this deployment has no capture ledger" })
        return { status: 200, type: "application/x-ndjson; charset=utf-8", body: readFileSync(ledgerPath, "utf8") }
      }
      // The newest day-over-day diff, so the public mirror shows the same "what changed" the
      // deployment pages show without shipping a 2 MB index per day into git.
      if (path === "/v1/history/diff") {
        if (!opts.historyPath || !existsSync(opts.historyPath)) return json(404, { error: "this deployment has no capture ledger" })
        const names = readdirSync(opts.historyPath).filter(function (n) { return /^diff-[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$/.test(n) }).sort()
        if (names.length === 0) return json(404, { error: "no diff has been written yet" })
        return { status: 200, type: "text/markdown; charset=utf-8", body: readFileSync(join(opts.historyPath, names[names.length - 1]), "utf8") }
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
        const verdict = VERDICTS[record.verdict] || "unknown"
        return { status: 200, type: "image/svg+xml", body: svg("badge", COLORS[verdict] || "#8b949e", verdict) }
      }
      return json(404, { error: "no such route", routes: ["/health", "/v1/index/summary", "/v1/history", "/v1/servers", "/v1/servers/:name", "/badge/:name.svg"] })
    },
  }
}
