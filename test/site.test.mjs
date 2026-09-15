import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function buildPage(indexPath, diffText) {
  const out = mkdtempSync(join(tmpdir(), "ag-site-"))
  const args = [join(ROOT, "scripts", "build-site.mjs"), "--index", indexPath, "--out", out]
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
  const made = {}
  const el = function (id) {
    if (!made[id]) made[id] = { id: id, textContent: id === "data" ? dataTag : id === "diffdata" ? diffTag : "", innerHTML: "", value: "", style: {}, classList: { add: function () {}, remove: function () {} } }
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
