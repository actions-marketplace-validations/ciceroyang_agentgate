#!/usr/bin/env node
/**
 * 从外网验收公开 demo。
 *
 * 覆盖不到的:systemd、Caddy 配置文件本身。覆盖得到的:证书能不能用、页面在不在、
 * 服务有没有真的在跑(records 不是样本的 300 条)、索引是不是当天的,以及 2026-09-18 那次
 * 主域对调有没有对调干净:产品在主域、个人站在 cicero.、旧地址 app. 的页面 301 而 API 仍直连。
 *
 *   node scripts/verify-public.mjs --base https://xn--5kvo87g.com --expect-min 1000
 */
const argv = process.argv.slice(2)
const argOf = function (name, fallback) {
  const i = argv.indexOf("--" + name)
  return i === -1 ? fallback : argv[i + 1]
}
const base = (argOf("base", "https://xn--5kvo87g.com")).replace(/\/$/, "")
const personal = (argOf("personal", "https://cicero.xn--5kvo87g.com")).replace(/\/$/, "")
const legacy = (argOf("legacy", "https://app.xn--5kvo87g.com")).replace(/\/$/, "")
const expectMin = Number(argOf("expect-min", 1000))
let failures = 0
const check = function (name, ok, detail) {
  if (ok) { console.log("ok    " + name); return }
  failures += 1
  console.log("FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 200) : ""))
}
/** One request. A failure is a result, not an exception: a site that is not up yet should show
 *  as every check failing with a reason, not as the first line aborting the whole report. */
const get = async function (url) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20000) })
    return { status: res.status, type: res.headers.get("content-type") || "", text: await res.text() }
  } catch (error) {
    return { status: 0, type: "", text: "", error: String((error && error.message) || error) }
  }
}

try {
  const home = await get(base + "/")
  check("首页可达(证书有效、Caddy 有 app. 的站点)", home.status === 200, home.status)
  check("首页是站点而不是 API", home.type.indexOf("text/html") !== -1, home.type)
  check("首页是产品页,不是另一个站点", home.text.indexOf("agentgate") !== -1 || home.text.indexOf("智量") !== -1)

  for (const p of ["/pricing.html", "/try.html", "/evidence.html", "/report-sample.html", "/security.html", "/privacy.html"]) {
    const r = await get(base + p)
    check("页面 " + p, r.status === 200 && r.type.indexOf("text/html") !== -1, r.status + " " + r.type)
  }
  const pilot = await get(base + "/en/pilot.html")
  check("英文企业试点页", pilot.status === 200 && pilot.type.indexOf("text/html") !== -1 && pilot.text.indexOf("Week 1 continuation gate") !== -1, pilot.status + " " + pilot.type)

  // RFC 9116 puts this at a fixed path; a security page without it is a page nobody's scanner
  // will find.
  const securityTxt = await get(base + "/.well-known/security.txt")
  check("security.txt 在 RFC 规定的路径上", securityTxt.status === 200, securityTxt.status + " " + securityTxt.type)
  check("security.txt 里有 Contact 与 Expires", /^Contact:/m.test(securityTxt.text) && /^Expires:/m.test(securityTxt.text), securityTxt.text.slice(0, 120))

  const health = await get(base + "/health")
  let h = null
  try { h = JSON.parse(health.text) } catch (error) {}
  check("/health 是 200 且是 JSON", health.status === 200 && h !== null, health.status + " " + health.text.slice(0, 80))
  if (h) {
    check("服务真的在跑,不是在读样本(records >= " + expectMin + ")", typeof h.records === "number" && h.records >= expectMin, "records=" + h.records)
    const age = h.generatedAt ? (Date.now() - Date.parse(h.generatedAt)) / 3600000 : null
    check("索引是 36 小时内生成的", age !== null && age < 36, h.generatedAt || "no generatedAt")
  }

  const summary = await get(base + "/v1/index/summary")
  check("/v1/index/summary 可达", summary.status === 200, summary.status)
  const list = await get(base + "/v1/servers?limit=1")
  check("/v1/servers 可达", list.status === 200, list.status)
  const badge = await get(base + "/badge/anything.svg")
  check("badge 渲染成 SVG", badge.status === 200 && badge.type.indexOf("image/svg+xml") !== -1 && badge.text.indexOf("<svg") === 0, badge.status + " " + badge.type)

  // 2026-09-18: the product took the apex and the personal site moved to its own name. Both are
  // checked here because a switch that half-happened looks fine from either side alone.
  const personalHome = await get(personal + "/")
  check("个人站在自己的域名上可达", personalHome.status === 200 && personalHome.type.indexOf("text/html") !== -1, personalHome.status + " " + personalHome.type)
  check("那个域名上是个人站,不是产品页", personalHome.text.indexOf("Cicero Yang") !== -1 || personalHome.text.indexOf("杨雨衡") !== -1, personalHome.text.slice(0, 80))
  const legacyPage = await get(legacy + "/pricing.html")
  check("旧地址 app. 的页面 301 到主域", legacyPage.status === 301, legacyPage.status)
  const legacyApi = await get(legacy + "/v1/index/summary")
  check("旧地址的 /v1 仍然直连可用(已经在用它的地方不用当天改)", legacyApi.status === 200, legacyApi.status)
} catch (error) {
  check("请求本身成功", false, error && error.message)
}

console.log("")
console.log(failures === 0 ? "公开验收: 全过 (" + base + ")" : "公开验收: " + failures + " 项没过")
process.exit(failures === 0 ? 0 : 1)
