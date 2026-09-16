#!/usr/bin/env node
/**
 * Inject the index into the static page.
 *
 * The page is a real file, not a string built here. Building HTML by concatenating
 * strings in JavaScript is how a stray double quote turns into a syntax error at the
 * worst moment; this script only replaces one placeholder.
 *
 *   node scripts/build-site.mjs --index data/index.json --out dist
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const argOf = function (name, fallback) { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const indexPath = argOf("--index", "data/sample-index.json")
const outDir = argOf("--out", "dist")
const templatePath = argOf("--template", join(ROOT, "site", "evidence.html"))
const diffPath = argOf("--diff", null)
const maxRecords = Number(argOf("--max-records", 20000))
const pagesDir = argOf("--pages", join(ROOT, "site"))
const indexName = argOf("--name", "evidence.html")
if (!existsSync(indexPath)) { console.error("no index at " + indexPath); process.exit(2) }
if (!existsSync(templatePath)) { console.error("no template at " + templatePath); process.exit(2) }

const index = JSON.parse(readFileSync(indexPath, "utf8"))
// The page embeds its records, so its size grows with the index: 2,000 records is half a
// megabyte, 50,000 is fifteen, 200,000 is sixty. A sixty-megabyte page is not a page. The
// cap keeps the ones worth looking at first and the page states what was left out, because
// a silently truncated view is the same failure this project keeps arguing against.
const PRIORITY = { incomplete: 0, findings: 1, clean: 2 }
const all = index.records || []
const ordered = all.slice().sort(function (a, b) {
  const pa = PRIORITY[a.verdict] === undefined ? 3 : PRIORITY[a.verdict]
  const pb = PRIORITY[b.verdict] === undefined ? 3 : PRIORITY[b.verdict]
  if (pa !== pb) return pa - pb
  return String(a.server).localeCompare(String(b.server))
})
const kept = ordered.slice(0, maxRecords)
const truncated = all.length > kept.length
const records = kept.map(function (r) {
  return {
    server: r.server,
    verdict: r.verdict,
    packages: (r.packages || []).map(function (p) { return p.name + (p.version ? "@" + p.version : " (unpinned)") }),
    evidence: Object.keys(r.evidence || {}).map(function (k) {
      const b = r.evidence[k] || {}
      return {
        block: k,
        status: b.status,
        source: b.source,
        reason: b.reason || null,
        findings: (b.findings || []).map(function (f) { return { rule: f.rule, severity: f.severity, message: f.message || f.evidence || "", file: f.file || null } }),
      }
    }),
  }
})
const counts = { clean: 0, findings: 0, incomplete: 0 }
for (const r of records) counts[r.verdict] = (counts[r.verdict] || 0) + 1

/**
 * Substitute a placeholder with literal text.
 *
 * String.replace() gives a string replacement three special dollar forms: the matched
 * text, the text after the match, and the text before it. A registry entry whose name
 * contains one of those splices the rest of the template -- including a literal
 * </script> -- into the middle of the embedded JSON and closes the block early. A function
 * replacement has no such syntax, so the data is text here and never a pattern.
 *
 * The names come from other people\u0027s registrations. They are treated accordingly.
 */
function put(page, placeholder, value) { return page.replace(placeholder, function () { return value }) }

/** JSON destined for a <script> block: "<" must not survive, or a value containing
 *  "</script>" ends the block and everything after it is parsed as HTML. */
function jsonForScript(value) { return JSON.stringify(value).replace(/</g, "\\u003c") }

const data = jsonForScript(records)
const diffText = diffPath && existsSync(diffPath) ? readFileSync(diffPath, "utf8") : ""
let page = readFileSync(templatePath, "utf8")
page = put(page, "__DATA__", data)
page = put(page, "window.__GENERATED_AT__", jsonForScript(index.generatedAt || "unknown"))
page = put(page, "__DIFFJSON__", jsonForScript(diffText))
page = put(page, "__TOTAL__", jsonForScript(all.length))
page = put(page, "__SHOWN__", jsonForScript(records.length))
page = put(page, "__TRUNCATED__", jsonForScript(truncated))
page = put(page, "window.__COUNTS__", jsonForScript(
    '<span class="v clean">clean ' + (counts.clean || 0) + '</span> · <span class="v findings">findings ' + (counts.findings || 0) + '</span> · <span class="v incomplete">incomplete ' + (counts.incomplete || 0) + "</span>"
  ))

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, indexName), page)

// The marketing pages are plain files, copied in rather than generated. Without this the
// site was only the data table, which is not what a visitor should land on.
let copied = 0
if (pagesDir && existsSync(pagesDir)) {
  for (const name of readdirSync(pagesDir)) {
    // the plain pages plus the small assets a real site needs (favicon, robots, sitemap, 404)
    if (!/\.[a-z0-9]+$/.test(name)) continue
    if (name === "evidence.html") continue
    const target = name === "index.html" ? "index.html" : name
    if (target === indexName) continue
    copyFileSync(join(pagesDir, name), join(outDir, target))
    copied += 1
  }
}
writeFileSync(join(outDir, ".nojekyll"), "")
console.log("site written to " + join(outDir, indexName) + " (" + Math.round(page.length / 1024) + " KB, " + records.length + " records" + (diffText ? ", with a diff" : "") + ") and " + copied + " page(s) copied")
