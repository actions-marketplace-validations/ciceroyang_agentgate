import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { parseInventory, createInventoryReport } from "../packages/inventory/src/inventory.mjs"
import { appendWatch } from "../packages/watch/src/watch.mjs"
import { FORBIDDEN_WORDS } from "../packages/pack/src/pack.mjs"
import { scratchDir } from "./tmpdir.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(ROOT, "bin", "agentgate.mjs")
const DIGEST = "b".repeat(64)
const WHEN = "2026-09-18T00:00:00.000Z"

function indexFixture() {
  return {
    generatedAt: WHEN, scanner: "test-fixture-not-production", count: 1,
    records: [{
      server: "example/tool", packages: [{ registry: "npm", name: "@example/tool", version: "1.2.3" }],
      verdict: "clean", generatedAt: WHEN,
      evidence: {
        registryDocument: { status: "clean", source: "test-fixture", findings: [],
          provenance: { package: { registry: "npm", name: "@example/tool", version: "1.2.3" }, complete: true,
            content: { algorithm: "sha256", digest: DIGEST, scope: "registryDocument/v1:test-fixture" } } },
        packageManifest: { status: "clean", source: "test-fixture", findings: [],
          provenance: { package: { registry: "npm", name: "@example/tool", version: "1.2.3" }, complete: true,
            content: { algorithm: "sha256", digest: DIGEST, scope: "packageManifest/v1:test-fixture" } } },
      },
      scanExecution: { schemaVersion: "agentgate.scan-execution/v1",
        subject: { server: "example/tool", packages: [{ registry: "npm", name: "@example/tool", version: "1.2.3" }] },
        scanner_execution: { components: ["registryDocument", "packageManifest"].map(function (id) {
          return { id: id, required: true, status: "completed", exit_code: 0, output_present: true,
            output_parseable: true, semantic_consistency: "ok", reason: null,
            findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } }
        }), required: 2, completed: 2, failed: 0, state: "complete" },
        digest: null, generatedAt: WHEN },
    }],
  }
}

function fixture() {
  const dir = scratchDir("ag-pack-")
  const indexPath = join(dir, "index.json")
  const inputPath = join(dir, "tools.json")
  const index = indexFixture()
  writeFileSync(indexPath, JSON.stringify(index))
  writeFileSync(inputPath, JSON.stringify({ tools: [
    { name: "我的工具", server: "example/tool", package: "@example/tool", registry: "npm", version: "1.2.3" },
  ] }))
  return { dir, indexPath, inputPath, index }
}

function cli(args) {
  return spawnSync(process.execPath, [CLI, "pack", ...args], { encoding: "utf8", timeout: 60000, cwd: ROOT })
}

test("a fully backed pack exits 0 and every file is written", function () {
  const { dir, indexPath, inputPath, index } = fixture()
  const archive = join(dir, "archive")
  const report = createInventoryReport(parseInventory(readFileSync(inputPath, "utf8")), index, { generatedAt: WHEN })
  appendWatch(archive, { report: report, entries: parseInventory(readFileSync(inputPath, "utf8")), capturedAt: WHEN })
  appendWatch(archive, { report: report, entries: parseInventory(readFileSync(inputPath, "utf8")), capturedAt: WHEN })
  const calls = join(dir, "calls.jsonl")
  writeFileSync(calls, JSON.stringify({ method: "tools/call", decision: "allow" }) + "\n")
  const out = join(dir, "pack")
  const run = cli(["--input", inputPath, "--index", indexPath, "--archive", archive, "--calls", calls, "--out", out])
  assert.equal(run.status, 0, run.stderr + run.stdout)
  for (const name of ["pack.json", "pack.html", "answers.aicaiq.md", "manifest.txt", "manifest.sha256"]) {
    assert.equal(existsSync(join(out, name)), true, name)
  }
  const pack = JSON.parse(readFileSync(join(out, "pack.json"), "utf8"))
  assert.equal(pack.schemaVersion, "agentgate.evidence-pack/v1")
  assert.equal(pack.coverage.questions.total, 58)
  assert.equal(pack.coverage.questions.measured, pack.coverage.questions.ours)
  assert.equal(pack.coverage.questions.partial + pack.coverage.questions.unmeasured, 0)
  assert.match(run.stdout, /勘验证|校验通过|复核/)
  const verified = cli(["--verify", out])
  assert.equal(verified.status, 0, verified.stderr)
  const manifest = readFileSync(join(out, "manifest.txt"), "utf8")
  assert.match(manifest, /^[0-9a-f]{64} {2}pack\.json$/m)
  assert.match(manifest, /command: agentgate pack --input tools\.json --framework aicaiq --archive <dir> --calls <file>/)
  for (const text of [readFileSync(join(out, "pack.html"), "utf8"), readFileSync(join(out, "answers.aicaiq.md"), "utf8"), JSON.stringify(pack)]) {
    assert.equal(FORBIDDEN_WORDS.test(text), false, "a forbidden word reached the pack")
  }
})

