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
import { renderInventoryPage } from "../packages/inventory/src/web.mjs"
import { readLedger, coverageOf } from "../packages/history/src/ledger.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const argOf = function (name, fallback) { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const indexPath = argOf("--index", "data/sample-index.json")
const outDir = argOf("--out", "dist")
const templatePath = argOf("--template", join(ROOT, "site", "evidence.html"))
const diffPath = argOf("--diff", null)
const maxRecords = Number(argOf("--max-records", 20000))
const pagesDir = argOf("--pages", join(ROOT, "site"))
const historyDir = argOf("--history", join(ROOT, "data", "history"))
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
function renderOwner(group, slug, template, index) {
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
    return '<tr><td><a href="/s/' + slugOf(r.server) + '.html">' + esc(r.server) + "</a></td>"
      + '<td><span class="verdict ' + esc(r.verdict) + '">' + esc(r.verdict) + "</span></td>"
      + '<td class="muted">' + esc(pkgs) + "</td>"
      + '<td class="muted">' + findings.length + " 条" + (notable ? ",其中 " + notable + " 条非 info" : "") + "</td></tr>"
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
  page = putAll(page, "__VERDICTS__", shown.join(" ") + (sev.length ? ' <span class="muted">发现 ' + sev.join(" / ") + "</span>" : ""))
  page = putAll(page, "__ROWS__", rows)
  return page
}

/**
 * One page per server, so a single record can be linked to and read on its own.
 *
 * The order of the substitutions matters: the block tables are built from escaped text that
 * may itself contain a placeholder-looking string, so they go in last, after every scalar.
 */
function renderServer(record, slug, template, index) {
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
      ? "<table><tr><th>规则</th><th>级别</th><th>位置</th><th>说明</th></tr>" + rows + "</table>"
      : '<p class="muted">这一块没有产生发现。</p>'
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
  const repo = repoUrl ? esc(repoUrl) : "(注册表条目里没有可用的仓库地址)"
  const name = String(record.server)
  const meta = '<div class="box"><p class="muted">包:' + (pkgs || "(无)") + "<br>仓库:" + repo + "</p></div>"
  const owner = ownerOf(record)
  const ownerLink = owner ? '<p class="muted">发布方:<a href="/o/' + esc(ownerSlug(owner)) + '.html">' + esc(owner) + "</a></p>" : ""
  let page = template
  page = putAll(page, "__SLUG__", esc(slug))
  page = putAll(page, "__SERVER__", esc(name))
  page = putAll(page, "__VERDICT__", esc(record.verdict || "unknown"))
  page = putAll(page, "__THRESHOLD__", esc(index.threshold || "-"))
  page = putAll(page, "__GENERATED__", esc(record.generatedAt || index.generatedAt || "-"))
  page = putAll(page, "__API__", esc("https://app.xn--5kvo87g.com/v1/servers/" + encodeURIComponent(name)))
  page = putAll(page, "__BADGE__", esc("https://app.xn--5kvo87g.com/badge/" + encodeURIComponent(name) + ".svg"))
  page = putAll(page, "__OWNERLINK__", ownerLink)
  page = putAll(page, "__META__", meta)
  page = putAll(page, "__UNMEASURED__", unmeasured.length
    ? '<h2>没测到的部分</h2><div class="box warn">' + unmeasured.join("\n") + "</div>"
    : '<h2>没测到的部分</h2><div class="box"><p class="muted">这条记录里没有 unmeasured 的块。</p></div>')
  // Coverage as its own section: which scanners were required, which finished, and why the rest
  // did not. A record written before this block existed says so instead of implying it is complete.
  const execution = record.scanExecution && record.scanExecution.scanner_execution
  let executionHtml
  if (execution) {
    const rows = (execution.components || []).map(function (c) {
      return "<tr><td>" + esc(c.id) + "</td><td>" + (c.required ? "必需" : "可选") + '</td><td class="sev">' + esc(c.status) + "</td><td>" +
        (c.output_present ? "有" : "无") + " / " + (c.output_parseable ? "可读" : "不可读") + "</td><td>" + esc(c.semantic_consistency) + "</td><td>" + esc(c.reason || "") + "</td></tr>"
    }).join("")
    executionHtml = '<h2>哪些扫描器跑完了</h2><div class="box' + (execution.state === "complete" ? "" : " warn") + '">' +
      "<p>状态:<b>" + esc(execution.state) + "</b> · 必需 " + esc(execution.required) + " 个,跑完 " + esc(execution.completed) + " 个,没跑成 " + esc(execution.failed) + " 个</p>" +
      (rows ? "<table><tr><th>扫描器</th><th>是否必需</th><th>状态</th><th>输出</th><th>一致性</th><th>原因</th></tr>" + rows + "</table>"
        : '<p class="muted">这条记录没有列出任何扫描器,所以它不可能被算作完整。</p>') + "</div>"
  } else {
    executionHtml = '<h2>哪些扫描器跑完了</h2><div class="box"><p class="muted">这条记录写于 scan-execution 之前,没有这一块。没有记录不等于跑完过。</p></div>'
  }
  page = putAll(page, "__EXECUTION__", executionHtml)
  page = putAll(page, "__BLOCKS__", blocks.join("\n"))
  return page
}

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
    if (name === "evidence.html" || name === "server.html" || name === "owner.html" || name === "inventory.html" || name === "history.html") continue
    const target = name === "index.html" ? "index.html" : name
    if (target === indexName) continue
    copyFileSync(join(pagesDir, name), join(outDir, target))
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
  writeFileSync(join(outDir, "inventory.html"), renderInventoryPage(readFileSync(inventoryTemplate, "utf8"), inventoryIndex))
  copyFileSync(join(ROOT, "site", "inventory-page.mjs"), join(outDir, "inventory-page.mjs"))
  copyFileSync(join(ROOT, "packages", "inventory", "src", "inventory.mjs"), join(outDir, "inventory.mjs"))
  copyFileSync(join(ROOT, "packages", "inventory", "src", "report.mjs"), join(outDir, "inventory-report.mjs"))
}
if (existsSync(SERVER_TEMPLATE)) {
  const serverTpl = readFileSync(SERVER_TEMPLATE, "utf8")
  const dir = join(outDir, "s")
  mkdirSync(dir, { recursive: true })
  const bySlug = new Map()
  for (const r of all) {
    const slug = slugOf(r.server)
    if (bySlug.has(slug)) { console.error("slug collision: " + r.server + " vs " + bySlug.get(slug)); process.exit(2) }
    bySlug.set(slug, r.server)
    writeFileSync(join(dir, slug + ".html"), renderServer(r, slug, serverTpl, index))
  }
  const stale = prunePages(dir, new Set(bySlug.keys()))
  console.log("wrote " + bySlug.size + " per-server page(s) into " + dir + (stale > 0 ? " and removed " + stale + " that are no longer in the index" : ""))
}
if (existsSync(OWNER_TEMPLATE)) {
  const ownerTpl = readFileSync(OWNER_TEMPLATE, "utf8")
  const groups = new Map()
  for (const r of all) {
    const owner = ownerOf(r)
    if (!owner) continue
    const key = ownerSlug(owner)
    if (!groups.has(key)) groups.set(key, { display: owner, records: [] })
    groups.get(key).records.push(r)
  }
  const dir = join(outDir, "o")
  mkdirSync(dir, { recursive: true })
  for (const [key, group] of groups) {
    writeFileSync(join(dir, key + ".html"), renderOwner(group, key, ownerTpl, index))
  }
  const stale = prunePages(dir, new Set(groups.keys()))
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
  writeFileSync(join(outDir, "history.html"), historyPage)
  console.log("wrote history.html with " + coverage.captures + " capture(s) over " + coverage.days + " day(s)")
}

