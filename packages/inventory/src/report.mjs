/** A portable, script-free report. Treat every value from the inventory or index as data. */
function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function valueText(value, fallback = "未提供") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const STATES = {
  matched: "证据已对应",
  unmatched: "未找到对应记录",
  ambiguous: "需要确认候选",
  version_missing: "需要实际版本",
  version_mismatch: "版本未对应",
  insufficient: "证据不足",
};

function label(item) {
  return item.label || STATES[item.state] || "状态未知";
}

function inputName(item) {
  const input = item.input || {};
  return input.name || input.server || input.package || "未命名工具";
}

function rows(fields) {
  return fields.map(([name, value]) => "<tr><th scope=\"row\">" + esc(name) + "</th><td>" + esc(valueText(value)) + "</td></tr>").join("");
}

function nextSteps(item) {
  const steps = Array.isArray(item.nextSteps) ? item.nextSteps : [];
  return steps.length ? "<ul>" + steps.map(step => "<li>" + esc(step) + "</li>").join("") + "</ul>" : "<p>需要补充能确认工具身份、实际版本或检查范围的材料。</p>";
}

function renderEvidence(evidence) {
  const provenance = evidence.provenance || {};
  const content = provenance.content || {};
  const pkg = provenance.package || {};
  const digestRecorded = content.algorithm === "sha256" && typeof content.digest === "string" && /^[a-f0-9]{64}$/i.test(content.digest);
  const identity = [pkg.registry, pkg.name, pkg.version].filter(Boolean).join(" / ");
  return "<section class=\"evidence\"><h4>" + esc(evidence.block || "未命名证据块") + "</h4><table><tbody>" + rows([
    ["记录状态", evidence.status],
    ["来源", evidence.source],
    ["未覆盖原因", evidence.reason || "未记录额外原因；状态仍以本证据块为准"],
    ["对应包与版本", identity],
    ["检查范围", content.scope],
    ["来源证明", evidence.provenance ? (provenance.complete === true ? "完整（仅限上述检查范围）" : "不完整") : "未提供"],
    ["内容摘要状态", digestRecorded ? "已记录 SHA-256；本报告未重新读取原内容计算摘要" : "未提供有效的 SHA-256 摘要"],
    ["摘要算法", content.algorithm],
    ["内容摘要", content.digest],
  ]) + "</tbody></table></section>";
}

/**
 * The coverage block, per item. It answers "which scanners ran", which is a different question
 * from "what did they find" and from "is this safe". A record written before the block existed
 * says so; the absence is not a pass.
 */
function renderExecution(item) {
  if (!item.selected) return "";
  const execution = item.execution;
  if (!execution) return "<h4>扫描覆盖</h4><p class=\"gap\">这条目录记录写于 scan-execution 之前，没有记录哪些扫描器跑过。没有记录不等于跑完过。</p>";
  const components = Array.isArray(execution.components) ? execution.components : [];
  const counted = ["required", "completed", "failed"].every(key => Number.isInteger(execution[key]));
  const summary = counted
    ? "状态：" + valueText(execution.state, "未提供") + " · 必需 " + execution.required + " 个，跑完 " + execution.completed + " 个，没跑成 " + execution.failed + " 个"
    : "状态：" + valueText(execution.state, "未提供") + " · 计数未提供；不能据此判断跑完与否";
  const table = components.length
    ? "<table><thead><tr><th>扫描器</th><th>是否必需</th><th>状态</th><th>输出</th><th>一致性</th><th>原因</th></tr></thead><tbody>" +
      components.map(component => "<tr><td>" + esc(component.id) + "</td><td>" + (component.required ? "必需" : "可选") + "</td><td>" + esc(component.status) + "</td><td>" + (component.output_present ? "有" : "无") + " / " + (component.output_parseable ? "可读" : "不可读") + "</td><td>" + esc(component.semantic_consistency) + "</td><td>" + esc(component.reason || "") + "</td></tr>").join("") +
      "</tbody></table>"
    : "<p class=\"gap\">这条记录没有列出任何扫描器，所以它不可能被算作完整。</p>";
  return "<h4>扫描覆盖</h4><p class=\"" + (execution.state === "complete" && counted ? "muted" : "gap") + "\">" + esc(summary) + "</p>" + table +
    "<p class=\"muted\">以上覆盖只描述这份目录记录；没跑成的部分没有算作通过。版本未对应时，它也不能证明你的实际安装。</p>";
}

