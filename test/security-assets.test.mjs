import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { scratchDir } from "./tmpdir.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Built once: the checks below are all about the copy that a visitor would receive. */
function build() {
  const out = scratchDir("ag-security-")
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"), "--index", join(ROOT, "data", "sample-index.json"), "--out", out], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  return out
}

const site = build()
const securityHtml = readFileSync(join(site, "security.html"), "utf8")
const privacyHtml = readFileSync(join(site, "privacy.html"), "utf8")
const securityTxt = readFileSync(join(site, ".well-known", "security.txt"), "utf8")

test("the three compliance paths are in the build output", function () {
  assert.equal(existsSync(join(site, ".well-known", "security.txt")), true)
  assert.equal(existsSync(join(site, "security.html")), true)
  assert.equal(existsSync(join(site, "privacy.html")), true)
})

test("security.txt follows RFC 9116 and does not expire in the past", function () {
  const field = function (name) {
    const match = new RegExp("^" + name + ":\\s*(.+)$", "m").exec(securityTxt)
    return match ? match[1].trim() : null
  }
  assert.match(field("Contact") || "", /^mailto:.+@.+$/)
  assert.match(field("Canonical") || "", /^https:\/\//)
  assert.match(field("Policy") || "", /^https:\/\//)
  const expires = Date.parse(field("Expires") || "")
  assert.equal(Number.isFinite(expires), true, "Expires must be a date")
  assert.ok(expires > Date.now(), "an expired security.txt points at an address nobody reads")
})

test("the pages are static: no scripts and no third-party requests", function () {
  for (const [name, html] of [["security.html", securityHtml], ["privacy.html", privacyHtml]]) {
    assert.equal(html.indexOf("<script"), -1, name + " must not carry a script")
    assert.equal(html.indexOf("http://") , -1, name + " must not reference plain http")
    assert.equal(/src="https?:/.test(html), false, name + " must not load external resources")
    // The two names are ours: the apex (product since 2026-09-18) and app. (legacy, still a 301).
    assert.equal(/href="https:\/\/(?!xn--5kvo87g\.com|app\.xn--5kvo87g\.com)/.test(html), false, name + " must not link to a third-party origin")
  }
})

test("the security page claims only what the deployment actually does", function () {
  // Both names are the switches the deployment reads; the claim is checkable, not a slogan.
  assert.match(securityHtml, /AGENTGATE_ACCESS_LOG/)
  assert.match(securityHtml, /不记/)
  assert.match(securityHtml, /Caddy/)
  assert.match(privacyHtml, /核不到的/)
})

test("neither page claims a certification or a compliance outcome", function () {
  // Only affirmative claims are forbidden: a sentence that says we do NOT promise something is
  // the opposite of the failure this guards against, and a regex cannot tell the two apart by
  // keyword alone.
  const overclaim = /已通过(认证|审计)|已认证|保证(能)?(通过|合规)|完全合规|合规通过|我们已合规/
  for (const [name, html] of [["security.html", securityHtml], ["privacy.html", privacyHtml]]) {
    assert.equal(overclaim.test(html), false, name)
  }
  assert.match(securityHtml, /不替任何人认证/)
  assert.match(securityHtml, /不承诺/)
})

test("both pages are in the sitemap", function () {
  const sitemap = readFileSync(join(site, "sitemap.xml"), "utf8")
  assert.match(sitemap, /security\.html/)
  assert.match(sitemap, /privacy\.html/)
})
