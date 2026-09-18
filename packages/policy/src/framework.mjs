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
 *
 * Every item in the four domains a security reviewer actually asks a vendor about is classified:
 * STA, CCC, LOG and A&A. Most of them are not ours - that is the point of the table, and the
 * count of "not ours" is published with the count of "ours".
 */

export const OWNERS = {
  we: "我们出证据",
  customer: "你们自证",
  "third-party": "第三方",
}

/**
 * The evidence classes an answer may point at. The ids are the contract between this mapping and
 * the pack builder (packages/pack/src/classes.mjs): a "we" entry that names a class the pack
 * cannot compute would be a claim with nothing behind it, so a test compares the two lists.
 */
export const EVIDENCE_CLASS_IDS = [
  "tool-identity",
  "exact-version",
  "content-digest",
  "package-metadata",
  "scan-execution",
  "change-history",
  "archive-integrity",
  "coverage-accounting",
  "gateway-decisions",
]

const ENTRIES = [
  // ---- STA: supply chain and third-party relationships ----
  { id: "STA-01.1", topic: "供应链风险管理的策略与流程", owner: "customer", evidence: [],
    weProvide: "策略文件本身不是我们写的；我们能提供工具层的可执行判定（策略文件加 CI 退出码）作为流程执行的证据之一。",
    boundary: "流程的建立、批准与沟通在你们内部系统里。" },
  { id: "STA-01.2", topic: "供应链策略的定期复审", owner: "customer", evidence: [],
    weProvide: "工具层的变化摘要可以当作复审的输入材料。",
    boundary: "复审的会议、结论与签署是你们的。" },
  { id: "STA-02.1", topic: "共享安全责任模型（SSRM）的策略与流程", owner: "customer", evidence: [],
    weProvide: "我们能给出工具层的责任归属列（我们出证据 / 你们自证 / 第三方），作为 SSRM 里工具这一层的输入。",
    boundary: "SSRM 的划分原则与签署是你们的。" },
  { id: "STA-02.2", topic: "SSRM 策略的定期复审", owner: "customer", evidence: [],
    weProvide: "归属列随每次采集重算，可以对照出这一层有没有变化。",
    boundary: "SSRM 文档的复审记录不在我们这里。" },
  { id: "STA-03.1", topic: "SSRM 在整条供应链上的应用与文档化", owner: "customer", evidence: [],
    weProvide: "只覆盖公开可查的工具与包这一层。",
    boundary: "整条供应链（人、合同、子处理方）的 SSRM 应用是你们的。" },
  { id: "STA-04.1", topic: "向客户提供 SSRM 指引", owner: "customer", evidence: ["tool-identity", "exact-version"],
    weProvide: "证据包可以直接作为指引的工具层附件转给你们的客户。",
    boundary: "指引正文与适用范围由你们写。" },
  { id: "STA-05.1", topic: "AICM 控制的共享归属划分", owner: "customer", evidence: ["coverage-accounting"],
    weProvide: "我们对四个域逐条标了归属与边界，工具层这部分可以直接引用。",
    boundary: "全部控制的归属划分是你们的责任矩阵。" },
  { id: "STA-06.1", topic: "SSRM 文档的复审与验证", owner: "customer", evidence: [],
    weProvide: "我们能提供材料清单与逐条来源，供你们的验证方使用。",
    boundary: "验证这件事由你们或第三方做。" },
  { id: "STA-07.1", topic: "自己负责范围内的供应链风险管理", owner: "we", evidence: ["tool-identity", "coverage-accounting"],
    weProvide: "每条结论标注来源与覆盖范围；没覆盖的证据块标为未测到并说明原因。",
    boundary: "不替你评价内部流程本身。" },
  { id: "STA-08.1", topic: "整条供应链关系的清单", owner: "we", evidence: ["tool-identity", "exact-version"],
    weProvide: "清单逐条匹配公开记录；匹配不上、版本冲突、证据不足的原样列出，不当作通过。",
    boundary: "只覆盖公开可查的那部分供应链。" },
  { id: "STA-09.1", topic: "供应链物料清单（工具 / agent 层）", owner: "we", evidence: ["tool-identity", "exact-version", "content-digest"],
    weProvide: "在用工具的清单加逐条公开证据：包名、精确版本、来源、内容 SHA-256。",
    boundary: "不含模型层。模型层的材料要你们自己补，报告里会写明这一块未覆盖。" },
  { id: "STA-09.2", topic: "物料清单的定期复审与更新", owner: "we", evidence: ["change-history", "archive-integrity"],
    weProvide: "每天采集；版本没变但证据变了的部分单独列出；每次归档都留下可比较的记录。",
    boundary: "你们内部那次复审的会议记录不在我们这里。" },
  { id: "STA-10.1", topic: "供应链风险的定期复审", owner: "we", evidence: ["change-history", "archive-integrity"],
    weProvide: "每日快照与变更；高危发现的人工复核基线（谁读过、对哪个版本）。",
    boundary: "风险接受与否是你们的决定，不是我们的输出。" },
  { id: "STA-11.1", topic: "服务协议应包含的条款", owner: "customer", evidence: [],
    weProvide: "这份清单里「日志与监控能力」「变更管理」「审计权」几项，我们可以提供工具层的证据供你们作为协议附件。",
    boundary: "条款文本、谈判与签署是你们的法务。" },
  { id: "STA-12.1", topic: "供应链协议的定期复审", owner: "customer", evidence: [],
    weProvide: "工具层的变化可以提示哪些协议需要重看，但不替代复审。",
    boundary: "协议复审是你们的流程。" },
  { id: "STA-13.1", topic: "内部评估确认标准与流程的一致性", owner: "customer", evidence: [],
    weProvide: "我们能提供检查输出与退出码，作为评估时的一个可重复的输入。",
    boundary: "内部评估本身由你们做。" },
  { id: "STA-14.1", topic: "要求供应链各方遵守信息安全与保密要求", owner: "customer", evidence: [],
    weProvide: "我们能说明我们这一侧做了什么、没做什么，供你们转述。",
    boundary: "对上游的要求与举证是你们的合同工作。" },
  { id: "STA-15.1", topic: "服务提供方治理策略的复审", owner: "customer", evidence: [],
    weProvide: "我们的公开来源与免责边界随时可查。",
    boundary: "你们对服务提供方的治理复审不是我们的输出。" },
  { id: "STA-16.1", topic: "基于风险的供应链安全评估", owner: "we", evidence: ["package-metadata", "content-digest"],
    weProvide: "变更记录与复核基线，供你们的评估引用。",
    boundary: "评估方法与风险等级由你们定。" },

  // ---- CCC: change control and configuration management ----
  { id: "CCC-01.1", topic: "变更风险管理的策略与流程", owner: "customer", evidence: [],
    weProvide: "策略文件（required / forbidden / pinned）是一种可执行的变更规则，可被你们引用。",
    boundary: "策略的批准与适用范围是你们的。" },
  { id: "CCC-01.2", topic: "变更策略的定期复审", owner: "customer", evidence: [],
    weProvide: "规则命中与证据变化可以作为复审的输入。",
    boundary: "复审记录在你们那里。" },
  { id: "CCC-02.1", topic: "变更控制、批准与测试流程", owner: "customer", evidence: ["exact-version"],
    weProvide: "工具层的版本固定与基线比较可以作为发布门禁的一部分。",
    boundary: "测试标准与批准流在你们内部。" },
  { id: "CCC-03.1", topic: "变更管理程序的实施", owner: "customer", evidence: [],
    weProvide: "我们能给出工具层变更的可核记录，供程序引用。",
    boundary: "程序本身的实施证据在你们的系统里。" },
  { id: "CCC-04.1", topic: "资产新增 / 移除 / 更新的授权程序", owner: "customer", evidence: [],
    weProvide: "策略文件（required / forbidden / pinned）加 CI 退出码：不合规的合不进去。",
    boundary: "审批流本身在你们的内部系统里，我们只提供可执行的判定与记录。" },
  { id: "CCC-05.1", topic: "限制影响客户租户的变更", owner: "customer", evidence: [],
    weProvide: "我们的检查只读公开材料，不进入你们的租户环境。",
    boundary: "租户环境里的变更控制是你们的。" },
  { id: "CCC-06.1", topic: "变更基线的维护", owner: "we", evidence: ["change-history", "content-digest"],
    weProvide: "每次归档加差异比较；版本没变但内容变了的情况单独标注。",
    boundary: "你们部署环境的基线不在我们这里。" },
  { id: "CCC-06.2", topic: "偏离基线时的发现", owner: "we", evidence: ["change-history", "archive-integrity"],
    weProvide: "变更检测；未测到的部分照样列出，不会被算成没有偏离。",
    boundary: "发现之后的处置是你们的流程。" },
  { id: "CCC-07.1", topic: "变更通知", owner: "we", evidence: ["change-history"],
    weProvide: "变更摘要，可在显式指定后推送到企业微信 / 飞书 / Slack。",
    boundary: "通知渠道与接收人由你们决定；不指定 webhook 就不会发出任何请求。" },
  { id: "CCC-08.1", topic: "例外与紧急变更的管理", owner: "customer", evidence: [],
    weProvide: "例外本身不该被自动放行：我们的检查不提供静默豁免。",
    boundary: "例外的审批与记录在你们那里。" },
  { id: "CCC-09.1", topic: "回滚到已知良好状态", owner: "customer", evidence: [],
    weProvide: "我们能指出哪个版本对应哪份证据，便于你们确定回滚目标。",
    boundary: "回滚操作与演练是你们的。" },

  // ---- LOG: logging and monitoring ----
  { id: "LOG-01.1", topic: "日志与监控的策略和流程", owner: "customer", evidence: [],
    weProvide: "我们记录自己做了什么：采集时间、内容摘要、匹配结果、与上次的差异。",
    boundary: "你们自己的日志与监控策略不是我们写的。" },
  { id: "LOG-01.2", topic: "日志策略的定期复审", owner: "customer", evidence: [],
    weProvide: "我们的记录格式与范围是公开的，可直接引用。",
    boundary: "复审与批准在你们那里。" },
  { id: "LOG-02.1", topic: "审计日志的安全与留存", owner: "we", evidence: ["archive-integrity"],
    weProvide: "只追加的归档（每行带上一行哈希）加公开的历史页与异地镜像。",
    boundary: "不覆盖模型输入输出的日志。" },
  { id: "LOG-03.1", topic: "安全相关事件的识别与监控", owner: "we", evidence: ["package-metadata", "change-history"],
    weProvide: "规则命中加变更检测，作为事件来源之一。",
    boundary: "事件响应流程是你们的。" },
  { id: "LOG-03.2", topic: "基于安全事件的告警", owner: "customer", evidence: ["change-history"],
    weProvide: "变更摘要可以在你们显式配置后作为告警来源之一。",
    boundary: "告警阈值、接收人与处置是你们的。" },
  { id: "LOG-04.1", topic: "审计日志的访问限制与访问记录", owner: "customer", evidence: [],
    weProvide: "我们保证改动可被发现，不保证谁能读。",
    boundary: "访问控制与访问日志在你们那一侧。" },
  { id: "LOG-05.1", topic: "关联与监控审计日志以发现异常", owner: "customer", evidence: ["change-history"],
    weProvide: "版本没变而证据变了这类变化，是我们能提供的一类异常信号。",
    boundary: "跨系统的关联分析不在我们这里。" },
  { id: "LOG-05.2", topic: "异常处置流程", owner: "customer", evidence: [],
    weProvide: "我们给出可复核的原始材料，供你们的处置流程引用。",
    boundary: "处置动作与时限是你们的。" },
  { id: "LOG-06.1", topic: "可靠的时间源", owner: "customer", evidence: [],
    weProvide: "我们只提供记录时间与归档顺序，时间源本身不是我们的。",
    boundary: "全系统统一时间源是你们的基础设施工作。" },
  { id: "LOG-07.1", topic: "应记录的系统事件元数据", owner: "customer", evidence: ["scan-execution"],
    weProvide: "我们记哪些字段、每个字段覆盖什么范围，都在报告里写明，可作为范围定义的参考。",
    boundary: "你们系统的日志字段范围由你们定。" },
  { id: "LOG-07.2", topic: "记录范围的定期复审", owner: "customer", evidence: [],
    weProvide: "每次采集的范围与排除项都写在记录里，可直接对照。",
    boundary: "复审本身是你们的流程。" },
  { id: "LOG-08.1", topic: "客户侧敏感数据的检出与脱敏", owner: "customer", evidence: [],
    weProvide: "我们不接收也不需要你们的日志内容，因此不产生这类暴露面。",
    boundary: "你们自己日志里的敏感数据要你们处理。" },
  { id: "LOG-09.1", topic: "含安全信息的审计记录", owner: "we", evidence: ["scan-execution", "content-digest"],
    weProvide: "每次采集的记录：时间、内容摘要、匹配结果、与上次的差异。",
    boundary: "你们内部系统的日志不在我们这里。" },
  { id: "LOG-10.1", topic: "审计记录防未授权访问、修改、删除", owner: "we", evidence: ["archive-integrity"],
    weProvide: "篡改可检测：重算哈希链，被改过的记录会让校验以非零退出。",
    boundary: "访问控制本身在你们那边；我们保证的是改动可被发现。" },
  { id: "LOG-11.1", topic: "加密操作与密钥管理的监控报告", owner: "customer", evidence: [],
    weProvide: "我们不读取、不输出任何凭据或密钥。",
    boundary: "密钥管理与加密操作的日志是你们的。" },
  { id: "LOG-12.1", topic: "密钥生命周期事件的日志", owner: "customer", evidence: [],
    weProvide: "我们的输出里永远不出现凭据值。",
    boundary: "密钥生命周期日志在你们的 KMS 或 HSM 里。" },
  { id: "LOG-13.1", topic: "物理访问的日志与监控", owner: "customer", evidence: [],
    weProvide: "我们不涉及物理设施。",
    boundary: "机房与办公区访问记录是你们的。" },
  { id: "LOG-14.1", topic: "监控系统异常与失败的上报", owner: "customer", evidence: ["scan-execution"],
    weProvide: "「哪些扫描器跑完了、哪些没跑成」就在每次的记录里，这是我们能提供的异常来源。",
    boundary: "上报流程与责任人由你们定。" },
  { id: "LOG-14.2", topic: "异常与失败的即时通知", owner: "customer", evidence: [],
    weProvide: "报告顶部先写未测到的部分，读的人不会先看到结论。",
    boundary: "通知的责任人与时限是你们的流程。" },
  { id: "LOG-15.1", topic: "AI 模型输入事件的日志", owner: "customer", evidence: [],
    weProvide: "这一块我们不覆盖：我们不读模型输入输出，也不把它写进任何交付物。",
    boundary: "输入事件日志要你们在自己的推理链路上做。" },
  { id: "LOG-16.1", topic: "AI 模型输出事件的日志", owner: "customer", evidence: [],
    weProvide: "同上：我们的记录不包含模型输出内容。",
    boundary: "输出事件日志要你们自己做。" },

  // ---- A&A: audit and assurance ----
  { id: "A&A-01.1", topic: "审计与保证的策略和流程", owner: "customer", evidence: [],
    weProvide: "我们能提供可复核的原始材料，供你们的审计流程使用。",
    boundary: "审计策略本身由你们制定。" },
  { id: "A&A-01.2", topic: "审计策略的定期复审", owner: "customer", evidence: [],
    weProvide: "我们的方法说明与覆盖范围随时可查。",
    boundary: "复审记录在你们那里。" },
  { id: "A&A-02.1", topic: "独立评估", owner: "third-party", evidence: [],
    weProvide: "每条结论可追到出处，材料可以直接交给评估方。",
    boundary: "独立评估本身必须由独立的一方做，我们不是。" },
  { id: "A&A-03.1", topic: "基于风险的审计计划", owner: "third-party", evidence: [],
    weProvide: "我们提供逐条的来源与未测范围，供评估方排优先级。",
    boundary: "审计计划的制定与执行不由我们做。" },
  { id: "A&A-04.1", topic: "合规的验证", owner: "third-party", evidence: [],
    weProvide: "可核对的证据，供验证方使用。",
    boundary: "我们不出合规结论，也不替任何人认证。" },
  { id: "A&A-05.1", topic: "审计管理与审计标准的对齐", owner: "third-party", evidence: [],
    weProvide: "我们的输出是机器可读的，便于评估方按自己的标准复核。",
    boundary: "审计管理流程与标准对齐由审计方与你们完成。" },
  { id: "A&A-06.1", topic: "基于风险的纠正措施计划", owner: "customer", evidence: [],
    weProvide: "发现逐条带规则、级别与原因，可以直接作为整改清单的输入。",
    boundary: "整改计划、责任人与验收是你们的。" },
]

export const FRAMEWORKS = {
  aicaiq: {
    id: "aicaiq",
    name: "AI-CAIQ v1.1.0（对照）",
    source: "Cloud Security Alliance AI-CAIQ v1.1.0 的条目编号；本文件只保留编号与我们的说明，不转载官方原文。",
    note: "这张表说明我们能提供什么证据，不是合规结论。每一条最终由谁交账，见归属列。",
    domains: ["STA", "CCC", "LOG", "A&A"],
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
    if (entry.evidence.length > 0) lines.push("  证据类：" + entry.evidence.join(", "))
  }
  return lines.join("\n")
}