function renderItem(item, index) {
  const input = item.input || {};
  const selected = item.selected || {};
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const candidates = Array.isArray(item.candidates) ? item.candidates : [];
  return "<article class=\"item\"><h3>" + (index + 1) + ". " + esc(inputName(item)) + "</h3>" +
    "<p class=\"state\">" + esc(label(item)) + "</p><p>" + esc(item.reason || "未记录说明") + "</p>" +
    "<div class=\"identity\"><section><h4>用户填写的清单</h4><table><tbody>" + rows([
      ["名称", input.name], ["Server", input.server], ["包名", input.package], ["注册表", input.registry], ["实际版本（用户填写）", input.version || "未填写；不能确认实际版本"],
    ]) + "</tbody></table></section><section><h4>对应的目录记录</h4><table><tbody>" + rows([
      ["Server", selected.server || "尚未确认"], ["包名", selected.package], ["注册表", selected.registry], ["目录版本", selected.version || "未提供；不能代替实际版本"], ["证据生成时间", item.evidenceGeneratedAt],
    ]) + "</tbody></table></section></div>" +
    (!item.selected && candidates.length ? "<h4>尚待确认的候选</h4><ul>" + candidates.map(candidate => "<li>" + esc([candidate.server, candidate.package, candidate.registry, candidate.version].filter(Boolean).join(" / ")) + "</li>").join("") + "</ul>" : "") +
    renderExecution(item) +
    (evidence.length ? "<h4>目录中的证据与检查范围</h4>" + evidence.map(renderEvidence).join("") : "<p class=\"gap\">没有可用于本条清单的证据块。未覆盖不等于未发现问题。</p>") + "</article>";
}

/**
 * The questionnaire mapping, when one was asked for. It is a separate section for a reason: the
 * per-item rows above are evidence, and this table is who answers what. Merging them would let
 * the reader take one for the other.
 */
function renderFramework(framework) {
  const owners = { we: "我们出证据", customer: "你们自证", "third-party": "第三方" };
  const entries = Array.isArray(framework.entries) ? framework.entries : [];
  return "<h2>问卷对照（" + esc(framework.name) + "）</h2>" +
    "<p class=\"muted\">" + esc(framework.note) + " 来源：" + esc(framework.source) + "</p>" +
    "<table><thead><tr><th>条目</th><th>它问什么</th><th>最终由谁交账</th><th>我们能给什么</th><th>边界</th></tr></thead><tbody>" +
    entries.map(function (entry) {
      return "<tr><td>" + esc(entry.id) + "</td><td>" + esc(entry.topic) + "</td><td>" + esc(owners[entry.owner] || entry.owner) + "</td><td>" + esc(entry.weProvide) + "</td><td>" + esc(entry.boundary) + "</td></tr>";
    }).join("") + "</tbody></table>";
}

