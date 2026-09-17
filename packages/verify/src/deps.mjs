/**
 * The repository claims to have no third-party dependencies. This is what makes that claim
 * checkable rather than aspirational.
 *
 * Two halves: the manifest must stay empty, and no source file may import a bare specifier -
 * which is how a dependency actually arrives. A package that is imported but not declared runs
 * today only because it is installed on the author's machine, and fails on a clean checkout.
 *
 * Node built-ins are allowed, resolved through module.builtinModules rather than a hand-written
 * list that would drift with the Node version.
 */
import { builtinModules } from "node:module"

const BUILTINS = new Set(builtinModules.concat(["node:test", "node:test/reporters"]))

const PATTERNS = [
  /^\s*import\s+[^"']*from\s*["']([^"']+)["']/,
  /^\s*import\s*["']([^"']+)["']/,
  /^\s*export\s+[^"']*from\s*["']([^"']+)["']/,
  /^[^"']*?\brequire\(\s*["']([^"']+)["']\s*\)/,
  /^[^"']*?\bimport\(\s*["']([^"']+)["']\s*\)/,
]

/** True for anything that resolves without a package: relative, absolute, URL or built-in. */
export function isLocalSpecifier(specifier) {
  if (specifier.indexOf(".") === 0 || specifier.indexOf("/") === 0) return true
  if (specifier.indexOf("node:") === 0) return true
  if (/^[a-z]+:/i.test(specifier)) return true
  return BUILTINS.has(specifier)
}

/** Every specifier a source file imports or requires. */
export function bareImportsOf(source) {
  const found = []
  const lines = String(source).split("\n")
  for (let i = 0; i < lines.length; i += 1) {
    for (const pattern of PATTERNS) {
      const match = pattern.exec(lines[i])
      if (!match) continue
      const specifier = match[1]
      if (isLocalSpecifier(specifier)) break
      found.push({ specifier: specifier, line: i + 1 })
      break
    }
  }
  return found
}

export function scanBareImports(files) {
  const problems = []
  for (const file of files || []) {
    for (const hit of bareImportsOf(file.text)) {
      problems.push({ path: file.path, specifier: hit.specifier, line: hit.line })
    }
  }
  return problems
}

export function dependencyNames(packageJson) {
  const doc = packageJson || {}
  return {
    dependencies: Object.keys(doc.dependencies || {}),
    devDependencies: Object.keys(doc.devDependencies || {}),
    optionalDependencies: Object.keys(doc.optionalDependencies || {}),
    peerDependencies: Object.keys(doc.peerDependencies || {}),
  }
}
