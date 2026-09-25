/**
 * The evidence pack: one directory a vendor hands to the person reviewing them.
 *
 * A report answers "what did you find". A pack answers "what can you show me, and what could you
 * not measure" - in a form the reviewer can check without trusting us. Three files carry the
 * content, a manifest carries their hashes, and a seal carries the manifest's hash. Nothing here
 * calls a network, and nothing here decides that something is compliant.
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileDigest } from "../../history/src/ledger.mjs"
import { evaluateClasses, classContractProblems } from "./classes.mjs"

export const PACK_SCHEMA = "agentgate.evidence-pack/v1"
export const PACK_CONTENT_FILES = ["answers.aicaiq.md", "pack.html", "pack.json"]
export const MANIFEST_NAME = "manifest.txt"
export const SEAL_NAME = "manifest.sha256"

/** The words this product is not allowed to print about itself. */
export const FORBIDDEN_WORDS = /已满足|合规通过|认证通过|已认证|完全合规|保证合规/

export const LIMITS = [
  "只覆盖公开可查的注册表与包记录；自托管、内部发布、未公开的工具不在内。",
  "工具层之外的部分（模型层、训练数据、人员、合同）不在本次范围内。",
  "这不是合规结论：我们出证据，你们自证，独立评估由第三方做。",
  "没有测到的部分不会被算作通过；未测条目数与原因在每份交付物里都写明。",
]

function unique(values) {
  const out = []
  for (const value of values) if (out.indexOf(value) === -1) out.push(value)
  return out
}

/**
 * Turn an inventory report plus the questionnaire mapping into a pack.
 *
 * The claims are the mapping's own words; every state below them is computed from the data that
 * was actually read. If an answer claims we provide something and no evidence class backs it, the
 * pack does not build - a claim with nothing behind it is the one failure this product exists to
 * avoid.
 */
export function buildPack(options) {
  const report = options.report || {}
  const framework = options.framework
  if (!framework || !Array.isArray(framework.entries)) throw new Error("缺少问卷对照表，无法生成答案")
  const problems = classContractProblems()
  if (problems.length > 0) throw new Error("证据类定义不一致：" + problems.join("；"))
  const generatedAt = options.generatedAt || new Date().toISOString()
  const items = (report.items || []).map(function (entry) {
    return {
      id: entry.id,
      input: entry.input,
      state: entry.state,
      label: entry.label,
      reason: entry.reason,
      selected: entry.selected || null,
      evidence: (entry.evidence || []).map(function (block) {
        const content = (block.provenance && block.provenance.content) || {}
        return {
          block: block.block, status: block.status, source: block.source, reason: block.reason,
          digest: content.algorithm === "sha256" ? content.digest || null : null, scope: content.scope || null,
          observedAt: block.observedAt || null, auditedAt: block.auditedAt || null, scanner: block.scanner || null,
          findings: block.findings || [],
        }
      }),
      execution: entry.execution || null,
      findings: entry.findings || [],
      claim: "ev:" + entry.id,
    }
  })
  const classes = evaluateClasses(items, { archive: options.archive || null, calls: options.calls || null })
  const classById = new Map(classes.map(function (cls) { return [cls.id, cls] }))
  const answers = framework.entries.map(function (entry) {
    const declared = Array.isArray(entry.evidence) ? entry.evidence.slice() : []
    const chosen = declared.map(function (id) { return classById.get(id) }).filter(Boolean)
    const backing = unique(chosen.flatMap(function (cls) { return cls.backing }))
    let state
    if (entry.owner !== "we") state = "not-ours"
    else if (declared.length === 0) state = "unmeasured"
    else {
      const measured = chosen.filter(function (cls) { return cls.state === "measured" }).length
      const partial = chosen.filter(function (cls) { return cls.state === "partial" }).length
      state = measured === declared.length ? "measured" : (measured + partial > 0 ? "partial" : "unmeasured")
    }
    return {
      id: entry.id, topic: entry.topic, owner: entry.owner, state: state,
      evidenceClasses: declared, backing: backing,
      weProvide: entry.weProvide, boundary: entry.boundary,
    }
  })
  const ours = answers.filter(function (a) { return a.owner === "we" })
  const blocks = items.flatMap(function (entry) { return entry.evidence })
  const coverage = {
    questions: {
      total: answers.length, ours: ours.length, notOurs: answers.length - ours.length,
      measured: ours.filter(function (a) { return a.state === "measured" }).length,
      partial: ours.filter(function (a) { return a.state === "partial" }).length,
      unmeasured: ours.filter(function (a) { return a.state === "unmeasured" }).length,
    },
    items: {
      total: items.length,
      matched: items.filter(function (entry) { return entry.state === "matched" }).length,
      needsAttention: (report.summary && typeof report.summary.needsAttention === "number")
        ? report.summary.needsAttention : items.filter(function (entry) { return entry.state !== "matched" }).length,
    },
    evidence: {
      blocks: blocks.length,
      withDigest: blocks.filter(function (block) { return block.digest && block.scope }).length,
    },
  }
  const pack = {
    schemaVersion: PACK_SCHEMA,
    generatedAt: generatedAt,
    tool: { name: "agentgate", version: String(options.toolVersion || "unknown") },
    index: {
      generatedAt: (report.index && report.index.generatedAt) || null,
      scanner: (report.index && report.index.scanner) || null,
      records: (report.index && report.index.total) || items.length,
      snapshot: Boolean(report.index && report.index.snapshot),
      truncated: Boolean(report.index && report.index.truncated),
    },
    input: { items: items.length, framework: framework.id },
    items: items,
    evidenceClasses: classes,
    answers: answers,
    coverage: coverage,
    limits: LIMITS,
  }
  assertPackIntegrity(pack)
  return pack
}