// Every server page belongs in the sitemap, otherwise the only way to reach a record is to
// already know its URL. A sitemap holds 50,000 URLs, so past that it has to become an index,
// and the main pages are carried over from the plain sitemap so there is still one source
// for them rather than two lists that drift.
if (existsSync(SERVER_TEMPLATE)) {
  const base = "https://app.xn--5kvo87g.com"
  const main = (readFileSync(join(ROOT, "site", "sitemap.xml"), "utf8").match(/<url>[\s\S]*?<\/url>/g) || [])
  const serverUrls = all.map(function (r) {
    return "<url><loc>" + esc(base + "/s/" + slugOf(r.server) + ".html") + "</loc><priority>0.4</priority></url>"
  })
  const ownerKeys = new Set()
  for (const r of all) { const o = ownerOf(r); if (o) ownerKeys.add(ownerSlug(o)) }
  const ownerUrls = Array.from(ownerKeys).map(function (k) {
    return "<url><loc>" + esc(base + "/o/" + k + ".html") + "</loc><priority>0.5</priority></url>"
  })
  const top = main.concat(ownerUrls)
  const head = '<?xml version="1.0" encoding="UTF-8"?>'
  const urlset = function (urls) {
    return head + '\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.map(function (u) { return "  " + u }).join("\n") + "\n</urlset>\n"
  }
  const LIMIT = 45000
  if (top.length + serverUrls.length <= LIMIT) {
    writeFileSync(join(outDir, "sitemap.xml"), urlset(top.concat(serverUrls)))
  } else {
    const files = []
    for (let i = 0; i < serverUrls.length; i += LIMIT) {
      const name = "sitemap-servers-" + (files.length + 1) + ".xml"
      writeFileSync(join(outDir, name), urlset(serverUrls.slice(i, i + LIMIT)))
      files.push(name)
    }
    writeFileSync(join(outDir, "sitemap-main.xml"), urlset(top))
    files.unshift("sitemap-main.xml")
    writeFileSync(join(outDir, "sitemap.xml"), head + '\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + files.map(function (f) { return "  <sitemap><loc>" + base + "/" + f + "</loc></sitemap>" }).join("\n") + "\n</sitemapindex>\n")
  }
  console.log("sitemap: " + (top.length + serverUrls.length) + " url(s)")
}
writeFileSync(join(outDir, ".nojekyll"), "")
console.log("site written to " + join(outDir, indexName) + " (" + Math.round(page.length / 1024) + " KB, " + records.length + " records" + (diffText ? ", with a diff" : "") + ") and " + copied + " page(s) copied")
