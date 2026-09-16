import { existsSync } from "node:fs"
import { join } from "node:path"

const HOOKS = ["preinstall", "install", "postinstall", "prepare"]

/** Hooks npm runs when someone installs the published package. */
const CONSUMER_HOOKS = ["preinstall", "install", "postinstall"]
const CRITICAL = [
  { re: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, what: "downloads a script and pipes it into a shell" },
  { re: /\b(ba|z|da)?sh\s+-c\b[^\n]*\b(curl|wget)\b/, what: "runs a shell that fetches a remote script" },
  { re: /\bbase64\s+(-d|--decode)\b/, what: "decodes base64 at install time" },
  { re: /\bnode\s+(-e|--eval)\b|\bpython[0-9.]*\s+-c\b/, what: "evaluates inline code at install time", inspect: true },
  { re: /\beval\b|\bchild_process\b|\bexecSync\b|\bspawnSync\b/, what: "spawns a process at install time" },
]

/**
 * Capabilities that make inline install code worth a critical. Tested against the raw
 * program, so module names inside string arguments count: in `node -e "..."` the quoted
 * argument *is* the code that runs.
 */
const ACTIVE = /\bfetch\s*\(|XMLHttpRequest|\baxios\b|\bundici\b|\bwriteFile|\bappendFile|\brmSync|\bunlinkSync|\beval\s*\(|new\s+Function|Buffer\.from\s*\([^)]*['"]base64|\bimport\s*\(|require\s*\(\s*['"](?!(?:node:)?(?:fs|path|child_process)['"])|process\.env\s*[\w.\[\]'"]*\s*=|process\.exit/

/**
 * A spawn whose first argument is not a fixed literal can be steered by whatever produced
 * the argument. A literal command (\`execSync('npm run build')\`) runs at install time, but
 * nothing in the repository can change what it runs, so it is a medium, not a critical.
 * Spawns are read separately from ACTIVE because the tell is the argument, not the call.
 */
const SPAWN_CALL = /\b(?:execSync|execFileSync|spawnSync|execFile|spawn)\s*\(/g
const LITERAL_ARG = /^\s*(['"\x60])(?:\\.|(?!\1)[\s\S])*\1\s*[),]/
export function spawnIsSteerable(text) {
  const s = String(text)
  const re = new RegExp(SPAWN_CALL.source, "g")
  let match
  while ((match = re.exec(s)) !== null) {
    const rest = s.slice(match.index + match[0].length)
    if (!LITERAL_ARG.test(rest)) return true
  }
  return false
}

/** Whether the program reaches for a spawn primitive at all, however it is called. */
export function hasSpawn(text) {
  return /\b(?:execSync|execFileSync|spawnSync|execFile|spawn|child_process)\b/.test(String(text))
}

/**
 * Tokens a print-only banner is built from. An inline program made only of these plus
 * strings and punctuation cannot fetch, write or spawn anything.
 */
const INERT_IDENTIFIERS = new Set([
  "console", "log", "error", "warn", "info", "debug", "process", "stdout", "stderr", "write", "exit", "env",
  "require", "fs", "path", "node:fs", "node:path", "existsSync", "join", "resolve", "basename", "dirname",
  "__dirname", "__filename", "try", "catch", "finally", "if", "else", "return", "throw", "new", "typeof",
  "const", "let", "var", "function", "true", "false", "null", "undefined", "String", "Number", "JSON",
  "stringify", "parse", "Error", "e", "err",
])

/**
 * The inline program of a hook command, or null when the command is not exactly one
 * inline invocation. Deliberately strict: if the eval is wrapped in a shell, chained, or
 * otherwise not the whole command, we do not pretend to have read it.
 */
export function extractInline(command) {
  const re = /^\s*(?:node\s+(?:-e|--eval)|python[0-9.]*\s+-c)\s+(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|(\S+))\s*$/
  const m = re.exec(String(command))
  if (!m) return null
  const program = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]
  return program === undefined ? null : program
}

/**
 * What an inline install hook actually does.
 *
 * The rule that matters is the payload, and the payload is sitting in the command string,
 * so there is no reason to guess from the shape. A banner that only prints is not a
 * supply-chain incident; code that can reach the network, spawn, or rewrite files is.
 * When the program cannot be read (wrapped, chained, obfuscated) the answer is "unknown",
 * which still reports as critical rather than assuming it is harmless.
 *
 * @param {string} command
 * @returns {{ kind: "inert"|"active"|"fixed"|"unread"|"opaque", program: string|null }}
 */
export function classifyInline(command) {
  const program = extractInline(command)
  if (program === null) return { kind: "unread", program: null }
  if (ACTIVE.test(program)) return { kind: "active", program: program }
  // A spawn we can read: critical only when its command can be steered.
  if (hasSpawn(program)) return { kind: spawnIsSteerable(program) ? "active" : "fixed", program: program }
  const stripped = program
    .replace(/'(?:[^'\\]|\\.)*'/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, " ")
  const unknown = (stripped.match(/[A-Za-z_$][\w$]*/g) || []).filter(function (t) { return !INERT_IDENTIFIERS.has(t) })
  return { kind: unknown.length === 0 ? "inert" : "opaque", program: program }
}

/** The severity and extra wording for a matched hook pattern, or null when it is a false positive. */
function describe(hook, pattern, body, consumer) {
  const base = consumer ? "critical" : "medium"
  if (!pattern.inspect) return { severity: base, note: "" }
  const verdict = classifyInline(body)
  // A print-only banner is a false positive, not a low-severity finding: the benign
  // corpus stays at zero findings, so inert inline code reports nothing at all.
  if (verdict.kind === "inert") return null
  if (verdict.kind === "active") {
    return { severity: base, note: " (the inline code can reach the network, spawn a process or rewrite files)" }
  }
  if (verdict.kind === "fixed") {
    return { severity: "medium", note: " (the inline code runs a command at install time, but the command is a fixed literal, so nothing here can redirect it)" }
  }
  if (verdict.kind === "unread") {
    return { severity: base, note: " (the inline code is wrapped or chained, so it could not be read here: treat it as live code)" }
  }
  return { severity: base, note: " (the inline code does more than print, but not in a way this check can classify: treat it as live code)" }
}

export function checkManifest(rel, text) {
  const findings = []
  let doc
  try { doc = JSON.parse(text) } catch (error) { return findings }
  const scripts = doc && doc.scripts
  if (!scripts || typeof scripts !== "object") return findings
  for (const hook of HOOKS) {
    const body = scripts[hook]
    if (typeof body !== "string" || body.trim() === "") continue
    for (const pattern of CRITICAL) {
      if (pattern.re.test(body)) {
        const consumer = CONSUMER_HOOKS.indexOf(hook) !== -1
        const decision = describe(hook, pattern, body, consumer)
        if (decision === null) break
        findings.push({
          rule: "AG-INSTALL-001",
          severity: decision.severity,
          file: rel,
          line: null,
          message: "the " + hook + " script " + pattern.what
            + (consumer ? "" : " (prepare runs on a local or git install, not when the published package is installed)")
            + decision.note,
        })
        break
      }
    }
  }
  return findings
}

export const check = {
  id: "install-hooks",
  run: function (ctx) {
    const rel = "package.json"
    const abs = join(ctx.root, rel)
    if (!existsSync(abs)) return { findings: [], filesRead: [] }
    return { findings: checkManifest(rel, ctx.readText(abs)), filesRead: [rel] }
  },
}
