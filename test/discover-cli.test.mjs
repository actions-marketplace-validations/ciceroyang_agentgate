import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchDir } from "./tmpdir.mjs"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agentgate.mjs")

function run(args, cwd) {
  return spawnSync(process.execPath, [BIN].concat(args), { cwd: cwd, encoding: "utf8" })
}

function fixture() {
  const dir = scratchDir("ag-discover-")
  mkdirSync(join(dir, "repo"), { recursive: true })
  writeFileSync(join(dir, "repo", ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "demo-pkg@1.0.0"] } } }))
  return dir
}

test("discover prints an inventory-ready list and exits 0", function () {
  const dir = fixture()
  const out = run(["discover", "--home", dir, "--roots", join(dir, "repo")])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout.trim(), "demo-pkg@1.0.0")
  assert.match(out.stderr, /服务器 1 个/)
})

test("a config that cannot be parsed makes discover exit 2 and say the list is partial", function () {
  const dir = fixture()
  writeFileSync(join(dir, "repo", "mcp.json"), "{ broken")
  const out = run(["discover", "--home", dir, "--roots", join(dir, "repo")])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /这份清单不完整/)
  assert.match(out.stderr, /invalid-json/)
})

test("--format json carries the sources and the boundary", function () {
  const dir = fixture()
  const out = run(["discover", "--home", dir, "--roots", join(dir, "repo"), "--format", "json"])
  const body = JSON.parse(out.stdout)
  assert.equal(body.schemaVersion, 1)
  assert.equal(body.counts.servers, 1)
  assert.ok(body.boundary.length > 0)
  assert.equal(body.incomplete, false)
})

test("--out writes once and refuses to overwrite", function () {
  const dir = fixture()
  const target = join(dir, "tools.txt")
  const first = run(["discover", "--home", dir, "--roots", join(dir, "repo"), "--out", target])
  assert.equal(first.status, 0, first.stderr)
  assert.equal(readFileSync(target, "utf8").trim(), "demo-pkg@1.0.0")
  const mode = statSync(target).mode & 0o777
  assert.equal(mode, 0o600, "a private inventory should not be world readable")
  const second = run(["discover", "--home", dir, "--roots", join(dir, "repo"), "--out", target])
  assert.notEqual(second.status, 0)
})

test("a machine with no configs is not an error", function () {
  const dir = scratchDir("ag-discover-empty-")
  mkdirSync(join(dir, "repo"), { recursive: true })
  const out = run(["discover", "--home", dir, "--roots", join(dir, "repo")])
  assert.equal(out.status, 0)
  assert.equal(out.stdout, "")
})
