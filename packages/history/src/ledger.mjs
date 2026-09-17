import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * The record of every capture, in order, chained.
 *
 * The diff package answers "what changed between two index builds". This one answers a
 * different question: "were those builds actually made when this record says they were, and has
 * anything been rewritten since". Anyone can rebuild an index today and put yesterday's date on
 * it; a chained ledger makes that detectable, because editing one line breaks the hash of every
 * line after it. The value of this file is a pure function of time, which is the one ingredient
 * a competitor cannot buy.
 *
 * The ledger is append-only. Each capture also writes the index it saw into
 * `snapshots/<sha256>.json`, addressed by content, so two captures of an unchanged index share
 * one file. If a snapshot is later pruned to save space, verification says so instead of
 * pretending the capture never happened.
 */

export const LEDGER_VERSION = 1

function sha256Hex(buffer) { return createHash("sha256").update(buffer).digest("hex") }

/** The hash a line is referenced by, computed over the exact bytes that are stored. */
export function hashOfLine(raw) { return sha256Hex(Buffer.from(raw, "utf8")) }

/** The SHA-256 of a file, which is what a capture records about the index it saw. */
export function fileDigest(path) { return sha256Hex(readFileSync(path)) }

export function countsOf(index) {
  const counts = { clean: 0, findings: 0, incomplete: 0 }
  for (const r of (index && index.records) || []) {
    if (r && typeof r.verdict === "string") counts[r.verdict] = (counts[r.verdict] || 0) + 1
  }
  return counts
}

/** The ledger as stored: every line, with the hash that identifies it. */
export function readLedger(historyDir) {
  const path = join(historyDir, "ledger.jsonl")
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
 * Record one capture. Appends exactly one line; never edits an earlier one.
 *
 * `indexFile` is the file whose bytes are hashed and archived, not a re-serialization of the
 * parsed object: the evidence is the file as it was served, byte for byte.
 */
export function appendCapture(historyDir, options) {
  mkdirSync(historyDir, { recursive: true })
  const snapshots = join(historyDir, "snapshots")
  mkdirSync(snapshots, { recursive: true })
  const bytes = readFileSync(options.indexFile)
  const digest = sha256Hex(bytes)
  const snapshotName = digest + ".json"
  const snapshotPath = join(snapshots, snapshotName)
  if (!existsSync(snapshotPath)) writeFileSync(snapshotPath, bytes)

  const capturedAt = options.capturedAt || (options.index && options.index.generatedAt) || new Date().toISOString()
  // The day is what the caller is recording, which can be a backfill: the daily job passes its
  // --date, not the clock.
  const day = options.day || capturedAt.slice(0, 10)
  const previous = readLedger(historyDir)
  const entry = {
    schemaVersion: LEDGER_VERSION,
    capturedAt: capturedAt,
    day: day,
    records: Array.isArray(options.index && options.index.records) ? options.index.records.length : 0,
    counts: countsOf(options.index),
    scanner: options.scanner || null,
    snapshot: "snapshots/" + snapshotName,
    sha256: digest,
    prev: previous.length > 0 ? previous[previous.length - 1].hash : null,
  }
  const line = JSON.stringify(entry)
  appendFileSync(join(historyDir, "ledger.jsonl"), line + "\n")
  // The caller gets the hash it can chain against without re-reading the file.
  entry.hash = hashOfLine(line)

  // The day archive is the first capture of that day and is never rewritten: a later capture on
  // the same day updates previous.json (which the next diff compares against) but not this.
  const dayPath = join(historyDir, day + ".json")
  const wroteDay = !existsSync(dayPath)
  if (wroteDay) copyFileSync(options.indexFile, dayPath)
  return { entry: entry, wroteDay: wroteDay }
}

/**
 * Rebuild the ledger from the day archives that are already on disk.
 *
 * A ledger that can only be written by the job that ran is one disk failure away from being a
 * claim nobody can check. The day archives carry their own generatedAt and scanner, so a lost
 * ledger can be rebuilt from them; what it cannot recover is a day whose archive is also gone,
 * which is exactly the gap this reports.
 */
export function backfill(historyDir) {
  mkdirSync(join(historyDir, "snapshots"), { recursive: true })
  const recorded = new Set(readLedger(historyDir).map(function (e) { return e.day }))
  const files = readdirSync(historyDir).filter(function (f) { return /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$/.test(f) }).sort()
  const added = []
  for (const file of files) {
    const day = file.slice(0, 10)
    if (recorded.has(day)) continue
    const index = JSON.parse(readFileSync(join(historyDir, file), "utf8"))
    const result = appendCapture(historyDir, {
      index: index,
      indexFile: join(historyDir, file),
      scanner: index.scanner || null,
      day: day,
      capturedAt: index.generatedAt || day + "T00:00:00.000Z",
    })
    added.push(result.entry)
  }
  return added
}

/** Captures per day, and the days in between that have none. */
export function coverageOf(entries) {
  const days = new Map()
  for (const e of entries) days.set(e.day, (days.get(e.day) || 0) + 1)
  const ordered = Array.from(days.keys()).sort()
  const gaps = []
  if (ordered.length > 0) {
    const first = new Date(ordered[0] + "T00:00:00Z")
    const last = new Date(ordered[ordered.length - 1] + "T00:00:00Z")
    for (let t = first.getTime(); t <= last.getTime(); t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10)
      if (!days.has(day)) gaps.push(day)
    }
  }
  return {
    captures: entries.length,
    days: days.size,
    first: ordered.length > 0 ? ordered[0] : null,
    last: ordered.length > 0 ? ordered[ordered.length - 1] : null,
    gaps: gaps,
  }
}

