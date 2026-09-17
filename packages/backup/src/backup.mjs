/**
 * Backups, and the thing that actually matters: a restore that has been attempted.
 *
 * "There is a backup" and "the backup can be restored" are different claims, and only the second
 * one is worth anything on the day it is needed. So the archive carries a manifest with a
 * SHA-256 and a byte count for every file, and the drill re-hashes what it extracted before it
 * trusts any of it.
 *
 * Everything here takes an injected exec, so the logic is testable without a filesystem full of
 * tarballs, and the CLI passes spawnSync.
 */
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"

export const BACKUP_VERSION = 1

export function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
}

/** Which sources exist, and which were expected and are not there. A missing source is reported. */
export function planArchive(sources) {
  const entries = []
  const missing = []
  for (const source of sources || []) {
    if (!existsSync(source.path)) { missing.push(source.prefix) ; continue }
    entries.push({ prefix: source.prefix, path: source.path })
  }
  return { entries: entries, missing: missing }
}

export function buildManifest(options) {
  const opts = options || {}
  const files = []
  for (const entry of opts.entries || []) {
    const collected = []
    if (statSync(entry.path).isDirectory()) walk(entry.path, collected)
    else collected.push(entry.path)
    for (const file of collected) {
      files.push({
        path: relative(opts.root, file).split(sep).join("/"),
        bytes: statSync(file).size,
        sha256: sha256OfFile(file),
      })
    }
  }
  files.sort(function (a, b) { return a.path.localeCompare(b.path) })
  return {
    schemaVersion: BACKUP_VERSION,
    createdAt: opts.createdAt || new Date().toISOString(),
    host: opts.host || null,
    records: typeof opts.records === "number" ? opts.records : null,
    historyCaptures: typeof opts.historyCaptures === "number" ? opts.historyCaptures : null,
    files: files,
    missing: opts.missing || [],
  }
}

/** A staging copy, then one tar. Files are copied rather than tarred from their own parent so the
 *  archive has a stable shape to verify against. */
export function createArchive(options) {
  const opts = options || {}
  const exec = opts.exec
  const outFile = opts.outFile
  mkdirSync(dirname(outFile), { recursive: true })
  const staging = mkdtempSync(join(tmpdir(), "agentgate-backup-"))
  try {
    for (const entry of opts.plan.entries) {
      cpSync(entry.path, join(staging, entry.prefix), { recursive: true })
    }
    // Hash the staged copies, not the originals: the manifest describes what is inside the
    // archive, and a path relative to the staging root is the only one that means that.
    const staged = opts.plan.entries.map(function (entry) { return { prefix: entry.prefix, path: join(staging, entry.prefix) } })
    const manifest = buildManifest({
      root: staging, entries: staged, createdAt: opts.createdAt, host: opts.host,
      records: opts.records, historyCaptures: opts.historyCaptures, missing: opts.plan.missing,
    })
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    const result = exec("tar", ["-czf", outFile, "-C", staging, "."], { encoding: "utf8" })
    if (!result || result.status !== 0) {
      return { ok: false, detail: result && result.stderr ? String(result.stderr).trim().split("\n")[0] : "tar 失败", manifest: manifest }
    }
    const notInArchive = opts.plan.missing
    return { ok: true, detail: null, manifest: manifest, outFile: outFile, missing: notInArchive }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export function extractArchive(options) {
  const result = options.exec("tar", ["-xzf", options.archiveFile, "-C", options.destDir], { encoding: "utf8" })
  if (!result || result.status !== 0) {
    return { ok: false, detail: result && result.stderr ? String(result.stderr).trim().split("\n")[0] : "解不开这个归档" }
  }
  return { ok: true, detail: null }
}

/**
 * Re-hash what was extracted against the manifest, and refuse any entry that would land outside
 * the destination: a backup is an input like any other.
 */
export function verifyRestored(root) {
  const problems = []
  const manifestPath = join(root, "manifest.json")
  if (!existsSync(manifestPath)) return { ok: false, problems: ["归档里没有 manifest.json，无法核对内容"], manifest: null }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    return { ok: false, problems: ["manifest.json 不是可读的 JSON"], manifest: null }
  }
  const base = resolve(root)
  for (const file of manifest.files || []) {
    const target = resolve(base, String(file.path))
    if (target !== base && target.indexOf(base + sep) !== 0) {
      problems.push("manifest 里的路径跑到归档外面去了：" + String(file.path))
      continue
    }
    if (!existsSync(target)) { problems.push("归档里少了文件：" + file.path); continue }
    const size = statSync(target).size
    if (size !== file.bytes) problems.push(file.path + " 字节数不符（记录 " + file.bytes + "，实际 " + size + "）")
    const digest = sha256OfFile(target)
    if (digest !== file.sha256) problems.push(file.path + " 的内容与清单不一致")
  }
  return { ok: problems.length === 0, problems: problems, manifest: manifest }
}

/**
 * Old archives go, but the newest one never does: a window shorter than the outage would
 * otherwise delete the only copy that could still restore the service.
 */
export function pruneArchives(options) {
  const opts = options || {}
  const keepDays = typeof opts.keepDays === "number" ? opts.keepDays : 14
  const now = typeof opts.now === "number" ? opts.now : Date.now()
  const cutoff = now - keepDays * 24 * 3600 * 1000
  const named = (opts.files || []).map(function (file) {
    const match = /agentgate-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tgz$/.exec(file)
    if (!match) return { file: file, at: null }
    return { file: file, at: Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) }
  }).sort(function (a, b) { return (b.at || 0) - (a.at || 0) })
  const keep = []
  const remove = []
  named.forEach(function (item, index) {
    if (index === 0) { keep.push(item.file); return }
    if (item.at === null) { keep.push(item.file); return }
    if (item.at < cutoff) remove.push(item.file)
    else keep.push(item.file)
  })
  return { keep: keep, remove: remove }
}
