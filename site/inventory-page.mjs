import { parseInventory, createInventoryReport } from "./inventory.mjs";
import { renderInventoryReport } from "./inventory-report.mjs";

const MAX_BYTES = 1024 * 1024;
const $ = id => document.getElementById(id);
const input = $("inventory-input");
const fileInput = $("inventory-file");
let index = null;
let entries = [];
let selections = {};
let report = null;
let reportHtml = null;
let demonstration = false;
let revision = 0;
let downloadUrl = null;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function clearError() { $("page-error").hidden = true; $("page-error").textContent = ""; }
function showError(error) {
  $("page-error").textContent = error instanceof Error ? error.message : String(error);
  $("page-error").hidden = false;
  $("page-error").focus();
}
function setStatus(text) { $("work-status").textContent = text; }
function invalidatePreview(message = "材料已变更，请重新生成报告预览。") {
  reportHtml = null;
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  $("download-button").disabled = true;
  $("report-preview").removeAttribute("srcdoc");
  $("preview-section").hidden = true;
  $("preview-status").textContent = message;
}
function invalidateInput() {
  revision += 1;
  invalidatePreview();
  entries = [];
  selections = {};
  report = null;
  $("results-section").hidden = true;
  $("inventory-items").replaceChildren();
}

function indexDescription() {
  const box = $("index-status");
  box.replaceChildren();
  const sample = index.snapshot === true || index.sample === true || /sample|样本|示例/i.test(String(index.snapshot || ""));
  box.classList.toggle("sample", sample);
  box.append(element("strong", sample ? "正在使用样本目录" : "正在使用已有历史快照"));
  box.append(element("p", "生成时间：" + (index.generatedAt || "未提供") + " · 本页记录：" + index.records.length + " · 目录总数：" + (index.total ?? index.count ?? index.records.length)));
  box.append(element("p", sample ? "样本用于演示，不能代表完整目录或最新状态。即使名称和版本相同，也不能用样本证明实际情况。" : "此页面不会重新联网查询目录；版本与时间以每条记录为准，历史资料不代表当前运行情况。"));
  if (index.truncated) box.append(element("p", "本页目录已截断。未找到的工具可能只是未包含在本页中。"));
}

function rebuild() {
  report = createInventoryReport(entries, index, { selections, generatedAt: new Date().toISOString() });
  report.demonstration = demonstration;
  renderSummary();
}

function renderSummary() {
  const items = report.items || [];
  const matched = items.filter(item => item.state === "matched").length;
  const attention = items.filter(item => item.state !== "matched" || (item.findings || []).length > 0).length;
  const box = $("report-summary");
  box.replaceChildren();
  for (const [number, text] of [[items.length, "条清单"], [matched, "条证据已对应"], [attention, "条仍需处理"]]) {
    const part = element("p");
    part.append(element("b", number), document.createTextNode(text));
    box.append(part);
  }
}

function selectedKey(item) {
  return selections[item.id] || ((item.candidates || []).find(candidate => item.selected && candidate.server === item.selected.server && candidate.package === item.selected.package && candidate.registry === item.selected.registry && candidate.version === item.selected.version) || {}).key || "";
}

function writeItemStatus(card, item) {
  const state = card.querySelector(".state");
  state.textContent = item.label || item.state || "状态未知";
  state.classList.toggle("attention", item.state !== "matched");
  card.querySelector(".item-reason").textContent = item.reason || "";
  const next = card.querySelector(".item-next");
  next.replaceChildren();
  for (const step of item.nextSteps || []) next.append(element("li", step));
  next.hidden = !next.childElementCount;
  card.querySelector(".version-reference").textContent = item.selected
    ? "目录记录版本：" + (item.selected.version || "未提供") + "。不会自动写入实际版本输入框。"
    : "先确认目录记录；实际版本始终由你填写。";
  const select = card.querySelector("select");
  if (select) select.value = selectedKey(item);
  const note = card.querySelector(".evidence-note");
  if (note) note.textContent = "本条目录证据：" + (item.evidence || []).length + " 个证据块 · 证据生成时间：" + (item.evidenceGeneratedAt || "未提供") + "。来源、检查范围和内容摘要会保留在报告中。";
}

