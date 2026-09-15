import { walk } from "../fs-scan.mjs"

/**
 * Narrow on purpose. Each pattern is a shape that is almost never correct, so the
 * check stays quiet on ordinary code. Anything broader belongs in a taint analysis,
 * not in a regex, and pretending otherwise produces the kind of noise that gets a
 * scanner switched off.
 */
export const PATTERNS = [
  { rule: "AG-SRC-001", severity: "high", re: /(?<![.\w])(exec|execSync)\s*\(\s*`[^`]*\$\{/, message: "shell command built from a template literal containing interpolation" },
  { rule: "AG-SRC-001", severity: "high", re: /(?<![.\w])(exec|execSync)\s*\(\s*[A-Za-z_$][\w$]*\s*\+/, message: "shell command built by concatenating a variable into exec()" },
  { rule: "AG-SRC-001", severity: "high", re: /\bos\.system\s*\(\s*f/, message: "os.system() called with an f-string" },
  { rule: "AG-SRC-001", severity: "high", re: /\bos\.system\s*\(\s*[A-Za-z_][\w.]*\s*\+/, message: "os.system() called with string concatenation" },
  { rule: "AG-SRC-001", severity: "high", re: /\bsubprocess\.(run|call|Popen|check_output|check_call)\s*\([\s\S]{0,200}?shell\s*=\s*True/, message: "subprocess called with shell=True" },
  { rule: "AG-SRC-002", severity: "medium", re: /(?<![.\w])eval\s*\(\s*[A-Za-z_$]/, message: "eval() on a non-literal argument" },
  { rule: "AG-SRC-002", severity: "medium", re: /\bnew\s+Function\s*\(/, message: "new Function() compiles a string as code" },
]

const EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py"]

/** Generated or vendored output: a bundler emits new Function() and eval() by design. */
const GENERATED = /(^|\/)(\.smithery|out|coverage|vendor|generated|__generated__)\//
const BUNDLED = /\.(min|bundle)\.js$/

/** Shell interpolation in a dev script or a test is a real shape with a smaller reach. */
const DEV_PATH = /(^|\/)(test|tests|scripts|bench|benchmarks|examples|e2e)(\/|$)/

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1
  return line
}

/**
 * One finding per rule per file, with an occurrence count. A provisioning module
 * that builds forty shell strings is one thing to review, not forty, and a scanner
 * that emits forty findings for it gets switched off before anyone reads the first.
 *
 * Severity is capped at medium for AG-SRC-001: whether an interpolation is
 * exploitable depends on whether the argument was validated, and a regex cannot
 * know that. One file in the sample validates the address on the line above the
 * exec call; the pattern still fires, correctly, as something to look at.
 */
export function checkSource(rel, text) {
  const byRule = new Map()
  if (GENERATED.test(rel) || BUNDLED.test(rel)) return []
  const dev = DEV_PATH.test(rel)
  for (const pattern of PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.indexOf("g") === -1 ? pattern.re.flags + "g" : pattern.re.flags)
    let match
    while ((match = re.exec(text)) !== null) {
      const severity = pattern.rule === "AG-SRC-001" ? (dev ? "low" : "medium") : pattern.severity
      if (!byRule.has(pattern.rule)) {
        byRule.set(pattern.rule, {
          rule: pattern.rule,
          severity: severity,
          file: rel,
          line: lineOf(text, match.index),
          message: pattern.message + (pattern.rule === "AG-SRC-001" && dev ? " (in a script or test path: real shape, smaller reach)" : ""),
          count: 0,
        })
      }
      byRule.get(pattern.rule).count += 1
      if (match.index === re.lastIndex) re.lastIndex += 1
    }
  }
  return Array.from(byRule.values()).map(function (entry) {
    return {
      rule: entry.rule,
      severity: entry.severity,
      file: entry.file,
      line: entry.line,
      message: entry.message + (entry.count > 1 ? " (" + entry.count + " occurrences in this file)" : ""),
    }
  })
}

export const check = {
  id: "source-injection",
  run: function (ctx) {
    const findings = []
    const filesRead = []
    for (const file of walk(ctx.root, { exts: EXTS, maxFiles: 800 })) {
      filesRead.push(file.rel)
      findings.push.apply(findings, checkSource(file.rel, ctx.readText(file.abs)))
    }
    return { findings: findings, filesRead: filesRead }
  },
}
