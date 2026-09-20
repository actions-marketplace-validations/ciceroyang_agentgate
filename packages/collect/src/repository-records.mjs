/**
 * Repository-level records: the part of the chain the registry census cannot see.
 *
 * The registry lists about two thousand servers. GitHub carries tens of thousands of repositories
 * that call themselves MCP servers and never appear there, which is why a company can publish one
 * and have no record anywhere in our index. These records close that gap without pretending to have
 * done work we did not do: the metadata block says exactly what was read, and a required component
 * is left skipped, so the record can never come out of this as `clean`.
 *
 * The identity rules are deliberate. A repository already represented by a registry row is not
 * added again (the URL is the join key), and two records may not share one identity: an index that
 * counts the same publisher twice is a smaller number wearing a bigger hat.
 */
import { createHash } from "node:crypto"
import { buildScanExecution } from "./execution.mjs"

export const REPOSITORY_BLOCK = "repositoryMetadata"
export const REPOSITORY_SOURCE = "github-census"
export const REPOSITORY_SCOPE =
  "repositoryMetadata/v1: GitHub repository metadata (stars, forks, license, archived, pushed_at, created_at, default_branch, description) as returned by the public search API; no source code read, no package inspected"

/** One canonical form, shared with the collector, so the join key cannot drift between the two. */
export function normalizeRepoUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null
  const trimmed = value.trim().replace(/[#?].*$/, "").replace(/\.git$/, "").replace(/\/+$/, "")
  const match = /^(?:git@)?(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/]+)\/([^/]+)$/i.exec(trimmed.replace(/^git@github\.com:/, "git@github.com/"))
  if (!match) return null
  return "https://github.com/" + match[1].toLowerCase() + "/" + match[2].toLowerCase()
}

export function repositoryIdentity(repoUrl) {
  const url = normalizeRepoUrl(repoUrl)
  return url ? url.replace("https://github.com/", "github.com/") : null
}

/** A repository whose tree carries an MCP-named entry file, or that declares an MCP descriptor. */
export function looksLikeServer(verdict) {
  if (!verdict || typeof verdict !== "object") return false
  if (verdict.kind === "descriptor-only") return true
  return typeof verdict.matched === "string" && /mcp/i.test(verdict.matched)
}

/**
 * What we can honestly say about a repository from its metadata alone. Each finding carries the
 * field it came from, because a finding nobody can recompute is an opinion.
 */
export function repositoryFindings(entry, options) {
  const opts = options || {}
  const now = Date.parse(opts.now || new Date().toISOString())
  const staleAfter = Number.isFinite(opts.staleAfterDays) ? opts.staleAfterDays : 365
  const findings = []
  if (entry.archived === true) {
    findings.push({ rule: "repository-archived", severity: "medium",
      evidence: "GitHub marks this repository archived, so it receives no further fixes" })
  }
  if (!entry.license) {
    findings.push({ rule: "repository-license-missing", severity: "medium",
      evidence: "no license is declared, so the terms under which this code may be used are unknown" })
  }
  const pushed = entry.pushedAt ? Date.parse(entry.pushedAt) : NaN
  if (Number.isFinite(pushed) && Number.isFinite(now) && (now - pushed) / 86400000 > staleAfter) {
    findings.push({ rule: "repository-stale", severity: "low",
      evidence: "last push " + String(entry.pushedAt).slice(0, 10) + ", more than " + staleAfter + " days ago" })
  }
  return findings
}

function metadataDigest(entry) {
  const projected = {
    fullName: entry.fullName, stars: entry.stars, forks: entry.forks, archived: entry.archived === true,
    license: entry.license || null, pushedAt: entry.pushedAt || null, createdAt: entry.createdAt || null,
    defaultBranch: entry.defaultBranch || null, description: entry.description || null,
  }
  return createHash("sha256").update(JSON.stringify(projected)).digest("hex")
}

