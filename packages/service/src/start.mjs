import { createServer } from "node:http"
import { createService } from "./server.mjs"
import { DEFAULT_PORT, DEFAULT_HOST } from "./defaults.mjs"
import { createMetrics, createAccessLog, routeTemplate, requestIdOf, isLoopback } from "./observability.mjs"

/**
 * The gauges for /metrics.
 *
 * It asks the service rather than re-reading the index, so a scrape can never disagree with
 * /health, and it never throws: a service that cannot answer is reported as health_ok 0 with the
 * other gauges absent, which is the same shape as every other "unmeasured" answer here.
 */
function gaugeSnapshot(service, nowMs) {
  const gauges = {}
  try {
    const out = service.handle("GET", "/health")
    if (!out || out.status !== 200) { gauges.health_ok = 0; return gauges }
    const body = JSON.parse(out.body)
    gauges.health_ok = 1
    if (typeof body.records === "number") gauges.index_records = body.records
    const generated = Date.parse(body.generatedAt)
    if (Number.isFinite(generated)) gauges.index_age_seconds = Math.max(0, Math.round((nowMs - generated) / 1000))
    const history = body.history
    if (history) {
      if (typeof history.captures === "number") gauges.history_captures = history.captures
      if (typeof history.gaps === "number") gauges.history_gaps = history.gaps
      if (typeof history.ageHours === "number") gauges.history_age_seconds = Math.round(history.ageHours * 3600)
      gauges.history_stale = history.stale === true ? 1 : 0
    }
  } catch (error) {
    gauges.health_ok = 0
  }
  return gauges
}

export function start(options) {
  const service = options.service || createService(options)
  const now = typeof options.now === "function" ? options.now : Date.now
  const metrics = options.metrics || createMetrics({ now: now })
  const accessLog = options.accessLog === true
    ? createAccessLog(function (line) { process.stdout.write(line) })
    : typeof options.accessLog === "function" ? createAccessLog(options.accessLog) : null
  const server = createServer(function (req, res) {
    const startedAt = process.hrtime.bigint()
    const route = routeTemplate(req.url)
    const requestId = requestIdOf(req.headers)
    res.setHeader("x-request-id", requestId)
    const finish = function (status) {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
      metrics.observeRequest(route, status, ms)
      if (accessLog) accessLog({ method: req.method, route: route, status: status, ms: Math.round(ms), requestId: requestId })
    }
    if (route === "/metrics") {
      // Loopback only. Caddy does not proxy this path, and if the service were bound to a public
      // interface anyway, the counters are still not the internet's business.
      if (!isLoopback(req.socket && req.socket.remoteAddress)) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        res.end(JSON.stringify({ error: "no such route" }) + "\n")
        finish(404)
        return
      }
      const body = metrics.render(gaugeSnapshot(service, now()), now())
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" })
      res.end(body)
      finish(200)
      return
    }
    let out
    try {
      out = service.handle(req.method, req.url)
    } catch (error) {
      // An exception must not kill the process or look like an answer. It is a 500,
      // and the body says so in the same words the rest of the tool uses.
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ error: "the service failed to answer, which is not a pass", detail: String((error && error.message) || error) }) + "\n")
      finish(500)
      return
    }
    res.writeHead(out.status, Object.assign({ "content-type": out.type }, out.headers || {}))
    res.end(out.body)
    finish(out.status)
  })
  // 0 is a valid port that asks the operating system for a free one. "options.port || 8080"
  // quietly turned it into 8080, so a caller asking for an ephemeral port got the default instead.
  const port = options.port === undefined || options.port === null ? DEFAULT_PORT : options.port
  server.listen(port, options.host || DEFAULT_HOST, options.onListening)
  return server
}
