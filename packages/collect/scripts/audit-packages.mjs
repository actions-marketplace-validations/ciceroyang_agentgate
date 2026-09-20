#!/usr/bin/env node
/**
 * Audit the packages a repository declared.
 *
 * The registry side of this pipeline audits a package because the registry told it the package
 * exists. A repository record had no coordinates at all until `fetch-manifests.mjs` started reading
 * the manifest the classification step found. This step takes those coordinates and runs the same
 * audit the registry path runs, so a repository record can carry measured evidence instead of a
 * component that is skipped because nobody looked.
 *
 * What it will not do is guess. A synthetic server object is built from the coordinates, and it
 * carries no `transport`: inventing `stdio` would add a finding about a transport nobody checked.
 * A registry this pipeline cannot audit yet is reported as `unsupported-registry`, which is a fact,
 * not a pass. Hook scripts are fetched so their status is real rather than "missing because we did
 * not ask".
 *
 *   node packages/collect/scripts/audit-packages.mjs --coordinates data/package-coordinates.json \
 *     --out data/package-audit.json --rate 2
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { auditPackage, auditPypiPackage, fetchNpmDocument, fetchPypiDocument, fetchHookScript,
  hookScriptRefs, registryProvenance } from "../mcp-audit.mjs"
import { contentProvenance } from "../provenance.mjs"

/** Registries this step can audit today. Anything else is named, never quietly skipped. */
export const AUDITABLE = ["npm", "pypi"]

/**
 * The server object the audit functions expect, built out of coordinates and nothing else.
 * There is deliberately no `transport`: `auditPackage` adds a stdio finding when it sees one, and
 * we have not checked how this package is run.
 */
export function syntheticServer(coords) {
  return { packages: [{ registryType: coords.registry, identifier: coords.name, version: coords.version }] }
}

export function auditability(coords) {
  if (!coords || coords.status !== "read") return "manifest-not-read"
  if (!coords.name) return "no-package-name-in-manifest"
  if (AUDITABLE.indexOf(coords.registry) === -1) return "unsupported-registry"
  return "auditable"
}

async function auditOne(coords, httpOpts) {
  const server = syntheticServer(coords)
  const declared = { version: coords.version }
  if (coords.registry === "npm") {
    const doc = await fetchNpmDocument(coords.name, httpOpts.http)
    if (!doc) return { status: "metadata-unavailable", findings: [] }
    const refs = hookScriptRefs(pickVersionManifest(doc, coords)?.scripts)
    const hookScripts = {}
    for (const path of refs.slice(0, 5)) {
      const text = await fetchHookScript(coords.name, coords.version, path, httpOpts.http)
      if (typeof text === "string") hookScripts[path] = text
    }
    return { status: "audited", findings: auditPackage(server, doc, declared, hookScripts),
      provenance: registryProvenance(server, doc, hookScripts) }
  }
  const doc = await fetchPypiDocument(coords.name, httpOpts.http)
  if (!doc) return { status: "metadata-unavailable", findings: [] }
  return { status: "audited", findings: auditPypiPackage(server, doc, declared),
    provenance: contentProvenance({ package: { registry: "pypi", name: coords.name, version: coords.version },
      scope: "pypiDocument/v1: the published PyPI document for the declared package",
      input: { pypiDocument: doc }, complete: true }) }
}

function pickVersionManifest(doc, coords) {
  const versions = doc && doc.versions
  if (versions && coords.version && versions[coords.version]) return versions[coords.version]
  return null
}

function argOf(name, fallback) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf("--" + name)
  if (at === -1) return fallback
  if (at + 1 >= argv.length || argv[at + 1].indexOf("--") === 0) return true
  return argv[at + 1]
}

const isMain = process.argv[1] && process.argv[1].endsWith("audit-packages.mjs")
if (isMain) {
  const coordinatesPath = String(argOf("coordinates", "data/package-coordinates.json"))
  const out = String(argOf("out", "data/package-audit.json"))
  const rate = Number(argOf("rate", 2))
  const limit = Number(argOf("limit", 0))
  const coordinates = JSON.parse(readFileSync(coordinatesPath, "utf8")).results || {}
  const previous = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")).results || {}) : {}
  const results = { ...previous }
  const all = Object.keys(coordinates).filter((k) => auditability(coordinates[k]) === "auditable")
  const chosen = limit > 0 ? all.slice(0, limit) : all
  const todo = chosen.filter((k) => !results[k])
  const skipped = {}
  for (const k of Object.keys(coordinates)) {
    const why = auditability(coordinates[k])
    if (why !== "auditable") skipped[why] = (skipped[why] || 0) + 1
  }
  console.log(JSON.stringify({ manifests: Object.keys(coordinates).length, auditable: all.length,
    alreadyAudited: chosen.length - todo.length, toAudit: todo.length, notAuditable: skipped, rate }))

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  let tokens = 0
  let last = Date.now()
  async function takeToken() {
    for (;;) {
      const now = Date.now()
      tokens = Math.min(4, tokens + ((now - last) / 1000) * rate)
      last = now
      if (tokens >= 1) { tokens -= 1; return }
      await wait(Math.max(50, Math.ceil(((1 - tokens) / rate) * 1000)))
    }
  }
  const checkpoint = () => writeFileSync(out + ".partial.json", JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 0))

  let next = 0
  let done = 0
  const started = Date.now()
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= todo.length) return
      const fullName = todo[i]
      const coords = coordinates[fullName]
      await takeToken()
      let result
      try {
        result = await auditOne(coords, {})
      } catch (error) {
        result = { status: "failed", error: String(error && error.message ? error.message : error).slice(0, 160) }
      }
      results[fullName] = Object.assign({ registry: coords.registry, name: coords.name, version: coords.version,
        manifest: coords.manifest, url: coords.url, digest: coords.digest }, result)
      done += 1
      if (done % 50 === 0) {
        checkpoint()
        const seconds = Math.max((Date.now() - started) / 1000, 1)
        console.log(JSON.stringify({ done, of: todo.length, rate: Math.round((done / seconds) * 100) / 100,
          etaMinutes: Math.round((todo.length - done) / Math.max(done / seconds, 0.01) / 60) }))
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  const tally = {}
  for (const v of Object.values(results)) tally[v.status] = (tally[v.status] || 0) + 1
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 0))
  console.log(JSON.stringify({ wrote: out, audited: Object.keys(results).length, tally }))
}