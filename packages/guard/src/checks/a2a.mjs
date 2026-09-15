import { walk } from "../fs-scan.mjs"

const DANGEROUS_CAP = /(admin|debug|internal|code[_-]?exec|exec|shell|file[_-]?(system|management)|production|database|manage[_-]?user|delete|write)/i
const MAX_TOKEN_LIFETIME = 3600

function isCard(rel) {
  const base = rel.split("/").pop()
  return base === "agent-card.json" || base.endsWith(".agent-card.json") || base === "agent.json"
}

export function checkCard(rel, doc) {
  const findings = []
  if (!doc || typeof doc !== "object") return findings
  const hasShape = Array.isArray(doc.capabilities) || Array.isArray(doc.skills) || typeof doc.verifySignature === "boolean"
  if (!hasShape) return findings
  if (typeof doc.url === "string" && /^http:\/\//i.test(doc.url)) {
    findings.push({ rule: "AG-A2A-001", severity: "high", file: rel, line: null, message: "agent card is served over plain http: " + doc.url })
  }
  if (doc.verifySignature === false) {
    findings.push({ rule: "AG-A2A-002", severity: "high", file: rel, line: null, message: "agent card disables signature verification" })
  }
  const algorithms = Array.isArray(doc.algorithms) ? doc.algorithms : []
  if (algorithms.some(function (a) { return String(a).toLowerCase() === "none" })) {
    findings.push({ rule: "AG-A2A-003", severity: "critical", file: rel, line: null, message: "agent card accepts the \"none\" signing algorithm" })
  }
  if (typeof doc.tokenLifetime === "number" && doc.tokenLifetime > MAX_TOKEN_LIFETIME) {
    findings.push({ rule: "AG-A2A-004", severity: "medium", file: rel, line: null, message: "token lifetime is " + doc.tokenLifetime + "s, over the " + MAX_TOKEN_LIFETIME + "s ceiling" })
  }
  const caps = Array.isArray(doc.capabilities) ? doc.capabilities : []
  for (const cap of caps) {
    if (typeof cap === "string" && DANGEROUS_CAP.test(cap)) {
      findings.push({ rule: "AG-A2A-005", severity: "medium", file: rel, line: null, message: "agent card advertises the internal capability " + cap })
    }
  }
  const skills = Array.isArray(doc.skills) ? doc.skills : []
  for (const skill of skills) {
    if (!skill || typeof skill !== "object") continue
    const name = typeof skill.name === "string" ? skill.name : "<unnamed>"
    if (DANGEROUS_CAP.test(name) || (typeof skill.description === "string" && DANGEROUS_CAP.test(skill.description))) {
      findings.push({ rule: "AG-A2A-005", severity: "medium", file: rel, line: null, message: "skill " + name + " exposes an internal capability" })
    }
    if (skill.inputSchema === undefined) {
      findings.push({ rule: "AG-A2A-006", severity: "low", file: rel, line: null, message: "skill " + name + " declares no inputSchema" })
    }
  }
  return findings
}

export const check = {
  id: "a2a",
  run: function (ctx) {
    const findings = []
    const filesRead = []
    for (const file of walk(ctx.root, { exts: [".json"], maxFiles: 400 })) {
      if (!isCard(file.rel)) continue
      let doc
      try { doc = JSON.parse(ctx.readText(file.abs)) } catch (error) { continue }
      const got = checkCard(file.rel, doc)
      if (got.length === 0) continue
      filesRead.push(file.rel)
      findings.push.apply(findings, got)
    }
    return { findings: findings, filesRead: filesRead }
  },
}