test("an unmeasured tool keeps the pack from exiting 0, and says which part was not measured", function () {
  const { dir, indexPath, inputPath } = fixture()
  writeFileSync(inputPath, JSON.stringify({ tools: [
    { name: "我的工具", server: "example/tool", package: "@example/tool", registry: "npm", version: "1.2.3" },
    "an-unmatched-tool",
  ] }))
  const out = join(dir, "pack")
  const run = cli(["--input", inputPath, "--index", indexPath, "--out", out])
  assert.equal(run.status, 2, run.stderr + run.stdout)
  assert.match(run.stdout + run.stderr, /没有完全测到/)
  const pack = JSON.parse(readFileSync(join(out, "pack.json"), "utf8"))
  assert.ok(pack.coverage.questions.partial + pack.coverage.questions.unmeasured > 0)
  const html = readFileSync(join(out, "pack.html"), "utf8")
  assert.match(html, /本次有 \d+ 条我们声称能给的答案没有完全测到/)
  const md = readFileSync(join(out, "answers.aicaiq.md"), "utf8")
  assert.match(md, /本次未覆盖：/)
  assert.match(md, /不是我们/)
})

test("a changed byte fails verification and a missing manifest cannot be verified", function () {
  const { dir, indexPath, inputPath } = fixture()
  const out = join(dir, "pack")
  assert.equal(cli(["--input", inputPath, "--index", indexPath, "--out", out]).status, 2)
  const page = join(out, "pack.html")
  const original = readFileSync(page, "utf8")
  writeFileSync(page, original + "<!-- changed -->")
  const changed = cli(["--verify", out])
  assert.equal(changed.status, 1, changed.stdout + changed.stderr)
  assert.match(changed.stderr, /pack\.html/)
  writeFileSync(page, original)
  assert.equal(cli(["--verify", out]).status, 0)
  rmSync(join(out, "manifest.txt"))
  const broken = cli(["--verify", out])
  assert.equal(broken.status, 2)
  assert.match(broken.stderr, /manifest\.txt/)
})

test("a config-shaped input is refused and no secret reaches stdout, stderr or the pack", function () {
  const { dir, indexPath, inputPath } = fixture()
  writeFileSync(inputPath, JSON.stringify({ mcpServers: { secret: { env: { TOKEN: "never-output-this-secret" } } } }))
  const out = join(dir, "pack")
  const run = cli(["--input", inputPath, "--index", indexPath, "--out", out])
  assert.equal(run.status, 2, run.stdout)
  assert.equal(existsSync(out), false)
  assert.doesNotMatch(run.stdout + run.stderr, /never-output-this-secret/)
})

test("pack refuses to overwrite a directory that already has something in it", function () {
  const { dir, indexPath, inputPath } = fixture()
  const out = join(dir, "pack")
  writeFileSync(join(out === out ? dir : dir, "keep.txt"), "existing")
  const run = cli(["--input", inputPath, "--index", indexPath, "--out", dir])
  assert.equal(run.status, 3, run.stdout)
  assert.match(run.stderr, /不是空的/)
})

test("a missing index is refused instead of producing an empty pack", function () {
  const { dir, inputPath } = fixture()
  const run = cli(["--input", inputPath, "--index", join(dir, "missing.json"), "--out", join(dir, "pack")])
  assert.equal(run.status, 2)
  assert.match(run.stderr, /找不到证据索引/)
})
