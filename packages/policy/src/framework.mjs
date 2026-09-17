/**
 * What we can answer in someone else's questionnaire, and what we cannot.
 *
 * A customer's security questionnaire asks about their supply chain. Part of the answer is a
 * tool list with checkable evidence, which is what we produce; part of it is their own process;
 * part of it only an independent assessor can sign. Keeping those three apart in the data - not
 * in a footnote - is the difference between a mapping and a sales claim.
 *
 * Only control identifiers and our own wording appear here. The official questionnaire text is
 * the Cloud Security Alliance's, is licensed, and is not reproduced in this repository.
 */

export const OWNERS = {
  we: "我们出证据",
  customer: "你们自证",
  "third-party": "第三方",
}

const ENTRIES = [
  { id: "STA-09.1", topic: "供应链物料清单（工具 / agent 层）", owner: "we",
    weProvide: "在用工具的清单加逐条公开证据：包名、精确版本、来源、内容 SHA-256。",
    boundary: "不含模型层。模型层的材料要你们自己补，报告里会写明这一块未覆盖。" },
  { id: "STA-09.2", topic: "物料清单的定期复审与更新", owner: "we",
    weProvide: "每天采集；版本没变但证据变了的部分单独列出；每次归档都留下可比较的记录。",
    boundary: "你们内部那次复审的会议记录不在我们这里。" },
  { id: "STA-08.1", topic: "整条供应链关系的清单", owner: "we",
    weProvide: "清单逐条匹配公开记录；匹配不上、版本冲突、证据不足的原样列出，不当作通过。",
    boundary: "只覆盖公开可查的那部分供应链。" },
  { id: "STA-07.1", topic: "自己负责范围内的供应链风险管理", owner: "we",
    weProvide: "每条结论标注来源与覆盖范围；没覆盖的证据块标为未测到并说明原因。",
    boundary: "不替你评价内部流程本身。" },
  { id: "STA-10.1", topic: "供应链风险的定期复审", owner: "we",
    weProvide: "每日快照与变更；高危发现的人工复核基线（谁读过、对哪个版本）。",
    boundary: "风险接受与否是你们的决定，不是我们的输出。" },
  { id: "STA-16.1", topic: "基于风险的供应链安全评估", owner: "we",
    weProvide: "变更记录与复核基线，供你们的评估引用。",
    boundary: "评估方法与风险等级由你们定。" },
  { id: "CCC-04.1", topic: "资产新增 / 移除 / 更新的授权程序", owner: "customer",
    weProvide: "策略文件（required / forbidden / pinned）加 CI 退出码：不合规的合不进去。",
    boundary: "审批流本身在你们的内部系统里，我们只提供可执行的判定与记录。" },
  { id: "CCC-06.1", topic: "变更基线的维护", owner: "we",
    weProvide: "每次归档加差异比较；版本没变但内容变了的情况单独标注。",
    boundary: "你们部署环境的基线不在我们这里。" },
  { id: "CCC-06.2", topic: "偏离基线时的发现", owner: "we",
    weProvide: "变更检测；未测到的部分照样列出，不会被算成没有偏离。",
    boundary: "发现之后的处置是你们的流程。" },
  { id: "CCC-07.1", topic: "变更通知", owner: "we",
    weProvide: "变更摘要，可在显式指定后推送到企业微信 / 飞书 / Slack。",
    boundary: "通知渠道与接收人由你们决定；不指定 webhook 就不会发出任何请求。" },
  { id: "LOG-02.1", topic: "审计日志的安全与留存", owner: "we",
    weProvide: "只追加的归档（每行带上一行哈希）加公开的历史页与异地镜像。",
    boundary: "不覆盖模型输入输出的日志。" },
  { id: "LOG-09.1", topic: "含安全信息的审计记录", owner: "we",
    weProvide: "每次采集的记录：时间、内容摘要、匹配结果、与上次的差异。",
    boundary: "你们内部系统的日志不在我们这里。" },
  { id: "LOG-10.1", topic: "审计记录防未授权访问、修改、删除", owner: "we",
    weProvide: "篡改可检测：重算哈希链，被改过的记录会让校验以非零退出。",
    boundary: "访问控制本身在你们那边；我们保证的是改动可被发现。" },
  { id: "LOG-03.1", topic: "安全相关事件的识别与监控", owner: "we",
    weProvide: "规则命中加变更检测，作为事件来源之一。",
    boundary: "事件响应流程是你们的。" },
  { id: "A&A-02.1", topic: "独立评估", owner: "third-party",
    weProvide: "每条结论可追到出处，材料可以直接交给评估方。",
    boundary: "独立评估本身必须由独立的一方做，我们不是。" },
  { id: "A&A-04.1", topic: "合规的验证", owner: "third-party",
    weProvide: "可核对的证据，供验证方使用。",
    boundary: "我们不出合规结论，也不替任何人认证。" },
]

export const FRAMEWORKS = {
  aicaiq: {
    id: "aicaiq",
    name: "AI-CAIQ v1.1.0（对照）",
    source: "Cloud Security Alliance AI-CAIQ v1.1.0 的条目编号；本文件只保留编号与我们的说明，不转载官方原文。",
    note: "这张表说明我们能提供什么证据，不是合规结论。每一条最终由谁交账，见归属列。",
    entries: ENTRIES,
  },
}

/**
 * AICM is the control set the questionnaire is built on; AI-CAIQ is the questionnaire. Only the
 * latter is mapped here, so the alias is accepted (people say "AICM") but the caller can see
 * that the name it asked for is not the artifact it got.
 */
export const ALIASES = { aicm: "aicaiq" }

export function frameworkById(id) {
  const resolved = Object.prototype.hasOwnProperty.call(FRAMEWORKS, id) ? id : ALIASES[id]
  const framework = resolved ? FRAMEWORKS[resolved] : null
  if (!framework) throw new Error("不认识的框架：" + id + "（可用：" + Object.keys(FRAMEWORKS).join(", ") + "）")
  return framework
}

export function ownerCounts(framework) {
  const counts = { we: 0, customer: 0, "third-party": 0 }
  for (const entry of framework.entries) {
    if (counts[entry.owner] === undefined) counts[entry.owner] = 0
    counts[entry.owner] += 1
  }
  return counts
}

export function renderFrameworkText(framework) {
  const counts = ownerCounts(framework)
  const lines = []
  lines.push(framework.name + "  共 " + framework.entries.length + " 条")
  lines.push("来源：" + framework.source)
  lines.push("说明：" + framework.note)
  lines.push("归属：" + Object.keys(counts).map(function (key) { return (OWNERS[key] || key) + " " + counts[key] }).join(" · "))
  lines.push("")
  for (const entry of framework.entries) {
    lines.push(entry.id + "  " + entry.topic + "  [" + (OWNERS[entry.owner] || entry.owner) + "]")
    lines.push("  我们能给：" + entry.weProvide)
    lines.push("  边界：" + entry.boundary)
  }
  return lines.join("\n")
}