/**
 * Reference integrity: every id named anywhere in the pack has to exist in the pack. A dangling
 * reference is a generation failure, not a warning, because the reader cannot tell the difference
 * between evidence that is missing and evidence that was never there.
 */
export function assertPackIntegrity(pack) {
  const ids = new Set((pack.items || []).map(function (entry) { return entry.id }))
  const problems = []
  for (const cls of pack.evidenceClasses || []) {
    for (const id of cls.backing) if (!ids.has(id)) problems.push("证据类 " + cls.id + " 引用了不存在的条目 " + id)
    for (const miss of cls.missing) if (!ids.has(miss.item)) problems.push("证据类 " + cls.id + " 的未测项引用了不存在的条目 " + miss.item)
  }
  for (const answer of pack.answers || []) {
    for (const id of answer.backing) if (!ids.has(id)) problems.push("答案 " + answer.id + " 引用了不存在的条目 " + id)
    for (const id of answer.evidenceClasses) {
      if (!(pack.evidenceClasses || []).some(function (cls) { return cls.id === id })) {
        problems.push("答案 " + answer.id + " 引用了不存在的证据类 " + id)
      }
    }
    if (answer.owner === "we" && answer.evidenceClasses.length === 0) problems.push("答案 " + answer.id + " 声称我们出证据，却没有指向任何证据类")
  }
  if (problems.length > 0) throw new Error("引用完整性检查没过：" + problems.join("；"))
  return true
}

const OWNER_LABELS = { we: "我们出证据", customer: "你们自证", "third-party": "第三方" }
const STATE_LABELS = { measured: "本次测到", partial: "部分测到", unmeasured: "本次没测到", "not-ours": "不是我们" }

export function ownerLabel(owner) { return OWNER_LABELS[owner] || owner }
export function stateLabel(state) { return STATE_LABELS[state] || state }

function shortDigest(value) {
  return value ? String(value).slice(0, 16) : null
}

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

