/**
 * What the service says about itself, and what it refuses to say.
 *
 * Two rules from the rest of the project apply here. A metric label must never be a string an
 * outside caller chose: an unrecognised path is counted as "/other", so a scanner cannot grow
 * the metric set without bound and turn a scrape into a memory leak. And the default output
 * identifies nobody - no address, no user agent, no query string - because the deployment's own
 * data-handling page promises that, and a log line is the easiest place to break such a promise.
 *
 * Zero dependencies, like the rest of the service.
 */
import { randomUUID } from "node:crypto"

const EXACT_ROUTES = [
  "/", "/health", "/metrics", "/inventory.html",
  "/v1/index/summary", "/v1/history", "/v1/history/diff", "/v1/servers",
]

/** A bounded set of labels for an unbounded set of paths. */
export function routeTemplate(rawPath) {
  let path = String(rawPath === undefined || rawPath === null ? "/" : rawPath)
  const cut = path.indexOf("?")
  if (cut !== -1) path = path.slice(0, cut)
  if (EXACT_ROUTES.indexOf(path) !== -1) return path
  if (/^\/v1\/servers\/[^/]+$/.test(path)) return "/v1/servers/:name"
  if (/^\/badge\/[^/]+\.svg$/.test(path)) return "/badge/:name.svg"
  if (path.indexOf("/v1/") === 0) return "/v1/other"
  return "/other"
}

/** The service is meant to be reached through Caddy on loopback; /metrics is for this machine. */
export function isLoopback(address) {
  if (typeof address !== "string") return false
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/

/** A caller-supplied id is kept only when it is a plain identifier; otherwise we make one. */
export function requestIdOf(headers) {
  const provided = headers && headers["x-request-id"]
  if (typeof provided === "string" && REQUEST_ID.test(provided)) return provided
  return randomUUID()
}

function labelValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

function labels(pairs) {
  const keys = Object.keys(pairs)
  if (keys.length === 0) return ""
  return "{" + keys.map(function (key) { return key + '="' + labelValue(pairs[key]) + '"' }).join(",") + "}"
}

export function createMetrics(options) {
  const startedAtMs = options && typeof options.now === "function" ? options.now() : Date.now()
  const requests = new Map()
  const durations = new Map()
  const counters = new Map()
  return {
    observeRequest(route, status, ms) {
      const key = route + "\u0000" + String(status)
      requests.set(key, (requests.get(key) || 0) + 1)
      const current = durations.get(route) || { sum: 0, count: 0 }
      current.sum += Number.isFinite(ms) ? ms : 0
      current.count += 1
      durations.set(route, current)
    },
    increment(name, value) {
      counters.set(name, (counters.get(name) || 0) + (typeof value === "number" ? value : 1))
    },
    /**
     * gauges: {name: number}. A value that is not a finite number is skipped and counted, so a
     * scraper never receives a NaN and the gap is still visible in the output.
     */
    render(gauges, nowMs) {
      const lines = []
      const out = function (text) { lines.push(text) }
      out("# HELP agentgate_http_requests_total HTTP requests by route and status.")
      out("# TYPE agentgate_http_requests_total counter")
      const requestKeys = Array.from(requests.keys()).sort()
      for (const key of requestKeys) {
        const parts = key.split("\u0000")
        out("agentgate_http_requests_total" + labels({ route: parts[0], status: parts[1] }) + " " + requests.get(key))
      }
      out("# HELP agentgate_http_request_duration_seconds Request duration by route.")
      out("# TYPE agentgate_http_request_duration_seconds summary")
      for (const route of Array.from(durations.keys()).sort()) {
        const value = durations.get(route)
        out("agentgate_http_request_duration_seconds_sum" + labels({ route: route }) + " " + (value.sum / 1000).toFixed(6))
        out("agentgate_http_request_duration_seconds_count" + labels({ route: route }) + " " + value.count)
      }
      let skipped = 0
      const gaugeKeys = Object.keys(gauges || {}).sort()
      for (const name of gaugeKeys) {
        const value = gauges[name]
        if (typeof value !== "number" || !Number.isFinite(value)) { skipped += 1; continue }
        out("agentgate_" + name + " " + value)
      }
      out("# HELP agentgate_metrics_nonfinite_total Gauges that were not a finite number and were not emitted.")
      out("# TYPE agentgate_metrics_nonfinite_total counter")
      out("agentgate_metrics_nonfinite_total " + skipped)
      out("# HELP agentgate_uptime_seconds Seconds since the process started this service.")
      out("# TYPE agentgate_uptime_seconds gauge")
      out("agentgate_uptime_seconds " + ((nowMs - startedAtMs) / 1000).toFixed(3))
      for (const name of Array.from(counters.keys()).sort()) {
        out("# TYPE agentgate_" + name + " counter")
        out("agentgate_" + name + " " + counters.get(name))
      }
      return lines.join("\n") + "\n"
    },
  }
}

/**
 * One JSON line per request. Deliberately absent: the client address, the user agent and the
 * query string - the first two identify a person and the third can carry their data.
 */
export function createAccessLog(write) {
  return function logAccess(entry) {
    write(JSON.stringify({
      ts: entry.ts || new Date().toISOString(),
      method: entry.method,
      route: entry.route,
      status: entry.status,
      ms: entry.ms,
      requestId: entry.requestId,
    }) + "\n")
  }
}

/**
 * SIGTERM from systemd is a request, not an execution. Finish what is in flight, then leave;
 * a stuck request must not keep a deploy from completing, so there is a deadline.
 */
export function installShutdown(server, options) {
  const opts = options || {}
  const graceMs = typeof opts.graceMs === "number" ? opts.graceMs : 5000
  const log = opts.log || function (line) { process.stderr.write(line + "\n") }
  const exit = opts.exit || function (code) { process.exit(code) }
  let closing = false
  const close = function (signal) {
    if (closing) return
    closing = true
    log("shutdown: " + signal)
    const timer = setTimeout(function () {
      log("shutdown: forcing exit after " + graceMs + "ms")
      exit(1)
    }, graceMs)
    if (typeof timer.unref === "function") timer.unref()
    server.close(function () {
      clearTimeout(timer)
      log("shutdown: closed")
      exit(0)
    })
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections()
  }
  const handlers = {
    SIGTERM: function () { close("SIGTERM") },
    SIGINT: function () { close("SIGINT") },
  }
  for (const signal of Object.keys(handlers)) process.on(signal, handlers[signal])
  return {
    close: close,
    remove: function () { for (const signal of Object.keys(handlers)) process.removeListener(signal, handlers[signal]) },
  }
}
