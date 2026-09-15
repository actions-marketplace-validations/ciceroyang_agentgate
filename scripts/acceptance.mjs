#!/usr/bin/env node
/**
 * M1 acceptance. Starts the service against the committed sample index and asks it the
 * questions a user would ask. Exits non-zero on the first thing that is not true.
 */
import { start } from "../packages/service/src/start.mjs"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const PORT = Number(process.env.ACCEPTANCE_PORT || 8791)
const BASE = "http://127.0.0.1:" + PORT
let failures = 0
const check = function (name, ok, detail) {
  if (ok) { console.log("ok    " + name); return }
  failures += 1
  console.log("FAIL  " + name + (detail ? "  -> " + detail : ""))
}

const sample = JSON.parse(readFileSync(join(ROOT, "data", "sample-index.json"), "utf8"))
const first = sample.records[0]
const server = start({ indexPath: join(ROOT, "data", "does-not-exist.json"), samplePath: join(ROOT, "data", "sample-index.json"), port: PORT, host: "127.0.0.1" })

const get = async function (path, parse) {
  const res = await fetch(BASE + path)
  const text = await res.text()
  return { status: res.status, text: text, json: parse === false ? null : JSON.parse(text) }
}

try {
  const health = await get("/health")
  check("health answers", health.status === 200 && health.json.ok === true, String(health.status))
  check("health reports the sample it fell back to", health.json.records === sample.count, JSON.stringify(health.json))

  const summary = await get("/v1/index/summary")
  check("summary counts every verdict", summary.json.count === sample.count, JSON.stringify(summary.json.verdicts))
  check("no verdict is negative or missing", ["clean", "findings", "incomplete"].every(function (k) { return typeof summary.json.verdicts[k] === "number" }))

  const record = await get("/v1/servers/" + encodeURIComponent(first.server))
  check("an exact server resolves", record.status === 200 && record.json.server === first.server, String(record.status))
  check("the record carries its evidence", record.json.evidence && Object.keys(record.json.evidence).length > 0)

  const badge = await get("/badge/" + encodeURIComponent(first.server) + ".svg", false)
  check("the badge renders", badge.status === 200 && badge.text.indexOf("<svg") === 0, String(badge.status))
  check("the badge says the verdict, not a reassurance", badge.text.indexOf(first.verdict) !== -1)

  const missing = await get("/v1/servers/definitely/not/a/server")
  check("an unknown server is a 404, not a clean", missing.status === 404, String(missing.status))
} catch (error) {
  failures += 1
  console.log("FAIL  the service could not be reached: " + error.message)
} finally {
  server.close()
}

console.log("")
console.log(failures === 0 ? "M1 acceptance: green" : "M1 acceptance: " + failures + " failure(s)")
process.exit(failures === 0 ? 0 : 1)
