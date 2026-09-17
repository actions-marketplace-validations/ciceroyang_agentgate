import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchDir } from "./tmpdir.mjs"
import { start } from "../packages/service/src/start.mjs"
import { appendCapture } from "../packages/history/src/ledger.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(ROOT, "scripts", "healthcheck.mjs")

function buildDeployment(ageHours, recordCount) {
  const dir = scratchDir("ag-health-")
  const generatedAt = new Date(Date.now() - ageHours * 3600 * 1000).toISOString()
  const records = []
  for (let i = 0; i < recordCount; i += 1) records.push({ server: "a/one-" + i, verdict: "clean" })
  const indexPath = join(dir, "index.json")
  writeFileSync(indexPath, JSON.stringify({ generatedAt: generatedAt, threshold: "medium", count: records.length, records: records }))
  const historyPath = join(dir, "history")
  mkdirSync(historyPath, { recursive: true })
  appendCapture(historyPath, { index: { generatedAt: generatedAt, records: records }, indexFile: indexPath })
  return { dir: dir, indexPath: indexPath, historyPath: historyPath }
}

function runCli(args) {
  const child = spawn(process.execPath, [CLI].concat(args), { cwd: ROOT, env: Object.assign({}, process.env) })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", function (chunk) { stdout += chunk })
  child.stderr.on("data", function (chunk) { stderr += chunk })
  return new Promise(function (resolve) {
    child.on("exit", function (code) { resolve({ status: code, stdout: stdout, stderr: stderr }) })
  })
}

async function withServer(options, body) {
  const server = start(Object.assign({ port: 0, host: "127.0.0.1" }, options))
  await new Promise(function (resolve) { server.once("listening", resolve) })
  const base = "http://127.0.0.1:" + server.address().port
  try { return await body(base) } finally { await new Promise(function (resolve) { server.close(resolve) }) }
}

test("a healthy deployment exits 0 and reports the numbers", async function () {
  const deployment = buildDeployment(1, 3)
  await withServer({ indexPath: deployment.indexPath, historyPath: deployment.historyPath }, async function (base) {
    const out = await runCli(["--url", base + "/health", "--history", deployment.historyPath, "--disk-path", deployment.dir, "--state", join(deployment.dir, "state.json"), "--no-alert", "--format", "json"])
    assert.equal(out.status, 0, out.stdout + out.stderr)
    const body = JSON.parse(out.stdout)
    assert.equal(body.ok, true)
    assert.deepEqual(body.checked.sort(), ["disk", "health", "ledger"])
    assert.equal(body.facts.index_records, 3)
  })
})

test("a capture that is three days old exits 1 with the age problem", async function () {
  const deployment = buildDeployment(72, 3)
  await withServer({ indexPath: deployment.indexPath, historyPath: deployment.historyPath }, async function (base) {
    const out = await runCli(["--url", base + "/health", "--history", deployment.historyPath, "--disk-path", deployment.dir, "--state", join(deployment.dir, "state.json"), "--no-alert"])
    assert.equal(out.status, 1)
    assert.match(out.stdout, /history_age/)
  })
})

test("an unreachable service is a problem even though nothing could be read", async function () {
  const deployment = buildDeployment(1, 1)
  const out = await runCli(["--url", "http://127.0.0.1:9/health", "--history", deployment.historyPath, "--state", join(deployment.dir, "state.json"), "--no-alert"])
  assert.equal(out.status, 1)
  assert.match(out.stdout, /health_not_ok/)
  assert.match(out.stdout, /health/)
})

test("--dry-run prints the mail it would send and sends nothing", async function () {
  const deployment = buildDeployment(72, 1)
  const env = {
    SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "465", SMTP_USER: "u@example.com",
    SMTP_PASS: "not-a-real-password", AGENTGATE_ALERT_TO: "me@example.com",
  }
  const child = spawn(process.execPath, [CLI, "--url", "http://127.0.0.1:9/health", "--history", deployment.historyPath, "--state", join(deployment.dir, "state.json"), "--dry-run"], { cwd: ROOT, env: Object.assign({}, process.env, env) })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", function (c) { stdout += c })
  child.stderr.on("data", function (c) { stderr += c })
  const status = await new Promise(function (resolve) { child.on("exit", resolve) })
  assert.equal(status, 1)
  assert.match(stderr, /dry-run：没有真的发送/)
  assert.match(stderr, /Subject: \[agentgate\] 巡检异常/)
  assert.equal(stderr.indexOf("not-a-real-password"), -1)
})

test("needing to alert without credentials fails loudly with 3", async function () {
  const deployment = buildDeployment(72, 1)
  const child = spawn(process.execPath, [CLI, "--url", "http://127.0.0.1:9/health", "--history", deployment.historyPath, "--state", join(deployment.dir, "state.json")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { SMTP_HOST: "", SMTP_PORT: "", SMTP_USER: "", SMTP_PASS: "", AGENTGATE_ALERT_TO: "" }),
  })
  let stderr = ""
  child.stderr.on("data", function (c) { stderr += c })
  const status = await new Promise(function (resolve) { child.on("exit", resolve) })
  assert.equal(status, 3)
  assert.match(stderr, /告警环境变量缺少|告警没能发出/)
})

test("--site checks the public URLs", async function () {
  const deployment = buildDeployment(1, 1)
  await withServer({ indexPath: deployment.indexPath, historyPath: deployment.historyPath }, async function (base) {
    const ok = await runCli(["--url", base + "/health", "--history", deployment.historyPath, "--state", join(deployment.dir, "state.json"), "--no-alert", "--site", base + "/health"])
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    const bad = await runCli(["--url", base + "/health", "--history", deployment.historyPath, "--state", join(deployment.dir, "state2.json"), "--no-alert", "--site", base + "/nope"])
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /url/)
  })
})
test("--backup-dir turns a stopped backup into an alert condition", async function () {
  const deployment = buildDeployment(1, 1)
  const backups = join(deployment.dir, "backups")
  mkdirSync(backups, { recursive: true })
  const nowName = "agentgate-19700101T000000Z.tgz"
  writeFileSync(join(backups, nowName), "x")
  const fresh = await runCli(["--url", "http://127.0.0.1:9/health", "--history", deployment.historyPath, "--state", join(deployment.dir, "s1.json"), "--no-alert", "--backup-dir", backups])
  assert.equal(fresh.status, 1)
  assert.equal(fresh.stdout.indexOf("backup_age"), -1, "a just-written archive is not old")
  assert.equal(fresh.stdout.indexOf("health_not_ok") !== -1, true)

  const missing = await runCli(["--url", "http://127.0.0.1:9/health", "--history", deployment.historyPath, "--state", join(deployment.dir, "s2.json"), "--no-alert", "--backup-dir", join(deployment.dir, "nope")])
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /backup_absent/)
})
