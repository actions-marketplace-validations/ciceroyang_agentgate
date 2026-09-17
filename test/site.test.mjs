import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { scratchDir } from "./tmpdir.mjs"
import { appendCapture } from "../packages/history/src/ledger.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function buildPage(indexPath, diffText) {
  const out = scratchDir("ag-site-")
  const args = [join(ROOT, "scripts", "build-site.mjs"), "--index", indexPath, "--out", out, "--name", "index.html"]
  if (diffText !== undefined) {
    const diffPath = join(out, "diff.md")
    writeFileSync(diffPath, diffText)
    args.push("--diff", diffPath)
  }
  const run = spawnSync(process.execPath, args, { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  return readFileSync(join(out, "index.html"), "utf8")
}

/** Run the page script with just enough DOM to catch a runtime error. */
function runPageScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(function (m) { return m[1] })
  const code = scripts.join("\n")
  const dataTag = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]
  const diffTag = /<script id="diffdata" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]
  const totalsTag = /<script id="totals" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]
  const made = {}
  const el = function (id) {
    if (!made[id]) made[id] = { id: id, textContent: id === "data" ? dataTag : id === "diffdata" ? diffTag : id === "totals" ? totalsTag : "", innerHTML: "", value: "", style: {}, classList: { add: function () {}, remove: function () {} } }
    return made[id]
  }
  // the page registers keydown/click listeners; the stub only needs to accept the registration
  const sandbox = { document: { getElementById: el, addEventListener: function () {} }, window: {}, console: console }
  const fn = new Function("document", "window", "console", code)
  fn(sandbox.document, sandbox.window, sandbox.console)
  return made
}

test("the built page runs without throwing and renders rows", function () {
  const html = buildPage(join(ROOT, "data", "sample-index.json"))
  const made = runPageScript(html)
  assert.match(made.rows.innerHTML, /<tr onclick="openD\(0\)"/)
  assert.match(made.n.textContent, /显示 \d+ \/ \d+/)
  assert.equal(made.diff, undefined, "the diff element is not touched when there is nothing to show")
})

test("the page renders a diff when one is given", function () {
  const html = buildPage(join(ROOT, "data", "sample-index.json"), "index diff\n  added: 3")
  const made = runPageScript(html)
  assert.match(made.diff.textContent, /added: 3/)
  assert.equal(made.diff.style.display, "block")
})

test("a record with no packages still renders", function () {
  const dir = scratchDir("ag-site-fixture-")
  const indexPath = join(dir, "index.json")
  writeFileSync(indexPath, JSON.stringify({ generatedAt: "T", threshold: "medium", count: 1, records: [{ server: "a/b", verdict: "incomplete", packages: [], evidence: { packageManifest: { status: "unmeasured", source: "guard-scan", reason: "metadata-unavailable", findings: [] } } }] }))
  const made = runPageScript(buildPage(indexPath))
  assert.match(made.rows.innerHTML, /a\/b/)
  assert.match(made.rows.innerHTML, /incomplete/)
})

test("a large index is capped and the page says so", function () {
  const dir = scratchDir("ag-cap-")
  const indexPath = join(dir, "index.json")
  const records = []
  for (let i = 0; i < 40; i += 1) {
    records.push({ server: "s/" + i, verdict: i === 3 ? "incomplete" : i < 8 ? "findings" : "clean", packages: [], evidence: {} })
  }
  writeFileSync(indexPath, JSON.stringify({ generatedAt: "T", threshold: "medium", count: records.length, records: records }))
  const out = scratchDir("ag-cap-out-")
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"), "--index", indexPath, "--out", out, "--name", "index.html", "--max-records", "10"], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  const html = readFileSync(join(out, "index.html"), "utf8")
  const totals = JSON.parse(/<script id="totals" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1])
  assert.deepEqual(totals, { total: 40, shown: 10, truncated: true })
  assert.equal((html.match(/"server":/g) || []).length, 10)
  const embedded = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1])
  assert.equal(embedded[0].verdict, "incomplete", "the notable records must survive the cap")
  const clean = embedded.filter(function (r) { return r.verdict === "clean" }).length
  const notable = embedded.filter(function (r) { return r.verdict !== "clean" }).length
  assert.equal(notable, 8, "every incomplete and findings record must survive the cap")
  assert.equal(clean, 2, "clean records only fill what is left")
})

test("a small index is not marked truncated", function () {
  const html = buildPage(join(ROOT, "data", "sample-index.json"))
  const totals = JSON.parse(/<script id="totals" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1])
  assert.equal(totals.truncated, false)
  assert.equal(totals.total, totals.shown)
})


