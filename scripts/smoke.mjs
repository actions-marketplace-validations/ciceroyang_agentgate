#!/usr/bin/env node
/**
 * 部署后检查。对给定地址问几个必须成立的问题，任何一条不成立就非零退出。
 *
 *   node scripts/smoke.mjs https://api.智量.com
 *   node scripts/smoke.mjs http://127.0.0.1:8080 --expect-min 1000
 */
const base = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/$/, "")
const argOf = function (name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : Number(process.argv[i + 1]) }
const expectMin = argOf("--expect-min", 0)
let failures = 0
const check = function (name, ok, detail) {
  if (ok) { console.log("ok    " + name); return }
  failures += 1
  console.log("FAIL  " + name + (detail ? "  -> " + detail : ""))
}
const get = async function (path) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(15000) })
  return { status: res.status, text: await res.text() }
}

try {
  const health = await get("/health")
  const h = JSON.parse(health.text)
  check("服务可达且 /health 是 200", health.status === 200, String(health.status))
  check("索引存在", typeof h.records === "number", JSON.stringify(h).slice(0, 120))
  if (expectMin > 0) check("索引至少有 " + expectMin + " 条（不是样本）", h.records >= expectMin, "records=" + h.records)
  const age = h.generatedAt ? (Date.now() - Date.parse(h.generatedAt)) / 3600000 : null
  check("索引是 36 小时内生成的", age !== null && age < 36, h.generatedAt || "no generatedAt")

  const summary = await get("/v1/index/summary")
  const s = JSON.parse(summary.text)
  check("/v1/index/summary 有 verdict 计数", s.verdicts && (s.verdicts.clean + s.verdicts.findings + s.verdicts.incomplete) > 0, JSON.stringify(s.verdicts))

  const list = await get("/v1/servers?limit=1")
  const l = JSON.parse(list.text)
  const first = l.records && l.records[0]
  check("能列出记录", !!first, list.text.slice(0, 120))
  if (first) {
    const rec = await get("/v1/servers/" + encodeURIComponent(first.server))
    check("能取到单个记录", rec.status === 200 && JSON.parse(rec.text).server === first.server, String(rec.status))
    const badge = await get("/badge/" + encodeURIComponent(first.server) + ".svg")
    check("badge 能渲染", badge.status === 200 && badge.text.indexOf("<svg") === 0, String(badge.status))
  }
} catch (error) {
  failures += 1
  console.log("FAIL  连不上 " + base + "  -> " + error.message)
}

console.log("")
console.log(failures === 0 ? "smoke: green (" + base + ")" : "smoke: " + failures + " failure(s)")
process.exit(failures === 0 ? 0 : 1)
