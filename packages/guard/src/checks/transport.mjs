import { existsSync } from "node:fs"
import { join } from "node:path"
import { CONFIG_PATHS } from "./mcp-config.mjs"

const AUTH_HINT = /(authorization|auth|bearer|token|api[_-]?key|x-api-key)/i
const TLS_OFF = /(NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["\']?0|--insecure\b|--no-verify\b|rejectUnauthorized\s*[:=]\s*false)/
const WILDBIND = /(^|[\s:,=])0\.0\.0\.0([\s:/]|$)/

export function checkConfig(rel, text) {
  const findings = []
  let doc
  try { doc = JSON.parse(text) } catch (error) { return findings }
  const servers = doc && (doc.mcpServers || doc.servers)
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return findings
  for (const name of Object.keys(servers)) {
    const entry = servers[name]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const url = typeof entry.url === "string" ? entry.url : ""
    const args = Array.isArray(entry.args) ? entry.args.filter(function (a) { return typeof a === "string" }) : []
    const env = entry.env && typeof entry.env === "object" ? entry.env : {}
    const headers = entry.headers && typeof entry.headers === "object" ? entry.headers : {}
    const joined = [url].concat(args).join(" ")
    const loopback = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)([:\/]|$)/i.test(url)
    if (/^http:\/\//i.test(url) && !loopback) {
      findings.push({ rule: "AG-TRANSPORT-001", severity: "high", file: rel, line: null, message: "server " + name + " has a plain http endpoint: " + url })
    }
    if (url !== "") {
      const hasAuth = Object.keys(headers).some(function (k) { return AUTH_HINT.test(k) }) || Object.keys(env).some(function (k) { return AUTH_HINT.test(k) })
      if (!hasAuth) {
        findings.push({ rule: "AG-TRANSPORT-002", severity: "medium", file: rel, line: null, message: "server " + name + " is remote but configures no authentication" })
      }
    }
    if (TLS_OFF.test(joined) || Object.keys(env).some(function (k) { return TLS_OFF.test(k + "=" + String(env[k])) })) {
      findings.push({ rule: "AG-TRANSPORT-003", severity: "high", file: rel, line: null, message: "server " + name + " disables TLS verification" })
    }
    if (WILDBIND.test(joined)) {
      findings.push({ rule: "AG-TRANSPORT-004", severity: "medium", file: rel, line: null, message: "server " + name + " binds or dials 0.0.0.0" })
    }
  }
  return findings
}

export const check = {
  id: "transport",
  run: function (ctx) {
    const findings = []
    const filesRead = []
    for (const rel of CONFIG_PATHS) {
      const abs = join(ctx.root, rel)
      if (!existsSync(abs)) continue
      filesRead.push(rel)
      findings.push.apply(findings, checkConfig(rel, ctx.readText(abs)))
    }
    return { findings: findings, filesRead: filesRead }
  },
}
