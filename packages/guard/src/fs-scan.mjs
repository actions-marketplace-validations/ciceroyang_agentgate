import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

const DEFAULT_SKIP = [".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__", ".next", "target"]

/**
 * Reads a file as text, and refuses to be the reason a machine runs out of memory.
 *
 * This scanner is pointed at repositories it does not control, and a repository may contain a
 * generated bundle far larger than any source file. Reading one is not a correctness problem --
 * but the failure has to be loud. It throws, the check it happened in fails, and the scan
 * reports "incomplete" with the file named, which is the same answer as any other unreadable
 * input. Silently skipping it would report "clean" about something that was never read.
 */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

export function makeReader(options) {
  const maxBytes = (options && options.maxBytes) || DEFAULT_MAX_BYTES
  return function readText(abs) {
    let size = null
    try { size = statSync(abs).size } catch (error) { size = null }
    if (size !== null && size > maxBytes) {
      throw new Error("refusing to read " + abs + ": " + size + " bytes is over the " + maxBytes + " byte limit")
    }
    return readFileSync(abs, "utf8")
  }
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
