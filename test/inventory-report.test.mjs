import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInventoryReport } from "../packages/inventory/src/report.mjs";
import { parseInventory, createInventoryReport } from "../packages/inventory/src/inventory.mjs";

function fixture(extra = {}) {
  return {
    schemaVersion: 1, generatedAt: "2026-09-17T00:00:00Z",
    index: { generatedAt: "2026-09-16T00:00:00Z", snapshot: false, scanner: "commit-123", total: 2 },
    items: [{
      id: "entry-1", input: { name: "My MCP", server: "acme/tool", package: "@acme/tool", registry: "npm", version: "1.0.0" },
      state: "version_mismatch", label: "版本未对应", reason: "目录只记录其他版本", nextSteps: ["提供实际版本的证据"],
      candidates: [{ key: "candidate-1", server: "acme/tool", package: "@acme/tool", registry: "npm", version: "2.0.0" }],
      selected: { server: "acme/tool", package: "@acme/tool", registry: "npm", version: "2.0.0" },
      evidenceGeneratedAt: "2026-09-15T12:30:00Z",
      evidence: [{ block: "packageManifest", status: "findings", source: "guard-scan", reason: null, findings: [], provenance: {
        package: { registry: "npm", name: "@acme/tool", version: "2.0.0" },
        content: { algorithm: "sha256", digest: "a".repeat(64), scope: "manifest only; script bodies not inspected" }, complete: true,
      } }],
      findings: [{ rule: "AG-EXAMPLE", severity: "high", file: "package.json", message: "An example finding" }],
    }],
    ...extra,
  };
}

test("inventory report keeps gaps before findings and both versions with their source scope", () => {
  const html = renderInventoryReport(fixture());
  assert.ok(html.indexOf("先处理：未覆盖与待确认") < html.indexOf("已有证据中的发现"));
  for (const text of ["实际版本（用户填写）", "1.0.0", "目录版本", "2.0.0", "2026-09-16T00:00:00Z", "证据生成时间", "2026-09-15T12:30:00Z", "commit-123", "manifest only; script bodies not inspected", "a".repeat(64), "本报告未重新读取原内容计算摘要", "提供实际版本的证据"]) assert.ok(html.includes(text), text);
  assert.match(html, /不是安全认证/);
  assert.match(html, /没有扫描本机/);
});

test("inventory report escapes every input, candidate, finding and provenance field", () => {
  const payload = '\"><script src="https://evil.invalid/x">bad</script><img src=x onerror=alert(1)>&';
  const poison = {
    schemaVersion: payload, generatedAt: payload,
    index: { generatedAt: payload, snapshot: payload, scanner: payload, total: payload },
    items: [{
      id: payload, input: { name: payload, server: payload, package: payload, registry: payload, version: payload },
      state: payload, label: payload, reason: payload, nextSteps: [payload], evidenceGeneratedAt: payload,
      candidates: [{ key: payload, server: payload, package: payload, registry: payload, version: payload }], selected: null,
      evidence: [{ block: payload, status: payload, source: payload, reason: payload, provenance: {
        package: { registry: payload, name: payload, version: payload }, content: { algorithm: payload, digest: payload, scope: payload }, complete: false,
      }, findings: [] }],
      findings: [{ rule: payload, severity: payload, file: payload, message: payload, reason: payload }],
    }],
  };
  const html = renderInventoryReport(poison);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.ok(!html.includes(payload));
  assert.match(html, /&lt;script src=&quot;https:\/\/evil\.invalid\/x&quot;&gt;/);
  assert.doesNotMatch(html, /class="[^"]*evil/);
  const selected = renderInventoryReport({ ...poison, items: [{ ...poison.items[0], selected: poison.items[0].candidates[0] }] });
  assert.doesNotMatch(selected, /<script\b|<img\b/i);
});

test("inventory report is self-contained and has no active or remote resources", () => {
  const html = renderInventoryReport(fixture());
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<(?:script|iframe|object|embed|form|input|link|img)\b/i);
  assert.doesNotMatch(html, /\b(?:src|href|action)\s*=/i);
  assert.doesNotMatch(html, /@import|url\s*\(/i);
  assert.match(html, /<style>/);
});

test("sample, truncated and demonstration reports state their limitations", () => {
  const data = fixture({ demonstration: true });
  data.index.snapshot = true;
  data.index.truncated = true;
  const html = renderInventoryReport(data);
  assert.match(html, /演示报告/);
  assert.match(html, /不能代表完整目录或最新结果/);
  assert.match(html, /页面目录经过截断/);
  assert.match(html, /不代表任何人的实际安装/);
  assert.match(html, /样本历史快照/);
});

test("matched does not become a safety verdict, and totals come from the actual items", () => {
  const data = fixture({ summary: { total: 999, matched: 999, needsAttention: 0 } });
  data.items[0].state = "matched";
  data.items[0].label = "证据已对应";
  const html = renderInventoryReport(data);
  assert.doesNotMatch(html, />999</);
  assert.match(html, /证据已对应 · 不代表安全/);
  assert.match(html, /这不表示工具没有风险/);
  assert.match(html, /AG-EXAMPLE/);
  assert.match(html, /<b>1<\/b><span>仍需处理/);
});

test("missing provenance and absent versions stay explicit in the exported report", () => {
  const data = fixture();
  data.items[0].input.version = null;
  data.items[0].selected = null;
  data.items[0].evidence[0].provenance = null;
  data.items[0].evidenceGeneratedAt = null;
  const html = renderInventoryReport(data);
  assert.match(html, /未填写；不能确认实际版本/);
  assert.match(html, /尚待确认的候选/);
  assert.match(html, /未提供有效的 SHA-256 摘要/);
  assert.match(html, /未提供；不能代替实际版本/);
  assert.match(html, /证据生成时间<\/th><td>未提供/);
});

test("the shared matcher supplies the report's boolean sample warning and actual source time", () => {
  const index = {
    snapshot: true, generatedAt: "2026-09-16T00:00:00Z", records: [{
      server: "acme/tool", generatedAt: "2026-09-15T08:30:00Z", verdict: "clean",
      packages: [{ registry: "npm", name: "@acme/tool", version: "1.0.0" }],
      evidence: {},
    }],
  };
  const report = createInventoryReport(parseInventory('[{"name":"acme/tool","version":"1.0.0"}]'), index);
  assert.equal(report.items[0].state, "insufficient");
  const html = renderInventoryReport(report);
  assert.match(html, /本次使用样本目录/);
  assert.match(html, /2026-09-15T08:30:00Z/);
  assert.match(html, /<b>0<\/b><span>证据已对应/);
});