test("the plain pages are published beside the index, and the index does not overwrite them", function () {
  const out = scratchDir("ag-site-full-")
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"), "--index", join(ROOT, "data", "sample-index.json"), "--out", out, "--name", "evidence.html", "--pages", join(ROOT, "site")], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)

  // The sample report is a separate step in the published workflow; generate it the same way so
  // this test walks the site a visitor actually gets.
  const sample = spawnSync(process.execPath, [join(ROOT, "bin", "agentgate.mjs"), "check", "--root", join(ROOT, "examples", "action-verify"), "--policy", join(ROOT, "examples", "action-verify", "agentgate.policy.json"), "--format", "html", "--out", join(out, "report-sample.html")], { encoding: "utf8" })
  assert.ok(existsSync(join(out, "report-sample.html")), "the sample report was not written: " + sample.stderr)

  const landing = readFileSync(join(out, "index.html"), "utf8")
  assert.match(landing, /智量/, "the landing page is what a visitor lands on")
  assert.doesNotMatch(landing, /id="rows"/, "the landing page is not the data table")

  const evidence = readFileSync(join(out, "evidence.html"), "utf8")
  assert.match(evidence, /id="rows"/, "the browsable index still gets built")

  // The index builds its rows in the browser, so a stray quote in that script is a page that
  // renders nothing — and nothing else in the suite would notice. It happened once already.
  const blocks = /<script>([\s\S]*)<\/script>/.exec(evidence)
  assert.ok(blocks, "the index page has no script block")
  const scriptPath = join(out, "page-script.js")
  writeFileSync(scriptPath, blocks[1])
  const parsed = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" })
  assert.equal(parsed.status, 0, "the index page script does not parse: " + parsed.stderr)
  assert.ok(evidence.indexOf('"/s/" + slug(') !== -1, "the index must link to the per-server pages")

  assert.match(readFileSync(join(out, "pricing.html"), "utf8"), /29,800|29,?800|价格/)
  assert.match(readFileSync(join(out, "try.html"), "utf8"), /自己试|十分钟/)

  // every relative link between the published pages must resolve, or the site ships dead ends
  for (const name of ["index.html", "evidence.html", "pricing.html", "try.html"]) {
    const html = readFileSync(join(out, name), "utf8")
    for (const m of html.matchAll(/href="([a-z0-9-]+\.html)"/g)) {
      assert.ok(existsSync(join(out, m[1])), name + " links to a page that was not published: " + m[1])
    }
  }
})

test("a repository field that is an empty object does not render as an object", function () {
  const dir = scratchDir("ag-site-repo-")
  const index = join(dir, "index.json")
  writeFileSync(index, JSON.stringify({ generatedAt: "T", threshold: "medium", count: 1, records: [
    { server: "a/empty-repo", verdict: "clean", packages: [], repository: {}, evidence: { registryDocument: { status: "clean", source: "mcp-census", findings: [] } }, generatedAt: "T" },
  ] }))
  const out = join(dir, "out")
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"), "--index", index, "--out", out, "--name", "evidence.html", "--pages", join(ROOT, "site")], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  const page = readFileSync(join(out, "s", "a__empty-repo.html"), "utf8")
  assert.doesNotMatch(page, /\[object Object\]/, "the repository field was rendered as an object")
  assert.match(page, /没有可用的仓库地址/)
})

test("every server gets a page of its own, and the page says what it did not measure", function () {
  const out = scratchDir("ag-site-servers-")
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"), "--index", join(ROOT, "data", "sample-index.json"), "--out", out, "--name", "evidence.html", "--pages", join(ROOT, "site")], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)

  const index = JSON.parse(readFileSync(join(ROOT, "data", "sample-index.json"), "utf8"))
  const slugOf = function (name) { return String(name).split("/").join("__").replace(/[^A-Za-z0-9._-]/g, "_") }

  for (const record of index.records) {
    assert.ok(existsSync(join(out, "s", slugOf(record.server) + ".html")), "no page for " + record.server)
  }

  const page = readFileSync(join(out, "s", slugOf(index.records[0].server) + ".html"), "utf8")
  for (const placeholder of ["__SERVER__", "__SLUG__", "__VERDICT__", "__THRESHOLD__", "__GENERATED__", "__META__", "__BLOCKS__", "__UNMEASURED__", "__EXECUTION__", "__API__", "__BADGE__"]) {
    assert.ok(page.indexOf(placeholder) === -1, "placeholder " + placeholder + " survived into the page")
  }
  assert.match(page, /没测到不等于干净/, "the page has to say that unmeasured is not clean")
  assert.match(page, /发现是/, "the page has to say what a finding is and is not")
  assert.doesNotMatch(page, /\*\*/, "markdown emphasis must not survive into HTML")

  // A page nobody can find is not published. The sitemap carries every record, and it still
  // carries the plain pages it was built from.
  const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8")
  assert.ok(sitemap.indexOf("<loc>https://app.xn--5kvo87g.com/</loc>") !== -1, "the sitemap lost the plain pages")
  assert.match(sitemap.trim(), /<\/urlset>$/, "the sitemap is malformed")
  for (const record of index.records) {
    assert.ok(sitemap.indexOf("/s/" + slugOf(record.server) + ".html") !== -1, "the sitemap is missing " + record.server)
  }

  // The template is a build input, not a page.
  assert.ok(!existsSync(join(out, "server.html")), "the template was published as a page")
})

