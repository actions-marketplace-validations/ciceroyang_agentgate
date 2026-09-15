import { existsSync } from "node:fs"
import { join } from "node:path"

export const SETTINGS_PATHS = [".claude/settings.json", ".claude/settings.local.json", ".codex/settings.json", ".gemini/settings.json"]

const HOOK_DANGER = [
  { re: /\b(curl|wget|nc|ncat|ssh|scp|rsync|ftp|telnet)\b/, what: "reaches the network from a hook" },
  { re: /\b(sudo|chmod\s+\+x)\b/, what: "escalates or marks a payload executable in a hook" },
  { re: /\bprintenv\b|\$ANTHROPIC[_-]|\$OPENAI[_-]|\$AWS[_-]|id_rsa|\.aws\/credentials/, what: "reads credentials in a hook" },
  { re: /\bpython[0-9.]*\s+-c\b|\bnode\s+-e\b|os\.system|subprocess\.|requests\.(post|get)|base64/, what: "evaluates inline code in a hook" },
]

const PROXY_ENV = /(ANTHROPIC_BASE_URL|ANTHROPIC_API_URL|OPENAI_API_BASE|OPENAI_BASE_URL|OPENAI_API_ENDPOINT|AZURE_OPENAI_ENDPOINT|API_BASE_URL)/
const BROAD_ALLOW = /^(\*|Bash\(\*\)|Edit\(\*\*\)|Write\(\*\*\)|mcp__\*)$/

function hookCommands(hooks) {
  const out = []
  if (!hooks || typeof hooks !== "object") return out
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry === "string") { out.push({ event: event, command: entry }); continue }
      if (entry && typeof entry === "object" && typeof entry.command === "string") out.push({ event: event, command: entry.command })
    }
  }
  return out
}

export function checkSettings(rel, text) {
  const findings = []
  let doc
  try { doc = JSON.parse(text) } catch (error) { return findings }
  if (!doc || typeof doc !== "object") return findings
  for (const hook of hookCommands(doc.hooks)) {
    for (const pattern of HOOK_DANGER) {
      if (pattern.re.test(hook.command)) {
        findings.push({ rule: "AG-HOOK-001", severity: "high", file: rel, line: null, message: "hook " + hook.event + " " + pattern.what + ": " + hook.command.slice(0, 80) })
        break
      }
    }
  }
  if (doc.enableAllProjectMcpServers === true) {
    findings.push({ rule: "AG-SETTINGS-001", severity: "high", file: rel, line: null, message: "enableAllProjectMcpServers auto-trusts every MCP server a repository declares" })
  }
  const allow = doc.permissions && Array.isArray(doc.permissions.allow) ? doc.permissions.allow : []
  for (const rule of allow) {
    if (typeof rule === "string" && BROAD_ALLOW.test(rule)) {
      findings.push({ rule: "AG-SETTINGS-002", severity: "high", file: rel, line: null, message: "permissions.allow grants the broad rule " + rule })
    }
  }
  const env = doc.env && typeof doc.env === "object" ? doc.env : {}
  for (const key of Object.keys(env)) {
    const value = String(env[key])
    if (PROXY_ENV.test(key) && /^https?:\/\//i.test(value)) {
      findings.push({ rule: "AG-SETTINGS-003", severity: "medium", file: rel, line: null, message: "env." + key + " redirects model traffic to " + value })
    }
  }
  return findings
}

export const check = {
  id: "agent-settings",
  run: function (ctx) {
    const findings = []
    const filesRead = []
    for (const rel of SETTINGS_PATHS) {
      const abs = join(ctx.root, rel)
      if (!existsSync(abs)) continue
      filesRead.push(rel)
      findings.push.apply(findings, checkSettings(rel, ctx.readText(abs)))
    }
    return { findings: findings, filesRead: filesRead }
  },
}
