import { test } from "node:test"
import assert from "node:assert/strict"
import { toHtmlReport, esc } from "../src/html-report.mjs"

const base = function (extra) {
  return Object.assign({ verdict: "findings", policyVersion: "agentgate.policy/v1", findings: [], coverage: { checksRun: ["mcp-config"], checksFailed: [], evidenceMissing: [], filesRead: [".mcp.json"], unparsedFiles: [], malformed: [] } }, extra || {})
}

test("a finding appears with its rule, location and reason", function () {
  const html = toHtmlReport(base({ findings: [{ rule: "AG-MCP-010", severity: "medium", file: ".mcp.json", message: "runs npx without a pin", reason: "forbidden by policy" }] }), { root: "/repo" })
  assert.match(html, /AG-MCP-010/)
  assert.match(html, /forbidden by policy/)
  assert.match(html, /FINDINGS/)
})

test("an incomplete result says so before the findings", function () {
  const html = toHtmlReport(base({ verdict: "incomplete", coverage: { checksRun: [], checksFailed: [{ id: "mcp-config", error: "boom" }], evidenceMissing: [{ server: "a/b", block: "packageManifest", reason: "metadata-unavailable" }], filesRead: [] } }), {})
  assert.match(html, /不等于通过/)
  assert.ok(html.indexOf("无法测量的部分") < html.indexOf("发现("), "the unmeasured section must come before the findings")
  assert.match(html, /metadata-unavailable/)
})

test("no unmeasured section when nothing is unmeasured", function () {
  assert.equal(toHtmlReport(base({}), {}).includes("无法测量的部分"), false)
})

test("the report is static: no script tag at all", function () {
  assert.equal(toHtmlReport(base({}), {}).includes("<script"), false)
})

test("content is escaped, so a finding cannot inject markup", function () {
  const html = toHtmlReport(base({ findings: [{ rule: "R", severity: "high", file: "a", message: "<script>alert(1)</script>", reason: "<img onerror=1>" }] }), {})
  assert.equal(html.includes("<script>alert(1)</script>"), false)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.equal(html.includes("<img onerror"), false)
})

test("esc handles null and undefined without printing them", function () {
  assert.equal(esc(undefined), "")
  assert.equal(esc(null), "")
  assert.equal(esc("a&b"), "a&amp;b")
})

test("tables are balanced", function () {
  const html = toHtmlReport(base({ findings: [{ rule: "R", severity: "low", file: "a", message: "m", reason: "r" }] }), {})
  assert.equal((html.match(/<table>/g) || []).length, (html.match(/<\/table>/g) || []).length)
})

test("every field that can come from the repository under scan is escaped", function () {
  // The report is the artefact the free checkup hands over, and it is built from names the
  // repository chooses: file paths, server keys, package names. One payload in every field,
  // including the ones the earlier test did not reach.
  const p = "<script>alert(1)</script>"
  const q = String.fromCharCode(34) + "><img onerror=1>"
  const html = toHtmlReport({
    verdict: p,
    policyVersion: p,
    findings: [{ rule: p, severity: "high", file: q, message: p, reason: q }],
    coverage: {
      checksRun: [p],
      checksFailed: [{ id: p, error: q }],
      evidenceMissing: [{ server: q, block: p, reason: q }],
      filesRead: [q],
      unparsedFiles: [p],
      malformed: [{ source: p, detail: q }],
    },
  }, { root: q, generatedAt: p, policy: { note: p } })

  assert.equal(html.indexOf("<script"), -1, "a script tag survived")
  assert.equal(html.indexOf("<img onerror"), -1, "an image tag survived")
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  // the verdict lands inside a class attribute, where a quote is the dangerous character
  assert.equal(html.indexOf("class=\"verdict " + q), -1, "a quote closed the class attribute")
})
