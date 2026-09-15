import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createService, matchRecords } from "../src/server.mjs"
import { start } from "../src/start.mjs"

function serviceWith(content) {
  const dir = mkdtempSync(join(tmpdir(), "ag-robust-"))
  const p = join(dir, "index.json")
  writeFileSync(p, content)
  return createService({ indexPath: p })
}

test("an index that is not valid JSON is a 503, not a crash", function () {
  assert.equal(serviceWith("{ broken").handle("GET", "/health").status, 503)
})

test("a JSON file without a records array is not an index", function () {
  assert.equal(serviceWith(JSON.stringify({ count: 1 })).handle("GET", "/v1/index/summary").status, 503)
})

test("a records field that is not an array is not an index", function () {
  assert.equal(serviceWith(JSON.stringify({ count: 1, records: "nope" })).handle("GET", "/v1/servers").status, 503)
})

test("a record without a server name is skipped, not fatal", function () {
  assert.deepEqual(matchRecords([{ server: "a/b" }, null, 3, {}], "a/b").map(function (r) { return r.server }), ["a/b"])
})

test("the fallback index is used only when the first one is unusable", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-fallback-"))
  const broken = join(dir, "a.json")
  const good = join(dir, "b.json")
  writeFileSync(broken, JSON.stringify({ records: "nope" }))
  writeFileSync(good, JSON.stringify({ generatedAt: "T", count: 1, records: [{ server: "a/b", verdict: "clean", packages: [], evidence: {} }] }))
  const svc = createService({ indexPath: broken, samplePath: good })
  const out = svc.handle("GET", "/v1/index/summary")
  assert.equal(out.status, 200)
  assert.match(out.body, /a\/b|count/)
})

test("a handler that throws becomes a 500, not a dead process", async function () {
  const exploding = { handle: function () { throw new Error("boom") } }
  const server = start({ service: exploding, port: 8792, host: "127.0.0.1" })
  try {
    const res = await fetch("http://127.0.0.1:8792/health")
    assert.equal(res.status, 500)
    const body = await res.json()
    assert.match(body.error, /not a pass/)
    assert.match(body.detail, /boom/)
  } finally {
    server.close()
  }
})
