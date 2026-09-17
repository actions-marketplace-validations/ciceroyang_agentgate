#!/usr/bin/env node
/**
 * Back up what cannot be recovered: the evidence index and, above all, the capture ledger.
 *
 *   node scripts/backup.mjs [--data data] [--site site] [--out-dir /var/backups/agentgate]
 *                           [--keep-days 14] [--dry-run]
 *
 * The archive carries a manifest of SHA-256 hashes, and scripts/restore-drill.mjs re-hashes it.
 * A missing data directory is a failure: an archive without the index would restore a dead
 * service and look like a success.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createArchive, planArchive, pruneArchives } from "../packages/backup/src/backup.mjs"
import { summarize } from "../packages/history/src/ledger.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function parse(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.indexOf("--") !== 0) continue
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && next.indexOf("--") !== 0) { out[name] = next; i += 1 } else out[name] = true
  }
  return out
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}

const args = parse(process.argv.slice(2))
const dataDir = resolve(String(args.data || join(ROOT, "data")))
const siteDir = resolve(String(args.site || join(ROOT, "site")))
const outDir = resolve(String(args["out-dir"] || "/var/backups/agentgate"))
const keepDays = Number(args["keep-days"] || 14)
const now = new Date()
const outFile = join(outDir, "agentgate-" + stamp(now) + ".tgz")

if (!existsSync(dataDir)) {
  console.error("backup: 没有数据目录可以备份：" + dataDir)
  process.exit(1)
}
const hasIndex = existsSync(join(dataDir, "index.json"))
if (!hasIndex && args["dry-run"] !== true) {
  console.error("backup: " + join(dataDir, "index.json") + " 不存在；没有索引的归档不是备份")
  process.exit(1)
}

const plan = planArchive([
  { prefix: "data", path: dataDir },
  { prefix: "site", path: siteDir },
])
const index = hasIndex ? JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8")) : { records: [] }
const historyDir = join(dataDir, "history")
let historyCaptures = null
if (existsSync(historyDir)) {
  const coverage = summarize(historyDir)
  historyCaptures = coverage.captures
}

let existing = []
if (existsSync(outDir)) existing = readdirSync(outDir).filter(function (name) { return /^agentgate-.*\.tgz$/.test(name) })
const prune = pruneArchives({ files: existing.concat(plan.entries.length > 0 ? [] : []).map(function (name) { return name }), keepDays: keepDays, now: now.getTime() })

if (args["dry-run"] === true) {
  process.stdout.write("将备份到 " + outFile + "\n")
  for (const entry of plan.entries) process.stdout.write("  含 " + entry.prefix + "  <- " + entry.path + "\n")
  for (const name of plan.missing) process.stdout.write("  缺（会记进 manifest）：" + name + "\n")
  if (!hasIndex) process.stdout.write("  注意：没有 index.json，真的跑会拒绝备份\n")
  process.stdout.write("  索引记录 " + (index.count || (index.records || []).length) + "，账本采集 " + String(historyCaptures) + "\n")
  const wouldRemove = pruneArchives({ files: existing, keepDays: keepDays, now: now.getTime() }).remove
  for (const name of wouldRemove) process.stdout.write("  会删除过期归档 " + name + "\n")
  process.exit(0)
}

const result = createArchive({
  plan: plan,
  outFile: outFile,
  exec: function (command, cliArgs, settings) { return spawnSync(command, cliArgs, settings) },
  createdAt: now.toISOString(),
  host: process.env.HOSTNAME || null,
  records: typeof index.count === "number" ? index.count : (index.records || []).length,
  historyCaptures: historyCaptures,
})
if (!result.ok) {
  console.error("backup: " + result.detail)
  process.exit(1)
}
for (const name of plan.missing) console.error("backup: 注意，这个源不存在，只记进了 manifest：" + name)

const size = statSync(outFile).size
process.stdout.write("备份完成：" + outFile + "（" + result.manifest.files.length + " 个文件，" + Math.round(size / 1024) + " KB，索引 " + String(result.manifest.records) + " 条，账本 " + String(result.manifest.historyCaptures) + " 次采集）\n")

const after = readdirSync(outDir).filter(function (name) { return /^agentgate-.*\.tgz$/.test(name) })
const toRemove = pruneArchives({ files: after, keepDays: keepDays, now: now.getTime() }).remove
for (const name of toRemove) {
  rmSync(join(outDir, name), { force: true })
  process.stdout.write("删除过期归档：" + name + "\n")
}
process.exit(0)
