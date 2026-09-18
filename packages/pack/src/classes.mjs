/**
 * The nine things this product can actually measure, and how each one is decided.
 *
 * A questionnaire answer is only as good as the thing behind it. So the words in an answer are
 * written by a person and the state of that answer is computed here from the data in the pack.
 * A class with no data behind it reads "unmeasured" and never improves by being described well.
 */
import { EVIDENCE_CLASS_IDS } from "../../policy/src/framework.mjs"

const item = function (id, title, test) { return { id, title, scope: "item", test } }
const context = function (id, title, test) { return { id, title, scope: "context", test } }

export const EVIDENCE_CLASSES = [
  item("tool-identity", "工具身份", function (entry) {
    return entry.selected ? null : (entry.reason || "没有匹配到索引里的记录")
  }),
  item("exact-version", "精确版本对应", function (entry) {
    return entry.state === "matched" ? null : (entry.reason || "版本与索引记录没有逐条对应")
  }),
  item("content-digest", "内容哈希与覆盖范围", function (entry) {
    return entry.evidence.some(function (e) { return e.digest && e.scope })
      ? null : "这一条的证据块里没有内容哈希或没有写明覆盖范围"
  }),
  item("package-metadata", "包元数据检查", function (entry) {
    return entry.evidence.some(function (e) { return e.block === "packageManifest" && e.status && e.status !== "unmeasured" })
      ? null : "没有包元数据检查记录（这项不是包形态，或索引里这一块未测到）"
  }),
  item("scan-execution", "扫描执行记录", function (entry) {
    return entry.execution ? null : "这一条没有扫描执行记录，哪些扫描器跑完、哪些没跑成无从判断"
  }),
  context("change-history", "变更历史", function (ctx) {
    const count = ctx.archive && Array.isArray(ctx.archive.entries) ? ctx.archive.entries.length : 0
    return count >= 2 ? null : "归档里只有 " + count + " 次可比快照，说明不了变化（需要至少 2 次）"
  }),
  context("archive-integrity", "归档可校验", function (ctx) {
    if (!ctx.archive || ctx.archive.present !== true) return "没有提供归档目录，哈希链无从校验"
    return ctx.archive.verified === true ? null : "归档哈希链校验没有通过"
  }),
  context("coverage-accounting", "覆盖范围记账", function (ctx) {
    return ctx.items.length > 0 ? null : "清单里没有可比对的条目，覆盖范围没有分母"
  }),
  context("gateway-decisions", "网关事前决策", function (ctx) {
    if (!ctx.calls || ctx.calls.provided !== true) return "没有提供网关调用日志（--calls），事前决策记录不在本次范围内"
    return ctx.calls.parsed === true ? null : "网关调用日志无法解析"
  }),
]

export function classIds() { return EVIDENCE_CLASSES.map(function (c) { return c.id }) }

/**
 * Compare the implemented classes with the ones the questionnaire mapping is allowed to name.
 * A mismatch means either a claim with nothing behind it or dead code, and both are worse than
 * a failing test.
 */
export function classContractProblems() {
  const implemented = classIds()
  const declared = EVIDENCE_CLASS_IDS.slice()
  const problems = []
  for (const id of declared) if (implemented.indexOf(id) === -1) problems.push("声明了但没有实现：" + id)
  for (const id of implemented) if (declared.indexOf(id) === -1) problems.push("实现了但没有声明：" + id)
  return problems
}

/**
 * Run every class over the pack's own data. The result is the only thing that decides whether an
 * answer reads measured, partial or unmeasured.
 */
export function evaluateClasses(items, ctx) {
  const context_ = Object.assign({ items: items }, ctx || {})
  return EVIDENCE_CLASSES.map(function (cls) {
    const backing = []
    const missing = []
    if (cls.scope === "item") {
      for (const entry of items) {
        const reason = cls.test(entry, context_)
        if (reason) missing.push({ item: entry.id, reason: reason })
        else backing.push(entry.id)
      }
    } else {
      // A context-level class (an archive, a call log) holds for the pack as a whole. It still
      // cannot cover an entry that never matched a record: saying otherwise would let history be
      // claimed for a tool we could not identify.
      const reason = cls.test(context_)
      for (const entry of items) {
        if (reason) missing.push({ item: entry.id, reason: reason })
        else if (entry.selected) backing.push(entry.id)
        else missing.push({ item: entry.id, reason: "这一条没有对上索引记录，这一类的证据覆盖不到它" })
      }
    }
    const state = backing.length > 0 && missing.length === 0 ? "measured"
      : backing.length > 0 ? "partial" : "unmeasured"
    return { id: cls.id, title: cls.title, state: state, backing: backing, missing: missing,
      counts: { backing: backing.length, missing: missing.length } }
  })
}
