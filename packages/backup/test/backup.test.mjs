import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { scratchDir } from "../../../test/tmpdir.mjs"
import { buildManifest, createArchive, extractArchive, planArchive, pruneArchives, verifyRestored } from "../src/backup.mjs"

function makeTree() {
  const dir = scratchDir("ag-backup-")
  mkdirSync(join(dir, "data", "history"), { recursive: true })
  writeFileSync(join(dir, "data", "index.json"), JSON.stringify({ count: 2, records: [{ server: "a/one" }, { server: "a/two" }] }))
  writeFileSync(join(dir, "data", "history", "ledger.jsonl"), "{\"day\":\"2026-09-17\"}\n")
  return dir
}

function goodExec(calls) {
  return function (command, args) { calls.push([command].concat(args)); return { status: 0, stderr: "" } }
}

test("planArchive says which sources are there and which are not", function () {
  const dir = makeTree()
  const plan = planArchive([{ prefix: "data", path: join(dir, "data") }, { prefix: "site", path: join(dir, "site") }])
  assert.equal(plan.entries.length, 1)
  assert.deepEqual(plan.missing, ["site"])
})

test("the manifest hashes the staged copies, not the originals", function () {
  const dir = makeTree()
  const calls = []
  const outFile = join(dir, "archives", "agentgate-20260917T000000Z.tgz")
  const result = createArchive({
    plan: planArchive([{ prefix: "data", path: join(dir, "data") }]),
    outFile: outFile, exec: goodExec(calls), createdAt: "2026-09-17T00:00:00.000Z", records: 2, historyCaptures: 1,
  })
  assert.equal(result.ok, true)
  const paths = result.manifest.files.map(function (file) { return file.path })
  assert.deepEqual(paths.sort(), ["data/history/ledger.jsonl", "data/index.json"])
  for (const file of result.manifest.files) assert.match(file.sha256, /^[a-f0-9]{64}$/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], "tar")
})

test("a tar that fails is reported rather than treated as an archive", function () {
  const dir = makeTree()
  const result = createArchive({
    plan: planArchive([{ prefix: "data", path: join(dir, "data") }]),
    outFile: join(dir, "x.tgz"),
    exec: function () { return { status: 2, stderr: "tar: disk full\nmore" } },
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /disk full/)
})

test("re-hashing catches an edited file, a missing file and an escaping path", function () {
  const dir = makeTree()
  const entries = [{ prefix: "data", path: join(dir, "data") }]
  const manifest = buildManifest({ root: dir, entries: entries, createdAt: "T" })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  assert.equal(verifyRestored(dir).ok, true)

  writeFileSync(join(dir, "data", "index.json"), "changed")
  const tampered = verifyRestored(dir)
  assert.equal(tampered.ok, false)
  assert.match(tampered.problems.join(" "), /内容与清单不一致|字节数不符/)

  writeFileSync(join(dir, "data", "index.json"), JSON.stringify({ count: 2, records: [] }))
  rmSync(join(dir, "data", "history", "ledger.jsonl"))
  assert.match(verifyRestored(dir).problems.join(" "), /少了文件/)

  const escaping = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  escaping.files.push({ path: "../../etc/passwd", bytes: 1, sha256: "a".repeat(64) })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(escaping))
  assert.match(verifyRestored(dir).problems.join(" "), /跑到归档外面去了/)
})

test("an archive without a readable manifest is refused", function () {
  const dir = scratchDir("ag-backup-")
  assert.match(verifyRestored(dir).problems.join(" "), /没有 manifest.json/)
  writeFileSync(join(dir, "manifest.json"), "{ not json")
  assert.match(verifyRestored(dir).problems.join(" "), /不是可读的 JSON/)
})

test("extraction failure is reported", function () {
  const broken = extractArchive({ archiveFile: "/nope.tgz", destDir: "/tmp", exec: function () { return { status: 2, stderr: "gzip: not in gzip format" } } })
  assert.equal(broken.ok, false)
  assert.match(broken.detail, /not in gzip format/)
})

test("the newest archive survives any window, and unknown names are left alone", function () {
  const now = Date.UTC(2026, 8, 17)
  const prune = pruneArchives({
    files: ["agentgate-20200101T000000Z.tgz", "agentgate-20260901T000000Z.tgz", "notes.txt", "agentgate-20260916T000000Z.tgz"],
    keepDays: 2, now: now,
  })
  assert.ok(prune.keep.indexOf("agentgate-20260916T000000Z.tgz") !== -1, "the newest is kept")
  assert.ok(prune.keep.indexOf("notes.txt") !== -1, "a file we did not name is not ours to delete")
  assert.deepEqual(prune.remove, ["agentgate-20260901T000000Z.tgz", "agentgate-20200101T000000Z.tgz"])
})

test("a window longer than the outage keeps everything recent", function () {
  const prune = pruneArchives({ files: ["agentgate-20260916T000000Z.tgz", "agentgate-20260917T000000Z.tgz"], keepDays: 30, now: Date.UTC(2026, 8, 17) })
  assert.deepEqual(prune.remove, [])
})
