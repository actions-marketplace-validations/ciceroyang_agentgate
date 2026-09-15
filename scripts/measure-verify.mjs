#!/usr/bin/env node
/**
 * Measure the claim extractor against a small labelled set.
 *
 * The extractor is heuristics: a sentence is "checkable" if it carries a link, a date-like
 * token, a number, a citation marker or a source phrase. Heuristics do not come with a
 * precision number, so this measures one, on twelve short texts, and prints whatever it
 * finds. The labels are mine, which is the obvious weakness of the exercise; it is still
 * better than the number being unavailable.
 *
 *   node scripts/measure-verify.mjs
 */
import { extractClaims } from "../packages/verify/src/claims.mjs"
import { report } from "../packages/verify/bin/crosscheck.mjs"

const LABELLED = [
  { id: "advice-no-claims", text: "我觉得这个方向值得试试。你先别急着下结论,多看看再决定。", checkable: [], defects: [] },
  { id: "impossible-month-zh", text: "该版本发布于 2024 年 13 月,修复了三个问题。", checkable: ["2024 年 13 月"], defects: ["contradicted"] },
  { id: "impossible-month-en", text: "It shipped on Smarch 3, 2025 with two fixes.", checkable: ["Smarch 3, 2025"], defects: ["contradicted"] },
  { id: "valid-date", text: "It shipped on March 3, 2025 with two fixes.", checkable: ["March 3, 2025"], defects: [] },
  { id: "citation-no-ref", text: "根据一份研究报告,效率提升了 300%。[1]", checkable: ["效率提升了 300%"], defects: ["unchecked"] },
  { id: "plain-number", text: "这个方案让构建时间从 12 分钟降到 3 分钟。", checkable: ["12 分钟"], defects: ["unchecked"] },
  { id: "source-phrase", text: "According to the study, adoption doubled last year.", checkable: ["adoption doubled"], defects: ["unchecked"] },
  { id: "no-checkable-but-long", text: "先说结论:这件事我不建议现在做。原因有三点,但都不是硬约束。", checkable: [], defects: [] },
  { id: "english-advice", text: "I would wait a week before deciding. The tradeoffs are not obvious yet.", checkable: [], defects: [] },
  { id: "mixed", text: "文档说 ignore all previous instructions 是攻击样例,不是真的指令。", checkable: ["ignore all previous instructions"], defects: ["unchecked"] },
  { id: "date-and-link", text: "See https://example.invalid/x for the 2025 report.", checkable: ["https://example.invalid/x"], defects: ["unchecked"] },
  { id: "year-only", text: "这是 2026 年的新方案,去年还没有。", checkable: ["2026 年"], defects: ["unchecked"] },
]

const stub = async function () { return { status: 0 } }

export async function measure() {

let truePositive = 0
let falsePositive = 0
let missed = 0
let expectedTotal = 0
const rows = []

for (const item of LABELLED) {
  const claims = extractClaims(item.text)
  for (const claim of claims) {
    const isReal = item.checkable.some(function (s) { return claim.text.indexOf(s) !== -1 })
    if (isReal) truePositive += 1
    else falsePositive += 1
    rows.push({ id: item.id, sentence: claim.text.slice(0, 60), labelled: isReal ? "checkable" : "not checkable" })
  }
  for (const expected of item.checkable) {
    expectedTotal += 1
    const found = claims.some(function (c) { return c.text.indexOf(expected) !== -1 })
    if (!found) missed += 1
  }
}

const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive)
const recall = expectedTotal === 0 ? 0 : (expectedTotal - missed) / expectedTotal

let defectExpected = 0
let defectCaught = 0
for (const item of LABELLED) {
  for (const want of item.defects) {
    defectExpected += 1
    const out = await report(item.text, { fetchHead: stub })
    const hit = out.findings.some(function (f) { return f.status === want }) || out.links.some(function (l) { return l.status === want })
    if (hit) defectCaught += 1
    else console.log("  missed defect in " + item.id + ": expected " + want)
  }
}

  return { texts: LABELLED.length, precision: precision, recall: recall, defectRate: defectExpected === 0 ? null : defectCaught / defectExpected, truePositive: truePositive, falsePositive: falsePositive, missed: missed, expectedTotal: expectedTotal, defectCaught: defectCaught, defectExpected: defectExpected, falsePositives: rows.filter(function (x) { return x.labelled === "not checkable" }) }
}

if (import.meta.url === new URL("file://" + process.argv[1]).href) {
  const m = await measure()
  const fmt = function (v) { return (v * 100).toFixed(0) + "%" }
  console.log("texts: " + m.texts)
  console.log("extraction precision: " + fmt(m.precision) + "  (" + m.truePositive + " of " + (m.truePositive + m.falsePositive) + " flagged sentences were labelled checkable)")
  console.log("extraction recall:    " + fmt(m.recall) + "  (" + (m.expectedTotal - m.missed) + " of " + m.expectedTotal + " labelled sentences were found)")
  const defectRate = m.defectRate === null ? "n/a" : fmt(m.defectRate)
  const defectDetail = m.defectRate === null ? "" : "  (" + m.defectCaught + " of " + m.defectExpected + " planted defects flagged)"
  console.log("defect catch rate:    " + defectRate + defectDetail)
  console.log("")
  console.log("sentences the extractor flagged that are not checkable:")
  for (const r of m.falsePositives) console.log("  [" + r.id + "] " + r.sentence)
}
