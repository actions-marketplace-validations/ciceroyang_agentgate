#!/usr/bin/env node
/**
 * Read an answer, list what can be checked, check what can be checked offline, and
 * mark the rest unchecked. Nothing here decides whether the answer is true; it says
 * which parts have something behind them and which parts nobody looked at.
 */
import { readFileSync } from "node:fs"
import { extractClaims, urlsIn } from "../src/claims.mjs"
import { dateProblem, invalidMonthName, resolveUrl, SUPPORTED, CONTRADICTED, UNCHECKED } from "../src/check.mjs"

export async function report(text, options) {
  const opts = options || {}
  const claims = extractClaims(text)
  const urls = Array.from(new Set(urlsIn(text)))
  const linkResults = []
  for (const u of urls) linkResults.push(await resolveUrl(u, opts.fetchHead))
  const findings = []
  for (const c of claims) {
    const problems = []
    const d = dateProblem(c.text, opts.now)
    if (d) problems.push({ status: CONTRADICTED, detail: d })
    const badMonth = invalidMonthName(c.text)
    if (badMonth) problems.push({ status: CONTRADICTED, detail: badMonth })
    if (c.kinds.indexOf("citation") !== -1 && urls.length === 0) problems.push({ status: UNCHECKED, detail: "a citation marker with no reference to resolve" })
    findings.push({ text: c.text, kinds: c.kinds, status: problems.length > 0 ? problems[0].status : UNCHECKED, detail: problems.length > 0 ? problems[0].detail : "nothing outside the answer was consulted", url: c.kinds.indexOf("url") !== -1 })
  }
  return { claims: claims.length, links: linkResults, findings: findings }
}

function render(r) {
  const lines = []
  lines.push("checkable claims: " + r.claims)
  lines.push("")
  for (const l of r.links) lines.push("  " + l.status.toUpperCase().padEnd(14) + l.url.slice(0, 70) + "  " + l.detail)
  if (r.links.length > 0) lines.push("")
  for (const f of r.findings) {
    lines.push("  " + f.status.toUpperCase().padEnd(14) + "[" + f.kinds.join(",") + "] " + f.text.slice(0, 90))
    lines.push("                 " + f.detail)
  }
  const contradicted = r.findings.filter(function (f) { return f.status === "contradicted" }).length + r.links.filter(function (l) { return l.status === "contradicted" }).length
  const unchecked = r.findings.filter(function (f) { return f.status === "unchecked" }).length + r.links.filter(function (l) { return l.status === "unchecked" }).length
  lines.push("")
  lines.push("contradicted: " + contradicted + "   unchecked: " + unchecked + "   (no confidence score is produced on purpose)")
  return lines.join("\n")
}

const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const offline = args.indexOf("--no-network") !== -1
  const fileIndex = args.indexOf("--file")
  const text = fileIndex !== -1 ? readFileSync(args[fileIndex + 1], "utf8") : readFileSync(0, "utf8")
  const fetchHead = offline ? async function () { return { status: 0 } } : undefined
  report(text, { fetchHead: fetchHead }).then(function (r) { process.stdout.write(render(r) + "\n") })
}
