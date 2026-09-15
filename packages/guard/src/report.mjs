const LEVEL = { critical: "error", high: "error", medium: "warning", low: "note", info: "note" }

export function toJson(result, meta) {
  return JSON.stringify({ tool: "agent-guard", version: meta.version, root: meta.root, verdict: result.verdict, summary: count(result), findings: result.findings, coverage: result.coverage }, null, 2)
}

function count(result) {
  const by = {}
  for (const f of result.findings) by[f.severity] = (by[f.severity] || 0) + 1
  return by
}

export function toConsole(result, meta) {
  const lines = []
  lines.push("agent-guard " + meta.version + "  " + meta.root)
  lines.push("")
  for (const f of result.findings) {
    lines.push("  " + f.severity.toUpperCase().padEnd(9) + f.rule + "  " + f.file + (f.line ? ":" + f.line : ""))
    lines.push("           " + f.message)
  }
  if (result.findings.length === 0) lines.push("  no findings")
  lines.push("")
  lines.push("  checks run: " + result.coverage.checksRun.join(", "))
  if (result.coverage.checksFailed.length > 0) {
    for (const failed of result.coverage.checksFailed) lines.push("  CHECK FAILED: " + failed.id + " -> " + failed.error)
  }
  lines.push("  files read: " + result.coverage.filesRead.length)
  if (result.coverage.unparsedFiles.length > 0) lines.push("  unparsed (not assessed): " + result.coverage.unparsedFiles.join(", "))
  lines.push("")
  lines.push("  verdict: " + result.verdict.toUpperCase())
  if (result.verdict === "incomplete") lines.push("  this is not a pass: a check did not run, so nothing is known about what it would have covered")
  return lines.join("\n") + "\n"
}

/**
 * SARIF that carries the failure. A crashed check becomes its own error-level
 * result, so code scanning shows it instead of showing an empty, quiet run.
 */
export function toSarif(result, meta) {
  const results = []
  for (const f of result.findings) {
    results.push({
      ruleId: f.rule,
      level: LEVEL[f.severity] || "warning",
      message: { text: f.message },
      locations: f.file ? [{ physicalLocation: { artifactLocation: { uri: f.file } } }] : [],
    })
  }
  for (const failed of result.coverage.checksFailed) {
    results.push({
      ruleId: "AG-INTERNAL-CHECK-FAIL",
      level: "error",
      message: { text: "check " + failed.id + " failed to run: " + failed.error },
      locations: [],
    })
  }
  return JSON.stringify({
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{ tool: { driver: { name: "agent-guard", version: meta.version } }, results: results }],
  }, null, 2)
}
