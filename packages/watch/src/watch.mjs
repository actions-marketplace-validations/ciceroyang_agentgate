/**
 * A record of what a customer's tool list looked like each time we captured it.
 *
 * The report is what the customer shows someone; this is what makes the report checkable later.
 * Each capture appends one line whose prev is the hash of the line before it, so rewriting an
 * earlier capture is detectable, and the projection it recorded lives in
 * snapshots/<sha256>.json, addressed by content so an unchanged list does not accumulate copies.
 *
 * The chaining primitive is the one the public index ledger already uses (hashOfLine). Two
 * ledgers with two hash rules would drift, and a drifted record is worth nothing.
 */
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hashOfLine } from "../../history/src/ledger.mjs"

export const WATCH_VERSION = 1

const FORMATS = ["raw", "wecom", "feishu", "slack"]

function sha256Hex(buffer) { return createHash("sha256").update(buffer).digest("hex") }

// Sort object keys and unordered evidence lists; keep only the digest, never private findings.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value ?? null
}

/** The identity of a list entry: the thing we would match against the index. */
export function keyOf(entry) {
  return entry.server || entry.package || entry.name || "(未命名)"
}

/** The bytes we hash when we say "this is the list we were given", order independent. */
export function canonicalInput(entries) {
  const rows = (entries || []).map(function (entry) {
    return {
      name: entry.name || null, server: entry.server || null, package: entry.package || null,
      registry: entry.registry || null, version: entry.version || null,
    }
  })
  rows.sort(function (a, b) { return JSON.stringify(a).localeCompare(JSON.stringify(b)) })
  return JSON.stringify(rows)
}

/**
 * What we keep from a report: enough to say what changed, and nothing that would turn this into
 * a copy of the customer's private material.
 */
export function projectionOf(report) {
  const rows = ((report && report.items) || []).map(function (item) {
    const input = item.input || {}
    return {
      key: keyOf(input),
      identity: JSON.stringify([input.server || null, input.registry || null, input.package || null, input.server || input.package ? null : input.name || null]),
      state: item.state || "insufficient",
      label: item.label || null,
      version: input.version || null,
      evidence: item.selected ? (item.selected.version || null) : null,
      findings: (item.findings || []).length,
      fingerprint: sha256Hex(JSON.stringify(canonical({
        selected: item.selected || null, findings: item.findings || [],
        evidence: (item.evidence || []).map(({ observedAt, auditedAt, ...content }) => content),
        execution: item.execution ? { state: item.execution.state, components: item.execution.components } : null,
        scanner: report.index?.scanner || null,
      }))),
    }
  })
  rows.sort(function (a, b) { return a.identity.localeCompare(b.identity) || JSON.stringify(a).localeCompare(JSON.stringify(b)) })
  return rows
}

export function diffProjections(previous, current) {
  const identity = i => i.identity || i.key
  const group = rows => {
    const groups = new Map()
    for (const row of rows || []) groups.set(identity(row), [...(groups.get(identity(row)) || []), row])
    return groups
  }
  const before = group(previous)
  const after = group(current)
  const added = (current || []).filter(i => !before.has(identity(i))).map(i => i.key)
  const removed = (previous || []).filter(i => !after.has(identity(i))).map(i => i.key)
  const changed = []
  for (const [id, items] of after) {
    const prior = before.get(id)
    if (!prior) continue
    const item = items[0], old = prior[0]
    const differs = JSON.stringify(canonical(prior)) !== JSON.stringify(canonical(items))
    if (differs) {
      changed.push({
        key: item.key, fromState: old.state, toState: item.state,
        fromLabel: old.label, toLabel: item.label,
        fromVersion: old.version, toVersion: item.version,
      })
    }
  }
  return { added: added, removed: removed, changed: changed }
}

/**
 * The Chinese summary that goes to a chat channel or a terminal. When there is nothing to
 * compare against it says so instead of printing "no changes", which would read as "verified".
 */
export function summarize(diff, options) {
  const opts = options || {}
  if (opts.firstRun) return "第一次归档：" + opts.items + " 项工具。没有可比的上一次，这次只记录当前状态，不做比较。"
  if (opts.comparable === false) return "上一次的快照没有保留，这次无法比较，只记录了当前状态（" + opts.items + " 项）。"
  const lines = []
  lines.push("新增 " + diff.added.length + "，移除 " + diff.removed.length + "，变化 " + diff.changed.length + "（共 " + opts.items + " 项）")
  for (const key of diff.added) lines.push("  + " + key)
  for (const key of diff.removed) lines.push("  - " + key)
  for (const change of diff.changed) {
    const from = change.fromLabel || change.fromState
    const to = change.toLabel || change.toState
    const version = change.fromVersion !== change.toVersion ? "（版本 " + (change.fromVersion || "未给") + " → " + (change.toVersion || "未给") + "）" : ""
    lines.push("  ~ " + change.key + "：" + from + " → " + to + version)
  }
  if (diff.added.length + diff.removed.length + diff.changed.length === 0) lines.push("  没有变化。")
  return lines.join("\n")
}

