import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchDir } from "./tmpdir.mjs"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agentgate.mjs")

function run(args) {
  return spawnSync(process.execPath, [BIN].concat(args), { encoding: "utf8" })
}

test("the framework command prints the mapping and exits 0", function () {
  const out = run(["framework"])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /STA-09\.1/)
  assert.match(out.stdout, /第三方/)
  assert.match(out.stdout, /不是合规结论/)
})

test("--format json exposes the entries", function () {
  const out = run(["framework", "--format", "json"])
  const body = JSON.parse(out.stdout)
  assert.equal(body.id, "aicaiq")
  assert.equal(body.entries.length, 58)
  assert.equal(body.entries.filter(function (e) { return e.owner === "we" }).length, 13)
  assert.equal(body.entries.filter(function (e) { return e.owner === "third-party" }).length, 4)
})

test("an unknown framework id is refused", function () {
  const out = run(["framework", "--id", "iso27001"])
  assert.equal(out.status, 3)
  assert.match(out.stderr, /不认识的框架/)
})

test("inventory --framework puts the mapping in the report next to the evidence", function () {
  const dir = scratchDir("ag-framework-")
  const indexPath = join(dir, "index.json")
  writeFileSync(indexPath, JSON.stringify({ generatedAt: "2026-09-17T00:00:00.000Z", records: [] }))
  const tools = join(dir, "tools.txt")
  writeFileSync(tools, "alpha@1.0.0\n")
  const html = run(["inventory", "--input", tools, "--index", indexPath, "--framework", "aicaiq", "--out", join(dir, "report.html")])
  assert.equal(html.status, 0, html.stderr)
  const page = readFileSync(join(dir, "report.html"), "utf8")
  assert.match(page, /问卷对照/)
  assert.match(page, /我们出证据/)
  assert.match(page, /不替任何人认证|不是合规结论/)
  const json = run(["inventory", "--input", tools, "--index", indexPath, "--framework", "aicaiq", "--format", "json"])
  assert.equal(JSON.parse(json.stdout).framework.id, "aicaiq")
})

test("inventory without --framework is unchanged", function () {
  const dir = scratchDir("ag-framework-")
  const indexPath = join(dir, "index.json")
  writeFileSync(indexPath, JSON.stringify({ generatedAt: "2026-09-17T00:00:00.000Z", records: [] }))
  const tools = join(dir, "tools.txt")
  writeFileSync(tools, "alpha@1.0.0\n")
  const out = run(["inventory", "--input", tools, "--index", indexPath])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout.indexOf("问卷对照"), -1)
})
