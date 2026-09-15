import { existsSync } from "node:fs"
import { join } from "node:path"

export const CONFIG_PATHS = [
  ".mcp.json",
  "mcp.json",
  "claude_desktop_config.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".continue/config.json",
]

const RUNNERS = ["npx", "uvx", "bunx", "pnpx", "pipx", "dlx"]
const SHELL_META = /[;&|`]|\$\(/
const SECRET_HINT = /(api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|credential)/i
const INSECURE_URL = /http:\/\//i
const BROAD_ROOT = /^(\/|~\/?|\/etc\/?|\/root\/?|\/home\/?|[A-Za-z]:\\?)$/
const PINNED = /@\d/
const PLACEHOLDER = /(your|example|sample|placeholder|changeme|change[_-]?me|dummy|fake|todo|redacted|test[_-]?key|<[^>]{1,40}>|\.\.\.)/i

/** A value that is a reference or a placeholder is not a leaked secret. */
export function looksLiteral(value) {
  if (value.indexOf("$") !== -1) return false
  if (PLACEHOLDER.test(value)) return false
  if (/^[A-Z][A-Z0-9_]{7,}$/.test(value)) return false
  return true
}

function pinIn(args) {
  return args.some(function (a) { return PINNED.test(a) })
}

export function checkConfig(rel, text) {
  const findings = []
  let doc
  try {
    doc = JSON.parse(text)
  } catch (error) {
    findings.push({ rule: "AG-MCP-001", severity: "low", file: rel, line: null, message: "config could not be parsed as JSON and was not assessed (" + error.message + ")" })
    return findings
  }
  const servers = doc && (doc.mcpServers || doc.servers)
  if (servers === undefined || servers === null) return findings
  if (typeof servers !== "object" || Array.isArray(servers)) {
    findings.push({ rule: "AG-MCP-002", severity: "high", file: rel, line: null, message: "mcpServers is not an object" })
    return findings
  }
  for (const name of Object.keys(servers)) {
    const entry = servers[name]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      findings.push({ rule: "AG-MCP-002", severity: "high", file: rel, line: null, message: "server " + name + " is not an object" })
      continue
    }
    const command = typeof entry.command === "string" ? entry.command : ""
    const args = Array.isArray(entry.args) ? entry.args.filter(function (a) { return typeof a === "string" }) : []
    const base = command.split("/").pop()
    if (RUNNERS.indexOf(base) !== -1 && !pinIn(args)) {
      findings.push({ rule: "AG-MCP-010", severity: "medium", file: rel, line: null, message: "server " + name + " runs " + base + " without a pinned version" })
    }
    if (command.indexOf("/") !== -1 && command.charAt(0) !== "/") {
      findings.push({ rule: "AG-MCP-011", severity: "medium", file: rel, line: null, message: "server " + name + " uses the relative command path " + command })
    }
    const joined = [command].concat(args).join(" ")
    if (SHELL_META.test(joined)) {
      findings.push({ rule: "AG-MCP-012", severity: "high", file: rel, line: null, message: "server " + name + " passes shell metacharacters in command or args" })
    }
    if (INSECURE_URL.test(joined)) {
      findings.push({ rule: "AG-MCP-013", severity: "medium", file: rel, line: null, message: "server " + name + " references a plain http URL" })
    }
    if (args.some(function (a) { return BROAD_ROOT.test(a) })) {
      findings.push({ rule: "AG-MCP-014", severity: "medium", file: rel, line: null, message: "server " + name + " is given a filesystem root" })
    }
    const env = entry.env
    if (env && typeof env === "object") {
      for (const key of Object.keys(env)) {
        const value = env[key]
        if (typeof value === "string" && value.length >= 12 && looksLiteral(value) && (SECRET_HINT.test(key) || /^[A-Za-z0-9_\-]{24,}$/.test(value))) {
          findings.push({ rule: "AG-MCP-015", severity: "high", file: rel, line: null, message: "server " + name + " embeds a literal credential in env." + key })
        }
      }
    }
  }
  return findings
}

export const check = {
  id: "mcp-config",
  run: function (ctx) {
    const findings = []
    const filesRead = []
    const unparsed = []
    for (const rel of CONFIG_PATHS) {
      const abs = join(ctx.root, rel)
      if (!existsSync(abs)) continue
      const text = ctx.readText(abs)
      filesRead.push(rel)
      try { JSON.parse(text) } catch (error) { unparsed.push(rel) }
      findings.push.apply(findings, checkConfig(rel, text))
    }
    return { findings: findings, filesRead: filesRead, unparsed: unparsed }
  },
}
