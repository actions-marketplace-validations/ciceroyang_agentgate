/**
 * Whether the deployment is actually working, asked from outside the process.
 *
 * /health is the service's own answer; this is someone checking it, plus the things /health
 * cannot see: free disk, whether the ledger still verifies, and whether the public URLs answer.
 * A check that cannot be performed is a problem, not a pass - the same rule the scanner uses.
 *
 * Pure on purpose: every source of truth (the health body, a statfs result, a verify result, an
 * HTTP status) is passed in, so the failure paths can be tested without a machine.
 */

export const DEFAULTS = {
  maxAgeHours: 26,
  minFreeBytes: 1024 * 1024 * 1024,
  repeatAlertHours: 6,
}

function problem(id, detail) {
  return { id: id, detail: detail }
}

export function checkHealth(body, options) {
  const opts = options || {}
  const maxAgeHours = typeof opts.maxAgeHours === "number" ? opts.maxAgeHours : DEFAULTS.maxAgeHours
  const problems = []
  if (!body || typeof body !== "object") return [problem("health_unreadable", "/health 没有返回一个对象")]
  if (body.ok !== true) {
    problems.push(problem("health_not_ok", "/health 的 ok 不是 true：" + String(body.reason || body.error || "未说明")))
    // Nothing else can be read from an answer that is not an answer. Reporting derived problems
    // off a synthetic body would be noise, not information.
    if (body.records === undefined && body.generatedAt === undefined) return problems
  }
  if (typeof body.records !== "number" || body.records <= 0) problems.push(problem("index_records", "索引记录数不是正整数：" + String(body.records)))
  const generated = Date.parse(body.generatedAt)
  if (!Number.isFinite(generated)) problems.push(problem("index_generated_at", "索引生成时间不可解析：" + String(body.generatedAt)))
  if (opts.requireHistory === false) return problems
  const history = body.history
  if (!history || typeof history !== "object") {
    problems.push(problem("history_absent", "这个部署没有采集历史块；采集停了就是不可逆的，所以这里算问题"))
    return problems
  }
  if (typeof history.captures !== "number" || history.captures <= 0) problems.push(problem("history_empty", "账本里没有采集记录"))
  if (typeof history.ageHours === "number" && history.ageHours > maxAgeHours) {
    problems.push(problem("history_age", "最后一次采集是 " + history.ageHours.toFixed(1) + " 小时前，超过 " + maxAgeHours + " 小时"))
  }
  if (history.stale === true) problems.push(problem("history_stale", "服务自己把历史标成了 stale"))
  if (Array.isArray(history.gaps) && history.gaps.length > 0) {
    problems.push(problem("history_gaps", history.gaps.length + " 天没有采集，最早缺口 " + String(history.gaps[0])))
  }
  return problems
}

export function checkDisk(stat, options) {
  const opts = options || {}
  const minFreeBytes = typeof opts.minFreeBytes === "number" ? opts.minFreeBytes : DEFAULTS.minFreeBytes
  if (!stat || typeof stat.freeBytes !== "number") return [problem("disk_unreadable", "读不到磁盘余量")]
  if (!Number.isFinite(stat.freeBytes) || stat.freeBytes < minFreeBytes) {
    return [problem("disk_low", "可用空间 " + String(stat.freeBytes) + " 字节，低于下限 " + minFreeBytes)]
  }
  return []
}

export function checkLedger(result) {
  if (!result || typeof result !== "object") return [problem("ledger_unreadable", "账本校验没有返回结果")]
  if (result.ok === true) return []
  const first = Array.isArray(result.problems) && result.problems.length > 0 ? result.problems[0] : null
  // verifyLedger returns strings; the checkers here return objects. Accept both rather than
  // force one of the two callers to change.
  const detail = typeof first === "string" ? first : first ? first.problem + "：" + first.detail : "账本校验失败"
  return [problem("ledger_broken", detail)]
}

/**
 * A backup that stopped happening is silent: the archive from last month still restores. So the
 * age of the newest archive is a check, not something to remember to look at.
 */
export function checkBackups(files, options) {
  const opts = options || {}
  // Deliberately its own key: maxAgeHours means the capture age everywhere else, and a check
  // that silently reads the other option is a check that is not testing what the caller asked for.
  const maxAgeHours = typeof opts.backupMaxAgeHours === "number" ? opts.backupMaxAgeHours : 36
  const list = (files || []).filter(function (file) { return file && typeof file.name === "string" && /^agentgate-.*\.tgz$/.test(file.name) })
  if (list.length === 0) return [problem("backup_absent", "备份目录里没有 agentgate 的归档")]
  let newest = list[0]
  for (const file of list) if (file.mtimeMs > newest.mtimeMs) newest = file
  const now = typeof opts.nowMs === "number" ? opts.nowMs : Date.now()
  const ageHours = (now - newest.mtimeMs) / 3600000
  if (!Number.isFinite(ageHours) || ageHours > maxAgeHours) {
    return [problem("backup_age", "最新备份 " + newest.name + " 是 " + ageHours.toFixed(1) + " 小时前（上限 " + maxAgeHours + " 小时）")]
  }
  return []
}

