import { existsSync } from "node:fs"
import { join } from "node:path"

const MUTABLE_REMOTE = /^(git[+:]|github:|gitlab:|bitbucket:|https?:)/i
const MUTABLE_LOCAL = /^(file:|link:)/i
const FLOATING = /^(\*|latest|x)$/i
const LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"]

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]

/**
 * A dev or peer dependency never reaches someone who installs this package, only
 * its maintainer, so the same finding carries a smaller blast radius. Severity
 * drops; the finding is kept, because the statement is still true.
 */
export function isRuntimeField(field) {
  return field === "dependencies" || field === "optionalDependencies"
}

export function dependenciesOf(doc) {
  const out = []
  if (!doc || typeof doc !== "object") return out
  for (const field of DEP_FIELDS) {
    const deps = doc[field]
    if (!deps || typeof deps !== "object") continue
    for (const name of Object.keys(deps)) out.push({ name: name, spec: String(deps[name]), field: field })
  }
  return out
}

export function checkManifest(rel, text) {
  const findings = []
  let doc
  try { doc = JSON.parse(text) } catch (error) { return findings }
  for (const dep of dependenciesOf(doc)) {
    const runtime = isRuntimeField(dep.field)
    const scope = runtime ? "" : " (dev-only: cannot reach a consumer of this package)"
    const remote = MUTABLE_REMOTE.test(dep.spec)
    const local = MUTABLE_LOCAL.test(dep.spec)
    if (remote || local) {
      // A remote ref can be repointed under you after you have read it; a path inside this
      // repository cannot, it only cannot be resolved by anyone else. Same rule, and the
      // honest severity for each is different.
      const severity = local ? (runtime ? "medium" : "low") : (runtime ? "high" : "medium")
      const what = local
        ? "resolves to a path inside this repository, which nobody installing the published package can resolve"
        : "resolves to a mutable source"
      findings.push({ rule: "AG-SUPPLY-001", severity: severity, file: rel, line: null, message: dep.field + " entry " + dep.name + " " + what + ": " + dep.spec + scope })
      continue
    }
    if (FLOATING.test(dep.spec.trim())) {
      findings.push({ rule: "AG-SUPPLY-002", severity: runtime ? "medium" : "low", file: rel, line: null, message: dep.field + " entry " + dep.name + " floats on " + dep.spec + scope })
    }
  }
  return findings
}

export const check = {
  id: "supply-chain",
  run: function (ctx) {
    const rel = "package.json"
    const abs = join(ctx.root, rel)
    if (!existsSync(abs)) return { findings: [], filesRead: [] }
    const text = ctx.readText(abs)
    const findings = checkManifest(rel, text)
    let doc = null
    try { doc = JSON.parse(text) } catch (error) { doc = null }
    if (doc && dependenciesOf(doc).length > 0) {
      const hasLock = LOCKFILES.some(function (name) { return existsSync(join(ctx.root, name)) })
      if (!hasLock) {
        findings.push({ rule: "AG-SUPPLY-003", severity: "low", file: rel, line: null, message: "dependencies are declared but no lockfile is committed" })
      }
    }
    return { findings: findings, filesRead: [rel] }
  },
}