function renderItems() {
  const container = $("inventory-items");
  container.replaceChildren();
  report.items.forEach((item, position) => {
    const entry = entries.find(value => value.id === item.id) || item.input || {};
    const card = element("article", undefined, "item-card");
    card.dataset.entry = item.id;
    const top = element("div", undefined, "item-top");
    const heading = element("div");
    heading.append(element("span", "工具 " + (position + 1), "item-number"));
    const title = element("h3", entry.name || entry.server || entry.package || "未命名工具");
    title.id = "tool-title-" + position;
    heading.append(title);
    card.setAttribute("aria-labelledby", title.id);
    top.append(heading, element("span", undefined, "state"));
    card.append(top, element("p", undefined, "item-reason"));

    const controls = element("div", undefined, "item-controls");
    const candidates = element("div");
    const selectId = "tool-candidate-" + position;
    const candidateLabel = element("label", "对应的目录记录");
    candidateLabel.htmlFor = selectId;
    const select = element("select");
    select.id = selectId;
    select.dataset.candidateFor = item.id;
    const empty = element("option", item.candidates.length ? "请选择或确认对应记录" : "没有找到候选记录");
    empty.value = "";
    select.append(empty);
    for (const candidate of item.candidates || []) {
      const option = element("option", candidate.server + (candidate.package ? " · " + candidate.package : "") + (candidate.version ? " @ " + candidate.version : " · 版本未知"));
      option.value = candidate.key;
      select.append(option);
    }
    select.value = selectedKey(item);
    select.disabled = !item.candidates.length;
    candidates.append(candidateLabel, select);

    const versionArea = element("div");
    const versionId = "tool-version-" + position;
    const versionLabel = element("label", "你实际使用的版本");
    versionLabel.htmlFor = versionId;
    const version = element("input");
    version.id = versionId;
    version.type = "text";
    version.autocomplete = "off";
    version.spellcheck = false;
    version.placeholder = "未确认就先留空";
    version.value = entry.version || "";
    version.dataset.versionFor = item.id;
    version.setAttribute("aria-describedby", "version-help-" + position);
    const versionHelp = element("p", "从你自己的配置或安装记录中确认。", "help");
    versionHelp.id = "version-help-" + position;
    versionArea.append(versionLabel, version, versionHelp);
    controls.append(candidates, versionArea);
    card.append(controls, element("p", undefined, "version-reference"), element("ul", undefined, "item-next"));
    const evidence = item.evidence || [];
    card.append(element("p", "本条目录证据：" + evidence.length + " 个证据块。来源、检查范围和内容摘要会保留在导出的报告中。", "evidence-note"));
    writeItemStatus(card, item);
    container.append(card);
  });
}

$("inventory-form").addEventListener("submit", event => {
  event.preventDefault();
  clearError();
  invalidateInput();
  if (!index) { showError(new Error("目录尚不可用，暂时无法核对清单。")); return; }
  try {
    if (new TextEncoder().encode(input.value).length > MAX_BYTES) throw new Error("清单超过 1 MB，请减少内容后重试。");
    entries = parseInventory(input.value);
    if (!entries.length) throw new Error("先粘贴至少一个工具名称，或选择一份清单文件。");
    rebuild();
    renderItems();
    $("results-section").hidden = false;
    setStatus("已核对 " + entries.length + " 条。请确认候选和实际版本；未知项会保留在报告中。");
    $("results-heading").focus();
  } catch (error) { report = null; showError(error); setStatus("未生成结果。请按提示调整清单后重试。"); }
});

input.addEventListener("input", () => {
  clearError();
  invalidateInput();
  fileInput.value = "";
  setStatus("清单已修改，请重新核对。旧报告已失效。");
});

fileInput.addEventListener("change", async () => {
  clearError();
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  invalidateInput();
  const thisRevision = revision;
  try {
    if (!/\.(txt|json)$/i.test(file.name)) throw new Error("请选择 .txt 或 .json 清单文件。");
    if (file.size > MAX_BYTES) throw new Error("文件超过 1 MB，请选择更小的清单。");
    const text = await file.text();
    if (thisRevision !== revision) return;
    input.value = text;
    demonstration = false;
    $("demo-note").hidden = true;
    setStatus("已在本地读取“" + file.name + "”。点击“核对清单”继续；文件没有上传。");
  } catch (error) { if (thisRevision === revision) { showError(error); setStatus("文件未导入。可以重新选择，或直接粘贴清单。"); } }
});

