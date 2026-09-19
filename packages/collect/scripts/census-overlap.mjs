#!/usr/bin/env node
/**
 * What the second census adds, before any of it is published.
 *
 * The question this answers is not "how many repositories are there" but "how many of them are
 * companies we currently cannot see at all". An index that grows from 2,000 to 12,000 by counting
 * the same publishers twice would be a worse number wearing a bigger hat.
 *
 *   node packages/collect/scripts/census-overlap.mjs --index data/index.json --github data/github-census.json
 */
import { readFileSync } from 'node:fs'
import { normalizeRepoUrl } from '../github-census.mjs'

function argOf(name, fallback) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--' + name)
  if (at === -1) return fallback
  if (at + 1 >= argv.length || argv[at + 1].indexOf('--') === 0) return true
  return argv[at + 1]
}

function load(path, what) {
  const json = JSON.parse(readFileSync(String(path), 'utf8'))
  if (what === 'index' && !Array.isArray(json.records)) throw new Error('not an index: ' + path)
  if (what === 'github' && !Array.isArray(json.repos)) throw new Error('not a github census: ' + path)
  return json
}

function pct(part, whole) { return whole === 0 ? '0%' : (Math.round((part / whole) * 1000) / 10) + '%' }

const indexPath = argOf('index', null)
const githubPath = argOf('github', null)
const minRepos = Number(argOf('min-repos', 2))
if (!indexPath || !githubPath) { console.error('usage: census-overlap.mjs --index <index.json> --github <github-census.json> [--min-repos 2]'); process.exit(2) }

const index = load(indexPath, 'index')
const github = load(githubPath, 'github')

const known = new Map()
for (const record of index.records) {
  const url = normalizeRepoUrl(record.repository)
  if (!url) continue
  if (!known.has(url)) known.set(url, [])
  known.get(url).push(record.server)
}

const rows = github.repos.map(function (repo) {
  const url = repo.repoUrl || normalizeRepoUrl('https://github.com/' + repo.fullName)
  return { ...repo, url, knownServers: known.get(url) || [] }
})
const overlap = rows.filter(function (r) { return r.knownServers.length > 0 })
const fresh = rows.filter(function (r) { return r.knownServers.length === 0 })

const ownerRepos = new Map()
for (const repo of rows) {
  if (!ownerRepos.has(repo.owner)) ownerRepos.set(repo.owner, { owner: repo.owner, repos: [], fresh: 0, stars: 0 })
  const entry = ownerRepos.get(repo.owner)
  entry.repos.push(repo.fullName)
  entry.stars += repo.stars || 0
  if (repo.knownServers.length === 0) entry.fresh += 1
}
const owners = [...ownerRepos.values()]
const leads = owners.filter(function (o) { return o.repos.length >= minRepos && o.fresh > 0 }).sort(function (a, b) { return b.stars - a.stars })

const out = []
out.push('# 第二份 census 带来的增量（未发布前的核对）')
out.push('')
out.push('*索引：' + String(indexPath) + '（' + index.records.length + ' 条，' + known.size + ' 个不同仓库）*')
out.push('*GitHub：' + String(githubPath) + '（topic ' + github.topic + '，' + rows.length + ' 个仓库，' + (github.requests || 0) + ' 次请求，截断标记 ' + github.truncated + '）*')
out.push('')
out.push('| 指标 | 值 |')
out.push('| --- | --- |')
out.push('| GitHub 仓库 | ' + rows.length + ' |')
out.push('| 其中已在我们索引里（按 repo URL 对上） | ' + overlap.length + '（' + pct(overlap.length, rows.length) + '） |')
out.push('| **我们完全看不到的仓库** | **' + fresh.length + '**（' + pct(fresh.length, rows.length) + '） |')
out.push('| 不同 owner | ' + owners.length + ' |')
out.push('| 发布 ≥2 个仓库的 owner | ' + owners.filter(function (o) { return o.repos.length >= minRepos }).length + ' |')
out.push('| **其中有我们看不到的仓库的 owner（新线索池）** | **' + leads.length + '** |')
out.push('| 归档仓库 | ' + rows.filter(function (r) { return r.archived }).length + '（' + pct(rows.filter(function (r) { return r.archived }).length, rows.length) + '） |')
out.push('| 有 license 的仓库 | ' + rows.filter(function (r) { return r.license }).length + '（' + pct(rows.filter(function (r) { return r.license }).length, rows.length) + '） |')
out.push('| 有 star 的仓库 | ' + rows.filter(function (r) { return (r.stars || 0) > 0 }).length + ' |')
out.push('')
out.push('## 新线索池里最大的一批（按 star 之和）')
out.push('')
out.push('| owner | 仓库数 | 其中我们看不到的 | star 合计 |')
out.push('| --- | --- | --- | --- |')
for (const lead of leads.slice(0, 25)) out.push('| `' + lead.owner + '` | ' + lead.repos.length + ' | ' + lead.fresh + ' | ' + lead.stars + ' |')
out.push('')
if (github.truncated) {
  out.push('> **注意：这份 GitHub census 自己被截断过**（有切片在 push 日期窗口小到不能再分时仍超过 API 上限）。上面所有数字都是下界。')
  out.push('')
}
const text = out.join(String.fromCharCode(10)) + String.fromCharCode(10)
const outPath = argOf('out', null)
if (outPath && outPath !== true) { const { writeFileSync } = await import('node:fs'); writeFileSync(String(outPath), text) }
process.stdout.write(text)