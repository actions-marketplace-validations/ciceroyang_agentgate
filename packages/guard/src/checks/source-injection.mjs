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
export const GENERATED = /(^|\/)(\.smithery|out|coverage|vendor|generated|__generated__)\//
export const BUNDLED = /\.(min|bundle)\.js$/

/** Shell interpolation in a dev script or a test is a real shape with a smaller reach. */
const DEV_PATH = /(^|\/)(test|tests|scripts|bench|benchmarks|examples|e2e)(\/|$)/

/**
 * Comment text replaced by spaces: same length, same newlines, so an offset still maps to
 * the line it came from.
 *
 * This exists because the rules below read like code and were matching prose. Two real
 * repositories were flagged for "eval() on a non-literal argument": one for the words
 * "tool-selection eval (plan §9)" in a JavaScript comment, one for `def eval(self):` — a
 * method that is *named* eval. A finding nobody can act on is worse than a missed one,
 * because it teaches the person reading it to stop reading.
 *
 * Strings are tracked so that `//` inside a string does not start masking code, and
 * template literals are left intact because AG-SRC-001 deliberately matches their contents.
 */
export function maskComments(text, ext) {
  const out = Array.from(text)
  const py = ext === ".py"
  const n = text.length
  let i = 0
  let quote = null
  while (i < n) {
    const c = text[i]
    if (quote) {
      if (c === "\\") { i += 2; continue }
      if (c === quote) { quote = null; i += 1; continue }
      i += 1
      continue
    }
    if (py && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const fence = text.slice(i, i + 3)
      out[i] = " "; out[i + 1] = " "; out[i + 2] = " "; i += 3
      while (i < n && !text.startsWith(fence, i)) { if (text[i] !== "\n") out[i] = " "; i += 1 }
      if (i < n) { out[i] = " "; out[i + 1] = " "; out[i + 2] = " "; i += 3 }
      continue
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; i += 1; continue }
    if (!py && c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") { out[i] = " "; i += 1 } continue }
    if (!py && c === "/" && text[i + 1] === "*") {
      out[i] = " "; out[i + 1] = " "; i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] !== "\n") out[i] = " "; i += 1 }
      if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2 }
      continue
    }
    if (py && c === "#") { while (i < n && text[i] !== "\n") { out[i] = " "; i += 1 } continue }
    i += 1
  }
  return out.join("")
}

/**
 * A definition is not a call. `def eval(self):` and `eval(x) {` introduce a function, they
 * do not evaluate a string; flagging them says the scanner did not look at the word before.
 */
export function isDefinitionAt(text, index) {
  const before = text.slice(Math.max(0, index - 40), index)
  if (/\b(def|function|class)\s+$/.test(before)) return true
  const ident = /^[A-Za-z_$][\w$]*/.exec(text.slice(index))
  if (!ident) return false
  // an identifier, its parameter list, then a body or a return-type colon: a definition
  return new RegExp("^" + ident[0].replace(/[$]/g, "\\function lineOf(text, index) {") + "\\s*\\([^)\\n]*\\)\\s*[:{]").test(text.slice(index, index + 160))
}

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
 * know that. A shell or eval shape inside a test or a script is downgraded to low
 * for the same reason in reverse: the reach is smaller and saying so is the honest
 * report. One file in the sample validates the address on the line above the
 * exec call; the pattern still fires, correctly, as something to look at.
 */
export function checkSource(rel, text) {
  const byRule = new Map()
  if (GENERATED.test(rel) || BUNDLED.test(rel)) return []
  const dev = DEV_PATH.test(rel)
  const ext = (/.[a-z]+$/.exec(rel) || [""])[0]
  // Rules match against the source with comments blanked out, so offsets still line up.
  const code = maskComments(text, ext)
  for (const pattern of PATTERNS) {
    const lineText = code
    const re = new RegExp(pattern.re.source, pattern.re.flags.indexOf("g") === -1 ? pattern.re.flags + "g" : pattern.re.flags)
    let match
    while ((match = re.exec(lineText)) !== null) {
      if (isDefinitionAt(lineText, match.index)) { if (match.index === re.lastIndex) re.lastIndex += 1; continue }
      let severity = pattern.severity
      if (dev && (pattern.rule === "AG-SRC-001" || pattern.rule === "AG-SRC-002")) severity = "low"
      else if (pattern.rule === "AG-SRC-001") severity = "medium" // a regex cannot know whether the argument was validated
      if (!byRule.has(pattern.rule)) {
        byRule.set(pattern.rule, {
          rule: pattern.rule,
          severity: severity,
          file: rel,
          line: lineOf(lineText, match.index),
          message: pattern.message + (dev && (pattern.rule === "AG-SRC-001" || pattern.rule === "AG-SRC-002") ? " (in a script or test path: real shape, smaller reach)" : ""),
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
      // Generated output is not read at all. Reading it first and discarding it afterwards is
      // how a hundred-megabyte bundle becomes a memory problem for a scan that ignores it.
      if (GENERATED.test(file.rel) || BUNDLED.test(file.rel)) continue
      filesRead.push(file.rel)
      findings.push.apply(findings, checkSource(file.rel, ctx.readText(file.abs)))
    }
    return { findings: findings, filesRead: filesRead }
  },
}
