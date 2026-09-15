import { severityRank, matchesServer, POLICY_VERSION } from "./policy.mjs"

/**
 * Evaluate a policy against a local scan and, when an index is given, against the
 * evidence records for the packages involved.
 *
 * Three outcomes and no fourth, matching the scanner: clean, findings, incomplete. Any
 * check that failed and any required evidence that is unmeasured forces incomplete,
 * whatever the findings say, because a partial answer is not a pass.
 */
export function evaluate(options) {
  const policy = options.policy
  const scan = options.scan || null
  const records = options.records || null
  const findings = []
  const checksFailed = []
  const evidenceMissing = []
  const threshold = severityRank(policy.threshold)

  if (scan) {
    for (const failed of (scan.coverage && scan.coverage.checksFailed) || []) checksFailed.push(failed)
    for (const f of scan.findings || []) {
      const forbidden = policy.forbiddenRules.indexOf(f.rule) !== -1 || policy.forbiddenSeverities.indexOf(f.severity) !== -1
      const above = severityRank(f.severity) >= threshold
      if (!forbidden && !above) continue
      findings.push({
        source: "scan",
        rule: f.rule,
        severity: f.severity,
        file: f.file,
        message: f.message,
        reason: forbidden ? "forbidden by policy" : "at or above the policy threshold " + policy.threshold,
      })
    }
  }

  for (const record of records || []) {
    for (const pattern of policy.forbiddenServers) {
      if (matchesServer(pattern, record.server)) {
        findings.push({ source: "index", rule: "POLICY-SERVER", severity: "high", file: record.server, message: "server matches the forbidden pattern " + pattern, reason: "forbidden by policy" })
      }
    }
    for (const blockName of policy.measuredEvidence) {
      const block = (record.evidence || {})[blockName]
      if (!block) { evidenceMissing.push({ server: record.server, block: blockName, reason: "the evidence block is absent" }); continue }
      if (block.status === "unmeasured") evidenceMissing.push({ server: record.server, block: blockName, reason: block.reason || "unmeasured" })
    }
    if (policy.pinPackages) {
      for (const pkg of record.packages || []) {
        if (!pkg.version) evidenceMissing.push({ server: record.server, block: "packageManifest", reason: "package " + pkg.name + " has no pinned version" })
      }
    }
  }

  const verdict = checksFailed.length > 0 || evidenceMissing.length > 0 ? "incomplete" : findings.length > 0 ? "findings" : "clean"
  return {
    policyVersion: policy.version || POLICY_VERSION,
    verdict: verdict,
    findings: findings,
    coverage: { checksFailed: checksFailed, evidenceMissing: evidenceMissing },
  }
}

export function exitCodeFor(result) {
  if (result.verdict === "incomplete") return 2
  if (result.verdict === "clean") return 0
  return 1
}
