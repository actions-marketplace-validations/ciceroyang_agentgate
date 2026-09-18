import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frameworkById, EVIDENCE_CLASS_IDS, OWNERS } from "../../policy/src/framework.mjs"
import { parseInventory, createInventoryReport } from "../../inventory/src/inventory.mjs"
import { classContractProblems } from "../src/classes.mjs"
import {
  buildPack, assertPackIntegrity, renderPackHtml, renderAnswers, renderManifest,
  writePack, verifyPack, PACK_SCHEMA, FORBIDDEN_WORDS, PACK_CONTENT_FILES,
} from "../src/pack.mjs"

const DIGEST = "a".repeat(64)
const WHEN = "2026-09-18T00:00:00.000Z"

function record(options) {
  const name = options.name
  const version = options.version || "1.2.3"
  const evidence = {
    packageManifest: {
      status: "clean", source: "test-fixture", findings: [],
      provenance: { package: { registry: "npm", name: name, version: version }, complete: true,
        content: { algorithm: "sha256", digest: DIGEST, scope: "packageManifest/v1:test-fixture" } },
    },
  }
  if (options.execution !== false) {
    evidence.registryDocument = {
      status: "clean", source: "test-fixture", findings: [],
      provenance: { package: { registry: "npm", name: name, version: version }, complete: true,
        content: { algorithm: "sha256", digest: DIGEST, scope: "registryDocument/v1:test-fixture" } },
    }
  }
  const result = {
    server: options.server, packages: [{ registry: "npm", name: name, version: version }],
    verdict: "clean", generatedAt: WHEN, evidence: evidence,
  }
  if (options.execution !== false) {
    result.scanExecution = { schemaVersion: "agentgate.scan-execution/v1",
      subject: { server: options.server, packages: [{ registry: "npm", name: name, version: version }] },
      scanner_execution: { components: ["registryDocument", "packageManifest"].map(function (id) {
        return { id: id, required: true, status: "completed", exit_code: 0, output_present: true,
          output_parseable: true, semantic_consistency: "ok", reason: null,
          findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } }
      }), required: 2, completed: 2, failed: 0, state: "complete" },
      digest: null, generatedAt: WHEN }
  }
  return result
}

const INDEX = {
  generatedAt: WHEN, scanner: "test-fixture-not-production", count: 2,
  records: [record({ server: "example/tool", name: "@example/tool" }), record({ server: "example/other", name: "other-mcp", version: "2.0.0", execution: false })],
}

function reportOf(text) {
  return createInventoryReport(parseInventory(text), INDEX, { generatedAt: WHEN })
}

function packOf(text, options) {
  return buildPack(Object.assign({
    report: reportOf(text), framework: frameworkById("aicaiq"), generatedAt: WHEN, toolVersion: "0.3.0",
  }, options || {}))
}

const TOOLS = JSON.stringify({ tools: [
  { name: "我的工具", server: "example/tool", package: "@example/tool", registry: "npm", version: "1.2.3" },
  { name: "另一个", server: "example/other", package: "other-mcp", registry: "npm", version: "2.0.0" },
  "an-unmatched-tool",
] })

test("the implemented evidence classes are exactly the ones the mapping may name", function () {
  assert.deepEqual(classContractProblems(), [])
  assert.equal(EVIDENCE_CLASS_IDS.length, 9)
})

test("every questionnaire item is classified and ours always name an evidence class", function () {
  const pack = packOf(TOOLS)
  assert.equal(pack.schemaVersion, PACK_SCHEMA)
  assert.equal(pack.answers.length, 58)
  for (const answer of pack.answers) {
    assert.ok(Object.prototype.hasOwnProperty.call(OWNERS, answer.owner), answer.id + " owner " + answer.owner)
    assert.ok(answer.boundary.length > 0, answer.id + " has no boundary")
    assert.ok(answer.weProvide.length > 0, answer.id + " has no claim")
    if (answer.owner === "we") assert.ok(answer.evidenceClasses.length > 0, answer.id + " claims without evidence")
    else assert.equal(answer.state, "not-ours", answer.id)
  }
  assert.equal(pack.coverage.questions.total, 58)
  assert.equal(pack.coverage.questions.ours + pack.coverage.questions.notOurs, 58)
})

test("a matched tool gives the inventory answers something to point at, and the state is computed", function () {
  const pack = packOf(TOOLS)
  assert.equal(pack.coverage.items.matched, 2, "the two packaged tools must match the index")
  assert.equal(pack.coverage.items.needsAttention, 1)
  const bom = pack.answers.filter(function (a) { return a.id === "STA-09.1" })[0]
  assert.ok(bom.backing.indexOf("tool-1") !== -1, "STA-09.1 should point at the matched tool")
  assert.equal(bom.state, "partial", "one of three tools did not match, so the answer is partial")
  const unmatchedOnly = packOf(JSON.stringify(["an-unmatched-tool"]))
  const bom2 = unmatchedOnly.answers.filter(function (a) { return a.id === "STA-09.1" })[0]
  assert.equal(bom2.state, "unmeasured")
  assert.equal(bom2.backing.length, 0)
  assert.equal(unmatchedOnly.coverage.questions.unmeasured > 0, true)
})