test("the evidence page says which scanners finished", function () {
  const dir = scratchDir("ag-site-execution-")
  const index = join(dir, "index.json")
  const record = function (server, verdict, scanExecution) {
    return { server: server, verdict: verdict, packages: [], repository: null, evidence: {}, scanExecution: scanExecution, generatedAt: "2026-09-17T00:00:00.000Z" }
  }
  writeFileSync(index, JSON.stringify({
    generatedAt: "2026-09-17T00:00:00.000Z",
    threshold: "medium",
    count: 3,
    records: [
      record("a/done", "clean", { scanner_execution: { components: [{ id: "registryDocument", required: true, status: "completed", output_present: true, output_parseable: true, semantic_consistency: "ok", reason: null }], required: 1, completed: 1, failed: 0, state: "complete" } }),
      record("b/partial", "incomplete", { scanner_execution: { components: [{ id: "repository", required: true, status: "failed", output_present: true, output_parseable: false, semantic_consistency: "unverified", reason: "not-in-run" }], required: 1, completed: 0, failed: 1, state: "incomplete" } }),
      record("c/old", "incomplete", null),
    ],
  }))
  const out = scratchDir("ag-site-execution-out-")
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"), "--index", index, "--out", out, "--name", "evidence.html", "--pages", join(ROOT, "site")], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)

  const slugOf = function (name) { return String(name).split("/").join("__").replace(/[^A-Za-z0-9._-]/g, "_") }
  const partial = readFileSync(join(out, "s", slugOf("b/partial") + ".html"), "utf8")
  assert.match(partial, /哪些扫描器跑完了/)
  assert.match(partial, /not-in-run/)
  assert.match(partial, /没跑成 1 个/)
  const done = readFileSync(join(out, "s", slugOf("a/done") + ".html"), "utf8")
  assert.match(done, /状态:<b>complete<\/b>/)
  const old = readFileSync(join(out, "s", slugOf("c/old") + ".html"), "utf8")
  assert.match(old, /写于 scan-execution 之前/)
})

test("a page for a record that is gone is removed, and nothing else in the directory is", function () {
  // The record set moves every day: a server leaves the registry, or is renamed and gets a new
  // slug. A page left behind stays reachable, says the site was rebuilt today, and nothing links
  // to it. The removal has to stay inside s/ and o/ -- the output directory also holds the
  // other site's releases/ and the hand-written root pages, which are not this script's.
  const out = scratchDir("ag-site-prune-")
  const run = function () {
    return spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"), "--index", join(ROOT, "data", "sample-index.json"), "--out", out, "--name", "evidence.html", "--pages", join(ROOT, "site")], { encoding: "utf8" })
  }
  const first = run()
  assert.equal(first.status, 0, first.stderr)

  const staleServer = join(out, "s", "old.example__gone.html")
  const staleOwner = join(out, "o", "ghost.html")
  const keep = join(out, "s", "notes.txt")
  writeFileSync(staleServer, "<html>gone</html>")
  writeFileSync(staleOwner, "<html>gone</html>")
  writeFileSync(keep, "not a page\n")

  const second = run()
  assert.equal(second.status, 0, second.stderr)
  assert.ok(!existsSync(staleServer), "a page for a record that is gone is still published")
  assert.ok(!existsSync(staleOwner), "a publisher page with no records left is still published")
  assert.ok(existsSync(keep), "pruning removed a file that is not a page this script writes")
  assert.match(second.stdout, /removed 1 that are no longer in the index/, second.stdout)
})

