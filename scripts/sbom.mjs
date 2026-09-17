#!/usr/bin/env node
/**
 * Generate our own SBOM, because we ask everyone else for one.
 *
 *   node scripts/sbom.mjs [--out dist/agentgate.cdx.json] [--stdout]
 *
 * File hashes cover the shipped source, so two SBOMs for the same commit match and a changed
 * file shows up. The dependencies list is empty on purpose: CI asserts that separately.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildSbom } from "../packages/verify/src/sbom.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE_ROOTS = ["bin", "packages", "scripts"]
const SKIP = new Set(["node_modules", ".git", "corpus", "data", "dist"])

function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full)
  }
}

function argValue(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}

const args = process.argv.slice(2)
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
let commit = process.env.GITHUB_SHA || null
if (!commit) {
  try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() } catch (error) { commit = "unknown" }
}
const files = []
for (const root of SOURCE_ROOTS) {
  const dir = join(ROOT, root)
  if (existsSync(dir)) collect(dir, files)
}
const bom = buildSbom({
  name: pkg.name, version: pkg.version, license: pkg.license, commit: commit,
  timestamp: new Date().toISOString(),
  files: files.map(function (file) { return { path: relative(ROOT, file), text: readFileSync(file, "utf8") } }),
})
const rendered = JSON.stringify(bom, null, 2) + "\n"
if (args.indexOf("--stdout") !== -1) {
  process.stdout.write(rendered)
} else {
  const out = resolve(argValue(args, "--out") || join(ROOT, "dist", "agentgate-" + pkg.version + ".cdx.json"))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, rendered)
  process.stdout.write("SBOM: " + out + "（文件 " + bom.components.length + " 个，依赖 " + bom.dependencies[0].dependsOn.length + " 个）\n")
}
