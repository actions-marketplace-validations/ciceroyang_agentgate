#!/usr/bin/env node
/**
 * Classify repositories by their file tree, incrementally.
 *
 * The registry census cannot see most of the chain: a repository can carry the mcp-server topic,
 * publish a real MCP server, and never appear in the registry we read. This step gives every such
 * repository a verdict with the path that decided it, so a reader can check any single
 * classification instead of trusting a percentage.
 *
 * Two things make it survive contact with a daily job. It is incremental: a repository whose
 * pushed_at has not moved keeps its previous verdict, so the second run only looks at what changed.
 * And it is checkpointed, so a run that dies at repository 9,000 resumes instead of starting over.
 *
 *   node packages/collect/scripts/classify-repositories.mjs --census data/github-census.json \
 *     --out data/repository-classification.json --rate 1.3
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"

export const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|[^/]+\.csproj|Gemfile|composer\.json)$/i
export const DESCRIPTOR = /(^|\/)(mcp\.json|smithery\.yaml|smithery\.yml|server\.json|mcp\.yaml|mcp\.yml)$/i
export const CODE = /\.(ts|tsx|js|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|ex|exs)$/i
export const SERVERISH = /(^|[\/_.-])(server|mcp)([\/_.-]|$)/i
export const DOCS = /\.(md|mdx|txt|rst)$/i

/** The whole classification rule, in one function, so a test can hold it still. */
export function classifyPaths(paths) {
  const serverFile = paths.find((p) => CODE.test(p) && SERVERISH.test(p)) || null
  const descriptor = paths.find((p) => DESCRIPTOR.test(p)) || null
  const manifest = paths.find((p) => MANIFEST.test(p)) || null
  const kind = serverFile && manifest ? "server-like"
    : serverFile ? "server-ish"
    : descriptor ? "descriptor-only"
    : manifest ? "library/orphan manifest"
    : paths.some((p) => DOCS.test(p)) ? "docs/examples" : "other"
  // The manifest path is returned, not only consumed. `kind` records that a manifest exists —
  // "server-like" means a server file and a manifest — and then the path was thrown away, so the
  // record built from this file could not say which package a repository declares, or even that
  // it declares one. Carrying it here costs nothing: the tree was already fetched and parsed.
  return { kind, matched: serverFile || descriptor || manifest || null, manifest, descriptor }
}

/**
 * Which repositories need a request. Anything whose pushed_at is unchanged keeps its verdict: a
 * repository that did not move cannot have changed its file tree, and re-fetching it every day is
 * how a pipeline earns a rate limit.
 */
export function planIncremental(repos, previous) {
  const prev = previous || {}
  const kept = {}
  const todo = []
  for (const repo of repos) {
    const before = prev[repo.fullName]
    if (before && before.pushedAt && before.pushedAt === repo.pushedAt) { kept[repo.fullName] = before; continue }
    if (before && !repo.pushedAt) { kept[repo.fullName] = before; continue }
    todo.push(repo)
  }
  return { todo, kept }
}

function argOf(name, fallback) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf("--" + name)
  if (at === -1) return fallback
  if (at + 1 >= argv.length || argv[at + 1].indexOf("--") === 0) return true
  return argv[at + 1]
}

const isMain = process.argv[1] && process.argv[1].endsWith("classify-repositories.mjs")
if (isMain) {
  const censusPath = String(argOf("census", "data/github-census.json"))
  const out = String(argOf("out", "data/repository-classification.json"))
  const previousPath = String(argOf("previous", out))
  const rate = Number(argOf("rate", 1.3))
  const limit = Number(argOf("limit", 0))
  const token = argOf("token", process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null)
  const census = JSON.parse(readFileSync(censusPath, "utf8"))
  const previous = existsSync(previousPath) ? (JSON.parse(readFileSync(previousPath, "utf8")).results || {}) : {}
  const plan = planIncremental(census.repos || [], previous)
  const work = limit > 0 ? plan.todo.slice(0, limit) : plan.todo
  const results = { ...plan.kept }
  console.log(JSON.stringify({ repositories: (census.repos || []).length, kept: Object.keys(plan.kept).length, toFetch: work.length, rate }))

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
      if (i >= work.length) return
      const repo = work[i]
      const branch = repo.defaultBranch || "HEAD"
      const url = "https://api.github.com/repos/" + repo.fullName + "/git/trees/" + encodeURIComponent(branch) + "?recursive=1"
      let json = null
      let status = 0
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await takeToken()
        try {
          const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "agentgate-classify" }, signal: AbortSignal.timeout(30000) })
          status = res.status
          if (res.status === 200) { json = await res.json(); break }
          if (res.status === 404 || res.status === 409 || res.status === 451) break
          if (res.status === 403 || res.status === 429) { await wait(60000); continue }
          await wait(5000)
        } catch (error) { status = 0; await wait(5000) }
      }
      if (!json || !Array.isArray(json.tree)) {
        results[repo.fullName] = { kind: "unreadable", status, stars: repo.stars, owner: repo.owner, pushedAt: repo.pushedAt || null }
      } else {
        const paths = json.tree.filter((e) => e.type === "blob").map((e) => e.path)
        const verdict = classifyPaths(paths)
        results[repo.fullName] = { kind: verdict.kind, matched: verdict.matched,
          manifest: verdict.manifest, descriptor: verdict.descriptor, files: paths.length,
          truncated: json.truncated === true, stars: repo.stars, owner: repo.owner, pushedAt: repo.pushedAt || null }
      }
      done += 1
      if (done % 100 === 0) {
        checkpoint()
        const seconds = Math.max((Date.now() - started) / 1000, 1)
        console.log(JSON.stringify({ done, of: work.length, rate: Math.round((done / seconds) * 100) / 100,
          etaMinutes: Math.round((work.length - done) / Math.max(done / seconds, 0.01) / 60) }))
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  const tally = {}
  for (const v of Object.values(results)) tally[v.kind] = (tally[v.kind] || 0) + 1
  const servers = Object.values(results).filter((v) => v.kind === "descriptor-only" || (v.matched && /mcp/i.test(v.matched))).length
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), universe: (census.repos || []).length, servers, tally, results }, null, 2) + String.fromCharCode(10))
  console.log(JSON.stringify({ wrote: out, classified: Object.keys(results).length, servers, tally }))
}