/**
 * Recompute the chain and re-hash every retained snapshot.
 *
 * A missing snapshot is reported as not retained, not as tampering: pruning old content is a
 * storage decision, and the ledger still proves the capture happened. A snapshot whose bytes no
 * longer match, or a line whose prev does not match the line before it, is tampering.
 */
/** What the service can say about the record without reading the snapshots. */
export function summarize(historyDir) {
  const entries = readLedger(historyDir)
  const coverage = coverageOf(entries)
  const last = entries.length > 0 ? entries[entries.length - 1] : null
  return {
    captures: coverage.captures,
    days: coverage.days,
    first: coverage.first,
    last: coverage.last,
    gaps: coverage.gaps,
    lastCapturedAt: last ? last.capturedAt : null,
  }
}

export function verifyLedger(historyDir, options) {
  const opts = options || {}
  const entries = readLedger(historyDir)
  const problems = []
  const notRetained = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    const expectedPrev = i === 0 ? null : entries[i - 1].hash
    if (entry.prev !== expectedPrev) problems.push("line " + entry.line + ": prev does not match the line before it")
    const path = join(historyDir, entry.snapshot || "")
    if (!existsSync(path)) { notRetained.push(entry.snapshot); continue }
    const bytes = readFileSync(path)
    const digest = sha256Hex(bytes)
    if (digest !== entry.sha256) {
      problems.push("line " + entry.line + ": snapshot " + entry.snapshot + " is " + digest.slice(0, 12) + ", recorded " + String(entry.sha256).slice(0, 12))
      continue
    }
    // The numbers written on the line have to agree with the evidence it points at, otherwise
    // the last line of the ledger could be edited without anything noticing.
    try {
      const index = JSON.parse(bytes.toString("utf8"))
      const records = Array.isArray(index.records) ? index.records.length : 0
      if (records !== entry.records) problems.push("line " + entry.line + ": records says " + entry.records + ", the snapshot has " + records)
      const counts = countsOf(index)
      for (const key of Object.keys(counts)) {
        const written = (entry.counts || {})[key] || 0
        if (written !== counts[key]) problems.push("line " + entry.line + ": counts." + key + " says " + written + ", the snapshot has " + counts[key])
      }
    } catch (error) {
      problems.push("line " + entry.line + ": the retained snapshot is not readable JSON")
    }
  }
  // A day with no capture is the failure this whole file exists to make visible, so the age of
  // the last capture is part of verification, not a separate thing to remember to check.
  const last = entries.length > 0 ? entries[entries.length - 1] : null
  let ageHours = null
  let stale = false
  if (last && typeof opts.maxAgeHours === "number" && isFinite(opts.maxAgeHours)) {
    const now = opts.now ? opts.now.getTime() : Date.now()
    ageHours = (now - Date.parse(last.capturedAt)) / 3600000
    stale = ageHours > opts.maxAgeHours
    if (stale) problems.push("the last capture is " + ageHours.toFixed(1) + "h old (limit " + opts.maxAgeHours + "h)")
  }
  return {
    ok: problems.length === 0,
    problems: problems,
    notRetained: notRetained,
    coverage: coverageOf(entries),
    entries: entries,
    stale: stale,
    ageHours: ageHours,
  }
}
