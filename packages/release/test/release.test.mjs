import test from "node:test"
import assert from "node:assert/strict"
import { classifyPack, changelogHasVersion, pathsFromPackJson, summarize, tagMatches, versionFromTag, REQUIRED_FILES } from "../src/release.mjs"

test("a tag is the version with an optional v", function () {
  assert.equal(versionFromTag("v0.1.1"), "0.1.1")
  assert.equal(versionFromTag("0.1.1"), "0.1.1")
  assert.equal(tagMatches("v0.1.1", "0.1.1"), true)
  assert.equal(tagMatches("v0.1.10", "0.1.1"), false)
  assert.equal(tagMatches("v0.2.0", "0.1.1"), false)
})

test("npm pack output is read, and anything else is refused", function () {
  const paths = pathsFromPackJson(JSON.stringify([{ files: [{ path: "LICENSE" }, { path: "bin/agentgate.mjs" }] }]))
  assert.deepEqual(paths, ["LICENSE", "bin/agentgate.mjs"])
  assert.deepEqual(pathsFromPackJson(JSON.stringify({ files: [{ path: "a" }] })), ["a"])
  assert.throws(function () { pathsFromPackJson("not json") }, /不是 JSON/)
  assert.throws(function () { pathsFromPackJson(JSON.stringify({})) }, /没有 files 列表/)
})

test("the changelog has to have this version's section, and 0.1.1 is not 0.1.10", function () {
  assert.equal(changelogHasVersion("## [0.1.1] - 2026-09-17\n", "0.1.1"), true)
  assert.equal(changelogHasVersion("## 0.1.1\n", "0.1.1"), true)
  assert.equal(changelogHasVersion("## [0.2.0]\n", "0.1.1"), false)
  assert.equal(changelogHasVersion("## [0.1.10] - x\n", "0.1.1"), false)
})

test("a tarball with a missing file, a leak or an unexplained path is classified", function () {
  const paths = ["package.json", "README.md", "LICENSE", "bin/agentgate.mjs", "packages/x.mjs", "data/index.json", "docs/notes.md"]
  const classified = classifyPack(paths.filter(function (p) { return p !== "LICENSE" }), { allow: ["bin/", "packages/", "docs/spec/"] })
  assert.deepEqual(classified.missing, ["LICENSE"])
  assert.equal(REQUIRED_FILES.indexOf("bin/agentgate.mjs") !== -1, true)
  assert.deepEqual(classified.leaks.map(function (leak) { return leak.path }), ["data/index.json"])
  assert.deepEqual(classified.unexplained, ["package.json", "README.md", "docs/notes.md"])
})

test("a .env, a ledger and a tarball inside the package are all leaks", function () {
  const leaks = classifyPack([".env", "smtp.env", "data/history/ledger.jsonl", "dist/x.tgz", "a/b.log", "node_modules/x.js"], { allow: [] })
  assert.equal(leaks.leaks.length, 6)
})

test("a warning does not block a release and a problem does", function () {
  const warned = summarize([{ level: "warning", ok: false, detail: "dirty tree" }, { level: "problem", ok: true, detail: "fine" }])
  assert.equal(warned.ok, true)
  assert.deepEqual(warned.warnings, ["dirty tree"])
  const failed = summarize([{ level: "problem", ok: false, detail: "no changelog" }])
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.problems, ["no changelog"])
})
