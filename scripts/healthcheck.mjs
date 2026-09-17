#!/usr/bin/env node
/**
 * Ask the deployment how it is doing, from outside the process that would be reporting about
 * itself. This is the thing that notices a stopped daily job, and a stopped daily job is the one
 * failure here that cannot be recovered later.
 *
 *   node scripts/healthcheck.mjs                     # check, alert only if the state changed
 *   node scripts/healthcheck.mjs --dry-run           # print the mail, send nothing
 *   node scripts/healthcheck.mjs --format json --no-alert
 *
 * Exit 0 fine, 1 problems found, 3 could not alert (which is itself worth failing loudly for).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { checkLedger, decideAlert, buildMessage, renderText, runChecks } from "../packages/service/src/healthcheck.mjs"
import { alertEnv, sendAlert } from "../packages/service/src/alert.mjs"
import { verifyLedger } from "../packages/history/src/ledger.mjs"

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

async function getJson(target) {
  const controller = new AbortController()
  const timer = setTimeout(function () { controller.abort() }, 10000)
  try {
    const response = await fetch(target, { signal: controller.signal })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch (error) { body = null }
    return { status: response.status, body: body }
  } catch (error) {
    return { status: null, error: String((error && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

async function statusOf(target) {
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(10000) })
    return { url: target, status: response.status, ok: response.status === 200 }
  } catch (error) {
    return { url: target, status: null, error: String((error && error.message) || error), ok: false }
  }
}

function readState(path) {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, "utf8")) } catch (error) { return null }
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n")
}

const args = parse(process.argv.slice(2))
if (args.help) {
  process.stdout.write([
    "usage: healthcheck [--url http://127.0.0.1:8080/health] [--history data/history] [--disk-path .]",
    "                   [--site https://a/,https://a/history.html] [--max-age 26] [--repeat-hours 6]",
    "                   [--state data/healthcheck-state.json] [--format text|json] [--no-alert] [--dry-run]",
    "",
    "Alerts go through SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS and AGENTGATE_ALERT_TO.",
    "Exit: 0 fine, 1 problems, 3 could not alert.",
  ].join("\n") + "\n")
  process.exit(0)
}
const url = String(args.url || process.env.AGENTGATE_HEALTH_URL || "http://127.0.0.1:8080/health")
const historyDir = resolve(String(args.history || process.env.AGENTGATE_HISTORY || join(ROOT, "data", "history")))
const diskPath = resolve(String(args["disk-path"] || process.env.AGENTGATE_DISK_PATH || ROOT))
const stateFile = resolve(String(args.state || process.env.AGENTGATE_HEALTH_STATE || join(ROOT, "data", "healthcheck-state.json")))
const maxAgeHours = Number(args["max-age"] || process.env.AGENTGATE_MAX_AGE_HOURS || 26)
const repeatHours = Number(args["repeat-hours"] || process.env.AGENTGATE_REPEAT_HOURS || 6)
const dryRun = args["dry-run"] === true
const noAlert = args["no-alert"] === true
const sites = args.site ? String(args.site).split(",").map(function (s) { return s.trim() }).filter(Boolean) : []

const health = await getJson(url)
let disk = null
try {
  const stat = statfsSync(diskPath)
  disk = { freeBytes: stat.bsize * stat.bavail }
} catch (error) {
  disk = null
}
let ledger
if (!existsSync(historyDir)) ledger = { ok: false, problems: ["账本目录不存在：" + historyDir] }
else ledger = verifyLedger(historyDir, { maxAgeHours: maxAgeHours })
const urls = []
for (const site of sites) urls.push(await statusOf(site))
// Opt-in: a machine that keeps its backups somewhere else simply does not pass --backup-dir.
let backups
const backupDir = args["backup-dir"] ? resolve(String(args["backup-dir"])) : null
if (backupDir) {
  backups = []
  if (existsSync(backupDir)) {
    for (const name of readdirSync(backupDir)) {
      try { backups.push({ name: name, mtimeMs: statSync(join(backupDir, name)).mtimeMs }) } catch (error) { /* unreadable entries are not archives */ }
    }
  }
}

const facts = {
  health_url: url,
  health_status: health.status === null ? "unreachable" : health.status,
  index_records: health.body && health.body.records !== undefined ? health.body.records : "unknown",
  index_generated_at: health.body ? health.body.generatedAt : "unknown",
  history_age_hours: health.body && health.body.history ? health.body.history.ageHours : "unknown",
  ledger_captures: Array.isArray(ledger.entries) ? ledger.entries.length : "unknown",
  ledger_not_retained: Array.isArray(ledger.notRetained) ? ledger.notRetained.length : "unknown",
  backups_found: Array.isArray(backups) ? backups.filter(function (file) { return /\.tgz$/.test(file.name) }).length : "not checked",
  disk_free_bytes: disk ? disk.freeBytes : "unknown",
}

// An unreachable service is a problem, not a missing check: `health.body` being undefined
// used to make runChecks skip the health source entirely, which is exactly the shape of failure
// this project exists to prevent.
const healthBody = health.body && typeof health.body === "object"
  ? health.body
  : { ok: false, reason: health.status === null ? "unreachable：" + String(health.error || "") : "HTTP " + health.status + " 且响应不是 JSON 对象" }

const result = runChecks({
  health: healthBody,
  disk: disk,
  ledger: ledger,
  urls: urls.length > 0 ? urls : undefined,
  backups: backups,
  options: { maxAgeHours: maxAgeHours, backupMaxAgeHours: Number(args["backup-max-age"] || 36) },
  facts: facts,
})

const status = result.ok ? "ok" : "fail"
const previous = readState(stateFile)
const decision = decideAlert(previous, status, Date.now(), { repeatAlertHours: repeatHours })
writeState(stateFile, { status: status, lastAlertAt: decision.state.lastAlertAt, at: new Date().toISOString(), problems: result.problems.map(function (p) { return p.id }) })

let alert = { action: decision.action, reason: decision.reason, sent: null }
if (decision.action !== "none" && !noAlert) {
  let config = null
  try {
    config = alertEnv(process.env)
  } catch (error) {
    alert.sent = { ok: false, detail: error.message }
  }
  if (config) {
    const message = buildMessage({
      from: config.from, to: config.to,
      status: decision.action === "recovery" ? "recovery" : "fail",
      problems: result.problems, facts: facts, nowMs: Date.now(),
    })
    if (dryRun) {
      alert.sent = { ok: true, detail: "dry-run：没有真的发送" }
      process.stderr.write(message)
    } else {
      alert.sent = sendAlert(message, { config: config })
    }
  }
  if (alert.sent && alert.sent.ok === false) process.stderr.write("healthcheck: 告警没能发出：" + alert.sent.detail + "\n")
  else if (alert.sent) process.stderr.write("healthcheck: 告警已发出（" + alert.sent.detail + "）\n")
}

if (args.format === "json") {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: result.ok, checked: result.checked, problems: result.problems, facts: facts, alert: alert }, null, 2) + "\n")
} else {
  process.stdout.write(renderText(result, alert) + "\n")
}

if (alert.sent && alert.sent.ok === false) process.exit(3)
process.exit(result.ok ? 0 : 1)
