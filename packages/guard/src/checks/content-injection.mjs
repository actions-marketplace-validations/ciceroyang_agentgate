import { walk } from "../fs-scan.mjs"

/**
 * Prompt-injection phrasing, English and Chinese, plus the code-switched form
 * that single-language rules miss ("Ignore 以上所有 instructions"). The last one
 * is the reason this check exists: a bilingual attacker writes in both.
 */
export const PATTERNS = [
  { rule: "AG-INJECT-EN-01", severity: "high", re: /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|directions?)/i, message: "text tells the reader to ignore earlier instructions" },
  { rule: "AG-INJECT-EN-02", severity: "high", re: /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i, message: "text tells the reader to disregard earlier rules" },
  { rule: "AG-INJECT-EN-03", severity: "medium", re: /(you\s+are\s+now|from\s+now\s+on\s+you\s+are)\s+(a\s+|an\s+)?(admin|administrator|root|unrestricted|developer\s+mode|dan)\b/i, message: "text reassigns the model to a privileged role" },
  { rule: "AG-INJECT-EN-04", severity: "medium", re: /(reveal|print|output|show|repeat)\s+(the\s+|your\s+)?(system\s+prompt|initial\s+instructions|hidden\s+instructions)/i, message: "text asks for the hidden system prompt" },
  { rule: "AG-INJECT-ZH-01", severity: "high", re: /(忽略|无视|忘掉|忘记)(之前|以上|上面|前面|所有|全部)的?(指令|提示|规则|设定|要求)/, message: "text tells the reader to forget earlier instructions" },
  { rule: "AG-INJECT-ZH-02", severity: "medium", re: /(你现在是|从现在开始你是|从现在起你是)(管理员|超级用户|开发者模式|最高权限)/, message: "text reassigns the model to a privileged role" },
  { rule: "AG-INJECT-ZH-03", severity: "medium", re: /(输出|打印|告诉我|显示|重复)(一下)?(你的)?(系统提示|系统提示词|初始指令|隐藏指令)/, message: "text asks for the hidden system prompt" },
  { rule: "AG-INJECT-MIX-01", severity: "high", re: /(ignore|disregard|忽略|无视)\s*[\u4e00-\u9fff]+[^\n]{0,40}?(instructions?|prompts?|rules?|指令|规则)/i, message: "code-switched instruction override" },
]

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1
  return line
}

/** Ranges covered by a fenced block, so documentation examples can be told apart. */
export function fencedRanges(text) {
  const ranges = []
  const lines = text.split("\n")
  let offset = 0
  let start = -1
  let fence = null
  for (const line of lines) {
    const m = /^\s*(```+|~~~+)/.exec(line)
    if (m) {
      if (start === -1) { start = offset; fence = m[1].charAt(0) }
      else if (m[1].charAt(0) === fence) { ranges.push([start, offset + line.length]); start = -1; fence = null }
    }
    offset += line.length + 1
  }
  if (start !== -1) ranges.push([start, text.length])
  return ranges
}

/**
 * A match inside a fenced block or an inline code span is quoted, not prose. It is
 * still reported, at low severity, because a quoted payload is exactly what a
 * security document, a README or a skill file is full of and hiding it would be a
 * blind spot. It just should not carry the weight of live instruction text.
 */
/** A prohibition before the verb means the text forbids the act, it does not request it. */
const NEGATION = /\b(do\s+not|don't|does\s+not|never|must\s+not|should\s+not|mustn't|avoid|refuse\s+to)\s*$/i

export function isDefensive(text, index) {
  return NEGATION.test(text.slice(Math.max(0, index - 40), index))
}

export function isQuoted(text, index, ranges) {
  const inFence = (ranges || fencedRanges(text)).some(function (r) { return index >= r[0] && index < r[1] })
  if (inFence) return true
  const lineStart = text.lastIndexOf("\n", index - 1) + 1
  let ticks = 0
  let quotes = 0
  for (let i = lineStart; i < index; i += 1) {
    const ch = text.charAt(i)
    if (ch === "`") ticks += 1
    else if (ch === "\"") quotes += 1
  }
  return ticks % 2 === 1 || quotes % 2 === 1
}

export function checkText(rel, text) {
  const findings = []
  const ranges = fencedRanges(text)
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(text)
    if (!match) continue
    const quoted = isQuoted(text, match.index, ranges)
    const defensive = !quoted && isDefensive(text, match.index)
    const note = quoted
      ? " (quoted: inside a fence, inline code or a quoted span)"
      : defensive ? " (defensive: the text forbids this rather than asking for it)" : ""
    findings.push({
      rule: pattern.rule,
      severity: quoted || defensive ? "low" : pattern.severity,
      file: rel,
      line: lineOf(text, match.index),
      message: pattern.message + note,
    })
  }
  return findings
}

const EXTS = [".md", ".markdown", ".txt", ".rst"]

export const check = {
  id: "content-injection",
  run: function (ctx) {
    const findings = []
    const filesRead = []
    for (const file of walk(ctx.root, { exts: EXTS, maxFiles: 500 })) {
      filesRead.push(file.rel)
      findings.push.apply(findings, checkText(file.rel, ctx.readText(file.abs)))
    }
    return { findings: findings, filesRead: filesRead }
  },
}
