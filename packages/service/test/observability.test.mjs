import test from "node:test"
import assert from "node:assert/strict"
import { createAccessLog, createMetrics, isLoopback, requestIdOf, routeTemplate } from "../src/observability.mjs"

test("known routes keep their name and everything unknown collapses", function () {
  assert.equal(routeTemplate("/health"), "/health")
  assert.equal(routeTemplate("/v1/index/summary"), "/v1/index/summary")
  assert.equal(routeTemplate("/v1/servers/acme%2Fthing"), "/v1/servers/:name")
  assert.equal(routeTemplate("/badge/acme%2Fthing.svg"), "/badge/:name.svg")
  assert.equal(routeTemplate("/v1/servers?q=x&limit=1"), "/v1/servers")
  assert.equal(routeTemplate("/../../etc/passwd"), "/other")
  assert.equal(routeTemplate(""), "/other")
})

test("a thousand different paths do not become a thousand labels", function () {
  const labels = new Set()
  for (let i = 0; i < 1000; i += 1) labels.add(routeTemplate("/v1/servers/name-" + i + "?token=" + i))
  assert.deepEqual(Array.from(labels), ["/v1/servers/:name"])
})

test("only a plain request id from the caller is trusted, and only when it is an id", function () {
  assert.equal(requestIdOf({ "x-request-id": "abc12345" }), "abc12345")
  assert.notEqual(requestIdOf({ "x-request-id": "short" }).length, 5)
  assert.notEqual(requestIdOf({ "x-request-id": "x".repeat(200) }), "x".repeat(200))
  assert.notEqual(requestIdOf({ "x-request-id": "bad\nvalue-injected" }), "bad\nvalue-injected")
  assert.notEqual(requestIdOf({}), requestIdOf({}))
})

test("loopback is recognised, and nothing else is", function () {
  assert.equal(isLoopback("127.0.0.1"), true)
  assert.equal(isLoopback("::1"), true)
  assert.equal(isLoopback("::ffff:127.0.0.1"), true)
  assert.equal(isLoopback("10.0.0.5"), false)
  assert.equal(isLoopback(undefined), false)
})

test("counters aggregate and the exposition format is what a scraper expects", function () {
  const metrics = createMetrics({ now: function () { return 0 } })
  metrics.observeRequest("/health", 200, 2)
  metrics.observeRequest("/health", 200, 4)
  metrics.observeRequest("/v1/servers/:name", 404, 6)
  metrics.increment("errors_total", 1)
  const text = metrics.render({ index_records: 7 }, 1000)
  assert.match(text, /agentgate_http_requests_total\{route="\/health",status="200"\} 2/)
  assert.match(text, /agentgate_http_request_duration_seconds_count\{route="\/health"\} 2/)
  assert.match(text, /agentgate_http_request_duration_seconds_sum\{route="\/health"\} 0\.006000/)
  assert.match(text, /agentgate_index_records 7/)
  assert.match(text, /agentgate_uptime_seconds 1\.000/)
  assert.match(text, /agentgate_errors_total 1/)
  assert.match(text, /^# TYPE agentgate_http_requests_total counter$/m)
})

test("a gauge that is not a number is left out and counted, never printed as NaN", function () {
  const metrics = createMetrics({ now: function () { return 0 } })
  const text = metrics.render({ index_records: Number.NaN, health_ok: 1, nothing: undefined }, 0)
  assert.equal(text.indexOf("NaN"), -1)
  assert.match(text, /agentgate_metrics_nonfinite_total 2/)
  assert.match(text, /agentgate_health_ok 1/)
})

test("an access log line names the request and nobody else", function () {
  const lines = []
  const log = createAccessLog(function (line) { lines.push(line) })
  log({ method: "GET", route: "/other", status: 404, ms: 3, requestId: "abc12345" })
  const parsed = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(parsed).sort(), ["method", "ms", "requestId", "route", "status", "ts"])
  assert.equal(JSON.stringify(parsed).indexOf("203.0.113.7"), -1)
})
