import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { checkManifest, check } from "../src/checks/supply-chain.mjs"
import { makeReader } from "../src/fs-scan.mjs"
import { scratchDir } from "../../../test/tmpdir.mjs"

function rules(f) { return f.map(function (x) { return x.rule }).sort() }

test("a dependency from a git or http source is high", function () {
  const got = rules(checkManifest("package.json", JSON.stringify({ dependencies: { a: "git+https://x/y.git", b: "https://x/z.tgz" } })))
  assert.deepEqual(got, ["AG-SUPPLY-001", "AG-SUPPLY-001"])
})

test("a file: dependency is a packaging problem, not a remote source", function () {
  const runtime = checkManifest("package.json", JSON.stringify({ dependencies: { a: "file:../models" } }))
  assert.equal(runtime[0].rule, "AG-SUPPLY-001")
  assert.equal(runtime[0].severity, "medium")
  assert.match(runtime[0].message, /inside this repository/)
  const dev = checkManifest("package.json", JSON.stringify({ devDependencies: { a: "link:../models" } }))
  assert.equal(dev[0].severity, "low")
})

test("a floating version is flagged", function () {
  const got = rules(checkManifest("package.json", JSON.stringify({ dependencies: { a: "*", b: "latest" } })))
  assert.deepEqual(got, ["AG-SUPPLY-002", "AG-SUPPLY-002"])
})

test("a normal semver range is not flagged", function () {
  assert.deepEqual(checkManifest("package.json", JSON.stringify({ dependencies: { a: "^1.2.3" } })), [])
})

test("declared dependencies with no lockfile is a low finding", function () {
  const dir = scratchDir("ag-supply-")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { a: "1.0.0" } }))
  const out = check.run({ root: dir, readText: makeReader() })
  assert.deepEqual(rules(out.findings), ["AG-SUPPLY-003"])
})

test("a committed lockfile silences the lockfile rule", function () {
  const dir = scratchDir("ag-supply-")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { a: "1.0.0" } }))
  writeFileSync(join(dir, "package-lock.json"), "{}")
  assert.deepEqual(check.run({ root: dir, readText: makeReader() }).findings, [])
})

test("a runtime dependency from a mutable source is high, a dev one is medium", function () {
  const runtime = checkManifest("package.json", JSON.stringify({ dependencies: { a: "git+https://x/y.git" } }))
  const dev = checkManifest("package.json", JSON.stringify({ devDependencies: { a: "git+https://x/y.git" } }))
  assert.equal(runtime[0].severity, "high")
  assert.equal(dev[0].severity, "medium")
  assert.match(dev[0].message, /dev-only/)
})

test("a floating dev dependency is low, a floating runtime one is medium", function () {
  const runtime = checkManifest("package.json", JSON.stringify({ dependencies: { a: "*" } }))
  const dev = checkManifest("package.json", JSON.stringify({ devDependencies: { a: "*" } }))
  assert.equal(runtime[0].severity, "medium")
  assert.equal(dev[0].severity, "low")
})
