import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  compilePattern,
  stripFencedBlocks,
  ruleMatches,
  loadCatalog,
  precisionProbes,
  convergenceProbe,
} from "../scripts/rule-coverage.mjs"

function synthetic() {
  const root = mkdtempSync(join(tmpdir(), "rule-coverage-"))
  const dataDir = join(root, "data")
  const benignDir = join(root, "benign")
  mkdirSync(dataDir)
  mkdirSync(benignDir)
  const catalog = {
    source: "/synthetic/rules",
    files: 2,
    rules_digest: "sha256:synthetic",
    rules: [
      { id: "R1", scanTarget: "content", asi: ["ASI01"], cves: ["CVE-2026-0001"], tier: "pattern", severity: "high", conditionMode: "all", suppressInCodeBlocks: false },
      { id: "R2", scanTarget: "mcp", asi: ["ASI05"], cves: [], tier: "pattern", severity: "medium", conditionMode: "any", suppressInCodeBlocks: true },
    ],
    conditions: [
      { id: "R1", field: "content", operator: "regex", value: "alpha" },
      { id: "R1", field: "content", operator: "regex", value: "beta" },
      { id: "R2", field: "content", operator: "regex", value: "mcpServers" },
    ],
    parseErrors: [],
  }
  const conditionsPath = join(dataDir, "atr-conditions.json")
  writeFileSync(conditionsPath, JSON.stringify(catalog))
  const rows = [
    { text: "alpha only" },
    { text: "alpha and beta" },
    { text: "```\nmcpServers\n```", for_rule: "R2" },
    { text: "mcpServers here", for_rule: "R2" },
    { text: "mcpServers here", for_rule: "R3" },
  ]
  writeFileSync(join(benignDir, "corpus.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
  return { root, conditionsPath, benignDir }
}

test("compilePattern converts Python-style inline flags and never throws", () => {
  assert.equal(compilePattern("(?i)abc").test("ABC"), true)
  assert.equal(compilePattern("(?si)a.b").test("A\nB"), true)
  assert.equal(compilePattern("plain").test("plain"), true)
  assert.equal(compilePattern("["), null)
})

test("compilePattern retries with the Unicode flag for astral literals", () => {
  const astral = "[" + String.fromCodePoint(0xe0000) + "-" + String.fromCodePoint(0xe007f) + "]{3,}"
  const re = compilePattern(astral)
  assert.ok(re, "astral range should compile via the Unicode retry")
  assert.equal(re.test(String.fromCodePoint(0xe0001).repeat(3)), true)
})

test("stripFencedBlocks removes fenced documentation but keeps inline code", () => {
  assert.equal(stripFencedBlocks("a\n```json\n{\"x\":1}\n```\nb").includes("x"), false)
  assert.equal(stripFencedBlocks("a `inline` b"), "a `inline` b")
})

test("ruleMatches honours condition mode and the code-block gate", () => {
  const rule = (mode, suppress, values) => ({
    id: "r",
    mode,
    suppress,
    conditions: values.map((v) => ({ id: "r", field: "content", re: compilePattern(v) })),
  })
  assert.equal(ruleMatches(rule("any", false, ["alpha", "beta"]), "zz beta zz"), true)
  assert.equal(ruleMatches(rule("all", false, ["alpha", "beta"]), "zz beta zz"), false)
  assert.equal(ruleMatches(rule("all", false, ["alpha", "beta"]), "alpha and beta"), true)
  assert.equal(ruleMatches(rule("any", true, ["mcpServers"]), "```\nmcpServers\n```"), false)
  assert.equal(ruleMatches(rule("any", true, ["mcpServers"]), "mcpServers outside"), true)
})

test("loadCatalog counts modes, gates and only evaluable patterns", () => {
  const { conditionsPath } = synthetic()
  const { conditions, ruleIndex, catalog } = loadCatalog(conditionsPath)
  assert.equal(catalog.rules, 2)
  assert.equal(conditions.length, 3)
  assert.equal(catalog.extractedConditions, 3)
  assert.deepEqual(catalog.modes, { any: 1, all: 1 })
  assert.equal(catalog.suppressedRules, 1)
  assert.equal(catalog.cveRules, 1)
  assert.equal(catalog.cveCount, 1)
  assert.equal(catalog.skipped.length, 0)
  assert.equal(ruleIndex.length, 2)
})

test("precisionProbes separates pattern-level from rule-level and finds twins and orphans", () => {
  const { conditionsPath, benignDir } = synthetic()
  const { conditions, ruleIndex } = loadCatalog(conditionsPath)
  const p = precisionProbes(conditions, ruleIndex, benignDir)
  assert.equal(p.samples, 5)
  assert.equal(p.files, 1)
  // pattern level: every sample contains a matching fragment, fenced or not
  assert.equal(p.scopes[0].flagged, 5)
  // rule level: R1 is all-mode (only sample 2 satisfies both), R2 is gated by the fence
  assert.equal(p.rScopes[0].flagged, 3)
  assert.equal(p.rScopes[2].rulesApplied, 1)
  // the fence suppresses sample 3 for R2, so rule-level must not count it
  assert.equal(p.rScopes[0].perRule.R2, 2)
  assert.equal(p.twin.named, 3)
  assert.equal(p.twin.namedRules, 2)
  assert.deepEqual(p.twin.orphans, [{ rule: "R3", samples: 1 }])
  assert.equal(p.twin.patternLevel.tested, 2)
  assert.equal(p.twin.patternLevel.violations, 2)
  assert.equal(p.twin.ruleLevel.tested, 2)
  assert.equal(p.twin.ruleLevel.violations, 1)
})

test("convergenceProbe reports rank agreement against a published measurement", () => {
  const root = mkdtempSync(join(tmpdir(), "rule-convergence-"))
  const path = join(root, "benign-fp-measurement.json")
  writeFileSync(path, JSON.stringify({
    generated_at: "2026-09-02",
    commit: "deadbeef",
    corpus_digest: "digest",
    sample_count: 10,
    shapes: ["wide-raw"],
    corpora: ["a"],
    rules: {
      A: { fp_count: 5, maturity: "test" },
      B: { fp_count: 3, maturity: "test" },
      C: { fp_count: 1, maturity: "test" },
    },
  }))
  const same = convergenceProbe({ A: 10, B: 5, C: 1 }, path)
  assert.equal(same.measuredRules, 3)
  assert.equal(same.spearman, 1)
  assert.equal(same.top[0].rule, "A")
  assert.equal(same.theirTotal, 9)
  const inverted = convergenceProbe({ A: 1, B: 5, C: 10 }, path)
  assert.equal(inverted.spearman, -1)
})
