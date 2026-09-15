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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const argOf = function (name, fallback) { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const indexPath = argOf("--index", "data/sample-index.json")
const outDir = argOf("--out", "dist")
const templatePath = argOf("--template", join(ROOT, "site", "evidence.html"))
const diffPath = argOf("--diff", null)
if (!existsSync(indexPath)) { console.error("no index at " + indexPath); process.exit(2) }
if (!existsSync(templatePath)) { console.error("no template at " + templatePath); process.exit(2) }

const index = JSON.parse(readFileSync(indexPath, "utf8"))
const records = (index.records || []).map(function (r) {
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

const data = JSON.stringify(records).replace(/</g, "\\u003c")
const diffText = diffPath && existsSync(diffPath) ? readFileSync(diffPath, "utf8") : ""
const page = readFileSync(templatePath, "utf8")
  .replace("__DATA__", data)
  .replace('window.__GENERATED_AT__', JSON.stringify(index.generatedAt || "unknown"))
  .replace('__DIFFJSON__', JSON.stringify(diffText))
  .replace('window.__COUNTS__', JSON.stringify(
    '<span class="v clean">clean ' + (counts.clean || 0) + '</span> · <span class="v findings">findings ' + (counts.findings || 0) + '</span> · <span class="v incomplete">incomplete ' + (counts.incomplete || 0) + "</span>"
  ))

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, "index.html"), page)
writeFileSync(join(outDir, ".nojekyll"), "")
console.log("site written to " + join(outDir, "index.html") + " (" + Math.round(page.length / 1024) + " KB, " + records.length + " records" + (diffText ? ", with a diff" : "") + ")")
