/**
 * What changed between two index builds.
 *
 * The interesting category is the last one: anything that moved while the version stayed
 * the same. A new finding on an unchanged version is the shape of a silent change - a
 * package replaced without a release, a repository edited in place, a scan that started
 * seeing something it had not seen before. Anyone can diff two files; keeping the
 * previous file is the part that takes a year.
 */
function byServer(index) {
  const map = new Map()
  for (const r of (index && index.records) || []) { if (r && typeof r.server === "string") map.set(r.server, r) }
  return map
}

function packageKey(record) {
  const pkgs = Array.isArray(record.packages) ? record.packages : []
  return pkgs.map(function (p) { return (p && p.name) + "@" + ((p && p.version) || "unpinned") }).join(",")
}

function findingsKey(record) {
  const out = []
  const evidence = record && typeof record.evidence === "object" && record.evidence ? record.evidence : {}
  for (const blockName of Object.keys(evidence)) {
    const block = evidence[blockName] || {}
    for (const f of block.findings || []) out.push(blockName + ":" + f.rule)
    if (block.status === "unmeasured") out.push(blockName + ":unmeasured")
  }
  return out.sort().join("|")
}

export function diffIndex(from, to) {
  const before = byServer(from)
  const after = byServer(to)
  const added = []
  const removed = []
  const verdictChanged = []
  const packageChanged = []
  const silent = []
  for (const server of after.keys()) {
    if (!before.has(server)) { added.push(server); continue }
    const a = before.get(server)
    const b = after.get(server)
    if (a.verdict !== b.verdict) verdictChanged.push({ server: server, from: a.verdict, to: b.verdict })
    if (packageKey(a) !== packageKey(b)) packageChanged.push({ server: server, from: packageKey(a), to: packageKey(b) })
    else if (findingsKey(a) !== findingsKey(b)) {
      silent.push({ server: server, from: findingsKey(a), to: findingsKey(b) })
    }
  }
  for (const server of before.keys()) if (!after.has(server)) removed.push(server)
  const scannerFrom = (from && from.scanner) || null
  const scannerTo = (to && to.scanner) || null
  return {
    fromGeneratedAt: (from && from.generatedAt) || null,
    toGeneratedAt: (to && to.generatedAt) || null,
    scanner: { from: scannerFrom, to: scannerTo, changed: scannerFrom !== scannerTo },
    counts: { before: before.size, after: after.size },
    added: added.sort(),
    removed: removed.sort(),
    verdictChanged: verdictChanged,
    packageChanged: packageChanged,
    silent: silent,
  }
}

export function renderDiff(d) {
  const lines = []
  lines.push("index diff")
  lines.push("  from " + d.fromGeneratedAt + " (" + d.counts.before + " servers)")
  lines.push("  to   " + d.toGeneratedAt + " (" + d.counts.after + " servers)")
  lines.push("")
  lines.push("  added:           " + d.added.length)
  lines.push("  removed:         " + d.removed.length)
  lines.push("  verdict changed: " + d.verdictChanged.length)
  lines.push("  package changed: " + d.packageChanged.length)
  lines.push("  silent (no version move, different evidence): " + d.silent.length)
  if (d.scanner && d.scanner.changed) {
    lines.push("")
    lines.push("  the scanner changed between these two snapshots: " + (d.scanner.from || "(none)") + " -> " + (d.scanner.to || "(none)"))
    lines.push("  so some of what follows may be ours rather than theirs, and nothing here says which.")
  }
  if (d.silent.length > 0) {
    lines.push("")
    lines.push("  silent changes, where a version change would have explained it and did not:")
    for (const s of d.silent.slice(0, 20)) {
      lines.push("    " + s.server)
      lines.push("      before: " + (s.from || "(nothing)"))
      lines.push("      after:  " + (s.to || "(nothing)"))
    }
  }
  return lines.join("\n")
}
