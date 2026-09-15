import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The documentation is the product's front door, and a link to a file that was renamed or
 * consolidated away is invisible until a stranger clicks it. One was: the licence section of
 * the README pointed at docs/product/b2b.md, which no longer existed.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function markdownFiles(dir, out) {
  out = out || []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) markdownFiles(p, out)
    else if (name.endsWith(".md")) out.push(p)
  }
  return out
}

test("every relative link in the documentation resolves", function () {
  const broken = []
  for (const file of markdownFiles(ROOT)) {
    const text = readFileSync(file, "utf8")
    for (const m of text.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
      const target = m[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      if (target.startsWith("//")) continue
      if (!existsSync(resolve(dirname(file), target))) {
        broken.push(file.slice(ROOT.length + 1) + " -> " + target)
      }
    }
  }
  assert.deepEqual(broken, [], "the documentation links to files that are not there")
})