$("example-button").addEventListener("click", () => {
  clearError();
  invalidateInput();
  const record = index.records.find(record => record && record.server && Array.isArray(record.packages) && record.packages.some(pkg => pkg && pkg.name));
  const pkg = record && record.packages.find(pkg => pkg && pkg.name);
  input.value = JSON.stringify([
    record ? { name: record.server, ...(pkg.version ? { version: pkg.version } : {}) } : { name: "demo/example-tool", version: "1.0.0" },
    { name: "demo/not-in-this-directory" },
  ], null, 2);
  demonstration = true;
  $("demo-note").hidden = false;
  fileInput.value = "";
  setStatus("已填入演示清单。第一项取自当前目录，第二项用于展示未覆盖；这些不是你的安装数据。");
  input.focus();
});

$("reset-button").addEventListener("click", () => {
  clearError();
  invalidateInput();
  input.value = "";
  fileInput.value = "";
  demonstration = false;
  $("demo-note").hidden = true;
  setStatus("清单和报告已从页面内存中清除。已下载的文件由你自行保留或删除。");
  input.focus();
});

$("inventory-items").addEventListener("change", event => {
  const id = event.target.dataset.candidateFor;
  if (!id) return;
  clearError();
  invalidatePreview();
  selections[id] = event.target.value;
  try {
    rebuild();
    const oldId = event.target.id;
    renderItems();
    $(oldId)?.focus();
    setStatus("对应记录已调整。请重新生成预览后下载。");
  } catch (error) { showError(error); }
});

$("inventory-items").addEventListener("input", event => {
  const id = event.target.dataset.versionFor;
  if (!id) return;
  clearError();
  invalidatePreview();
  const entry = entries.find(value => value.id === id);
  if (entry) entry.version = event.target.value.trim();
  try {
    rebuild();
    // A version edit can make another row a duplicate (or resolve a duplicate).
    // Refresh all verdicts without replacing inputs, preserving typing focus.
    for (const item of report.items) {
      const card = $("inventory-items").querySelector('[data-entry="' + item.id + '"]');
      if (card) writeItemStatus(card, item);
    }
    setStatus("实际版本已修改。请重新生成预览后下载。");
  } catch (error) { report = null; showError(error); }
});

$("preview-button").addEventListener("click", () => {
  clearError();
  invalidatePreview();
  try {
    if (!entries.length) throw new Error("请先核对一份清单。");
    rebuild();
    reportHtml = renderInventoryReport(report);
    $("report-preview").srcdoc = reportHtml;
    $("preview-section").hidden = false;
    $("download-button").disabled = false;
    $("preview-status").textContent = (demonstration ? "演示报告 · " : "") + "本地生成于 " + report.generatedAt + "；后续修改会使这份预览与下载失效。";
    $("preview-heading").focus();
    setStatus("报告已在本地生成。请先查看未覆盖项，再决定是否下载与分享。");
  } catch (error) { reportHtml = null; showError(error); }
});

$("download-button").addEventListener("click", () => {
  if (!reportHtml || !report) return;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([reportHtml], { type: "text/html;charset=utf-8" }));
  const link = element("a");
  link.href = downloadUrl;
  link.download = "agentgate-inventory-" + (demonstration ? "demo-" : "") + new Date().toISOString().slice(0, 10) + ".html";
  document.body.append(link);
  link.click();
  link.remove();
  setStatus("已准备下载。报告包含你填写的名称和版本，请在分享前审阅。");
});

try {
  index = JSON.parse($("inventory-index").textContent);
  if (!index || !Array.isArray(index.records)) throw new Error("页面没有可用的证据目录，请使用构建后的页面或本地服务。");
  indexDescription();
  $("compare-button").disabled = false;
  $("example-button").disabled = false;
  setStatus("清单会在此页面内处理。可以先用演示清单了解流程。");
} catch (error) {
  index = null;
  $("index-status").textContent = "目录不可用；没有进行任何核对。";
  showError(new Error("无法读取页面中的证据目录。请使用构建后的页面或本地服务，原始模板不能直接核对清单。"));
  setStatus("请先确认页面已带上证据目录。");
}