/** The HTML contains no scripts, forms, external resources or untrusted markup. */
export function renderInventoryReport(report, options) {
  const data = report || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const source = data.index || {};
  const gaps = items.filter(item => item.state !== "matched");
  const findingItems = items.flatMap(item => (Array.isArray(item.findings) ? item.findings : []).map(finding => ({ item, finding })));
  const sample = source.snapshot === true || /sample|示例|样本/i.test(valueText(source.snapshot, ""));
  const snapshot = source.snapshot === true ? "样本历史快照" : source.snapshot === false ? "公开证据快照（非样本）" : valueText(source.snapshot, "类型未提供");
  const counts = { total: items.length, matched: items.filter(item => item.state === "matched").length, attention: items.filter(item => item.state !== "matched" || (Array.isArray(item.findings) && item.findings.length > 0)).length };
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><title>我的工具清单 · 证据报告 · agentgate</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#fff;color:#17191b;font:15px/1.75 system-ui,-apple-system,"PingFang SC",sans-serif}main{max-width:1000px;margin:auto;padding:44px 28px 72px}.brand{font-size:13px;letter-spacing:.05em;color:#656b72}h1{font-size:28px;line-height:1.3;margin:16px 0 12px}h2{font-size:20px;margin:36px 0 14px;padding-top:24px;border-top:1px solid #dfe3e6}h3{font-size:17px;margin:0 0 10px}h4{font-size:14px;margin:18px 0 8px}p{margin:8px 0}ul{padding-left:22px}.muted{color:#656b72;font-size:13px}.notice{padding:16px 18px;background:#f4f6f7;border:1px solid #dfe3e6;border-radius:8px;margin:20px 0}.gap{padding:14px 16px;background:#fffbf2;border-left:3px solid #b48228}.summary{display:flex;flex-wrap:wrap;gap:12px;margin:22px 0}.summary div{flex:1;min-width:140px;padding:14px 16px;border:1px solid #dfe3e6;border-radius:8px}.summary b{display:block;font-size:25px;font-weight:600}.summary span{font-size:13px;color:#656b72}.item{border:1px solid #dfe3e6;border-radius:8px;padding:20px;margin:16px 0;break-inside:avoid}.state{display:inline-block;font-size:13px;border:1px solid #b6bec6;border-radius:4px;padding:2px 8px}.identity{display:grid;grid-template-columns:1fr 1fr;gap:20px}.evidence{margin-top:20px;padding-top:2px;border-top:1px solid #e7eaed}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:8px 10px;border-bottom:1px solid #e7eaed;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{font-weight:500;color:#656b72;width:150px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;background:#f5f6f7;padding:12px;border-radius:4px}footer{margin-top:36px;padding-top:18px;border-top:1px solid #dfe3e6;font-size:13px;color:#656b72}.finding{margin:12px 0;padding:16px;border:1px solid #dfe3e6;border-radius:6px}@media(max-width:640px){main{padding:26px 16px 48px}.identity{grid-template-columns:1fr;gap:0}.item{padding:16px}th{width:110px}h1{font-size:24px}}@media print{main{max-width:none;padding:12px}.notice,.gap{-webkit-print-color-adjust:exact;print-color-adjust:exact}h2,h3,h4{break-after:avoid}.item{break-inside:auto}.evidence,.finding{break-inside:avoid}}
</style></head><body><main>
<p class="brand">智量 / agentgate</p><h1>我的工具清单 · 证据报告</h1>
<p class="muted">生成时间：${esc(valueText(data.generatedAt))} · 清单报告版本：${esc(valueText(data.schemaVersion))}</p>
${data.demonstration === true ? '<div class="gap"><strong>演示报告：这份清单来自页面示例，不代表任何人的实际安装或使用情况。</strong></div>' : ''}
<div class="notice"><strong>“证据已对应”表示工具身份与目录证据符合对应条件，不是安全认证或允许使用的审批。</strong><p>本报告只对照用户填写的清单与已有注册表历史资料，没有扫描本机、验证实际安装、执行工具或访问其服务。历史资料无法证明当前运行行为，用户填写的版本也未经本机核验。</p><p>报告由浏览器在本地生成；下载后包含你填写的工具名称与版本，分享前请确认这些内容可外发。</p></div>
<div class="summary"><div><b>${counts.total}</b><span>清单条目</span></div><div><b>${counts.matched}</b><span>证据已对应 · 不代表安全</span></div><div><b>${counts.attention}</b><span>仍需处理 · 含待查看的发现</span></div></div>
<h2>本次采用的目录</h2><table><tbody>${rows([
    ["快照类型", snapshot], ["目录生成时间", source.generatedAt], ["扫描器版本", source.scanner], ["目录记录总数", source.total],
  ])}</tbody></table>
<p class="${sample ? 'gap' : 'muted'}">${sample ? '本次使用样本目录；它用于演示，不能代表完整目录或最新结果。' : '本次使用的是页面加载时已有的历史快照，生成报告不会更新目录或重新检查上游内容。'}</p>
${source.truncated === true ? '<p class="gap">页面目录经过截断。未找到记录可能是本页未包含，不能据此判断该工具没有公开证据。</p>' : ''}
<h2>先处理：未覆盖与待确认</h2>
${gaps.length ? gaps.map(item => '<section class="gap"><h3>' + esc(inputName(item)) + ' · ' + esc(label(item)) + '</h3><p>' + esc(item.reason || '仍需补充可对应的材料') + '</p>' + nextSteps(item) + '</section>').join('\n') : '<p>在本次输入和目录范围内，没有待补充的对应项。这不表示工具没有风险，也不扩展任何证据块的检查范围。</p>'}
<h2>已有证据中的发现</h2>
<p class="muted">以下发现属于所选目录记录。版本未对应时，不能把它们直接归于你的实际安装版本。</p>
${findingItems.length ? findingItems.map(({ item, finding }) => '<section class="finding"><h3>' + esc(inputName(item)) + '</h3><p class="muted">目录对象：' + esc(item.selected ? [item.selected.server, item.selected.package, item.selected.version].filter(Boolean).join(' / ') : '尚未确认') + ' · 证据块：' + esc(finding.block || '未提供') + '</p><p><strong>' + esc(finding.rule || '未提供规则') + '</strong> · ' + esc(finding.severity || '级别未提供') + '</p><p>' + esc(finding.message || finding.evidence || '未记录发现说明') + '</p>' + (finding.reason ? '<p>' + esc(finding.reason) + '</p>' : '') + (finding.file ? '<p class="muted">位置：' + esc(finding.file) + '</p>' : '') + '</section>').join('\n') : '<p>本次已呈现的目录证据中没有附带发现；未覆盖项仍以上一节为准，不能据此判断所有工具无风险。</p>'}
<h2>逐项对应与证据范围</h2>${items.map(renderItem).join('\n')}
${options && options.framework ? renderFramework(options.framework) : ""}
<footer>本报告是静态、无脚本的 HTML 文件，不会联网更新。目录证据、实际安装与组织批准是三件不同的事；本报告只记录清单与目录证据的对应情况。未覆盖的部分没有被算作通过。</footer>
</main></body></html>\n`;
}
