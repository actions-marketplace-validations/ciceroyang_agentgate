import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createService, matchRecords, clearIndexCache } from "../src/server.mjs"
import { scratchDir } from "../../../test/tmpdir.mjs"

const SAMPLE = {
  generatedAt: "2026-09-15T00:00:00.000Z",
  threshold: "medium",
  count: 3,
  records: [
    { server: "acme/weather", verdict: "clean", packages: [{ registry: "npm", name: "@acme/weather", version: "1.0.0" }], evidence: {} },
    { server: "acme/weather-pro", verdict: "findings", packages: [], evidence: {} },
    { server: "other/thing", verdict: "incomplete", packages: [], evidence: {} },
  ],
}

function withIndex() {
  const dir = scratchDir("agentgate-")
  const p = join(dir, "index.json")
  writeFileSync(p, JSON.stringify(SAMPLE))
  return createService({ indexPath: p })
}

test("a missing index is a 503, never an empty success", function () {
  const svc = createService({ indexPath: "/nonexistent/index.json" })
  const out = svc.handle("GET", "/v1/index/summary")
  assert.equal(out.status, 503)
  assert.match(out.body, /no usable index is present/)
})

test("health reports the index it actually read", function () {
  const out = withIndex().handle("GET", "/health")
  assert.equal(out.status, 200)
  const body = JSON.parse(out.body)
  assert.equal(body.ok, true)
  assert.equal(body.records, 3)
  assert.match(body.index, /index\.json$/)
})

test("the summary counts verdicts", function () {
  const body = JSON.parse(withIndex().handle("GET", "/v1/index/summary").body)
  assert.deepEqual(body.verdicts, { clean: 1, findings: 1, incomplete: 1 })
})

test("an exact server name wins, and a partial one is ambiguous", function () {
  const svc = withIndex()
  const exact = JSON.parse(svc.handle("GET", "/v1/servers/acme/weather").body)
  assert.equal(exact.server, "acme/weather")
  const ambiguous = svc.handle("GET", "/v1/servers/acme")
  assert.equal(ambiguous.status, 300)
  assert.match(ambiguous.body, /ambiguous/)
  assert.equal(svc.handle("GET", "/v1/servers/nothing").status, 404)
})

test("the badge colour follows the verdict", function () {
  const svc = withIndex()
  const clean = svc.handle("GET", "/badge/acme/weather.svg")
  assert.equal(clean.status, 200)
  assert.match(clean.type, /svg/)
  assert.match(clean.body, /#2ea043/)
  const incomplete = svc.handle("GET", "/badge/other/thing.svg")
  assert.match(incomplete.body, /#8b949e/)
  const unknown = svc.handle("GET", "/badge/does/not/exist.svg")
  assert.match(unknown.body, /unknown/)
})

test("the server list filters without pretending to be complete", function () {
  const body = JSON.parse(withIndex().handle("GET", "/v1/servers?verdict=findings").body)
  assert.equal(body.count, 1)
  assert.equal(body.records[0].server, "acme/weather-pro")
})

test("matchRecords prefers exact, then substring", function () {
  const records = [{ server: "a/b" }, { server: "a/bc" }]
  assert.equal(matchRecords(records, "a/b").length, 1)
  assert.equal(matchRecords(records, "a/").length, 2)
})

test("a badge renders only a known verdict, whatever the index says", function () {
  const dir = scratchDir("agentgate-badge-")
  const p = join(dir, "index.json")
  writeFileSync(p, JSON.stringify({
    generatedAt: "2026-09-15T00:00:00.000Z",
    count: 2,
    records: [
      { server: "evil", verdict: 'clean" onload="alert(1)', packages: [], evidence: {} },
      { server: "inject", verdict: "</" + "text><script>alert(1)</" + "script>", packages: [], evidence: {} },
    ],
  }))
  clearIndexCache()
  const service = createService({ indexPath: p })
  for (const name of ["evil", "inject"]) {
    const out = service.handle("GET", "/badge/" + name + ".svg")
    assert.equal(out.status, 200)
    assert.equal(out.body.indexOf("onload="), -1, "an attribute came from the index")
    assert.equal(out.body.indexOf("<" + "script"), -1, "markup came from the index")
    assert.match(out.body, /unknown/, "an unrecognised verdict should render as unknown")
  }
  // and a real verdict still renders as itself
  clearIndexCache()
  const sample = withIndex()
  assert.match(sample.handle("GET", "/badge/acme/weather.svg").body, /clean/)
})