test("every publisher gets a page listing their servers, and the sitemap carries it", function () {
  const out = scratchDir("ag-site-owners-")
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"), "--index", join(ROOT, "data", "sample-index.json"), "--out", out, "--name", "evidence.html", "--pages", join(ROOT, "site")], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)

  const index = JSON.parse(readFileSync(join(ROOT, "data", "sample-index.json"), "utf8"))
  const ownerOf = function (r) {
    const rv = r.repository
    const url = typeof rv === "string" ? rv : (rv && rv.url) || ""
    const m = /^https?:\/\/github\.com\/([^\/]+)\//.exec(url)
    return m ? m[1].toLowerCase().replace(/[^a-z0-9-]/g, "_") : null
  }
  const slugOf = function (name) { return String(name).split("/").join("__").replace(/[^A-Za-z0-9._-]/g, "_") }
  const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8")
  const seen = new Map()

  let owners = 0
  for (const record of index.records) {
    const owner = ownerOf(record)
    if (!owner) continue
    owners += 1
    if (!seen.has(owner)) seen.set(owner, readFileSync(join(out, "o", owner + ".html"), "utf8"))
    const page = seen.get(owner)
    assert.ok(page.indexOf(record.server) !== -1, owner + " does not list " + record.server)
    assert.ok(page.indexOf("/s/" + slugOf(record.server) + ".html") !== -1, owner + " does not link " + record.server)
    assert.ok(sitemap.indexOf("/o/" + owner + ".html") !== -1, "the sitemap is missing /o/" + owner)
  }
  assert.ok(owners > 0, "the sample has no repository owners to check")
  assert.ok(!existsSync(join(out, "owner.html")), "the publisher template was published as a page")
})

// Registry data is written by whoever registered the server. It reaches this page as
// embedded JSON, twice. Two ways that went wrong: String.replace() reads $& and the
// dollar-prefix forms in a string replacement, so a name containing one spliced the rest of
// the template -- including a literal closing script tag -- into the middle of the JSON; and
// the diff was embedded as plain JSON.stringify, so a name containing a closing script tag
// ended the block on its own.

function block(html, id) {
  const open = '<script id="' + id + '" type="application/json">'
  const start = html.indexOf(open)
  assert.notEqual(start, -1, "no " + id + " block in the page")
  const from = start + open.length
  const end = html.indexOf("</" + "script>", from)
  assert.notEqual(end, -1, "the " + id + " block is not closed")
  return html.slice(from, end)
}

test("registry data cannot break out of the embedded json", function () {
  const dir = scratchDir("ag-hostile-")
  const idx = join(dir, "index.json")
  const payload = "</" + "script><script>window.__pwned=1</" + "script>"
  writeFileSync(idx, JSON.stringify({
    generatedAt: "2026-09-15T00:00:00.000Z" + payload,
    count: 3,
    records: [
      { server: "a$'b", verdict: "clean", packages: [], evidence: [] },
      { server: "c$&d", verdict: "findings", packages: [], evidence: [] },
      { server: payload, verdict: "clean", packages: [], evidence: [] },
    ],
  }))
  const html = buildPage(idx, "index diff" + "\n" + "  added: " + payload + "\n" + "  a$'b" + "\n")

  assert.equal(html.split('id="data"').length - 1, 1, "the data block was duplicated or lost")
  assert.equal(html.split('id="diffdata"').length - 1, 1, "the diff block was duplicated or lost")
  assert.equal(html.indexOf("__DATA__"), -1, "a placeholder survived")
  assert.equal(html.indexOf("__DIFFJSON__"), -1, "a placeholder survived")

  const data = block(html, "data")
  const diff = block(html, "diffdata")
  // nothing in either block may be a real "<"; that is what a closing script tag needs
  assert.equal(data.indexOf("<"), -1, "a value put real markup inside the data block")
  assert.equal(diff.indexOf("<"), -1, "a value put real markup inside the diff block")

  // the dollar forms must arrive as data, not be read as replacement syntax.
  // The page reorders records (notable first), so compare as a set.
  assert.deepEqual(JSON.parse(data).map(function (r) { return r.server }).sort(), [payload, "a$'b", "c$&d"].sort())
  assert.match(JSON.parse(diff), /a\$'b/, "the diff lost its dollar sign")
})

test("the pricing page says which tiers exist yet", function () {
  // The table lists SSO/SAML, RBAC, multi-tenancy and signed audit export under Team and
  // Enterprise. None of those are implemented. A footer calling the page a draft is not enough —
  // somebody reading it has to be able to tell what they can buy today.
  const pricing = readFileSync(join(ROOT, "site", "pricing.html"), "utf8")
  assert.match(pricing, /还在做/, "the pricing page no longer says the paid tiers are not built")
  assert.match(pricing, /现在能用的只有/, "it no longer says what is available today")
  const index = readFileSync(join(ROOT, "site", "index.html"), "utf8")
  assert.match(index, /这些还在做/, "the landing page presents the enterprise features as shipped")
})

test("the built site carries the pieces a public site needs", function () {
  // No favicon (a browser tab shows a default globe), no preview when the link is shared, no 404
  // page, a plain 404 body from Caddy -- each of those reads as unfinished to somebody opening the
  // URL for the first time, which is exactly what the first outreach asks them to do.
  const out = scratchDir("ag-assets-")
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"), "--index", join(ROOT, "data", "sample-index.json"), "--out", out, "--name", "evidence.html", "--pages", join(ROOT, "site")], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  for (const name of ["favicon.svg", "robots.txt", "sitemap.xml", "404.html", "index.html", "pricing.html", "try.html", "evidence.html"]) {
    assert.ok(existsSync(join(out, name)), "the published site is missing " + name)
  }
  const home = readFileSync(join(out, "index.html"), "utf8")
  assert.match(home, /rel="canonical"/, "no canonical link")
  assert.match(home, /og:title/, "no preview title when the link is shared")
  assert.match(home, /property="og:description"/, "no preview description")
  assert.match(home, /rel="icon"[^>]*favicon\.svg/, "no favicon")
  assert.match(home, /name="description" content="[^"]{20,}"/, "no real meta description")
  // and the description must not advertise what is not built
  assert.doesNotMatch(home, /企业版提供 SSO/, "the description still promises the enterprise tier")
  rmSync(out, { recursive: true, force: true })
})

