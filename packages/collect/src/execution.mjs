/**
 * The record that says whether a scan actually happened.
 *
 * A verdict of `clean` is a claim about work, and work that did not run cannot support it. This
 * module builds the block that travels with each record and answers one question: which scanners
 * were required, which completed, and whether their output was present, parseable and consistent.
 *
 * Field names inside `scanner_execution` deliberately follow the shape proposed in
 * modelcontextprotocol/registry#1404 rather than this repository's camelCase, so the two can be
 * diffed field by field instead of argued about in prose. Everything outside that block stays in
 * the local style.
 */

export const SCHEMA_VERSION = "agentgate.scan-execution/v1"

export const STATUSES = ["completed", "failed", "skipped"]
export const CONSISTENCY = ["ok", "mismatch", "unverified"]
export const SEVERITIES = ["critical", "high", "medium", "low", "info"]

export function emptyFindings() {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
}

function normalizeComponent(input) {
  const c = input || {}
  return {
    id: String(c.id === undefined || c.id === null ? "" : c.id),
    required: c.required !== false,
    status: STATUSES.indexOf(c.status) === -1 ? "failed" : c.status,
    exit_code: Number.isInteger(c.exit_code) ? c.exit_code : null,
    output_present: c.output_present === true,
    output_parseable: c.output_parseable === true,
    semantic_consistency: CONSISTENCY.indexOf(c.semantic_consistency) === -1 ? "unverified" : c.semantic_consistency,
    findings: Object.assign(emptyFindings(), c.findings || {}),
    reason: typeof c.reason === "string" && c.reason.length > 0 ? c.reason : null,
  }
}

function normalizeDigest(input) {
  if (!input || typeof input !== "object") return null
  if (typeof input.algorithm !== "string" || typeof input.value !== "string") return null
  return {
    algorithm: input.algorithm,
    scope: typeof input.scope === "string" ? input.scope : null,
    value: input.value,
    matches: input.matches === true ? true : input.matches === false ? false : null,
  }
}

/** A component is done when it ran, its output was there and readable, and it agreed with itself. */
export function componentComplete(component) {
  return component.status === "completed" &&
    component.output_present === true &&
    component.output_parseable === true &&
    component.semantic_consistency === "ok"
}

export function buildScanExecution(options) {
  const opts = options || {}
  const components = (opts.components || []).map(normalizeComponent)
  const digest = normalizeDigest(opts.digest)
  const requiredComponents = components.filter(function (c) { return c.required })
  const completed = requiredComponents.filter(componentComplete).length
  const failed = requiredComponents.length - completed
  // Nothing required is not a pass. A producer that requires nothing has measured nothing.
  const digestOk = !digest || digest.matches !== false
  const state = requiredComponents.length > 0 && failed === 0 && digestOk ? "complete" : "incomplete"
  return {
    schemaVersion: SCHEMA_VERSION,
    subject: {
      server: opts.subject && opts.subject.server ? String(opts.subject.server) : null,
      packages: (opts.subject && opts.subject.packages) || [],
    },
    scanner_execution: {
      components: components,
      required: requiredComponents.length,
      completed: completed,
      failed: failed,
      state: state,
    },
    digest: digest,
    generatedAt: opts.generatedAt || new Date().toISOString(),
  }
}

/** `clean` is allowed only when every required component finished and nothing contradicted itself. */
export function canBeClean(record) {
  return Boolean(record && record.scanner_execution && record.scanner_execution.state === "complete")
}

export function validateScanExecution(record) {
  const problems = []
  if (!record || typeof record !== "object") return { ok: false, problems: ["record is not an object"] }
  if (record.schemaVersion !== SCHEMA_VERSION) problems.push("schemaVersion is not " + SCHEMA_VERSION)
  if (!record.subject || typeof record.subject.server !== "string" || record.subject.server.length === 0) problems.push("subject.server is missing")
  const exec = record.scanner_execution
  if (!exec || typeof exec !== "object") return { ok: false, problems: problems.concat(["scanner_execution is missing"]) }
  if (!Array.isArray(exec.components)) problems.push("scanner_execution.components is not an array")
  const components = Array.isArray(exec.components) ? exec.components : []
  for (const c of components) {
    if (!c || typeof c !== "object") { problems.push("a component is not an object"); continue }
    if (typeof c.id !== "string" || c.id.length === 0) problems.push("a component has no id")
    if (typeof c.required !== "boolean") problems.push(c.id + ": required is not a boolean")
    if (STATUSES.indexOf(c.status) === -1) problems.push(c.id + ": status " + String(c.status) + " is not one of " + STATUSES.join(", "))
    if (CONSISTENCY.indexOf(c.semantic_consistency) === -1) problems.push(c.id + ": semantic_consistency is not one of " + CONSISTENCY.join(", "))
    if (typeof c.output_present !== "boolean" || typeof c.output_parseable !== "boolean") problems.push(c.id + ": output presence/parseability must be booleans")
  }
  const requiredList = components.filter(function (c) { return c.required === true })
  const countedComplete = requiredList.filter(componentComplete).length
  if (exec.required !== requiredList.length) problems.push("required says " + exec.required + ", the components say " + requiredList.length)
  if (exec.completed !== countedComplete) problems.push("completed says " + exec.completed + ", the components say " + countedComplete)
  if (exec.failed !== requiredList.length - countedComplete) problems.push("failed says " + exec.failed + ", the components say " + (requiredList.length - countedComplete))
  if (exec.state !== "complete" && exec.state !== "incomplete") problems.push("state is not complete/incomplete")
  if (exec.state === "complete" && countedComplete !== requiredList.length) problems.push("state is complete but not every required component is")
  if (exec.state === "complete" && record.digest && record.digest.matches === false) problems.push("state is complete but the digest is recorded as not matching")
  if (record.digest) {
    if (typeof record.digest.algorithm !== "string" || typeof record.digest.value !== "string") problems.push("digest needs algorithm and value")
  }
  return { ok: problems.length === 0, problems: problems }
}

/**
 * The mapping this module exists for: this repository's evidence blocks become the
 * `scanner_execution` shape. A block is a scanner; its status decides whether that scanner
 * completed, and an unmeasured block is a failed component with the reason kept verbatim.
 */
export function executionFromBlocks(options) {
  const opts = options || {}
  const blocks = opts.blocks || {}
  const components = Object.keys(blocks).map(function (id) {
    const block = blocks[id] || {}
    const measured = block.status === "clean" || block.status === "findings"
    const findings = emptyFindings()
    for (const f of block.findings || []) {
      if (SEVERITIES.indexOf(f && f.severity) !== -1) findings[f.severity] += 1
    }
    return {
      id: id,
      required: true,
      status: measured ? "completed" : "failed",
      exit_code: null,
      output_present: true,
      output_parseable: measured,
      semantic_consistency: measured ? "ok" : "unverified",
      findings: findings,
      reason: measured ? null : (block.reason || block.error || "unmeasured"),
    }
  })
  return buildScanExecution({
    subject: { server: opts.server || null, packages: opts.packages || [] },
    components: components,
    digest: opts.digest || null,
    generatedAt: opts.generatedAt,
  })
}
