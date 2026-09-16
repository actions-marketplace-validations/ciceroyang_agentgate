import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { createService } from "../packages/service/src/server.mjs"
import { start } from "../packages/service/src/start.mjs"
import { renderInventoryPage } from "../packages/inventory/src/web.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(ROOT, "bin/agentgate.mjs")
const PRELOAD = join(ROOT, "test/fixtures/no-network.cjs")
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ag-inventory-flow-"))
  const index = {
    generatedAt: "2026-09-17T01:00:00.000Z", scanner: "test-fixture-not-production", count: 1,
    records: [{ server: "example/tool", packages: [{ registry: "npm", name: "@example/tool", version: "1.2.3" }],
      verdict: "clean", generatedAt: "2026-09-17T01:00:00.000Z",
      evidence: { packageManifest: { status: "clean", source: "test-fixture", findings: [],
        provenance: { package: { registry: "npm", name: "@example/tool", version: "1.2.3" },
          complete: true, content: { algorithm: "sha256", digest: "a".repeat(64), scope: "package-manifest:test-fixture" } } } } }],
  }
  const indexPath = join(dir, "index.json")
  const inputPath = join(dir, "tools.json")
  writeFileSync(indexPath, JSON.stringify(index))
  writeFileSync(inputPath, JSON.stringify({ tools: [
    { name: "我的工具", server: "example/tool", package: "@example/tool", registry: "npm", version: "1.2.3" },
    "an-unmatched-tool",
  ] }))
  return { dir, index, indexPath, inputPath }
}
function cli(args) {
  return spawnSync(process.execPath, ["--require", PRELOAD, CLI, "inventory", ...args], { encoding: "utf8", timeout: 30000, cwd: ROOT })
}

test("offline inventory retains unknown tools and generates standalone HTML without executing or reaching the network", function () {
  const { dir, indexPath, inputPath } = fixture()
  const json = cli(["--input", inputPath, "--index", indexPath, "--format", "json"])
  assert.equal(json.status, 0, json.stderr)
  const report = JSON.parse(json.stdout)
  assert.equal(report.items.length, 2)
  assert.equal(report.items[0].state, "matched")
  assert.equal(report.items[1].state, "unmatched")
  const output = join(dir, "report.html")
  const run = cli(["--input", inputPath, "--index", indexPath, "--out", output])
  assert.equal(run.status, 0, run.stderr)
  const html = readFileSync(output, "utf8")
  assert.match(html, /我的工具/)
  assert.match(html, /an-unmatched-tool/)
  assert.doesNotMatch(html, /<script\b/i)
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/i)
  assert.match(html, /1\.2\.3/)
  const second = cli(["--input", inputPath, "--index", indexPath, "--out", output])
  assert.equal(second.status, 2)
  assert.equal(readFileSync(output, "utf8"), html, "reports must not be overwritten")
})

test("explicit missing index, wrong format and credential-bearing config fail without a report", function () {
  const { dir, inputPath, indexPath } = fixture()
  const output = join(dir, "no-report.html")
  for (const args of [
    ["--input", inputPath, "--index", join(dir, "missing.json")],
    ["--input", inputPath, "--index", indexPath, "--format", "xml"],
    ["--input", inputPath, "--index", indexPath, "--out"],
  ]) assert.equal(cli(args).status, 2)
  writeFileSync(inputPath, JSON.stringify({ mcpServers: { secret: { env: { TOKEN: "never-output-this-secret" } } } }))
  const run = cli(["--input", inputPath, "--index", indexPath, "--out", output])
  assert.equal(run.status, 2)
  assert.equal(existsSync(output), false)
  assert.doesNotMatch(run.stdout + run.stderr, /never-output-this-secret/)
})

test("default committed sample is explicitly historical, never a confirmed evidence match", function () {
  const { inputPath } = fixture()
  writeFileSync(inputPath, JSON.stringify([{ server: "agency.kesey/pretrip", package: "pretrip-mcp", version: "1.0.1", registry: "npm" }]))
  const run = cli(["--input", inputPath, "--index", join(ROOT, "data/sample-index.json"), "--format", "json"])
  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(run.stdout)
  assert.equal(result.index.snapshot, true)
  assert.equal(result.items[0].state, "insufficient")
})

test("local service serves the inventory and exact module allowlist, and has no upload endpoint", async function () {
  const { indexPath } = fixture()
  const svc = createService({ indexPath })
  const page = svc.handle("GET", "/inventory.html")
  assert.equal(page.status, 200)
  assert.doesNotMatch(page.body, /__INVENTORY_INDEX__/)
  assert.match(page.body, /example\/tool/)
  for (const path of ["/inventory-page.mjs", "/inventory.mjs", "/inventory-report.mjs"]) {
    const asset = svc.handle("GET", path)
    assert.equal(asset.status, 200, path)
    assert.match(asset.type, /javascript/)
  }
  assert.equal(svc.handle("POST", "/inventory.html").status, 405)
  assert.equal(svc.handle("GET", "/inventory/../../package.json").status, 404)
  assert.equal(createService({ indexPath: "/nonexistent-index" }).handle("GET", "/inventory.html").status, 503)
  const server = start({ indexPath, port: 0, host: "127.0.0.1" })
  await new Promise(function (done) { server.once("listening", done) })
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/inventory.html")
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.equal(response.headers.get("referrer-policy"), "no-referrer")
    assert.equal(response.status, 200)
  } finally { await new Promise(function (done) { server.close(done) }) }
})

test("embedded index cannot terminate its data block or interpret replacement syntax", function () {
  const template = '<script type="application/json" id="inventory-index">__INVENTORY_INDEX__</script>'
  const index = { records: [{ server: '</script><script>alert(1)</script>$&$\'\u2028' }] }
  const html = renderInventoryPage(template, index)
  assert.equal((html.match(/<script/g) || []).length, 1)
  const data = JSON.parse(html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>")))
  assert.deepEqual(data, index)
})

test("static build ships shared engine and preserves content provenance plus truncation", function () {
  const { dir, index, indexPath } = fixture()
  index.records.push({ ...index.records[0], server: "example/second" })
  index.count = 2
  writeFileSync(indexPath, JSON.stringify(index))
  const out = join(dir, "site")
  const run = spawnSync(process.execPath, [join(ROOT, "scripts/build-site.mjs"), "--index", indexPath, "--out", out, "--max-records", "1"], { encoding: "utf8", timeout: 30000 })
  assert.equal(run.status, 0, run.stderr)
  const html = readFileSync(join(out, "inventory.html"), "utf8")
  assert.doesNotMatch(html, /__INVENTORY_INDEX__/)
  assert.match(html, new RegExp("a".repeat(64)))
  assert.match(html, /"truncated":true/)
  assert.match(html, /"total":2/)
  for (const name of ["inventory.mjs", "inventory-report.mjs", "inventory-page.mjs"]) assert.ok(existsSync(join(out, name)), name)
})