export function repositoryRecord(entry, verdict, options) {
  const opts = options || {}
  const generatedAt = opts.generatedAt || new Date().toISOString()
  const identity = repositoryIdentity(entry.repoUrl || ("https://github.com/" + entry.fullName))
  if (!identity) return null
  const findings = repositoryFindings(entry, opts)
  const execution = buildScanExecution({
    subject: { server: identity, packages: [] },
    components: [
      { id: REPOSITORY_BLOCK, required: true, status: "completed", output_present: true,
        output_parseable: true, semantic_consistency: "ok",
        findings: findings.reduce(function (counts, f) { counts[f.severity] = (counts[f.severity] || 0) + 1; return counts }, {}) },
      // The package half of the chain was not inspected, and saying so is the point: this record
      // can never reach clean, however good the metadata looks.
      //
      // The reason names what THIS BUILD did - it did not look - and says nothing about the
      // repository. It used to read "no-package-declared-in-repository", which asserted a finding
      // we never checked: repos like firecrawl/firecrawl-mcp-server, upstash/context7 and
      // apify/apify-mcp-server all declare a package.json, and all three were recorded as
      // declaring none. "We did not measure it" is allowed. "We looked and there is nothing" is
      // not, when nobody looked.
      { id: "packageManifest", required: true, status: "skipped", reason: "package-not-inspected" },
    ],
    generatedAt: generatedAt,
  })
  return {
    server: identity,
    title: typeof entry.description === "string" && entry.description.length > 0 ? entry.description.slice(0, 200) : null,
    repository: normalizeRepoUrl(entry.repoUrl || ("https://github.com/" + entry.fullName)),
    packages: [],
    evidence: {
      [REPOSITORY_BLOCK]: {
        status: findings.length > 0 ? "findings" : "clean",
        source: REPOSITORY_SOURCE,
        reason: null,
        findings: findings,
        provenance: {
          package: { registry: null, name: null, version: null },
          content: { algorithm: "sha256", digest: metadataDigest(entry), scope: REPOSITORY_SCOPE },
          complete: true,
        },
      },
    },
    verdict: "incomplete",
    scanExecution: execution,
    generatedAt: generatedAt,
  }
}

/** Two records may not claim one identity, and no repository may appear twice. */
export function assertUniqueIdentities(records) {
  const seenServer = new Map()
  const seenRepo = new Map()
  const problems = []
  for (const record of records) {
    const server = String(record.server || "").toLowerCase()
    const repo = normalizeRepoUrl(record.repository)
    if (server) {
      if (seenServer.has(server)) problems.push("two records share the server identity " + server)
      seenServer.set(server, true)
    }
    if (repo) {
      if (seenRepo.has(repo)) problems.push("two records point at the same repository " + repo)
      seenRepo.set(repo, true)
    }
  }
  if (problems.length > 0) throw new Error("identity check failed: " + problems.slice(0, 5).join("; "))
  return true
}

export function buildRepositoryRecords(options) {
  const opts = options || {}
  const repositories = Array.isArray(opts.repositories) ? opts.repositories : []
  const classification = opts.classification || {}
  const knownUrls = opts.knownUrls instanceof Set ? opts.knownUrls : new Set(opts.knownUrls || [])
  const records = []
  const skipped = { alreadyRepresented: 0, notAServer: 0, unusable: 0, duplicate: 0 }
  const seen = new Set()
  for (const entry of repositories) {
    const url = normalizeRepoUrl(entry.repoUrl || ("https://github.com/" + entry.fullName))
    const identity = repositoryIdentity(url)
    if (!url || !identity) { skipped.unusable += 1; continue }
    if (knownUrls.has(url)) { skipped.alreadyRepresented += 1; continue }
    if (!looksLikeServer(classification[entry.fullName])) { skipped.notAServer += 1; continue }
    if (seen.has(identity)) { skipped.duplicate += 1; continue }
    seen.add(identity)
    const record = repositoryRecord(entry, classification[entry.fullName], opts)
    if (record) records.push(record)
  }
  assertUniqueIdentities(records)
  return {
    records: records,
    skipped: skipped,
    stats: {
      considered: repositories.length,
      added: records.length,
      alreadyRepresented: skipped.alreadyRepresented,
      notAServer: skipped.notAServer,
      unusable: skipped.unusable,
      duplicate: skipped.duplicate,
      withFindings: records.filter(function (r) { return r.evidence[REPOSITORY_BLOCK].findings.length > 0 }).length,
    },
  }
}
