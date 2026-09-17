#!/usr/bin/env node
/**
 * M5 acceptance. A backup is taken, the archive is restored into a clean directory, the ledger
 * chain in it verifies, the service starts against the restored index - and a truncated archive
 * fails the drill rather than being reported as a successful restore.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchDir } from "./scratch-dir.mjs"
import { appendCapture } from "../packages/history/src/ledger.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
let failures = 0
const check = function (name, ok, detail) {
  if (ok) { console.log("ok    " + name); return }
  failures += 1
  console.log("FAIL  " + name + (detail ? "  -> " + detail : ""))
}

function run(script, args, expectFailure) {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, script)].concat(args), { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    return { status: 0, stdout: stdout, stderr: "" }
  } catch (error) {
    return { status: error.status === null || error.status === undefined ? -1 : error.status, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") }
  }
}

const dir = scratchDir("ag-m5-")
const dataDir = join(dir, "data")
const siteDir = join(dir, "site")
const archives = join(dir, "archives")
mkdirSync(join(dataDir, "history"), { recursive: true })
mkdirSync(siteDir, { recursive: true })
const indexPath = join(dataDir, "index.json")
const index = { generatedAt: "2026-09-17T00:00:00.000Z", count: 2, records: [{ server: "a/one", verdict: "clean" }, { server: "a/two", verdict: "findings" }] }
writeFileSync(indexPath, JSON.stringify(index))
writeFileSync(join(siteDir, "index.html"), "<html>ok</html>")
appendCapture(join(dataDir, "history"), { index: index, indexFile: indexPath })

const planned = run("scripts/backup.mjs", ["--data", dataDir, "--site", siteDir, "--out-dir", archives, "--dry-run"])
check("the plan is printed without writing anything", planned.status === 0 && planned.stdout.indexOf("将备份到") !== -1, planned.stderr)
check("the dry run created no archive", !statSync(dir).isFile() && !(function () { try { readdirSync(archives) ; return true } catch (error) { return false } })())

const created = run("scripts/backup.mjs", ["--data", dataDir, "--site", siteDir, "--out-dir", archives])
check("the backup is written", created.status === 0 && created.stdout.indexOf("备份完成") !== -1, created.stderr)
const archive = readdirSync(archives)[0]
check("exactly one archive exists", readdirSync(archives).length === 1, String(readdirSync(archives)))

const restored = run("scripts/restore-drill.mjs", ["--out-dir", archives])
check("the drill verifies the ledger", restored.stdout.indexOf("账本校验通过") !== -1, restored.stdout + restored.stderr)
check("the service starts from the restored index", restored.stdout.indexOf("服务从恢复的数据起得来") !== -1, restored.stdout)
check("the drill passes", restored.status === 0, restored.stderr)

const bad = join(archives, "agentgate-19700101T000000Z.tgz")
writeFileSync(bad, readFileSync(join(archives, archive)))
truncateSync(bad, Math.floor(statSync(bad).size / 2))
const broken = run("scripts/restore-drill.mjs", ["--from", bad])
check("a truncated archive fails the drill", broken.status === 1, "status " + broken.status)
check("and it says the archive could not be opened", /归档解不开|恢复演练失败/.test(broken.stderr), broken.stderr)

const empty = run("scripts/restore-drill.mjs", ["--out-dir", join(dir, "nothing-here")])
check("a missing archive is refused with exit 3", empty.status === 3, "status " + empty.status)

console.log("")
console.log(failures === 0 ? "M5 acceptance: green" : "M5 acceptance: " + failures + " failure(s)")
process.exit(failures === 0 ? 0 : 1)
