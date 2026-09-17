import test from "node:test"
import assert from "node:assert/strict"
import { request } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { scratchDir } from "../../../test/tmpdir.mjs"
import { start } from "../src/start.mjs"

function fixtureIndex() {
  const dir = scratchDir("ag-limits-")
  const indexPath = join(dir, "index.json")
  writeFileSync(indexPath, JSON.stringify({ generatedAt: "2026-09-17T00:00:00.000Z", threshold: "medium", count: 1, records: [{ server: "a/one", verdict: "clean" }] }))
  return indexPath
}

async function withServer(options, body) {
  const server = start(Object.assign({ port: 0, host: "127.0.0.1" }, options))
  await new Promise(function (resolve) { server.once("listening", resolve) })
  const base = "http://127.0.0.1:" + server.address().port
  try { return await body(base, server) } finally { await new Promise(function (resolve) { server.close(resolve) }) }
}

function rawRequest(options, body) {
  return new Promise(function (resolve, reject) {
    const req = request(options, function (res) {
      let text = ""
      res.on("data", function (chunk) { text += chunk })
      res.on("end", function () { resolve({ status: res.statusCode, headers: res.headers, body: text }) })
    })
    req.on("error", reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

test("HEAD is answered by the GET handler with no body", async function () {
  const indexPath = fixtureIndex()
  await withServer({ indexPath: indexPath }, async function (base) {
    const response = await fetch(base + "/health", { method: "HEAD" })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type"), /application\/json/)
    assert.equal(await response.text(), "")
    assert.ok(response.headers.get("x-request-id"))
  })
})

test("every answer carries the headers that cost nothing", async function () {
  const indexPath = fixtureIndex()
  await withServer({ indexPath: indexPath }, async function (base) {
    const response = await fetch(base + "/health")
    assert.equal(response.headers.get("x-content-type-options"), "nosniff")
    assert.equal(response.headers.get("referrer-policy"), "no-referrer")
  })
})

test("a request with a body is refused before anything is read", async function () {
  const indexPath = fixtureIndex()
  await withServer({ indexPath: indexPath }, async function (base, server) {
    const port = server.address().port
    const withBody = await rawRequest({ host: "127.0.0.1", port: port, path: "/health", method: "POST", headers: { "content-length": "5" } }, "hello")
    assert.equal(withBody.status, 413)
    assert.match(withBody.body, /no request body/)
    const withoutBody = await rawRequest({ host: "127.0.0.1", port: port, path: "/health", method: "POST" })
    assert.equal(withoutBody.status, 405)
  })
})

test("the rate limit answers 429 with a retry-after and leaves /metrics alone", async function () {
  const indexPath = fixtureIndex()
  await withServer({ indexPath: indexPath, rateLimitPerMinute: 60, rateLimitBurst: 3 }, async function (base) {
    assert.equal((await fetch(base + "/health")).status, 200)
    assert.equal((await fetch(base + "/health")).status, 200)
    assert.equal((await fetch(base + "/health")).status, 200)
    const refused = await fetch(base + "/health")
    assert.equal(refused.status, 429)
    assert.ok(Number(refused.headers.get("retry-after")) >= 1)
    assert.equal((await fetch(base + "/metrics")).status, 200, "the scraper on loopback is not a client to be throttled")
  })
})

test("with the limit off, nothing is refused", async function () {
  const indexPath = fixtureIndex()
  await withServer({ indexPath: indexPath, rateLimitPerMinute: 0 }, async function (base) {
    for (let i = 0; i < 20; i += 1) assert.equal((await fetch(base + "/health")).status, 200)
  })
})

test("the connection timeouts are the tightened ones", async function () {
  const indexPath = fixtureIndex()
  await withServer({ indexPath: indexPath }, async function (base, server) {
    assert.equal(server.headersTimeout, 15000)
    assert.equal(server.requestTimeout, 20000)
    assert.equal(server.keepAliveTimeout, 5000)
    assert.ok(base.length > 0)
  })
})
