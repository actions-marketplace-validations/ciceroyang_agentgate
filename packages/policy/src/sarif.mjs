/**
 * SARIF for a policy result, so code scanning shows the same thing the terminal does.
 *
 * A check that failed to run, and evidence the policy required but nobody could measure,
 * both become error-level results rather than disappearing. That is the whole point: a
 * partial scan must be visible in the tool people actually look at.
 */
const LEVEL = { critical: "error", high: "error", medium: "warning", low: "note", info: "note" }

export function toSarif(result, meta) {
  const results = []
  for (const f of result.findings) {
    results.push({
      ruleId: f.rule,
      level: LEVEL[f.severity] || "warning",
      message: { text: String(f.message || "") + " (" + String(f.reason || "") + ")" },
      locations: f.file ? [{ physicalLocation: { artifactLocation: { uri: f.file } } }] : [],
    })
  }
  for (const m of (result.coverage && result.coverage.evidenceMissing) || []) {
    results.push({
      ruleId: "POLICY-UNMEASURED",
      level: "error",
      message: { text: m.server + " / " + m.block + " could not be measured: " + m.reason },
      locations: [],
    })
  }
  for (const c of (result.coverage && result.coverage.checksFailed) || []) {
    results.push({
      ruleId: "AG-INTERNAL-CHECK-FAIL",
      level: "error",
      message: { text: "check " + c.id + " failed to run: " + c.error },
      locations: [],
    })
  }
  return JSON.stringify({
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{ tool: { driver: { name: "agentgate", version: (meta && meta.version) || "0.1.0" } }, results: results }],
  }, null, 2)
}
