/**
 * Sending one alert mail, with curl and nothing else.
 *
 * The credential never appears in the argument list: argv is world-readable on a shared machine
 * via ps, so it goes into a mode-0600 netrc file that is removed afterwards. The file is written
 * to a private directory and overwritten before removal, because "deleted" and "gone" differ on
 * a journaling filesystem.
 */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"

export function alertEnv(env) {
  const source = env || {}
  const missing = []
  for (const name of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "AGENTGATE_ALERT_TO"]) {
    if (!source[name]) missing.push(name)
  }
  if (missing.length > 0) throw new Error("告警环境变量缺少：" + missing.join(", ") + "（只列名字，不打印值）")
  const port = Number(source.SMTP_PORT)
  if (!Number.isFinite(port) || port <= 0) throw new Error("SMTP_PORT 不是端口号")
  return {
    host: source.SMTP_HOST,
    port: port,
    user: source.SMTP_USER,
    pass: source.SMTP_PASS,
    from: source.AGENTGATE_ALERT_FROM || source.SMTP_USER,
    to: source.AGENTGATE_ALERT_TO,
  }
}

export function netrcText(config) {
  return "machine " + config.host + " login " + config.user + " password " + config.pass + "\n"
}

/**
 * runner defaults to spawnSync. It is injectable so a test can prove what is passed to curl
 * without opening a socket - in particular that the password is not in the arguments.
 */
export function sendAlert(message, options) {
  const opts = options || {}
  const config = opts.config
  const runner = opts.runner || function (command, args, settings) { return spawnSync(command, args, settings) }
  const dir = mkdtempSync(join(tmpdir(), "agentgate-alert-"))
  const netrcPath = join(dir, "netrc")
  try {
    writeFileSync(netrcPath, netrcText(config), { mode: 0o600 })
    const args = [
      "--netrc-file", netrcPath,
      "--url", "smtps://" + config.host + ":" + config.port,
      "--mail-from", config.from,
      "--mail-rcpt", config.to,
      "--upload-file", "-",
      "--ssl-reqd",
      "--silent", "--show-error",
      "--max-time", "30",
    ]
    const result = runner("curl", args, { input: message, encoding: "utf8", timeout: 45000 })
    if (!result || result.status !== 0) {
      const detail = result && result.stderr ? String(result.stderr).trim().split("\n")[0] : "curl 没有返回状态"
      return { ok: false, detail: detail.slice(0, 200) }
    }
    return { ok: true, detail: "已交给 " + config.host }
  } finally {
    try { writeFileSync(netrcPath, "x".repeat(64)) } catch (error) { /* best effort */ }
    try { unlinkSync(netrcPath) } catch (error) { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) { /* best effort */ }
  }
}