/** One payload per chat service. Pure, so the shape can be tested without a socket. */
export function webhookPayload(format, summaryText, diff, capturedAt) {
  if (FORMATS.indexOf(format) === -1) throw new Error("不认识的推送格式：" + format + "（支持 " + FORMATS.join(", ") + "）")
  if (format === "wecom") return { msgtype: "text", text: { content: summaryText } }
  if (format === "feishu") return { msg_type: "text", content: { text: summaryText } }
  if (format === "slack") return { text: summaryText }
  return {
    schemaVersion: WATCH_VERSION,
    capturedAt: capturedAt || null,
    summary: summaryText,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed.map(function (change) { return change.key }),
  }
}

export function readWatch(archiveDir) {
  const path = join(archiveDir, "watch.jsonl")
  if (!existsSync(path)) return []
  const raw = readFileSync(path, "utf8").split("\n")
  const out = []
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].trim().length === 0) continue
    const entry = JSON.parse(raw[i])
    entry.hash = hashOfLine(raw[i])
    entry.line = i + 1
    out.push(entry)
  }
  return out
}

/**
 * Record one capture. Appends exactly one line and never edits an earlier one.
 *
 * When the previous snapshot is gone the run still records what it saw, but it reports that the
 * comparison could not be made rather than pretending the list did not change.
 */
export function appendWatch(archiveDir, options) {
  mkdirSync(join(archiveDir, "snapshots"), { recursive: true })
  const previous = readWatch(archiveDir)
  const capturedAt = options.capturedAt || new Date().toISOString()
  const current = projectionOf(options.report)
  const last = previous.length > 0 ? previous[previous.length - 1] : null
  let previousProjection = null
  if (last && last.snapshot) {
    const snapshotPath = join(archiveDir, last.snapshot)
    if (existsSync(snapshotPath)) {
      try { previousProjection = JSON.parse(readFileSync(snapshotPath, "utf8")) } catch (error) { previousProjection = null }
    }
  }
  const inputDigest = sha256Hex(canonicalInput(options.entries))
  const projectionText = JSON.stringify(current, null, 2)
  const reportDigest = sha256Hex(projectionText)
  const snapshotName = "snapshots/" + reportDigest + ".json"
  const snapshotPath = join(archiveDir, snapshotName)
  if (!existsSync(snapshotPath)) writeFileSync(snapshotPath, projectionText)
  const firstRun = previous.length === 0
  const diff = previousProjection ? diffProjections(previousProjection, current) : { added: [], removed: [], changed: [] }
  const summaryOfReport = (options.report && options.report.summary) || {}
  const entry = {
    schemaVersion: WATCH_VERSION,
    capturedAt: capturedAt,
    inputDigest: inputDigest,
    reportDigest: reportDigest,
    items: current.length,
    matched: typeof summaryOfReport.matched === "number" ? summaryOfReport.matched : null,
    needsAttention: typeof summaryOfReport.needsAttention === "number" ? summaryOfReport.needsAttention : null,
    snapshot: snapshotName,
    prev: last ? last.hash : null,
  }
  const line = JSON.stringify(entry)
  appendFileSync(join(archiveDir, "watch.jsonl"), line + "\n")
  return {
    entry: entry,
    hash: hashOfLine(line),
    diff: diff,
    firstRun: firstRun,
    comparable: previousProjection !== null,
    summary: summarize(diff, { firstRun: firstRun, comparable: firstRun || previousProjection !== null, items: current.length }),
  }
}

/**
 * Recompute the chain and every retained snapshot.
 *
 * A pruned snapshot is reported and does not fail the check: dropping old bytes is a storage
 * decision, and saying so is different from a record that no longer matches itself.
 */
export function verifyWatch(archiveDir) {
  const entries = readWatch(archiveDir)
  const problems = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    const expectedPrev = i === 0 ? null : entries[i - 1].hash
    if ((entry.prev || null) !== expectedPrev) {
      problems.push({ line: entry.line, problem: "chain", detail: "第 " + entry.line + " 行的 prev 与上一行的哈希不一致" })
    }
    if (!entry.snapshot) { problems.push({ line: entry.line, problem: "chain", detail: "第 " + entry.line + " 行没有记录快照" }); continue }
    const snapshotPath = join(archiveDir, entry.snapshot)
    if (!existsSync(snapshotPath)) { problems.push({ line: entry.line, problem: "pruned", detail: "快照未保留：" + entry.snapshot }); continue }
    const digest = sha256Hex(readFileSync(snapshotPath))
    if (digest !== entry.reportDigest) problems.push({ line: entry.line, problem: "snapshot", detail: "快照内容与记录中的摘要不一致：" + entry.snapshot })
  }
  return {
    ok: problems.filter(function (p) { return p.problem !== "pruned" }).length === 0,
    captures: entries.length,
    problems: problems,
  }
}
