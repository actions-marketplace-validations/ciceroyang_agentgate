import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function buildPage(indexPath, diffText) {
  const out = mkdtempSync(join(tmpdir(), "ag-site-"))
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
  const sandbox = { document: { getElementById: el }, window: {}, console: console }
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
  const dir = mkdtempSync(join(tmpdir(), "ag-site-fixture-"))
  const indexPath = join(dir, "index.json")
  writeFileSync(indexPath, JSON.stringify({ generatedAt: "T", threshold: "medium", count: 1, records: [{ server: "a/b", verdict: "incomplete", packages: [], evidence: { packageManifest: { status: "unmeasured", source: "guard-scan", reason: "metadata-unavailable", findings: [] } } }] }))
  const made = runPageScript(buildPage(indexPath))
  assert.match(made.rows.innerHTML, /a\/b/)
  assert.match(made.rows.innerHTML, /incomplete/)
})

test("a large index is capped and the page says so", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-cap-"))
  const indexPath = join(dir, "index.json")
  const records = []
  for (let i = 0; i < 40; i += 1) {
    records.push({ server: "s/" + i, verdict: i === 3 ? "incomplete" : i < 8 ? "findings" : "clean", packages: [], evidence: {} })
  }
  writeFileSync(indexPath, JSON.stringify({ generatedAt: "T", threshold: "medium", count: records.length, records: records }))
  const out = mkdtempSync(join(tmpdir(), "ag-cap-out-"))
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
  const out = mkdtempSync(join(tmpdir(), "ag-site-full-"))
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
