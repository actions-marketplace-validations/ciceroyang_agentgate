import { readFileSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"

const DEFAULT_SKIP = [".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__", ".next", "target"]

export function makeReader() {
  return function readText(abs) { return readFileSync(abs, "utf8") }
}

export function walk(root, options) {
  const opts = options || {}
  const exts = opts.exts || null
  const skip = new Set(opts.skipDirs || DEFAULT_SKIP)
  const maxFiles = opts.maxFiles || 2000
  const out = []
  const rec = function (dir) {
    if (out.length >= maxFiles) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (error) { return }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) { if (!skip.has(entry.name)) rec(abs); continue }
      if (!entry.isFile()) continue
      if (exts && !exts.some(function (x) { return entry.name.endsWith(x) })) continue
      out.push({ abs: abs, rel: relative(root, abs).split(sep).join("/") })
    }
  }
  rec(root)
  return out
}
