import { existsSync } from "node:fs"
import { join } from "node:path"

const HOOKS = ["preinstall", "install", "postinstall", "prepare"]

/** Hooks npm runs when someone installs the published package. */
const CONSUMER_HOOKS = ["preinstall", "install", "postinstall"]
const CRITICAL = [
  { re: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, what: "downloads a script and pipes it into a shell" },
  { re: /\b(ba|z|da)?sh\s+-c\b[^\n]*\b(curl|wget)\b/, what: "runs a shell that fetches a remote script" },
  { re: /\bbase64\s+(-d|--decode)\b/, what: "decodes base64 at install time" },
  { re: /\bnode\s+-e\b|\bpython[0-9.]*\s+-c\b/, what: "evaluates inline code at install time" },
  { re: /\beval\b|\bchild_process\b|\bexecSync\b|\bspawnSync\b/, what: "spawns a process at install time" },
]

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
        findings.push({
          rule: "AG-INSTALL-001",
          severity: consumer ? "critical" : "medium",
          file: rel,
          line: null,
          message: "the " + hook + " script " + pattern.what
            + (consumer ? "" : " (prepare runs on a local or git install, not when the published package is installed)"),
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
