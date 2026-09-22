import { severityRank, matchesServer, POLICY_VERSION } from "./policy.mjs"
import { componentComplete, validateScanExecution } from "../../collect/src/execution.mjs"

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
  const records = Array.isArray(options.records) ? options.records : []
  const findings = []
  const checksFailed = []
  const evidenceMissing = []
  const executionIncomplete = []
  const malformed = []
  const threshold = severityRank(policy.threshold)
  const requiredScanners = policy.requiredScanners || []
  if (options.records != null && !Array.isArray(options.records)) malformed.push({ source: "index", detail: "records must be an array" })
  if (records.length === 0 && (policy.measuredEvidence.length > 0 || requiredScanners.length > 0 || policy.pinPackages || policy.forbiddenServers.length > 0)) {
    evidenceMissing.push({ server: "(local project)", block: "index", reason: "no matching evidence records loaded; provide an index for the exact package and version" })
  }

  if (scan) {
    for (const failed of (scan.coverage && scan.coverage.checksFailed) || []) checksFailed.push(failed)
    for (const f of scan.findings || []) {
      if (!f || typeof f !== "object" || typeof f.rule !== "string") { malformed.push({ source: "scan", detail: "a finding is not an object with a rule" }); continue }
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
    if (!record || typeof record.server !== "string") { malformed.push({ source: "index", detail: "a record has no server name" }); continue }
    for (const pattern of policy.forbiddenServers) {
      if (matchesServer(pattern, record.server)) {
        findings.push({ source: "index", rule: "POLICY-SERVER", severity: "high", file: record.server, message: "server matches the forbidden pattern " + pattern, reason: "forbidden by policy" })
      }
    }
    for (const blockName of policy.measuredEvidence) {
      const block = (record.evidence || {})[blockName]
      if (!block) { evidenceMissing.push({ server: record.server, block: blockName, reason: "the evidence block is absent" }); continue }
      if (!["clean", "findings"].includes(block.status)) evidenceMissing.push({ server: record.server, block: blockName, reason: block.reason || "unmeasured or invalid evidence status" })
    }
    // A scan-execution record that is not complete cannot support `clean`, whatever the findings
    // say. That is an invariant, not a policy option: it is checked for every record that carries
    // the block. A policy may additionally name scanners it insists on.
    const execution = record.scanExecution && record.scanExecution.scanner_execution
    const components = Array.isArray(execution?.components) ? execution.components : []
    if (record.scanExecution && (!execution || execution.state !== "complete" || !validateScanExecution(record.scanExecution).ok)) {
      executionIncomplete.push({
        server: record.server,
        state: execution?.state === "complete" ? "incomplete" : (execution?.state || "unknown"),
        failed: components.filter(c => c?.required && !componentComplete(c)).map(c => c.id),
      })
    }
    if (requiredScanners.length > 0) {
      const missing = requiredScanners.filter(function (id) {
        const component = components.filter(function (c) { return c?.id === id })[0]
        return !component || !componentComplete(component)
      })
      if (missing.length > 0) executionIncomplete.push({ server: record.server, state: execution ? (execution.state || "unknown") : "absent", failed: missing })
    }
    if (policy.pinPackages) {
      if (!Array.isArray(record.packages) || record.packages.length === 0) evidenceMissing.push({ server: record.server, block: "packageManifest", reason: "no declared package coordinates to verify" })
      for (const pkg of Array.isArray(record.packages) ? record.packages : []) {
        if (!pkg || typeof pkg !== "object") { malformed.push({ source: "index", detail: "invalid package coordinate" }); continue }
        if (!pkg.version) evidenceMissing.push({ server: record.server, block: "packageManifest", reason: "package " + pkg.name + " has no pinned version" })
      }
    }
  }

  const verdict = checksFailed.length > 0 || evidenceMissing.length > 0 || executionIncomplete.length > 0 || malformed.length > 0 ? "incomplete" : findings.length > 0 ? "findings" : "clean"
  return {
    policyVersion: policy.version || POLICY_VERSION,
    verdict: verdict,
    findings: findings,
    coverage: { checksFailed: checksFailed, evidenceMissing: evidenceMissing, executionIncomplete: executionIncomplete, malformed: malformed },
  }
}

export function exitCodeFor(result) {
  if (result.verdict === "incomplete") return 2
  if (result.verdict === "clean") return 0
  return 1
}