test("the detail drawer is painted above the sticky search bar", function () {
  // Reported from the live page: clicking a record opened the drawer and the search bar, which is
  // sticky at top:0 with z-index 2, covered its top 63px -- the heading and the close button. The
  // drawer is position:fixed but had no z-index of its own, so the bar won.
  //
  // It only shows once the page is scrolled; at scrollY 0 the bar is still below the header. In a
  // browser at scrollY 600, elementFromPoint at the drawer's top returned ".bar" before this fix
  // and "#detail" after it, and the close button was hit-testable only afterwards.
  const html = readFileSync(join(ROOT, "site", "evidence.html"), "utf8").replace(/\n/g, " ")
  const zIndexOf = function (selector) {
    const block = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}").exec(html)
    const z = /z-index:\s*(\d+)/.exec(block ? block[1] : "")
    return z ? Number(z[1]) : 0
  }
  const bar = zIndexOf(".bar")
  const detail = zIndexOf("#detail")
  assert.ok(bar > 0, "the bar no longer pins itself with a z-index")
  assert.ok(detail > bar, "the drawer (z-index " + detail + ") is not above the sticky bar (z-index " + bar + ")")
})

test("the capture ledger is published with its own text, and a missing day is not smoothed over", function () {
  const out = scratchDir("ag-site-history-")
  const history = scratchDir("ag-site-history-in-")
  const source = join(history, "source.json")
  writeFileSync(source, readFileSync(join(ROOT, "data", "sample-index.json")))
  const index = JSON.parse(readFileSync(source, "utf8"))
  appendCapture(history, { index: index, indexFile: source, scanner: "aaa", day: "2026-09-15", capturedAt: "2026-09-15T04:17:00.000Z" })
  appendCapture(history, { index: index, indexFile: source, scanner: "bbb", day: "2026-09-17", capturedAt: "2026-09-17T04:17:00.000Z" })

  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"), "--index", join(ROOT, "data", "sample-index.json"), "--out", out, "--name", "evidence.html", "--pages", join(ROOT, "site"), "--history", history], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  const page = readFileSync(join(out, "history.html"), "utf8")
  assert.match(page, /2 次采集/)
  assert.match(page, /2026-09-15T04:17:00.000Z/)
  assert.match(page, /1 天没有采集：2026-09-16/, "a missing day has to be named on the page, not smoothed over")
  assert.match(page, /&quot;scanner&quot;:&quot;bbb&quot;/, "the published ledger is not the ledger itself")
  assert.doesNotMatch(page, /__[A-Z]+__/, "a placeholder survived into the published page")
  const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8")
  assert.ok(sitemap.indexOf("/history.html") !== -1, "the record page is not in the sitemap")
})
