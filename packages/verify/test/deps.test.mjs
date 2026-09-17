import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { bareImportsOf, dependencyNames, isLocalSpecifier, scanBareImports } from "../src/deps.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

test("every import form is recognised", function () {
  const source = [
    'import a from "pkg-a"',
    'import { b } from "pkg-b"',
    'import "pkg-c"',
    'export { d } from "pkg-d"',
    'const e = require("pkg-e")',
    'const f = await import("pkg-f")',
  ].join("\n")
  assert.deepEqual(bareImportsOf(source).map(function (h) { return h.specifier }), ["pkg-a", "pkg-b", "pkg-c", "pkg-d", "pkg-e", "pkg-f"])
})

test("node built-ins, relative, absolute and URL specifiers are not dependencies", function () {
  const source = [
    'import { readFileSync } from "node:fs"',
    'import { join } from "path"',
    'import { x } from "./sibling.mjs"',
    'import { y } from "../up.mjs"',
    'import { z } from "/etc/absolute.mjs"',
    'const u = await import("file:///tmp/x.mjs")',
  ].join("\n")
  assert.deepEqual(bareImportsOf(source), [])
  assert.equal(isLocalSpecifier("node:test"), true)
  assert.equal(isLocalSpecifier("@scope/pkg"), false)
})

test("a specifier written inside a string is not an import", function () {
  const source = 'const fixture = \'const z = require("left-pad")\';\nwriteFileSync(p, "import x from \'pkg\'")'
  assert.deepEqual(bareImportsOf(source), [])
})

test("the line number is reported, so the failure can be found", function () {
  const hits = bareImportsOf('import a from "./local.mjs"\n\nimport b from "bad-pkg"')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].line, 3)
})

test("scanning several files keeps the path with the problem", function () {
  const problems = scanBareImports([
    { path: "a.mjs", text: 'import x from "left-pad"' },
    { path: "b.mjs", text: 'import y from "./local.mjs"' },
  ])
  assert.deepEqual(problems, [{ path: "a.mjs", specifier: "left-pad", line: 1 }])
})

test("all four dependency fields count", function () {
  const names = dependencyNames({ dependencies: { a: "1" }, devDependencies: { b: "1" }, optionalDependencies: { c: "1" }, peerDependencies: { d: "1" } })
  assert.deepEqual(names.dependencies, ["a"])
  assert.deepEqual(names.devDependencies, ["b"])
  assert.deepEqual(names.optionalDependencies, ["c"])
  assert.deepEqual(names.peerDependencies, ["d"])
})

test("this repository really has none, checked the way CI checks it", function () {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "check-zero-deps.mjs")], { cwd: ROOT, encoding: "utf8" })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /zero dependencies/)
})
