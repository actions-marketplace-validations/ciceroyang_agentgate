/**
 * What has to be true before a version is published, expressed as data so the checks can be
 * tested without publishing anything.
 *
 * The failure this exists to prevent: a tarball that is missing a directory, carries a generated
 * index or an environment file, or ships a version that disagrees with its own tag.
 */

export const REQUIRED_FILES = ["package.json", "README.md", "LICENSE", "bin/agentgate.mjs"]

/** A generated index is evidence from someone else's machine; a .env is a secret. */
export const FORBIDDEN_PATTERNS = [
  { pattern: /(^|\/)\.env($|\.)/, why: "环境文件不该进包" },
  { pattern: /smtp\.env/, why: "SMTP 凭据不该进包" },
  { pattern: /(^|\/)\.git\//, why: "git 元数据不该进包" },
  { pattern: /node_modules\//, why: "依赖目录不该进包" },
  { pattern: /\.tgz$/, why: "归档不该进包" },
  { pattern: /\.log$/, why: "日志不该进包" },
  { pattern: /(^|\/)data\/history\//, why: "采集账本属于部署，不属于包" },
  { pattern: /(^|\/)data\/index\.json$/, why: "生成出来的索引不属于包，样本才是" },
]

export function versionFromTag(tag) {
  return String(tag || "").replace(/^v/, "")
}

export function tagMatches(tag, version) {
  return versionFromTag(tag) === String(version)
}

/** npm pack --dry-run --json prints an array with one entry; anything else is not a packument. */
export function pathsFromPackJson(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error("npm pack 的输出不是 JSON：" + error.message)
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  if (!first || !Array.isArray(first.files)) throw new Error("npm pack 的输出里没有 files 列表")
  return first.files.map(function (file) { return file && file.path ? String(file.path) : "" }).filter(Boolean)
}

export function changelogHasVersion(text, version) {
  const pattern = new RegExp("^##\\s*\\[?" + String(version).replace(/\./g, "\\.") + "\\]?(\\s|$)", "m")
  return pattern.test(String(text || ""))
}

/** allow is package.json's files list: an entry ending in "/" is a prefix, otherwise an exact path. */
export function classifyPack(paths, options) {
  const opts = options || {}
  const allow = opts.allow || []
  const required = opts.required || REQUIRED_FILES
  const forbidden = opts.forbidden || FORBIDDEN_PATTERNS
  const present = new Set(paths)
  const missing = required.filter(function (path) { return !present.has(path) })
  const leaks = []
  for (const path of paths) {
    for (const rule of forbidden) {
      if (rule.pattern.test(path)) leaks.push({ path: path, why: rule.why })
    }
  }
  const leaked = new Set(leaks.map(function (leak) { return leak.path }))
  // A file reported with a specific reason is not also reported as unexplained: two lines for one
  // fact is how a report becomes something people stop reading.
  const unexplained = paths.filter(function (path) {
    if (leaked.has(path)) return false
    return !allow.some(function (entry) {
      return entry.endsWith("/") ? path.indexOf(entry) === 0 : path === entry
    })
  })
  return { missing: missing, leaks: leaks, unexplained: unexplained }
}

export function summarize(checks) {
  const problems = []
  const warnings = []
  for (const check of checks || []) {
    if (check.level === "problem" && !check.ok) problems.push(check.detail)
    if (check.level === "warning" && !check.ok) warnings.push(check.detail)
  }
  return { ok: problems.length === 0, problems: problems, warnings: warnings }
}
