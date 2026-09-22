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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { renderInventoryPage } from "../packages/inventory/src/web.mjs"
import { readLedger, coverageOf } from "../packages/history/src/ledger.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const argOf = function (name, fallback) { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const indexPath = argOf("--index", "data/sample-index.json")
const outDir = argOf("--out", "dist")
const templatePath = argOf("--template", join(ROOT, "site", "evidence.html"))
const diffPath = argOf("--diff", null)
const basePath = argOf("--base-path", "").replace(/\/$/, "")
if (basePath && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(basePath)) throw new Error("invalid --base-path")
function writePage(path, html) {
  // Only static root-relative attributes; external/canonical URLs and embedded JSON stay intact.
  writeFileSync(path, basePath ? html.replace(/\b(href|src|action)=(['"])\/(?!\/)/g, (_, attr, quote) => attr + "=" + quote + basePath + "/") : html)
}
const maxRecords = Number(argOf("--max-records", 20000))
const pagesDir = argOf("--pages", join(ROOT, "site"))
const historyDir = argOf("--history", join(ROOT, "data", "history"))
const indexName = argOf("--name", "evidence.html")
const packDir = argOf("--pack", join(ROOT, "docs", "samples", "evidence-pack-example"))
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
// The coverage block lives on the raw records; the projection above drops it. Count how many of
// the records actually shown are fully measured, because a headline number whose denominator a
// reader cannot see is the kind of claim this page exists to avoid.
const measured = { complete: 0, total: kept.length }
for (const r of kept) {
  const exec = r.scanExecution && r.scanExecution.scanner_execution
  if (exec && exec.state === "complete") measured.complete += 1
}
const measuredPct = measured.total ? (measured.complete / measured.total * 100).toFixed(1) : "0.0"

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

/** HTML-escape a value that came from someone else's registration. */
function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

/** Replace every occurrence. String.replace with a string pattern stops at the first one. */
function putAll(page, placeholder, value) { return page.split(placeholder).join(value) }

/** A stable, filesystem-safe slug for a server name. The name is someone else's string. */
function slugOf(name) { return String(name).split("/").join("__").replace(/[^A-Za-z0-9._-]/g, "_") }

const SERVER_TEMPLATE = join(ROOT, "site", "server.html")
const OWNER_TEMPLATE = join(ROOT, "site", "owner.html")
const HISTORY_TEMPLATE = join(ROOT, "site", "history.html")
const EN_DIR = join(ROOT, "site", "en")
const EN_SERVER_TEMPLATE = join(EN_DIR, "server.html")
const EN_OWNER_TEMPLATE = join(EN_DIR, "owner.html")
const EN_HISTORY_TEMPLATE = join(EN_DIR, "history.html")
const EN_EVIDENCE_TEMPLATE = join(EN_DIR, "evidence.html")

/** The GitHub login a record's repository belongs to, or null. */
function ownerOf(record) {
  const rv = record.repository
  const url = typeof rv === "string" ? rv : (rv && rv.url) || ""
  const m = /^https?:\/\/github\.com\/([^\/]+)\//.exec(url)
  return m ? m[1] : null
}

/** GitHub logins are case-insensitive, so the slug is the lowercased one. */
function ownerSlug(login) { return String(login).toLowerCase().replace(/[^a-z0-9-]/g, "_") }

/**
 * One page per publisher.
 *
 * A vendor with twenty-one servers cannot be read twenty-one pages at a time, and "here is
 * your report" has to be a page somebody can hand to their own customer. Same rules as the
 * server page: the rows are one line per server, and the limits are stated, not implied.
 */
function renderOwner(group, slug, template, index, locale = "zh") {
  const en = locale === "en"
  const verdicts = {}
  const severities = {}
  const ORDER = { incomplete: 0, findings: 1, clean: 2 }
  const rows = group.records.slice().sort(function (a, b) {
    const pa = ORDER[a.verdict] === undefined ? 3 : ORDER[a.verdict]
    const pb = ORDER[b.verdict] === undefined ? 3 : ORDER[b.verdict]
    if (pa !== pb) return pa - pb
    return String(a.server).localeCompare(String(b.server))
  }).map(function (r) {
    verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1
    const findings = []
    for (const key of Object.keys(r.evidence || {})) {
      for (const f of ((r.evidence[key] || {}).findings) || []) {
        findings.push(f)
        severities[f.severity] = (severities[f.severity] || 0) + 1
      }
    }
    const pkgs = (r.packages || []).map(function (p) { return p.name + (p.version ? "@" + p.version : "") }).join(", ") || "—"
    const notable = findings.filter(function (f) { return f.severity !== "info" }).length
    return '<tr><td><a href="' + (en ? "/en/s/" : "/s/") + slugOf(r.server) + '.html">' + esc(r.server) + "</a></td>"
      + '<td><span class="verdict ' + esc(r.verdict) + '">' + esc(r.verdict) + "</span></td>"
      + '<td class="muted">' + esc(pkgs) + "</td>"
      + '<td class="muted">' + findings.length + (en ? " finding(s)" + (notable ? ", " + notable + " above info" : "") : " 条" + (notable ? ",其中 " + notable + " 条非 info" : "")) + "</td></tr>"
  }).join("\n")
  const shown = ["clean", "findings", "incomplete", "unknown"].filter(function (v) { return verdicts[v] })
    .map(function (v) { return '<span class="verdict ' + v + '">' + v + " " + verdicts[v] + "</span>" })
  const sev = ["critical", "high", "medium", "low", "info"].filter(function (s) { return severities[s] })
    .map(function (s) { return s + " " + severities[s] })
  let page = template
  page = putAll(page, "__SLUG__", esc(slug))
  page = putAll(page, "__OWNER__", esc(group.display))
  page = putAll(page, "__COUNT__", String(group.records.length))
  page = putAll(page, "__GENERATED__", esc(index.generatedAt || "-"))
  page = putAll(page, "__VERDICTS__", shown.join(" ") + (sev.length ? ' <span class="muted">' + (en ? "Findings " : "发现 ") + sev.join(" / ") + "</span>" : ""))
  page = putAll(page, "__ROWS__", rows)
  return page
}

/**
 * One page per server, so a single record can be linked to and read on its own.
 *
 * The order of the substitutions matters: the block tables are built from escaped text that
 * may itself contain a placeholder-looking string, so they go in last, after every scalar.
 */
function renderServer(record, slug, template, index, locale = "zh") {
  const en = locale === "en"
  const t = function (zh, english) { return en ? english : zh }
  const ev = record.evidence || {}
  const blocks = []
  const unmeasured = []
  for (const key of Object.keys(ev)) {
    const b = ev[key] || {}
    const findings = b.findings || []
    const rows = findings.map(function (f) {
      const where = f.file ? esc(f.file) + (f.line ? ":" + esc(f.line) : "") : ""
      return "<tr><td>" + esc(f.rule) + '</td><td class="sev">' + esc(f.severity) + "</td><td>" + where + "</td><td>" + esc(f.message || f.evidence || "") + "</td></tr>"
    }).join("")
    const body = findings.length
      ? "<table><tr><th>" + t("规则", "Rule") + "</th><th>" + t("级别", "Severity") + "</th><th>" + t("位置", "Location") + "</th><th>" + t("说明", "Description") + "</th></tr>" + rows + "</table>"
      : '<p class="muted">' + t("这一块没有产生发现。", "This block produced no findings.") + "</p>"
    const html = "<h2>" + esc(key) + '</h2><p class="muted">status=' + esc(b.status) + " · source=" + esc(b.source || "-") + (b.reason ? " · reason=" + esc(b.reason) : "") + "</p>" + body
    if (b.status === "findings" || b.status === "clean") blocks.push(html)
    else unmeasured.push(html)
  }
  const pkgs = (record.packages || []).map(function (p) { return esc(p.name) + (p.version ? "@" + esc(p.version) : "") + " (" + esc(p.registry || "?") + ")" }).join(", ")
  const rv = record.repository
  // A registry entry can carry "repository": {}, which is truthy and names nothing. Rendering
  // it printed "仓库: [object Object]" on fifty-four published pages, because String({}) is a
  // string and nothing about that fails until a person opens the page.
  const repoUrl = typeof rv === "string" ? rv : (rv && typeof rv === "object" && typeof rv.url === "string" ? rv.url : null)
  const repo = repoUrl ? esc(repoUrl) : t("(注册表条目里没有可用的仓库地址)", "(no usable repository URL in the registry record)")
  const name = String(record.server)
  const meta = '<div class="box"><p class="muted">' + t("包:", "Packages: ") + (pkgs || t("(无)", "(none)")) + "<br>" + t("仓库:", "Repository: ") + repo + "</p></div>"
  const owner = ownerOf(record)
  const ownerLink = owner ? '<p class="muted">' + t("发布方:", "Publisher: ") + '<a href="' + (en ? "/en/o/" : "/o/") + esc(ownerSlug(owner)) + '.html">' + esc(owner) + "</a></p>" : ""
  let page = template
  page = putAll(page, "__SLUG__", esc(slug))
  page = putAll(page, "__SERVER__", esc(name))
  page = putAll(page, "__VERDICT__", esc(record.verdict || "unknown"))
  page = putAll(page, "__THRESHOLD__", esc(index.threshold || "-"))
  page = putAll(page, "__GENERATED__", esc(record.generatedAt || index.generatedAt || "-"))
  page = putAll(page, "__API__", esc("https://xn--5kvo87g.com/v1/servers/" + encodeURIComponent(name)))
  page = putAll(page, "__BADGE__", esc("https://xn--5kvo87g.com/badge/" + encodeURIComponent(name) + ".svg"))
  page = putAll(page, "__OWNERLINK__", ownerLink)
  page = putAll(page, "__META__", meta)
  page = putAll(page, "__UNMEASURED__", unmeasured.length
    ? '<h2>' + t("没测到的部分", "Unmeasured work") + '</h2><div class="box warn">' + unmeasured.join("\n") + "</div>"
    : '<h2>' + t("没测到的部分", "Unmeasured work") + '</h2><div class="box"><p class="muted">' + t("这条记录里没有 unmeasured 的块。", "This record has no unmeasured blocks.") + "</p></div>")
  // Coverage as its own section: which scanners were required, which finished, and why the rest
  // did not. A record written before this block existed says so instead of implying it is complete.
  const execution = record.scanExecution && record.scanExecution.scanner_execution
  let executionHtml
  if (execution) {
    const rows = (execution.components || []).map(function (c) {
      return "<tr><td>" + esc(c.id) + "</td><td>" + (c.required ? t("必需", "Required") : t("可选", "Optional")) + '</td><td class="sev">' + esc(c.status) + "</td><td>" +
        (c.output_present ? t("有", "Present") : t("无", "Absent")) + " / " + (c.output_parseable ? t("可读", "parseable") : t("不可读", "not parseable")) + "</td><td>" + esc(c.semantic_consistency) + "</td><td>" + esc(c.reason || "") + "</td></tr>"
    }).join("")
    executionHtml = '<h2>' + t("哪些扫描器跑完了", "Scan coverage") + '</h2><div class="box' + (execution.state === "complete" ? "" : " warn") + '">' +
      "<p>" + t("状态:", "State: ") + "<b>" + esc(execution.state) + "</b> · " + t("必需 ", "required ") + esc(execution.required) + t(" 个,跑完 ", ", completed ") + esc(execution.completed) + t(" 个,没跑成 ", ", failed ") + esc(execution.failed) + (en ? "" : " 个") + "</p>" +
      (rows ? "<table><tr><th>" + t("扫描器", "Scanner") + "</th><th>" + t("是否必需", "Required") + "</th><th>" + t("状态", "Status") + "</th><th>" + t("输出", "Output") + "</th><th>" + t("一致性", "Consistency") + "</th><th>" + t("原因", "Reason") + "</th></tr>" + rows + "</table>"
        : '<p class="muted">' + t("这条记录没有列出任何扫描器,所以它不可能被算作完整。", "No scanners are listed, so this record cannot be treated as complete.") + "</p>") + "</div>"
  } else {
    executionHtml = '<h2>' + t("哪些扫描器跑完了", "Scan coverage") + '</h2><div class="box"><p class="muted">' + t("这条记录写于 scan-execution 之前,没有这一块。没有记录不等于跑完过。", "This record predates scan-execution and has no coverage block. Missing records do not mean the scanners completed.") + "</p></div>"
  }
  page = putAll(page, "__EXECUTION__", executionHtml)
  page = putAll(page, "__BLOCKS__", blocks.join("\n"))
  return page
}

const data = jsonForScript(records)
const boundDiff = argOf("--diff-index-sha256", null) === createHash("sha256").update(readFileSync(indexPath)).digest("hex")
const diffText = boundDiff && index.snapshot !== true && index.sample !== true && diffPath && existsSync(diffPath) ? readFileSync(diffPath, "utf8") : ""
if (diffPath && !diffText) console.warn("diff omitted: supply --diff-index-sha256 for this exact non-sample index")
let page = readFileSync(templatePath, "utf8")
page = put(page, "__INDEX_NOTICE__", index.snapshot === true || index.sample === true
  ? "历史样本：只供演示，不能作为当前检查证据。"
  : "检查只覆盖列出的材料；请核对生成时间，定时刷新不保证成功。")
page = put(page, "__DATA__", data)
page = put(page, "window.__GENERATED_AT__", jsonForScript(index.generatedAt || "unknown"))
page = put(page, "__DIFFJSON__", jsonForScript(diffText))
page = put(page, "__TOTAL__", jsonForScript(all.length))
page = put(page, "__SHOWN__", jsonForScript(records.length))
page = put(page, "__TRUNCATED__", jsonForScript(truncated))
// The index carries two kinds of record and they are not comparable: registry entries are servers
// somebody registered, repository records are public repositories we only read metadata for. The
// page says both numbers instead of one percentage over the sum, because the sum would flatter the
// second kind -- and the second kind can never be clean by construction.
const repoRecords = all.filter(function (r) { return String(r.server || "").indexOf("github.com/") === 0 })
const registryRecords = all.filter(function (r) { return String(r.server || "").indexOf("github.com/") !== 0 })
const registryCounts = {}
for (const r of registryRecords) registryCounts[r.verdict] = (registryCounts[r.verdict] || 0) + 1
page = put(page, "window.__COUNTS__", jsonForScript(
    '注册表条目 ' + registryRecords.length + ": <span class=\"v clean\">clean " + (registryCounts.clean || 0) + '</span> · <span class="v findings">findings ' + (registryCounts.findings || 0) + '</span> · <span class="v incomplete">incomplete ' + (registryCounts.incomplete || 0) + '</span>' +
    (repoRecords.length > 0 ? ' ｜ 仓库记录 ' + repoRecords.length + ' 条(只读公开元数据,按设计不可能是 clean)' : '') +
    ' · 完全测过 ' + measured.complete + "/" + measured.total + " (" + measuredPct + "%)"
  ))

mkdirSync(outDir, { recursive: true })
writePage(join(outDir, indexName), page)

// Build the English evidence index from the same record projection and timestamps. Keeping one
// data path matters more than keeping one template: two independently prepared indexes would
// eventually disagree about what was measured.
if (existsSync(EN_EVIDENCE_TEMPLATE)) {
  let enPage = readFileSync(EN_EVIDENCE_TEMPLATE, "utf8")
  enPage = put(enPage, "__INDEX_NOTICE__", index.snapshot === true || index.sample === true
    ? "Historical sample: demonstration only; it is not current inspection evidence."
    : "Inspection covers only the listed material. Check the generation time; a scheduled refresh is not proof that every refresh succeeded.")
  enPage = put(enPage, "__DATA__", data)
  enPage = put(enPage, "window.__GENERATED_AT__", jsonForScript(index.generatedAt || "unknown"))
  enPage = put(enPage, "__DIFFJSON__", jsonForScript(diffText))
  enPage = put(enPage, "__TOTAL__", jsonForScript(all.length))
  enPage = put(enPage, "__SHOWN__", jsonForScript(records.length))
  enPage = put(enPage, "__TRUNCATED__", jsonForScript(truncated))
  enPage = put(enPage, "window.__COUNTS__", jsonForScript(
    "Registry records " + registryRecords.length + ": <span class=\"v clean\">clean " + (registryCounts.clean || 0) + '</span> · <span class="v findings">findings ' + (registryCounts.findings || 0) + '</span> · <span class="v incomplete">incomplete ' + (registryCounts.incomplete || 0) + "</span>" +
    (repoRecords.length > 0 ? " ｜ Repository records " + repoRecords.length + " (read-only public metadata; clean is impossible by design)" : "") +
    " · Fully measured " + measured.complete + "/" + measured.total + " (" + measuredPct + "%)"
  ))
  mkdirSync(join(outDir, "en"), { recursive: true })
  writePage(join(outDir, "en", "evidence.html"), enPage)
}

// The marketing pages are plain files, copied in rather than generated. Without this the
// site was only the data table, which is not what a visitor should land on.
let copied = 0
if (pagesDir && existsSync(pagesDir)) {
  for (const name of readdirSync(pagesDir)) {
    // the plain pages plus the small assets a real site needs (favicon, robots, sitemap, 404)
    if (!/\.[a-z0-9]+$/.test(name)) continue
    if (name === "evidence.html" || name === "server.html" || name === "owner.html" || name === "inventory.html" || name === "history.html") continue
    const target = name === "index.html" ? "index.html" : name
    if (target === indexName) continue
    if (name.endsWith(".html")) writePage(join(outDir, target), readFileSync(join(pagesDir, name), "utf8"))
    else copyFileSync(join(pagesDir, name), join(outDir, target))
    copied += 1
  }
  // /.well-known/security.txt has to land at the path the RFC names, and the page loop above
  // only copies files at the top level: a directory is skipped without this.
  const wellKnown = join(pagesDir, ".well-known")
  if (existsSync(wellKnown)) {
    mkdirSync(join(outDir, ".well-known"), { recursive: true })
    for (const name of readdirSync(wellKnown)) {
      if (!/\.[a-z0-9]+$/.test(name)) continue
      copyFileSync(join(wellKnown, name), join(outDir, ".well-known", name))
      copied += 1
    }
  }
  if (existsSync(EN_DIR)) {
    const enOut = join(outDir, "en")
    mkdirSync(enOut, { recursive: true })
    for (const name of readdirSync(EN_DIR)) {
      if (!/\.[a-z0-9]+$/.test(name)) continue
      if (["evidence.html", "server.html", "owner.html", "inventory.html", "history.html"].includes(name)) continue
      if (name.endsWith(".html")) writePage(join(enOut, name), readFileSync(join(EN_DIR, name), "utf8"))
      else copyFileSync(join(EN_DIR, name), join(enOut, name))
      copied += 1
    }
  }
}
// The evidence pack is published exactly as it was generated, under the same file names: the
// manifest lists a sha256 per file, and renaming one would break the only property the pack
// exists to have. So it is copied byte for byte rather than regenerated for the site.
let packFiles = 0
if (packDir && existsSync(packDir)) {
  mkdirSync(join(outDir, "pack"), { recursive: true })
  for (const name of readdirSync(packDir)) {
    if (!/\.(html|json|md|txt|sha256)$/.test(name)) continue
    copyFileSync(join(packDir, name), join(outDir, "pack", name))
    packFiles += 1
  }
}
// The personal inventory never leaves the browser. Ship the public snapshot and the same
// matching/report modules used by the offline CLI, not a name-querying upload endpoint.
/** Remove the pages this build no longer produces.
 *
 * The record set moves every day: a server leaves the registry, or is renamed and gets a new
 * slug. Without this, the page for the old name stays reachable and says the site was rebuilt
 * today, and the sitemap no longer mentions it -- an evidence page nobody links to and nobody
 * can tell is stale. Only *.html inside the two directories this script owns is removed:
 * /var/www/zhiliang also holds another site's releases/ and the hand-written root pages,
 * and none of that is this script's to delete.
 */
function prunePages(dir, keep) {
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".html")) continue
    if (keep.has(name.slice(0, -".html".length))) continue
    rmSync(join(dir, name), { force: true })
    removed += 1
  }
  return removed
}

const inventoryTemplate = join(ROOT, "site", "inventory.html")
if (existsSync(inventoryTemplate)) {
  const inventoryIndex = { ...index, records: kept, count: kept.length, total: all.length, truncated }
  writePage(join(outDir, "inventory.html"), renderInventoryPage(readFileSync(inventoryTemplate, "utf8"), inventoryIndex))
  copyFileSync(join(ROOT, "site", "inventory-page.mjs"), join(outDir, "inventory-page.mjs"))
  copyFileSync(join(ROOT, "packages", "inventory", "src", "inventory.mjs"), join(outDir, "inventory.mjs"))
  copyFileSync(join(ROOT, "packages", "inventory", "src", "report.mjs"), join(outDir, "inventory-report.mjs"))
  const enInventoryTemplate = join(EN_DIR, "inventory.html")
  if (existsSync(enInventoryTemplate)) {
    mkdirSync(join(outDir, "en"), { recursive: true })
    writePage(join(outDir, "en", "inventory.html"), renderInventoryPage(readFileSync(enInventoryTemplate, "utf8"), inventoryIndex))
  }
}
if (existsSync(SERVER_TEMPLATE)) {
  const serverTpl = readFileSync(SERVER_TEMPLATE, "utf8")
  const dir = join(outDir, "s")
  const enServerTpl = existsSync(EN_SERVER_TEMPLATE) ? readFileSync(EN_SERVER_TEMPLATE, "utf8") : null
  const enDir = join(outDir, "en", "s")
  mkdirSync(dir, { recursive: true })
  if (enServerTpl) mkdirSync(enDir, { recursive: true })
  const bySlug = new Map()
  for (const r of all) {
    const slug = slugOf(r.server)
    if (bySlug.has(slug)) { console.error("slug collision: " + r.server + " vs " + bySlug.get(slug)); process.exit(2) }
    bySlug.set(slug, r.server)
    writePage(join(dir, slug + ".html"), renderServer(r, slug, serverTpl, index))
    if (enServerTpl) writePage(join(enDir, slug + ".html"), renderServer(r, slug, enServerTpl, index, "en"))
  }
  const stale = prunePages(dir, new Set(bySlug.keys()))
  if (enServerTpl) prunePages(enDir, new Set(bySlug.keys()))
  console.log("wrote " + bySlug.size + " per-server page(s) into " + dir + (stale > 0 ? " and removed " + stale + " that are no longer in the index" : ""))
}
if (existsSync(OWNER_TEMPLATE)) {
  const ownerTpl = readFileSync(OWNER_TEMPLATE, "utf8")
  const enOwnerTpl = existsSync(EN_OWNER_TEMPLATE) ? readFileSync(EN_OWNER_TEMPLATE, "utf8") : null
  const groups = new Map()
  for (const r of all) {
    const owner = ownerOf(r)
    if (!owner) continue
    const key = ownerSlug(owner)
    if (!groups.has(key)) groups.set(key, { display: owner, records: [] })
    groups.get(key).records.push(r)
  }
  const dir = join(outDir, "o")
  const enDir = join(outDir, "en", "o")
  mkdirSync(dir, { recursive: true })
  if (enOwnerTpl) mkdirSync(enDir, { recursive: true })
  for (const [key, group] of groups) {
    writePage(join(dir, key + ".html"), renderOwner(group, key, ownerTpl, index))
    if (enOwnerTpl) writePage(join(enDir, key + ".html"), renderOwner(group, key, enOwnerTpl, index, "en"))
  }
  const stale = prunePages(dir, new Set(groups.keys()))
  if (enOwnerTpl) prunePages(enDir, new Set(groups.keys()))
  console.log("wrote " + groups.size + " publisher page(s) into " + dir + (stale > 0 ? " and removed " + stale + " that no longer publish anything in the index" : ""))
}

// The capture ledger, published. Its whole point is that someone who does not trust us can check
// it, so the page carries the ledger text itself rather than a summary of it: editing the file on
// the server afterwards contradicts a copy that is already published.
if (existsSync(HISTORY_TEMPLATE)) {
  const entries = readLedger(historyDir)
  const coverage = coverageOf(entries)
  const rows = entries.slice().reverse().map(function (e) {
    return "<tr><td>" + esc(e.capturedAt) + '</td><td class="num">' + e.records
      + '</td><td class="num">' + ((e.counts && e.counts.clean) || 0)
      + '</td><td class="num">' + ((e.counts && e.counts.findings) || 0)
      + '</td><td class="num">' + ((e.counts && e.counts.incomplete) || 0)
      + "</td><td>" + esc(e.scanner || "(未记录)") + "</td><td>" + esc(String(e.sha256 || "").slice(0, 16)) + "</td></tr>"
  }).join("\n")
  // A build without a ledger (the public mirror, built outside the deployment) says so rather
  // than printing "0 captures", which would read as "nothing was ever captured".
  const gaps = entries.length === 0
    ? "这个构建没有携带采集账本；账本在部署实例上。"
    : coverage.gaps.length === 0
      ? "没有缺天。"
      : coverage.gaps.length + " 天没有采集：" + coverage.gaps.join("、")
  const ledgerPath = join(historyDir, "ledger.jsonl")
  const ledgerText = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim() : ""
  let historyPage = readFileSync(HISTORY_TEMPLATE, "utf8")
  historyPage = put(historyPage, "__ROWS__", rows)
  historyPage = put(historyPage, "__FIRST__", esc(coverage.first || "（还没有采集）"))
  historyPage = put(historyPage, "__LAST__", esc(coverage.last || "（还没有采集）"))
  historyPage = put(historyPage, "__CAPTURES__", String(coverage.captures))
  historyPage = put(historyPage, "__DAYS__", String(coverage.days))
  historyPage = put(historyPage, "__GAPS__", esc(gaps))
  historyPage = put(historyPage, "__LEDGER__", esc(ledgerText))
  historyPage = put(historyPage, "__GENERATED__", esc(new Date().toISOString()))
  writePage(join(outDir, "history.html"), historyPage)
  if (existsSync(EN_HISTORY_TEMPLATE)) {
    const enRows = entries.slice().reverse().map(function (e) {
      return "<tr><td>" + esc(e.capturedAt) + '</td><td class="num">' + e.records
        + '</td><td class="num">' + ((e.counts && e.counts.clean) || 0)
        + '</td><td class="num">' + ((e.counts && e.counts.findings) || 0)
        + '</td><td class="num">' + ((e.counts && e.counts.incomplete) || 0)
        + "</td><td>" + esc(e.scanner || "(not recorded)") + "</td><td>" + esc(String(e.sha256 || "").slice(0, 16)) + "</td></tr>"
    }).join("\n")
    const enGaps = entries.length === 0
      ? "This build does not include the capture ledger; the deployment instance retains it."
      : coverage.gaps.length === 0 ? "No missing days." : coverage.gaps.length + " day(s) without a capture: " + coverage.gaps.join(", ")
    let enHistoryPage = readFileSync(EN_HISTORY_TEMPLATE, "utf8")
    enHistoryPage = put(enHistoryPage, "__ROWS__", enRows)
    enHistoryPage = put(enHistoryPage, "__FIRST__", esc(coverage.first || "no captures yet"))
    enHistoryPage = put(enHistoryPage, "__LAST__", esc(coverage.last || "no captures yet"))
    enHistoryPage = put(enHistoryPage, "__CAPTURES__", String(coverage.captures))
    enHistoryPage = put(enHistoryPage, "__DAYS__", String(coverage.days))
    enHistoryPage = put(enHistoryPage, "__GAPS__", esc(enGaps))
    enHistoryPage = put(enHistoryPage, "__LEDGER__", esc(ledgerText))
    enHistoryPage = put(enHistoryPage, "__GENERATED__", esc(new Date().toISOString()))
    mkdirSync(join(outDir, "en"), { recursive: true })
    writePage(join(outDir, "en", "history.html"), enHistoryPage)
  }
  console.log("wrote history.html with " + coverage.captures + " capture(s) over " + coverage.days + " day(s)")
}

// Every server page belongs in the sitemap, otherwise the only way to reach a record is to
// already know its URL. A sitemap holds 50,000 URLs, so past that it has to become an index,
// and the main pages are carried over from the plain sitemap so there is still one source
// for them rather than two lists that drift.
if (existsSync(SERVER_TEMPLATE)) {
  const base = "https://xn--5kvo87g.com"
  const main = (readFileSync(join(ROOT, "site", "sitemap.xml"), "utf8").match(/<url>[\s\S]*?<\/url>/g) || [])
  const serverUrls = all.map(function (r) {
    return "<url><loc>" + esc(base + "/s/" + slugOf(r.server) + ".html") + "</loc><priority>0.4</priority></url>"
  })
  const enServerUrls = existsSync(EN_SERVER_TEMPLATE) ? all.map(function (r) {
    return "<url><loc>" + esc(base + "/en/s/" + slugOf(r.server) + ".html") + "</loc><priority>0.4</priority></url>"
  }) : []
  const ownerKeys = new Set()
  for (const r of all) { const o = ownerOf(r); if (o) ownerKeys.add(ownerSlug(o)) }
  const ownerUrls = Array.from(ownerKeys).map(function (k) {
    return "<url><loc>" + esc(base + "/o/" + k + ".html") + "</loc><priority>0.5</priority></url>"
  })
  const enOwnerUrls = existsSync(EN_OWNER_TEMPLATE) ? Array.from(ownerKeys).map(function (k) {
    return "<url><loc>" + esc(base + "/en/o/" + k + ".html") + "</loc><priority>0.5</priority></url>"
  }) : []
  const top = main.concat(ownerUrls, enOwnerUrls)
  const head = '<?xml version="1.0" encoding="UTF-8"?>'
  const urlset = function (urls) {
    return head + '\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.map(function (u) { return "  " + u }).join("\n") + "\n</urlset>\n"
  }
  const LIMIT = 45000
  const recordUrls = serverUrls.concat(enServerUrls)
  if (top.length + recordUrls.length <= LIMIT) {
    writeFileSync(join(outDir, "sitemap.xml"), urlset(top.concat(recordUrls)))
  } else {
    const files = []
    for (let i = 0; i < recordUrls.length; i += LIMIT) {
      const name = "sitemap-servers-" + (files.length + 1) + ".xml"
      writeFileSync(join(outDir, name), urlset(recordUrls.slice(i, i + LIMIT)))
      files.push(name)
    }
    writeFileSync(join(outDir, "sitemap-main.xml"), urlset(top))
    files.unshift("sitemap-main.xml")
    writeFileSync(join(outDir, "sitemap.xml"), head + '\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + files.map(function (f) { return "  <sitemap><loc>" + base + "/" + f + "</loc></sitemap>" }).join("\n") + "\n</sitemapindex>\n")
  }
  console.log("sitemap: " + (top.length + recordUrls.length) + " url(s)")
}
writeFileSync(join(outDir, ".nojekyll"), "")
console.log("site written to " + join(outDir, indexName) + " (" + Math.round(page.length / 1024) + " KB, " + records.length + " records" + (diffText ? ", with a diff" : "") + ") and " + copied + " page(s) copied" + (packFiles > 0 ? " and " + packFiles + " pack file(s)" : ""))