/** The questionnaire view: one section per domain, every item classified, ours first. */
export function renderAnswers(pack) {
  const itemById = new Map((pack.items || []).map(function (entry) { return [entry.id, entry] }))
  const lines = []
  const q = pack.coverage.questions
  lines.push("# AI-CAIQ v1.1.0 对照：本次证据包")
  lines.push("")
  lines.push("生成时间：" + pack.generatedAt + "　工具：agentgate " + pack.tool.version)
  lines.push("索引快照：" + (pack.index.generatedAt || "未记录") + "　扫描器：" + (pack.index.scanner || "未记录") + "　记录数：" + pack.index.records)
  lines.push("")
  lines.push("本次共 " + q.total + " 条：" + q.ours + " 条我们出证据（测到 " + q.measured + "、部分测到 " + q.partial + "、没测到 " + q.unmeasured + "），" + q.notOurs + " 条不是我们。")
  lines.push("")
  lines.push("**没有测到的条目不算答过。** 每条下面的「本次依据」是这次生成时真正读到的条目；「本次未覆盖」是没读到或没跑成的部分。")
  lines.push("")
  const domains = []
  for (const answer of pack.answers) {
    const domain = answer.id.split("-")[0]
    if (domains.indexOf(domain) === -1) domains.push(domain)
  }
  for (const domain of domains) {
    lines.push("## " + domain)
    lines.push("")
    const rows = pack.answers.filter(function (a) { return a.id.split("-")[0] === domain })
      .slice().sort(function (a, b) { return a.id.localeCompare(b.id) })
    for (const answer of rows) {
      lines.push("### " + answer.id + "　" + answer.topic)
      lines.push("")
      lines.push("- 归属：" + ownerLabel(answer.owner) + "　本次状态：" + stateLabel(answer.state))
      lines.push("- 我们能给：" + answer.weProvide)
      lines.push("- 边界：" + answer.boundary)
      if (answer.backing.length === 0) lines.push("- 本次依据：（无）")
      else {
        const parts = answer.backing.map(function (id) {
          const entry = itemById.get(id)
          const selected = entry && entry.selected ? entry.selected : null
          const digest = entry && entry.evidence.length > 0 ? entry.evidence.map(function (b) { return shortDigest(b.digest) }).filter(Boolean)[0] : null
          return id + (selected && selected.version ? "@" + selected.version : "") + (digest ? "（sha256:" + digest + "…）" : "")
        })
        lines.push("- 本次依据：" + parts.join("、"))
      }
      const missing = []
      for (const id of answer.evidenceClasses) {
        const cls = pack.evidenceClasses.filter(function (c) { return c.id === id })[0]
        if (!cls || cls.missing.length === 0) continue
        const reasons = unique(cls.missing.map(function (m) { return m.reason }))
        missing.push(id + "：" + cls.missing.length + " 条未覆盖（" + reasons.slice(0, 2).join("；") + "）")
      }
      if (missing.length > 0) lines.push("- 本次未覆盖：" + missing.join("；"))
      lines.push("")
    }
  }
  lines.push("---")
  lines.push("")
  for (const limit of pack.limits) lines.push("- " + limit)
  lines.push("")
  return lines.join("\n")
}

