import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchDir } from "../../../test/tmpdir.mjs"
import { start } from "../src/start.mjs"
import { appendCapture } from "../../history/src/ledger.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const BIN = join(ROOT, "bin", "agentgate.mjs")

function fixtureIndex(dir, records) {
  const indexPath = join(dir, "index.json")
  writeFileSync(indexPath, JSON.stringify({ generatedAt: "2026-09-17T00:00:00.000Z", threshold: "medium", count: records.length, records: records }))
  return indexPath
}

async function withServer(options, body) {
  const server = start(Object.assign({ port: 0, host: "127.0.0.1" }, options))
  await new Promise(function (resolve) { server.once("listening", resolve) })
  const base = "http://127.0.0.1:" + server.address().port
  try { await body(base) } finally { await new Promise(function (resolve) { server.close(resolve) }) }
}

test("/metrics answers on loopback and reports the index and the counters", async function () {
  const dir = scratchDir("ag-metrics-")
  const indexPath = fixtureIndex(dir, [{ server: "a/one", verdict: "clean" }])
  const logged = []
  await withServer({ indexPath: indexPath, accessLog: function (line) { logged.push(line) } }, async function (base) {
    const health = await fetch(base + "/health")
    assert.equal(health.status, 200)
    assert.ok(health.headers.get("x-request-id"), "every answer carries a request id")
    const metrics = await fetch(base + "/metrics")
    assert.equal(metrics.status, 200)
    assert.match(metrics.headers.get("content-type"), /text\/plain/)
    const text = await metrics.text()
    assert.match(text, /agentgate_http_requests_total\{route="\/health",status="200"\} 1/)
    assert.match(text, /agentgate_health_ok 1/)
    assert.match(text, /agentgate_index_records 1/)
    assert.match(text, /agentgate_index_age_seconds \d+/)
    assert.equal(text.indexOf("history_captures"), -1, "no history path means no history gauges")
  })
  assert.equal(logged.length, 2)
})

test("a scanned path cannot appear in the metrics or in the access log", async function () {
  const dir = scratchDir("ag-metrics-")
  const indexPath = fixtureIndex(dir, [{ server: "a/one", verdict: "clean" }])
  const logged = []
  await withServer({ indexPath: indexPath, accessLog: function (line) { logged.push(line) } }, async function (base) {
    const secretish = "/v1/servers/secret-name-203.0.113.7?token=abcdef"
    await fetch(base + secretish)
    const text = await (await fetch(base + "/metrics")).text()
    assert.equal(text.indexOf("secret-name"), -1)
    assert.equal(text.indexOf("203.0.113.7"), -1)
    assert.match(text, /agentgate_http_requests_total\{route="\/v1\/servers\/:name",status="404"\} 1/)
    const line = logged[0]
    assert.equal(line.indexOf("secret-name"), -1)
    assert.equal(line.indexOf("token"), -1)
  })
})

test("the history ledger turns into gauges", async function () {
  const dir = scratchDir("ag-metrics-")
  const indexPath = fixtureIndex(dir, [{ server: "a/one", verdict: "clean" }])
  const historyDir = join(dir, "history")
  mkdirSync(historyDir, { recursive: true })
  appendCapture(historyDir, { index: { records: [{ server: "a/one", verdict: "clean" }] }, indexFile: indexPath })
  await withServer({ indexPath: indexPath, historyPath: historyDir }, async function (base) {
    const text = await (await fetch(base + "/metrics")).text()
    assert.match(text, /agentgate_history_captures 1/)
    assert.match(text, /agentgate_history_stale 0/)
    assert.match(text, /agentgate_history_age_seconds \d+/)
  })
})

test("a service with no index is health_ok 0 rather than an empty scrape", async function () {
  const dir = scratchDir("ag-metrics-")
  await withServer({ indexPath: join(dir, "missing.json"), samplePath: join(dir, "missing-sample.json") }, async function (base) {
    const text = await (await fetch(base + "/metrics")).text()
    assert.match(text, /agentgate_health_ok 0/)
    assert.equal(text.indexOf("agentgate_index_records "), -1)
  })
})

test("SIGTERM shuts the process down cleanly", async function () {
  const dir = scratchDir("ag-metrics-")
  const indexPath = fixtureIndex(dir, [{ server: "a/one", verdict: "clean" }])
  const child = spawn(process.execPath, [BIN, "serve", "--index", indexPath, "--port", "0"], { cwd: ROOT })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", function (chunk) { stdout += chunk })
  child.stderr.on("data", function (chunk) { stderr += chunk })
  await new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error("no startup line: " + stdout + stderr)) }, 10000)
    child.stdout.on("data", function () {
      if (stdout.indexOf("agentgate serving") !== -1) { clearTimeout(timer); resolve() }
    })
  })
  child.kill("SIGTERM")
  const code = await new Promise(function (resolve) { child.on("exit", resolve) })
  assert.equal(code, 0, "SIGTERM is a request to stop, not a crash: " + stderr)
  assert.match(stderr, /shutdown: SIGTERM/)
})