export function checkUrls(results) {
  const problems = []
  for (const result of results || []) {
    if (!result || result.ok === true) continue
    problems.push(problem("url", String(result.url) + " 返回 " + String(result.status === undefined ? result.error : result.status)))
  }
  return problems
}

/** Every source is optional; a source that was not checked is named as a gap, not treated as fine. */
export function runChecks(sources) {
  const input = sources || {}
  const problems = []
  const checked = []
  // Nothing checked is not fine. It is the same rule the scanner applies to a check that did not
  // run: an unmeasured deployment is not a healthy one.
  if (["health", "disk", "ledger", "urls", "backups"].every(function (key) { return input[key] === undefined })) {
    return { ok: false, checked: [], problems: [problem("nothing_checked", "没有任何一项被检查；没检查不等于通过")], facts: input.facts || {} }
  }
  if (input.health !== undefined) { problems.push.apply(problems, checkHealth(input.health, input.options)); checked.push("health") }
  if (input.disk !== undefined) { problems.push.apply(problems, checkDisk(input.disk, input.options)); checked.push("disk") }
  if (input.ledger !== undefined) { problems.push.apply(problems, checkLedger(input.ledger)); checked.push("ledger") }
  if (input.urls !== undefined) { problems.push.apply(problems, checkUrls(input.urls)); checked.push("urls") }
  if (input.backups !== undefined) { problems.push.apply(problems, checkBackups(input.backups, input.options)); checked.push("backups") }
  return { ok: problems.length === 0, checked: checked, problems: problems, facts: input.facts || {} }
}

const HOUR_MS = 3600 * 1000

/**
 * When to send mail: on the transition into failure, again every few hours while it stays
 * broken (so a forgotten alert does not become a forgotten outage), and once on recovery.
 */
export function decideAlert(previous, status, nowMs, options) {
  const opts = options || {}
  const repeatHours = typeof opts.repeatAlertHours === "number" ? opts.repeatAlertHours : DEFAULTS.repeatAlertHours
  const before = previous && typeof previous === "object" ? previous : null
  const lastAlertAt = before && before.lastAlertAt ? Date.parse(before.lastAlertAt) : NaN
  if (status === "fail") {
    if (!before || before.status !== "fail") {
      return { action: "alert", reason: "第一次发现异常", state: { status: status, lastAlertAt: new Date(nowMs).toISOString() } }
    }
    const since = Number.isFinite(lastAlertAt) ? nowMs - lastAlertAt : Infinity
    if (since >= repeatHours * HOUR_MS) {
      return { action: "alert", reason: "异常持续 " + Math.round(since / HOUR_MS) + " 小时，超过重发间隔", state: { status: status, lastAlertAt: new Date(nowMs).toISOString() } }
    }
    return { action: "none", reason: "仍异常，但还没到重发间隔", state: { status: status, lastAlertAt: before.lastAlertAt || null } }
  }
  if (before && before.status === "fail") {
    return { action: "recovery", reason: "从异常恢复", state: { status: status, lastAlertAt: null } }
  }
  return { action: "none", reason: "一直正常", state: { status: status, lastAlertAt: null } }
}

export function buildMessage(options) {
  const opts = options || {}
  const status = opts.status === "recovery" ? "recovery" : opts.status === "ok" ? "ok" : "fail"
  const problems = Array.isArray(opts.problems) ? opts.problems : []
  const subject = status === "fail"
    ? "[agentgate] 巡检异常：" + problems.length + " 项"
    : status === "recovery" ? "[agentgate] 巡检已恢复" : "[agentgate] 巡检正常"
  const lines = []
  lines.push("From: " + opts.from)
  lines.push("To: " + opts.to)
  lines.push("Subject: " + subject)
  lines.push("Date: " + new Date(opts.nowMs || Date.now()).toUTCString())
  lines.push("Content-Type: text/plain; charset=utf-8")
  lines.push("Content-Transfer-Encoding: 8bit")
  lines.push("")
  lines.push(status === "fail" ? "部署巡检发现以下问题：" : status === "recovery" ? "之前报告的问题已经消失：" : "巡检没有发现问题。")
  lines.push("")
  for (const item of problems) lines.push("- " + item.id + "：" + item.detail)
  if (problems.length === 0) lines.push("- 无")
  const facts = opts.facts && typeof opts.facts === "object" ? opts.facts : {}
  const keys = Object.keys(facts).sort()
  if (keys.length > 0) {
    lines.push("")
    lines.push("观测值：")
    for (const key of keys) lines.push("  " + key + " = " + String(facts[key]))
  }
  lines.push("")
  lines.push("复现：node scripts/healthcheck.mjs --format json")
  lines.push("这是可用性巡检，不是合规结论，也不代表被检查的内容没有风险。")
  return lines.join("\n") + "\n"
}

export function renderText(result, alert) {
  const lines = []
  lines.push("healthcheck: " + (result.ok ? "OK" : "PROBLEMS " + result.problems.length))
  lines.push("已检查：" + (result.checked.length > 0 ? result.checked.join(", ") : "无（什么都没检查，不能算通过）"))
  for (const item of result.problems) lines.push("  " + item.id + "  " + item.detail)
  if (alert) lines.push("告警动作：" + alert.action + "（" + alert.reason + "）")
  return lines.join("\n")
}
