import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchDir } from "./tmpdir.mjs"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agentgate.mjs")

function run(args, cwd) {
  return spawnSyncLike(args, cwd)
}

function spawnSyncLike(args, cwd) {
  const child = spawn(process.execPath, [BIN].concat(args), { cwd: cwd })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", function (chunk) { stdout += chunk })
  child.stderr.on("data", function (chunk) { stderr += chunk })
  return new Promise(function (resolve) {
    child.on("exit", function (code) { resolve({ status: code, stdout: stdout, stderr: stderr }) })
  })
}

function fixture() {
  const dir = scratchDir("ag-watch-cli-")
  const index = join(dir, "index.json")
  writeFileSync(index, JSON.stringify({ generatedAt: "2026-09-17T00:00:00.000Z", records: [] }))
  const tools = join(dir, "tools.txt")
  writeFileSync(tools, "alpha@1.0.0\n")
  return { dir: dir, index: index, tools: tools, archive: join(dir, "archive") }
}

test("two captures: the second reports the new tool and the archive has two lines", async function () {
  const f = fixture()
  const first = await run(["watch", "--input", f.tools, "--index", f.index, "--archive", f.archive])
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.match(first.stdout, /第一次归档/)
  writeFileSync(f.tools, "alpha@1.0.0\nbeta@2.0.0\n")
  const second = await run(["watch", "--input", f.tools, "--index", f.index, "--archive", f.archive])
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /新增 1/)
  assert.match(second.stdout, /\+ beta/)
  const lines = readFileSync(join(f.archive, "watch.jsonl"), "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
})

test("--verify passes on an intact archive and fails after a line is rewritten", async function () {
  const f = fixture()
  await run(["watch", "--input", f.tools, "--index", f.index, "--archive", f.archive])
  await run(["watch", "--input", f.tools, "--index", f.index, "--archive", f.archive])
  const ok = await run(["watch", "--verify", "--archive", f.archive])
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /链与快照一致/)
  const path = join(f.archive, "watch.jsonl")
  const lines = readFileSync(path, "utf8").trim().split("\n")
  lines[0] = lines[0].replace('"items":1', '"items":7')
  writeFileSync(path, lines.join("\n") + "\n")
  const bad = await run(["watch", "--verify", "--archive", f.archive])
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /有不一致/)
})

test("--verify on an archive that does not exist is refused, not silently fine", async function () {
  const f = fixture()
  const out = await run(["watch", "--verify", "--archive", f.archive])
  assert.equal(out.status, 3)
  assert.match(out.stderr, /没有归档可验证/)
})

test("a webhook receives the summary in the shape the service expects", async function () {
  const f = fixture()
  const received = []
  const server = createServer(function (req, res) {
    let body = ""
    req.on("data", function (chunk) { body += chunk })
    req.on("end", function () {
      received.push({ url: req.url, body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
  })
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve) })
  const port = server.address().port
  const out = await run(["watch", "--input", f.tools, "--index", f.index, "--archive", f.archive, "--webhook", "http://127.0.0.1:" + port + "/hook", "--webhook-format", "wecom"])
  await new Promise(function (resolve) { server.close(resolve) })
  assert.equal(out.status, 0, out.stdout + out.stderr)
  assert.equal(received.length, 1)
  assert.equal(received[0].body.msgtype, "text")
  assert.match(received[0].body.text.content, /第一次归档/)
})

test("a failed push keeps the capture and exits non-zero", async function () {
  const f = fixture()
  const server = createServer()
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve) })
  const port = server.address().port
  await new Promise(function (resolve) { server.close(resolve) })
  const out = await run(["watch", "--input", f.tools, "--index", f.index, "--archive", f.archive, "--webhook", "http://127.0.0.1:" + port + "/hook"])
  assert.equal(out.status, 3)
  assert.match(out.stderr, /推送失败/)
  const lines = readFileSync(join(f.archive, "watch.jsonl"), "utf8").trim().split("\n")
  assert.equal(lines.length, 1, "the capture must survive a push failure")
})

test("watch without --input explains itself instead of watching nothing", async function () {
  const out = await run(["watch"])
  assert.equal(out.status, 3)
  assert.match(out.stderr, /usage: agentgate watch/)
})
