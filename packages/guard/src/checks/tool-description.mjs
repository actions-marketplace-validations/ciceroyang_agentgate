import { walk } from "../fs-scan.mjs"
import { PATTERNS } from "./content-injection.mjs"

/** Zero-width, bidi and BOM characters: invisible in a rendered tool list. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/

const NAMES = ["server.json", "mcp-tools.json", "tools.json"]

function isCandidate(rel) {
  const base = rel.split("/").pop()
  return NAMES.indexOf(base) !== -1 || base.endsWith(".tools.json") || base.endsWith(".mcp.json")
}

export function toolsOf(doc) {
  if (!doc || typeof doc !== "object") return []
  const out = []
  const top = Array.isArray(doc.tools) ? doc.tools : []
  for (const t of top) if (t && typeof t === "object") out.push({ server: null, tool: t })
  const servers = doc.mcpServers || doc.servers
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    for (const name of Object.keys(servers)) {
      const entry = servers[name]
      if (!entry || typeof entry !== "object") continue
      const nested = Array.isArray(entry.tools) ? entry.tools : []
      for (const t of nested) if (t && typeof t === "object") out.push({ server: name, tool: t })
    }
  }
  return out
}

export function checkTools(rel, doc) {
  const findings = []
  for (const entry of toolsOf(doc)) {
    const tool = entry.tool
    const name = (entry.server ? entry.server + "/" : "") + (typeof tool.name === "string" ? tool.name : "<unnamed>")
    const description = typeof tool.description === "string" ? tool.description : ""
    const haystack = name + "\n" + description
    if (INVISIBLE.test(haystack)) {
      findings.push({ rule: "AG-TOOL-002", severity: "high", file: rel, line: null, message: "tool " + name + " carries invisible unicode in its name or description" })
    }
    for (const pattern of PATTERNS) {
      if (pattern.re.test(haystack)) {
        findings.push({ rule: "AG-TOOL-001", severity: "high", file: rel, line: null, message: "tool " + name + " description contains instruction-override text (" + pattern.rule + ")" })
        break
      }
    }
  }
  return findings
}

export const check = {
  id: "tool-description",
  run: function (ctx) {
    const findings = []
    const filesRead = []
    for (const file of walk(ctx.root, { exts: [".json"], maxFiles: 400 })) {
      if (!isCandidate(file.rel)) continue
      let doc
      try { doc = JSON.parse(ctx.readText(file.abs)) } catch (error) { continue }
      const got = checkTools(file.rel, doc)
      if (got.length === 0 && toolsOf(doc).length === 0) continue
      filesRead.push(file.rel)
      findings.push.apply(findings, got)
    }
    return { findings: findings, filesRead: filesRead }
  },
}
