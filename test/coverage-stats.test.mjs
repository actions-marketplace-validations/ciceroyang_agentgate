import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { computeCoverage, renderCoverage } from "../scripts/coverage-stats.mjs";
import { scratchDir } from "./tmpdir.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const complete = (id = "registryDocument") => ({ id, required: true, status: "completed", output_present: true, output_parseable: true, semantic_consistency: "ok", reason: null, findings: {} });
const failed = (id = "registryDocument", reason = "not-audited") => ({ id, required: true, status: "failed", output_present: true, output_parseable: false, semantic_consistency: "unverified", reason, findings: {} });
const rec = (server, verdict, exec, findings = []) => ({
  server, verdict,
  scanExecution: exec ? { scanner_execution: exec } : undefined,
  evidence: { registryDocument: { status: "clean", findings } },
});

test("coverage stats count states, reasons, scanner runs and findings", () => {
  const index = {
    generatedAt: "2026-09-17T00:00:00Z", scanner: "abc", records: [
      rec("a/clean", "clean", { components: [complete()], required: 1, completed: 1, failed: 0, state: "complete" }),
      rec("b/gap", "incomplete", { components: [failed()], required: 1, completed: 0, failed: 1, state: "incomplete" }),
      rec("c/findings", "findings", { components: [complete("packageManifest")], required: 1, completed: 1, failed: 0, state: "complete" }, [
        { rule: "AG-1", severity: "high" }, { rule: "AG-2", severity: "unknown" },
      ]),
    ],
  };
  const stats = computeCoverage(index);
  assert.equal(stats.total, 3);
  assert.equal(stats.generatedAt, "2026-09-17T00:00:00Z");
  assert.deepEqual(stats.states, { complete: 2, incomplete: 1, absent: 0 });
  assert.deepEqual(stats.verdicts, { clean: 1, incomplete: 1, findings: 1 });
  assert.deepEqual(stats.cross.incomplete, { incomplete: 1 });
  assert.deepEqual(stats.perScanner.registryDocument, { completed: 1, failed: 1, skipped: 0 });
  assert.deepEqual(stats.perScanner.packageManifest, { completed: 1, failed: 0, skipped: 0 });
  assert.deepEqual(stats.reasons, { "registryDocument not-audited": 1 });
  assert.equal(stats.requiredRuns, 3);
  assert.equal(stats.completedRuns, 2);
  assert.equal(stats.findingsTotal, 2);
  assert.deepEqual(stats.findings, { high: 1, unknown: 1 });
  assert.equal(stats.verdictIncompleteButComplete, 0);
  assert.deepEqual(stats.problems, []);
  const text = renderCoverage(stats);
  assert.match(text, /records: 3/);
  assert.match(text, /fully measured: 2 \(66\.7%\)/);
  assert.match(text, /registryDocument not-audited: 1/);
  assert.match(text, /problems: none/);
});

test("a clean verdict without a complete coverage block is a problem, not a statistic", () => {
  const stats = computeCoverage({ records: [
    rec("a/liar", "clean", { components: [failed()], required: 1, completed: 0, failed: 1, state: "incomplete" }),
    rec("b/none", "findings", null),
  ] });
  assert.equal(stats.problems.length, 2);
  assert.match(stats.problems[0], /a\/liar: clean with an incomplete coverage block/);
  assert.match(stats.problems[1], /b\/none: findings without a coverage block/);
});

test("a coverage block that says complete while a required scanner did not finish is caught", () => {
  const stats = computeCoverage({ records: [rec("a/broken", "incomplete", { components: [failed()], required: 1, completed: 0, failed: 1, state: "complete" })] });
  assert.equal(stats.problems.length, 1);
  assert.match(stats.problems[0], /coverage says complete but a required scanner did not finish/);
});

test("the CLI reads an index, emits JSON and refuses a missing one", () => {
  const dir = scratchDir("ag-coverage-");
  const file = join(dir, "index.json");
  writeFileSync(file, JSON.stringify({ records: [rec("a/clean", "clean", { components: [complete()], required: 1, completed: 1, failed: 0, state: "complete" })] }));
  const ok = spawnSync(process.execPath, ["scripts/coverage-stats.mjs", "--index", file], { cwd: ROOT, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /fully measured: 1 \(100\.0%\)/);
  const json = spawnSync(process.execPath, ["scripts/coverage-stats.mjs", "--index", file, "--json"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).states.complete, 1);
  const missing = spawnSync(process.execPath, ["scripts/coverage-stats.mjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage/);
  const absent = spawnSync(process.execPath, ["scripts/coverage-stats.mjs", "--index", join(dir, "nope.json")], { cwd: ROOT, encoding: "utf8" });
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /cannot read index/);
});