/** The reviewer view: what was measured, what was not, and the one line that matters at the top. */
export function renderPackHtml(pack) {
  const q = pack.coverage.questions
  const unmeasured = q.partial + q.unmeasured
  const head = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>证据包 · agentgate</title>",
    "<style>",
    "body{margin:0;background:#fff;color:#111;font:15px/1.7 system-ui,-apple-system,'PingFang SC',sans-serif}",
    "main{max-width:960px;margin:0 auto;padding:40px 22px 80px}",
    "h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:34px 0 10px;padding-top:16px;border-top:1px solid #e6e8eb}",
    "h3{font-size:15px;margin:20px 0 6px}",
    ".muted{color:#5b6472;font-size:13px}",
    ".badge{display:inline-block;padding:3px 10px;border-radius:999px;color:#fff;font-weight:600;font-size:12px}",
    ".measured{background:#2ea043}.partial{background:#d29922}.unmeasured{background:#8b949e}.not-ours{background:#5b6472}",
    "table{width:100%;border-collapse:collapse;margin:12px 0}",
    "th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e6e8eb;vertical-align:top;font-size:14px}",
    "th{color:#5b6472;font-weight:600}",
    "pre{white-space:pre-wrap;word-break:break-word;background:#f5f6f7;padding:10px;border-radius:6px;font-size:13px}",
    ".box{border:1px solid #e6e8eb;border-radius:8px;padding:12px 14px;margin:10px 0}",
    ".warn{border-color:#d29922;background:#fffaf0}",
    "footer{margin-top:48px;padding-top:16px;border-top:1px solid #e6e8eb}",
    "@media print{main{max-width:none}h2{page-break-after:avoid}}",
    "</style></head><body><main>",
  ].join("\n")
  const title = [
    "<h1>证据包</h1>",
    '<p class="muted">生成时间:' + esc(pack.generatedAt) + "　工具:agentgate " + esc(pack.tool.version) + "<br>索引快照:" + esc(pack.index.generatedAt || "未记录") + "　扫描器:" + esc(pack.index.scanner || "未记录") + "　记录数:" + esc(String(pack.index.records)) + "</p>",
  ].join("\n")
  const top = unmeasured === 0
    ? '<div class="box"><b>本次我们声称能给的 ' + q.ours + ' 条都测到了。</b>这不等于合规,只说明这份清单里没有未测项。</div>'
    : '<div class="box warn"><b>本次有 ' + unmeasured + ' 条我们声称能给的答案没有完全测到（部分测到 ' + q.partial + '、没测到 ' + q.unmeasured + '）。</b>它们不是"没问题",而是"这次没测到";明细在下面。</div>'
  const summary = [
    "<h2>覆盖摘要</h2>",
    "<table><tr><th>项目</th><th>数量</th></tr>",
    "<tr><td>问卷条目（AI-CAIQ 的 STA / CCC / LOG / A&amp;A）</td><td>" + q.total + "</td></tr>",
    "<tr><td>其中我们出证据</td><td>" + q.ours + "</td></tr>",
    "<tr><td>其中不是我们（你们自证 / 第三方）</td><td>" + q.notOurs + "</td></tr>",
    "<tr><td>清单条目 / 与证据对应 / 需要处理</td><td>" + pack.coverage.items.total + " / " + pack.coverage.items.matched + " / " + pack.coverage.items.needsAttention + "</td></tr>",
    "<tr><td>证据块 / 带内容哈希与覆盖范围</td><td>" + pack.coverage.evidence.blocks + " / " + pack.coverage.evidence.withDigest + "</td></tr>",
    "</table>",
  ].join("\n")
  const answerRows = pack.answers.slice().sort(function (a, b) { return a.id.localeCompare(b.id) }).map(function (answer) {
    return "<tr><td>" + esc(answer.id) + "</td><td>" + esc(answer.topic) + '</td><td><span class="badge ' + esc(answer.state) + '">' + esc(stateLabel(answer.state)) + "</span></td><td>" + esc(ownerLabel(answer.owner)) + "</td><td>" + answer.backing.length + "</td></tr>"
  }).join("\n")
  const answers = ["<h2>逐条答案(" + pack.answers.length + ")</h2>", '<p class="muted">我们能给什么、边界在哪，是人写的;本次测到什么，是数据算的。</p>',
    "<table><tr><th>条目</th><th>主题</th><th>本次状态</th><th>归属</th><th>依据条目数</th></tr>" + answerRows + "</table>"].join("\n")
  const classRows = pack.evidenceClasses.map(function (cls) {
    return "<tr><td>" + esc(cls.id) + "</td><td>" + esc(cls.title) + '</td><td><span class="badge ' + esc(cls.state) + '">' + esc(stateLabel(cls.state)) + "</span></td><td>" + cls.counts.backing + " / " + cls.counts.missing + "</td></tr>"
  }).join("\n")
  const classes = ["<h2>证据类(" + pack.evidenceClasses.length + ")</h2>", "<table><tr><th>证据类</th><th>说明</th><th>本次状态</th><th>有 / 缺</th></tr>" + classRows + "</table>"].join("\n")
  const itemRows = pack.items.map(function (entry) {
    const selected = entry.selected ? (entry.selected.package || entry.selected.server || "") + (entry.selected.version ? "@" + entry.selected.version : "") : ""
    return "<tr><td>" + esc(entry.id) + "</td><td>" + esc(entry.input.name) + "</td><td>" + esc(stateLabel(entry.state) === entry.state ? entry.label || entry.state : entry.label || entry.state) + "</td><td>" + esc(selected) + "</td><td>" + entry.evidence.length + "</td><td>" + entry.findings.length + "</td></tr>"
  }).join("\n")
  const items = ["<h2>清单与证据(" + pack.items.length + ")</h2>", "<table><tr><th>条目</th><th>输入</th><th>状态</th><th>对应</th><th>证据块</th><th>发现</th></tr>" + itemRows + "</table>"].join("\n")
  const missingRows = []
  for (const cls of pack.evidenceClasses) {
    for (const miss of cls.missing.slice(0, 200)) missingRows.push("<tr><td>" + esc(cls.id) + "</td><td>" + esc(miss.item) + "</td><td>" + esc(miss.reason) + "</td></tr>")
  }
  const missing = missingRows.length === 0 ? "" : ["<h2>没测到的部分(" + missingRows.length + ")</h2>",
    '<p class="muted">这些不是"没问题",而是"这次没测到"。</p>',
    "<table><tr><th>证据类</th><th>条目</th><th>原因</th></tr>" + missingRows.join("\n") + "</table>"].join("\n")
  const footer = [
    "<footer>",
    "<h2>范围与边界</h2>",
    "<ul>" + pack.limits.map(function (limit) { return "<li>" + esc(limit) + "</li>" }).join("") + "</ul>",
    '<p class="muted">复核这份包:<code>agentgate pack --verify &lt;目录&gt;</code>。重算 manifest.txt 里每个文件的 sha256,并核对 manifest.sha256 封条;任何一个字节被改都会以非零退出。</p>',
    "</footer>",
  ].join("\n")
  return head + title + top + summary + answers + classes + items + missing + footer + "</main></body></html>\n"
}

