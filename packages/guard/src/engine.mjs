/**
 * The scan engine.
 *
 * The property this tool exists to keep: a verdict of "clean" is never emitted
 * when a check failed to run. A check that throws moves the whole scan to
 * "incomplete", which carries its own exit code, so "nothing found" can never be
 * mistaken for "nothing ran".
 */

const ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

export function severityRank(severity) {
  return Object.prototype.hasOwnProperty.call(ORDER, severity) ? ORDER[severity] : 0
}

export function runScan(options) {
  const checks = options.checks
  const exclude = (options.exclude || []).map(function (p) { return String(p).replace(/^\/+|\/+$/g, "") }).filter(Boolean)
  const readText = options.readText
  const findings = []
  const checksRun = []
  const checksFailed = []
  const filesRead = new Set()
  const unparsed = new Set()
  for (const check of checks) {
    let out
    try {
      out = check.run({ root: options.root, readText: readText })
    } catch (error) {
      checksFailed.push({ id: check.id, error: String((error && error.message) || error) })
      continue
    }
    checksRun.push(check.id)
    for (const file of out.filesRead || []) filesRead.add(file)
    for (const file of out.unparsed || []) unparsed.add(file)
    for (const f of out.findings || []) {
      findings.push({
        rule: f.rule,
        severity: f.severity,
        file: f.file,
        line: f.line === undefined ? null : f.line,
        message: f.message,
        check: check.id,
      })
    }
  }
  const excluded = function (file) {
    if (!file) return false
    return exclude.some(function (p) { return file === p || file.indexOf(p + "/") === 0 })
  }
  const kept = findings.filter(function (f) { return !excluded(f.file) })
  const verdict = checksFailed.length > 0 ? "incomplete" : kept.length > 0 ? "findings" : "clean"
  kept.sort(function (a, b) {
    return a.rule.localeCompare(b.rule) || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0)
  })
  return {
    verdict: verdict,
    findings: kept,
    coverage: {
      checksRequested: checks.map(function (c) { return c.id }),
      checksRun: checksRun,
      checksFailed: checksFailed,
      filesRead: Array.from(filesRead).filter(function (f) { return !excluded(f) }).sort(),
      unparsedFiles: Array.from(unparsed).sort(),
    },
  }
}

/**
 * 0 clean, 1 when a finding reaches the threshold, 2 whenever the scan is
 * incomplete. 2 ignores --fail-on on purpose: a partial scan is not a pass and
 * cannot be turned into one by lowering the bar. Opt out explicitly instead.
 */
export function exitCodeFor(result, failOn) {
  if (result.verdict === "incomplete") return 2
  if (result.verdict === "clean") return 0
  const threshold = severityRank(failOn || "medium")
  return result.findings.some(function (f) { return severityRank(f.severity) >= threshold }) ? 1 : 0
}
