import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { createService, clearIndexCache } from "../src/server.mjs"
import { scratchDir } from "../../../test/tmpdir.mjs"

function writeIndex(path, server, generatedAt) {
  writeFileSync(path, JSON.stringify({ generatedAt: generatedAt || "T", count: 1, records: [{ server: server, verdict: "clean", packages: [], evidence: {} }] }))
}

test("a refresh takes effect without restarting the service", function () {
  clearIndexCache()
  const dir = scratchDir("ag-cache-")
  const path = join(dir, "index.json")
  writeIndex(path, "before/one")
  const svc = createService({ indexPath: path })
  assert.match(svc.handle("GET", "/v1/servers/before/one").body, /before\/one/)
  writeIndex(path, "after/two", "T2")
  const after = svc.handle("GET", "/v1/servers/after/two")
  assert.equal(after.status, 200, "the new record must be visible: " + after.body.slice(0, 120))
  assert.equal(svc.handle("GET", "/v1/servers/before/one").status, 404)
})

test("a same-size rewrite is still noticed", function () {
  clearIndexCache()
  const dir = scratchDir("ag-cache2-")
  const path = join(dir, "index.json")
  writeIndex(path, "aa/one")
  const svc = createService({ indexPath: path })
  assert.equal(svc.handle("GET", "/v1/servers/aa/one").status, 200)
  writeIndex(path, "bb/two")
  const stamp = new Date(Date.now() + 2000)
  utimesSync(path, stamp, stamp)
  assert.equal(svc.handle("GET", "/v1/servers/bb/two").status, 200, "a same-size change must invalidate the cache")
})

test("the cached index still answers identically", function () {
  clearIndexCache()
  const dir = scratchDir("ag-cache3-")
  const path = join(dir, "index.json")
  writeIndex(path, "cc/one")
  const svc = createService({ indexPath: path })
  const a = svc.handle("GET", "/v1/servers/cc/one").body
  const b = svc.handle("GET", "/v1/servers/cc/one").body
  assert.equal(a, b)
  assert.equal(JSON.parse(b).server, "cc/one")
})
