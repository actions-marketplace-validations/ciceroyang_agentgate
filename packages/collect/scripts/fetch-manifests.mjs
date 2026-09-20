#!/usr/bin/env node
/**
 * Read the package manifest a repository already told us it has.
 *
 * The classification step lists a repository's files and keeps the manifest path. This step reads
 * that one file and extracts the coordinates a package audit needs - registry, name, version - so a
 * repository record can carry `packages` instead of an empty array.
 *
 * Two things it will not do. It does not guess a name from the repository name, and it does not
 * invent a version: a manifest with no version yields coordinates with `version: null`, and the
 * policy layer already treats a package without a pinned version as missing evidence. What it read,
 * and a sha256 of the bytes it read, travels with the answer, so a reader can fetch the same URL and
 * check.
 *
 *   node packages/collect/scripts/fetch-manifests.mjs --classification data/repository-classification.json \
 *     --census data/github-census.json --out data/package-coordinates.json --rate 3
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"

export const MANIFEST_REGISTRY = {
  "package.json": "npm",
  "pyproject.toml": "pypi",
  "cargo.toml": "crates.io",
  "composer.json": "packagist",
  "pom.xml": "maven",
  "go.mod": "go",
  "gemfile": null,
}

function basenameOf(path) {
  const parts = String(path || "").split("/")
  return parts[parts.length - 1].toLowerCase()
}

/** The registry a manifest path belongs to, or null when it declares no publishable package. */
export function registryFor(path) {
  const base = basenameOf(path)
  if (base in MANIFEST_REGISTRY) return MANIFEST_REGISTRY[base]
  if (base.endsWith(".csproj")) return "nuget"
  if (base === "build.gradle") return "maven"
  return null
}

function tomlValue(text, key) {
  const re = new RegExp("^\\s*" + key + "\\s*=\\s*[\"\']([^\"\']+)[\"\']", "m")
  const m = re.exec(text)
  return m ? m[1] : null
}

function xmlTag(text, tag) {
  const m = new RegExp("<" + tag + ">\\s*([^<\\s]+)\\s*</" + tag + ">", "i").exec(text)
  return m ? m[1] : null
}

/**
 * What this manifest says its package is, or nothing. One function per format keeps the honest part
 * obvious: every branch either reads a value out of the file or returns null, and null is an answer.
 */
export function coordinatesFrom(path, content) {
  const base = basenameOf(path)
  const registry = registryFor(path)
  try {
    if (base === "package.json" || base === "composer.json") {
      const json = JSON.parse(content)
      const name = typeof json.name === "string" && json.name.length > 0 ? json.name : null
      const version = typeof json.version === "string" && json.version.length > 0 ? json.version : null
      return { registry, name, version }
    }
    if (base === "pyproject.toml" || base === "cargo.toml") {
      return { registry, name: tomlValue(content, "name"), version: tomlValue(content, "version") }
    }
    if (base === "pom.xml") {
      const group = xmlTag(content, "groupId")
      const artifact = xmlTag(content, "artifactId")
      return { registry, name: group && artifact ? group + ":" + artifact : artifact, version: xmlTag(content, "version") }
    }
    if (base.endsWith(".csproj")) {
      return { registry, name: xmlTag(content, "PackageId") || xmlTag(content, "AssemblyName"), version: xmlTag(content, "Version") }
    }
    if (base === "go.mod") {
      const m = /^\s*module\s+(\S+)/m.exec(content)
      return { registry, name: m ? m[1] : null, version: null }
    }
  } catch (error) {
    return { registry, name: null, version: null, unparsed: String(error && error.message ? error.message : error).slice(0, 120) }
  }
  return { registry, name: null, version: null }
}

export function rawUrl(fullName, branch, path) {
  return "https://raw.githubusercontent.com/" + fullName + "/" + encodeURIComponent(branch || "HEAD") + "/" + String(path).split("/").map(encodeURIComponent).join("/")
}

function argOf(name, fallback) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf("--" + name)
  if (at === -1) return fallback
  if (at + 1 >= argv.length || argv[at + 1].indexOf("--") === 0) return true
  return argv[at + 1]
}

const isMain = process.argv[1] && process.argv[1].endsWith("fetch-manifests.mjs")
if (isMain) {
  const classificationPath = String(argOf("classification", "data/repository-classification.json"))
  const censusPath = String(argOf("census", "data/github-census.json"))
  const out = String(argOf("out", "data/package-coordinates.json"))
  const rate = Number(argOf("rate", 3))
  const limit = Number(argOf("limit", 0))
  const classification = JSON.parse(readFileSync(classificationPath, "utf8")).results || {}
  const census = JSON.parse(readFileSync(censusPath, "utf8"))
  const branchOf = {}
  for (const repo of census.repos || []) branchOf[repo.fullName] = repo.defaultBranch || null
  const work = Object.keys(classification).filter((k) => typeof classification[k].manifest === "string" && classification[k].manifest.length > 0)
  const previous = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")).results || {}) : {}
  const results = { ...previous }
  const todo = (limit > 0 ? work.slice(0, limit) : work).filter((k) => !results[k])
  console.log(JSON.stringify({ withManifest: work.length, alreadyRead: work.length - todo.length, toFetch: todo.length, rate }))

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
      const manifest = classification[fullName].manifest
      const url = rawUrl(fullName, branchOf[fullName], manifest)
      await takeToken()
      let status = 0
      let text = null
      try {
        const res = await fetch(url, { headers: { "User-Agent": "agentgate-manifests" }, signal: AbortSignal.timeout(30000) })
        status = res.status
        if (res.status === 200) text = await res.text()
      } catch (error) { status = 0 }
      if (text === null) {
        results[fullName] = { manifest, url, status: "unreadable", http: status }
      } else {
        const digest = createHash("sha256").update(text).digest("hex")
        const coords = coordinatesFrom(manifest, text)
        results[fullName] = { manifest, url, status: "read", http: status, digest, bytes: text.length,
          registry: coords.registry, name: coords.name, version: coords.version,
          unparsed: coords.unparsed || null }
      }
      done += 1
      if (done % 100 === 0) {
        checkpoint()
        const seconds = Math.max((Date.now() - started) / 1000, 1)
        console.log(JSON.stringify({ done, of: todo.length, rate: Math.round((done / seconds) * 100) / 100,
          etaMinutes: Math.round((todo.length - done) / Math.max(done / seconds, 0.01) / 60) }))
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  const tally = {}
  for (const v of Object.values(results)) {
    const key = v.status === "read" && v.name ? (v.registry || "unknown-registry") + (v.version ? ":versioned" : ":no-version") : v.status
    tally[key] = (tally[key] || 0) + 1
  }
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), source: "raw.githubusercontent.com", results }, null, 0))
  console.log(JSON.stringify({ wrote: out, manifests: Object.keys(results).length, tally }))
}