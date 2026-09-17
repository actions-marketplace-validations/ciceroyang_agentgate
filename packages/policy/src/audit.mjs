/**
 * Aggregate per-directory verdicts into one.
 *
 * The rule the scanner uses is lifted a level: if any directory is incomplete the whole audit is
 * incomplete, whatever the others found. "Three of four repos are clean" is not a pass, and a
 * directory that could not be scanned at all counts as incomplete rather than absent.
 */
const KNOWN = ["clean", "findings", "incomplete"]

export function aggregateAudit(entries) {
  const list = entries || []
  const counts = { clean: 0, findings: 0, incomplete: 0 }
  // A verdict the aggregate does not recognise is incomplete, not clean. The scanner has the
  // same rule for an unregistered severity, and for the same reason.
  for (const entry of list) {
    const verdict = KNOWN.indexOf(entry.verdict) === -1 ? "incomplete" : entry.verdict
    counts[verdict] += 1
  }
  const verdict = counts.incomplete > 0 ? "incomplete" : counts.findings > 0 ? "findings" : "clean"
  // The exit codes already encode the priority (2 beats 1 beats 0), so the aggregate is the max.
  const exitCode = list.reduce(function (max, entry) {
    return Math.max(max, typeof entry.exitCode === "number" ? entry.exitCode : 2)
  }, 0)
  return {
    verdict: verdict,
    exitCode: exitCode,
    counts: counts,
    incomplete: list.filter(function (e) { return e.verdict === "incomplete" }).map(function (e) { return e.root }),
    total: list.length,
  }
}

export function renderAudit(entries, aggregate) {
  const lines = []
  lines.push("audit " + aggregate.total + " 个目录")
  for (const entry of entries) {
    const detail = []
    if (entry.findings) detail.push(entry.findings + " 条命中" + (entry.rules && entry.rules.length ? " (" + entry.rules.join(", ") + ")" : ""))
    if (entry.checksFailed) detail.push(entry.checksFailed + " 个检查没跑成")
    if (entry.evidenceMissing) detail.push(entry.evidenceMissing + " 条证据未测到")
    if (entry.reason) detail.push(entry.reason)
    lines.push("  " + String(entry.verdict).toUpperCase().padEnd(11) + (detail.join(", ") || "无") + "  " + entry.root)
  }
  lines.push("")
  lines.push("  整体: " + aggregate.verdict.toUpperCase() + (aggregate.verdict === "incomplete" ? "  (有目录没测完，整体不能算通过)" : ""))
  return lines.join("\n")
}
