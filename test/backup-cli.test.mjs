import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, statSync, truncateSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchDir } from "./tmpdir.mjs"
import { appendCapture } from "../packages/history/src/ledger.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BACKUP = join(ROOT, "scripts", "backup.mjs")
const DRILL = join(ROOT, "scripts", "restore-drill.mjs")

function run(script, args) {
  return spawnSync(process.execPath, [script].concat(args), { cwd: ROOT, encoding: "utf8" })
}

/** A deployment small enough to reason about and complete enough to restore. */
function deployment() {
  const dir = scratchDir("ag-p3-")
  mkdirSync(join(dir, "data", "history"), { recursive: true })
  mkdirSync(join(dir, "site"), { recursive: true })
  const indexPath = join(dir, "data", "index.json")
  const index = { generatedAt: "2026-09-17T00:00:00.000Z", count: 2, records: [{ server: "a/one", verdict: "clean" }, { server: "a/two", verdict: "findings" }] }
  writeFileSync(indexPath, JSON.stringify(index))
  // The capture records the same object the file holds: a ledger line whose numbers disagree with
  // its own snapshot is exactly what verifyLedger is built to catch.
  appendCapture(join(dir, "data", "history"), { index: index, indexFile: indexPath })
  writeFileSync(join(dir, "site", "index.html"), "<html>ok</html>")
  return { dir: dir, archives: join(dir, "archives") }
}

test("a backup is created, and the drill restores it and starts the service", function () {
  const d = deployment()
  const created = run(BACKUP, ["--data", join(d.dir, "data"), "--site", join(d.dir, "site"), "--out-dir", d.archives])
  assert.equal(created.status, 0, created.stdout + created.stderr)
  assert.match(created.stdout, /备份完成/)
  const archives = readdirSync(d.archives)
  assert.equal(archives.length, 1)

  const drilled = run(DRILL, ["--out-dir", d.archives])
  assert.equal(drilled.status, 0, drilled.stdout + drilled.stderr)
  assert.match(drilled.stdout, /账本校验通过/)
  assert.match(drilled.stdout, /服务从恢复的数据起得来：\/health 2 条记录/)
})

test("a truncated archive fails the drill instead of passing quietly", function () {
  const d = deployment()
  run(BACKUP, ["--data", join(d.dir, "data"), "--site", join(d.dir, "site"), "--out-dir", d.archives])
  const archive = join(d.archives, readdirSync(d.archives)[0])
  truncateSync(archive, Math.floor(statSync(archive).size / 2))
  const drilled = run(DRILL, ["--out-dir", d.archives])
  assert.equal(drilled.status, 1)
  assert.match(drilled.stderr, /归档解不开|恢复演练失败/)
})

test("drilling with no archive is refused, not reported as healthy", function () {
  const d = deployment()
  const drilled = run(DRILL, ["--out-dir", d.archives])
  assert.equal(drilled.status, 3)
  assert.match(drilled.stderr, /没有可用的归档/)
})

test("--dry-run prints the plan and writes nothing", function () {
  const d = deployment()
  const planned = run(BACKUP, ["--data", join(d.dir, "data"), "--site", join(d.dir, "site"), "--out-dir", d.archives, "--dry-run"])
  assert.equal(planned.status, 0, planned.stderr)
  assert.match(planned.stdout, /将备份到/)
  assert.equal(existsSync(d.archives), false)
})

test("a backup without an index is refused: that archive would restore a dead service", function () {
  const dir = scratchDir("ag-p3-")
  mkdirSync(join(dir, "data"), { recursive: true })
  const created = run(BACKUP, ["--data", join(dir, "data"), "--out-dir", join(dir, "archives")])
  assert.equal(created.status, 1)
  assert.match(created.stderr, /不是备份/)
})

test("pruning keeps the newest and drops what is older than the window", function () {
  const d = deployment()
  mkdirSync(d.archives, { recursive: true })
  writeFileSync(join(d.archives, "agentgate-20200101T000000Z.tgz"), "old")
  writeFileSync(join(d.archives, "agentgate-20200102T000000Z.tgz"), "old")
  const created = run(BACKUP, ["--data", join(d.dir, "data"), "--site", join(d.dir, "site"), "--out-dir", d.archives, "--keep-days", "3"])
  assert.equal(created.status, 0, created.stderr)
  const left = readdirSync(d.archives).sort()
  assert.equal(left.length, 1, "only today's archive should be left: " + left.join(", "))
  assert.match(created.stdout, /删除过期归档/)
})