test("an empty inventory measures nothing and says so at the top of the page", function () {
  const pack = packOf("")
  assert.equal(pack.items.length, 0)
  const html = renderPackHtml(pack)
  assert.match(html, /没有完全测到|都测到了/)
  assert.match(html, new RegExp("本次有 " + (pack.coverage.questions.partial + pack.coverage.questions.unmeasured) + " 条"))
  for (const cls of pack.evidenceClasses) assert.notEqual(cls.state, "measured", cls.id + " must not be measured with no items")
})

test("a reference to evidence that does not exist fails generation", function () {
  const pack = packOf(TOOLS)
  const broken = JSON.parse(JSON.stringify(pack))
  broken.answers[0].backing = ["tool-99"]
  assert.throws(function () { assertPackIntegrity(broken) }, /引用完整性/)
  const broken2 = JSON.parse(JSON.stringify(pack))
  broken2.answers.filter(function (a) { return a.owner === "we" })[0].evidenceClasses = []
  assert.throws(function () { assertPackIntegrity(broken2) }, /引用完整性/)
})

test("the archive decides whether change history and integrity are measured", function () {
  const allMatched = JSON.stringify({ tools: [
    { name: "我的工具", server: "example/tool", package: "@example/tool", registry: "npm", version: "1.2.3" },
  ] })
  const one = packOf(allMatched, { archive: { present: true, verified: true, entries: [1] } })
  const two = packOf(allMatched, { archive: { present: true, verified: true, entries: [1, 2] } })
  const broken = packOf(allMatched, { archive: { present: true, verified: false, entries: [1, 2] } })
  const state = function (pack, id) { return pack.evidenceClasses.filter(function (c) { return c.id === id })[0].state }
  assert.equal(state(one, "change-history"), "unmeasured")
  assert.equal(state(two, "change-history"), "measured")
  assert.equal(state(broken, "archive-integrity"), "unmeasured")
  assert.equal(state(two, "archive-integrity"), "measured")
  // A context class still cannot cover a tool that never matched: an archive of a list that
  // contains an unidentified tool is not history for that tool.
  const mixed = packOf(TOOLS, { archive: { present: true, verified: true, entries: [1, 2] } })
  assert.equal(state(mixed, "change-history"), "partial")
  const history = mixed.evidenceClasses.filter(function (c) { return c.id === "change-history" })[0]
  assert.deepEqual(history.missing.map(function (m) { return m.item }), ["tool-3"])
  assert.equal(mixed.evidenceClasses.filter(function (c) { return c.id === "archive-integrity" })[0].backing.indexOf("tool-3"), -1)
  assert.notEqual(packOf(TOOLS).evidenceClasses.filter(function (c) { return c.id === "archive-integrity" })[0].state, "measured")
})

test("nothing we print about ourselves uses a compliance word", function () {
  const pack = packOf(TOOLS)
  for (const text of [renderPackHtml(pack), renderAnswers(pack), JSON.stringify(pack)]) {
    assert.equal(FORBIDDEN_WORDS.test(text), false, "found a forbidden word")
  }
})

test("the same input produces the same pack, byte for byte", function () {
  const first = JSON.stringify(packOf(TOOLS), null, 2)
  const second = JSON.stringify(packOf(TOOLS), null, 2)
  assert.equal(first, second)
})

test("a pack verifies, a changed byte fails it, and a missing manifest cannot be checked", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-pack-"))
  const pack = packOf(TOOLS)
  writePack(dir, pack, { command: "agentgate pack --input tools.json --framework aicaiq" })
  for (const name of PACK_CONTENT_FILES) assert.equal(existsSync(join(dir, name)), true, name)
  const ok = verifyPack(dir)
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.code, 0)
  const page = join(dir, "pack.html")
  const original = readFileSync(page, "utf8")
  writeFileSync(page, original + "<!-- tampered -->")
  const tampered = verifyPack(dir)
  assert.equal(tampered.code, 1)
  assert.match(tampered.problems.map(function (p) { return p.detail }).join(";"), /pack.html/)
  writeFileSync(page, original)
  assert.equal(verifyPack(dir).code, 0)
  writeFileSync(join(dir, "extra.txt"), "not part of the pack")
  assert.deepEqual(verifyPack(dir).extra, ["extra.txt"])
  rmSync(join(dir, "manifest.txt"))
  const noManifest = verifyPack(dir)
  assert.equal(noManifest.code, 2)
  assert.equal(noManifest.problems[0].kind, "missing-manifest")
  rmSync(dir, { recursive: true, force: true })
})

test("a non-empty target directory is refused instead of overwritten", function () {
  const dir = mkdtempSync(join(tmpdir(), "ag-pack-"))
  writeFileSync(join(dir, "keep.txt"), "existing")
  assert.throws(function () { writePack(dir, packOf(TOOLS), { command: "x" }) }, /不是空的/)
  rmSync(dir, { recursive: true, force: true })
})

test("the manifest names the command that produced it and does not hash itself", function () {
  const pack = packOf(TOOLS)
  const manifest = renderManifest({ pack: pack, command: "agentgate pack --input tools.json --framework aicaiq",
    files: PACK_CONTENT_FILES.map(function (name) { return { name: name, sha256: DIGEST } }) })
  assert.match(manifest, /command: agentgate pack --input tools\.json/)
  assert.equal(/^[0-9a-f]{64}  manifest\.txt$/m.test(manifest), false)
  assert.match(manifest, /只覆盖公开可查的注册表与包记录/)
})