export function renderManifest(options) {
  const pack = options.pack
  const lines = []
  lines.push("agentgate evidence pack")
  lines.push("generated: " + pack.generatedAt)
  lines.push("tool: agentgate " + pack.tool.version)
  lines.push("index: generatedAt=" + (pack.index.generatedAt || "未记录") + " scanner=" + (pack.index.scanner || "未记录") + " records=" + pack.index.records + " snapshot=" + pack.index.snapshot)
  lines.push("command: " + options.command)
  lines.push("scope: 只覆盖公开可查的注册表与包记录;自托管与内部工具不在内")
  lines.push("files:")
  for (const file of options.files.slice().sort(function (a, b) { return a.name.localeCompare(b.name) })) {
    lines.push(file.sha256 + "  " + file.name)
  }
  lines.push("verify: agentgate pack --verify <dir>")
  lines.push("note: " + MANIFEST_NAME + " 自身由 " + SEAL_NAME + " 封存(自指哈希无法校验)")
  return lines.join("\n") + "\n"
}

export function writePack(dir, pack, options) {
  const target = resolve(dir)
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error("目录不是空的,不会覆盖:" + target + "（换一个 --out,或先清空）")
  }
  mkdirSync(target, { recursive: true })
  const files = {}
  files["pack.json"] = JSON.stringify(pack, null, 2) + "\n"
  files["pack.html"] = renderPackHtml(pack)
  files["answers.aicaiq.md"] = renderAnswers(pack)
  for (const name of PACK_CONTENT_FILES) writeFileSync(join(target, name), files[name], { mode: 0o644 })
  const manifest = renderManifest({
    pack: pack,
    command: options.command,
    files: PACK_CONTENT_FILES.map(function (name) { return { name: name, sha256: fileDigest(join(target, name)) } }),
  })
  writeFileSync(join(target, MANIFEST_NAME), manifest, { mode: 0o644 })
  writeFileSync(join(target, SEAL_NAME), fileDigest(join(target, MANIFEST_NAME)) + "  " + MANIFEST_NAME + "\n", { mode: 0o644 })
  return { dir: target, files: PACK_CONTENT_FILES.concat([MANIFEST_NAME, SEAL_NAME]) }
}

/**
 * Recompute everything the manifest claims. A changed file is a failure (exit 1); a manifest that
 * cannot be read at all is "could not check" (exit 2), and the two are reported differently.
 */
export function verifyPack(dir) {
  const target = resolve(dir)
  const manifestPath = join(target, MANIFEST_NAME)
  if (!existsSync(manifestPath)) return { ok: false, code: 2, problems: [{ kind: "missing-manifest", detail: "找不到 " + MANIFEST_NAME }], files: [], extra: [] }
  let manifest
  try { manifest = readFileSync(manifestPath, "utf8") } catch (error) {
    return { ok: false, code: 2, problems: [{ kind: "unreadable-manifest", detail: error.message }], files: [], extra: [] }
  }
  const problems = []
  const sealPath = join(target, SEAL_NAME)
  if (existsSync(sealPath)) {
    const expected = readFileSync(sealPath, "utf8").trim().split(/\s+/)[0]
    const actual = fileDigest(manifestPath)
    if (expected !== actual) problems.push({ kind: "seal", detail: MANIFEST_NAME + " 与封条不一致(封条 " + expected.slice(0, 16) + "…,实际 " + actual.slice(0, 16) + "…)" })
  } else {
    problems.push({ kind: "missing-seal", detail: "没有 " + SEAL_NAME + ",封条缺失" })
  }
  const listed = []
  for (const line of manifest.split("\n")) {
    const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line)
    if (!match) continue
    const name = match[2]
    listed.push(name)
    const path = join(target, name)
    if (!existsSync(path)) { problems.push({ kind: "missing-file", detail: name + " 在清单里但目录里没有" }); continue }
    const actual = fileDigest(path)
    if (actual !== match[1]) problems.push({ kind: "hash", detail: name + " 的 sha256 与清单不一致(清单 " + match[1].slice(0, 16) + "…,实际 " + actual.slice(0, 16) + "…)" })
  }
  if (listed.length === 0) problems.push({ kind: "empty-manifest", detail: MANIFEST_NAME + " 里没有任何文件哈希" })
  const extra = readdirSync(target).filter(function (name) { return listed.indexOf(name) === -1 && name !== MANIFEST_NAME && name !== SEAL_NAME })
  const changed = problems.filter(function (p) { return ["seal", "hash", "missing-file"].indexOf(p.kind) !== -1 })
  const code = problems.length === 0 ? 0 : (changed.length > 0 ? 1 : 2)
  return { ok: problems.length === 0, code: code, problems: problems, files: listed, extra: extra }
}
