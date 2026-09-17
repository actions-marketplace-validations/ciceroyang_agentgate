#!/usr/bin/env node
/**
 * The repository says it has no third-party dependencies. This checks both halves of that: the
 * manifest is empty, and nothing imports a package that would have to be installed.
 *
 * Exit 0 when both hold, 1 when either does not. Run by scripts/verify.sh and by CI, because a
 * claim that only lives in a README is a claim nobody tests.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { dependencyNames, scanBareImports } from "../packages/verify/src/deps.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE_ROOTS = ["bin", "packages", "scripts", "test"]
const SKIP = new Set(["node_modules", ".git", "corpus", "data", "site", "dist"])

function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full)
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const names = dependencyNames(pkg)
const declared = [].concat(names.dependencies, names.devDependencies, names.optionalDependencies, names.peerDependencies)

const files = []
for (const root of SOURCE_ROOTS) {
  const dir = join(ROOT, root)
  if (existsSync(dir)) collect(dir, files)
}
const scanned = files.map(function (file) { return { path: relative(ROOT, file), text: readFileSync(file, "utf8") } })
const imported = scanBareImports(scanned)

for (const name of declared) process.stdout.write("declared dependency: " + name + "\n")
for (const hit of imported) process.stdout.write("bare import: " + hit.path + ":" + hit.line + " -> " + hit.specifier + "\n")

if (declared.length === 0 && imported.length === 0) {
  process.stdout.write("zero dependencies: " + scanned.length + " source files scanned, none imports a package\n")
  process.exit(0)
}
process.stderr.write("this repository is supposed to have no third-party dependencies\n")
process.exit(1)
