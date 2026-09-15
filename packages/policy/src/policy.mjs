/**
 * The policy language, version agentgate.policy/v1.
 *
 * Deliberately small and declarative: a company writes down what it refuses, and the
 * evaluation reports what it found, what it could not check, and why. The evaluation
 * never decides "probably fine": anything unmeasured makes the result incomplete.
 */
import { readFileSync, existsSync } from "node:fs"

export const POLICY_VERSION = "agentgate.policy/v1"

const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }
export function severityRank(severity) { return RANK[severity] === undefined ? 0 : RANK[severity] }

function asJson(value) {
  if (!value) return null
  if (typeof value === "object") return value
  if (!existsSync(value)) return null
  try { return JSON.parse(readFileSync(value, "utf8")) } catch (error) { return null }
}

function asArray(value) { return Array.isArray(value) ? value.filter(function (v) { return typeof v === "string" }) : [] }

export function normalizePolicy(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("policy must be an object")
  const required = doc.required && typeof doc.required === "object" ? doc.required : {}
  const forbidden = doc.forbidden && typeof doc.forbidden === "object" ? doc.forbidden : {}
  const threshold = typeof doc.threshold === "string" ? doc.threshold : "high"
  if (!Object.prototype.hasOwnProperty.call(RANK, threshold)) throw new Error("unknown threshold: " + threshold)
  return {
    version: typeof doc.version === "string" ? doc.version : POLICY_VERSION,
    threshold: threshold,
    pinPackages: required.pinnedPackages === true,
    measuredEvidence: asArray(required.measuredEvidence),
    forbiddenRules: asArray(forbidden.rules),
    forbiddenSeverities: asArray(forbidden.severities),
    forbiddenServers: asArray(forbidden.servers),
    forbiddenTools: asArray(forbidden.tools),
  }
}

/** What a scan uses when no policy file was written. It refuses nothing extra, because
 *  inventing obligations on a user's behalf is how a tool starts lying about what it checked.
 *  The checks still report their own findings; a policy only adds what *you* refuse. */
export const DEFAULT_POLICY_DOC = {
  version: POLICY_VERSION,
  threshold: "medium",
  required: { pinnedPackages: false, measuredEvidence: [] },
  forbidden: { rules: [], severities: [], servers: [], tools: [] },
}

export function defaultPolicy() { return normalizePolicy(DEFAULT_POLICY_DOC) }

export function loadPolicy(value) {
  const doc = asJson(value)
  if (!doc) throw new Error("policy could not be read")
  return normalizePolicy(doc)
}

/** A tiny glob: "acme/*" or an exact name. Deliberately not a regex, so a policy file
 *  cannot become a program. */
export function matchesServer(pattern, name) {
  if (pattern === name) return true
  if (pattern.indexOf("*") === -1) return false
  const parts = pattern.split("*")
  if (parts.length !== 2) return false
  return name.indexOf(parts[0]) === 0 && name.slice(name.length - parts[1].length) === parts[1]
}
