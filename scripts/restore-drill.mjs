#!/usr/bin/env node
/**
 * Restore the newest backup and prove it works, because an untested backup is a belief.
 *
 *   node scripts/restore-drill.mjs [--from backup.tgz] [--out-dir /var/backups/agentgate] [--keep]
 *
 * What it does, in order: extract into a temporary directory, re-hash every file against the
 * manifest, verify the ledger chain, then start the service against the restored index and ask
 * it for /health. Exit 0 only if all of that holds; 1 if the backup is bad; 3 if there was
 * nothing to drill.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { extractArchive, verifyRestored } from "../packages/backup/src/backup.mjs"
import { verifyLedger } from "../packages/history/src/ledger.mjs"
import { start } from "../packages/service/src/start.mjs"

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

function newestArchive(dir) {
  if (!existsSync(dir)) return null
  const names = readdirSync(dir).filter(function (name) { return /^agentgate-.*\.tgz$/.test(name) }).sort()
  return names.length > 0 ? join(dir, names[names.length - 1]) : null
}

const args = parse(process.argv.slice(2))
const outDir = resolve(String(args["out-dir"] || "/var/backups/agentgate"))
const archiveFile = args.from ? resolve(String(args.from)) : newestArchive(outDir)
if (!archiveFile || !existsSync(archiveFile)) {
  console.error("restore-drill: 没有可用的归档（找的是 " + outDir + "）")
  process.exit(3)
}

const work = mkdtempSync(join(tmpdir(), "agentgate-restore-"))
const keep = args.keep === true
const problems = []
let manifest = null

try {
  const extracted = extractArchive({ archiveFile: archiveFile, destDir: work, exec: function (command, cliArgs, settings) { return spawnSync(command, cliArgs, settings) } })
  if (!extracted.ok) {
    console.error("restore-drill: 归档解不开：" + extracted.detail)
    process.exit(1)
  }

  const verified = verifyRestored(work)
  manifest = verified.manifest
  if (!verified.ok) for (const item of verified.problems) problems.push(item)

  const historyDir = join(work, "data", "history")
  if (manifest && manifest.historyCaptures !== null && manifest.historyCaptures > 0) {
    if (!existsSync(historyDir)) problems.push("manifest 说有采集记录，但归档里没有 data/history")
    else {
      const ledger = verifyLedger(historyDir)
      if (!ledger.ok) for (const item of ledger.problems) problems.push("账本：" + item)
      else process.stdout.write("账本校验通过：链与 " + String(ledger.entries.length) + " 条采集记录一致\n")
    }
  }

  const indexPath = join(work, "data", "index.json")
  if (!existsSync(indexPath)) {
    problems.push("归档里没有 data/index.json，服务起不来")
  } else {
    const server = start({ indexPath: indexPath, port: 0, host: "127.0.0.1" })
    await new Promise(function (resolveReady) { server.once("listening", resolveReady) })
    try {
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/health")
      const body = await response.json()
      if (response.status !== 200 || body.ok !== true) problems.push("从恢复出来的索引起服务，/health 不是 200 ok")
      else {
        process.stdout.write("服务从恢复的数据起得来：/health " + String(body.records) + " 条记录\n")
        if (manifest && typeof manifest.records === "number" && body.records !== manifest.records) {
          problems.push("记录数与 manifest 不符（manifest " + manifest.records + "，服务 " + body.records + "）")
        }
      }
    } finally {
      await new Promise(function (resolveClose) { server.close(resolveClose) })
    }
  }

  if (problems.length > 0) {
    for (const item of problems) console.error("restore-drill: " + item)
    console.error("恢复演练失败：" + problems.length + " 个问题（归档 " + archiveFile + "）")
    process.exit(1)
  }
  process.stdout.write("恢复演练通过：" + archiveFile + "（" + (manifest ? manifest.files.length : 0) + " 个文件）" + "\n")
  process.exit(0)
} finally {
  if (keep) process.stderr.write("保留解出来的目录：" + work + "\n")
  else rmSync(work, { recursive: true, force: true })
}
