/**
 * A report someone can read without a terminal.
 *
 * Static HTML, no script, printable, one file: this is what the free evidence checkup
 * actually hands over. The console output is for the engineer running the scan; this is
 * for the person who has to be shown why a tool was refused.
 *
 * Anything that could not be measured is its own section, above the findings, because a
 * report that buries what it did not check reads as more complete than it is.
 */
export function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const COLORS = { critical: "#b62324", high: "#d13438", medium: "#d29922", low: "#5b6472", info: "#8b949e" }

export function toHtmlReport(result, meta) {
  const m = meta || {}
  const findings = result.findings || []
  const coverage = result.coverage || {}
  const evidenceMissing = coverage.evidenceMissing || []
  const checksFailed = coverage.checksFailed || []
  const malformed = coverage.malformed || []
  const verdict = String(result.verdict || "unknown")

  const head = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>证据体检报告 · agentgate</title>",
    "<style>",
    "body{margin:0;background:#fff;color:#111;font:15px/1.7 system-ui,-apple-system,'PingFang SC',sans-serif}",
    "main{max-width:900px;margin:0 auto;padding:40px 22px 80px}",
    "h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:34px 0 10px;padding-top:16px;border-top:1px solid #e6e8eb}",
    ".muted{color:#5b6472;font-size:13px}",
    ".verdict{display:inline-block;padding:4px 12px;border-radius:999px;color:#fff;font-weight:600}",
    ".clean{background:#2ea043}.findings{background:#d29922}.incomplete{background:#8b949e}.unknown{background:#5b6472}",
    "table{width:100%;border-collapse:collapse;margin:12px 0}",
    "th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e6e8eb;vertical-align:top;font-size:14px}",
    "th{color:#5b6472;font-weight:600}",
    ".sev{font-weight:600}",
    "pre{white-space:pre-wrap;word-break:break-word;background:#f5f6f7;padding:10px;border-radius:6px;font-size:13px}",
    ".box{border:1px solid #e6e8eb;border-radius:8px;padding:12px 14px;margin:10px 0}",
    ".warn{border-color:#d29922;background:#fffaf0}",
    "footer{margin-top:48px;padding-top:16px;border-top:1px solid #e6e8eb}",
    "@media print{main{max-width:none}h2{page-break-after:avoid}}",
    "</style></head><body><main>",
  ].join("\n")

  const title = [
    "<h1>证据体检报告</h1>",
    '<p class="muted">对象:' + esc(m.root || "(未指定)") + "<br>生成时间:" + esc(m.generatedAt || new Date().toISOString()) + "<br>策略版本:" + esc(result.policyVersion || "unknown") + "</p>",
    '<p><span class="verdict ' + verdict + '">' + esc(verdict.toUpperCase()) + "</span></p>",
    verdict === "incomplete"
      ? '<div class="box warn"><b>这份结果不完整,不等于通过。</b>下面有检查没能跑完,或有证据块无法测量。它们列在发现之前。</div>'
      : "",
  ].join("\n")

  const coverageSection = [
    "<h2>检查覆盖</h2>",
    "<table><tr><th>项目</th><th>结果</th></tr>",
    "<tr><td>执行的检查</td><td>" + esc((coverage.checksRun || []).join(", ") || "(无)") + "</td></tr>",
    "<tr><td>未能执行的检查</td><td>" + (checksFailed.length ? esc(checksFailed.map(function (c) { return c.id + ": " + c.error }).join("; ")) : "无") + "</td></tr>",
    "<tr><td>读到的文件</td><td>" + esc((coverage.filesRead || []).join(", ") || "(无)") + "</td></tr>",
    "<tr><td>无法解析的文件</td><td>" + esc((coverage.unparsedFiles || []).join(", ") || "无") + "</td></tr>",
    "<tr><td>格式错误的输入</td><td>" + (malformed.length ? esc(malformed.map(function (x) { return x.source + ": " + x.detail }).join("; ")) : "无") + "</td></tr>",
    "</table>",
  ].join("\n")

  const unmeasuredSection = evidenceMissing.length === 0 ? "" : [
    "<h2>无法测量的部分(" + evidenceMissing.length + ")</h2>",
    '<p class="muted">这些不是"没问题",而是"没人查过"。它们使整份报告的结论变成 INCOMPLETE。</p>',
    "<table><tr><th>对象</th><th>证据块</th><th>原因</th></tr>",
    evidenceMissing.slice(0, 200).map(function (x) {
      return "<tr><td>" + esc(x.server) + "</td><td>" + esc(x.block) + "</td><td>" + esc(x.reason) + "</td></tr>"
    }).join("\n"),
    "</table>",
  ].join("\n")

  const findingsSection = [
    "<h2>发现(" + findings.length + ")</h2>",
    findings.length === 0
      ? '<p class="muted">没有触发策略的内容。</p>'
      : "<table><tr><th>级别</th><th>规则</th><th>位置</th><th>结论与原因</th></tr>" + findings.map(function (f) {
          return "<tr><td class=\"sev\" style=\"color:" + (COLORS[f.severity] || "#111") + "\">" + esc(String(f.severity || "").toUpperCase()) + "</td><td>" + esc(f.rule) + "</td><td>" + esc(f.file || "") + "</td><td>" + esc(f.message) + "<br><span class=\"muted\">" + esc(f.reason || "") + "</span></td></tr>"
        }).join("\n") + "</table>",
  ].join("\n")

  const policySection = m.policy ? [
    "<h2>使用的策略</h2>",
    "<pre>" + esc(JSON.stringify(m.policy, null, 2)) + "</pre>",
  ].join("\n") : ""

  const footer = [
    "<footer>",
    '<p class="muted">这份报告由 agentgate 生成。每个结论都能追到具体的文件与字段;上表中"无法测量"的部分没有被算作通过。</p>',
    '<p class="muted">复现:在仓库根目录执行 <code>node bin/agentgate.mjs check --policy &lt;策略文件&gt; --root .</code>,退出码 0 = clean、1 = findings、2 = incomplete。</p>',
    "</footer>",
  ].join("\n")

  return head + title + coverageSection + unmeasuredSection + findingsSection + policySection + footer + "</main></body></html>\n"
}
