import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { join } from "node:path"
import { walk, makeReader } from "../src/fs-scan.mjs"
import { runScan } from "../src/engine.mjs"
import { check as sourceInjection } from "../src/checks/source-injection.mjs"
import { scratchDir } from "../../../test/tmpdir.mjs"

/**
 * The walker, pointed at repositories this project does not control.
 *
 * Two things it must not do with someone else\u0027s tree: follow a link out of the directory it
 * was asked to scan, and let a file it could not read become a clean verdict. The first was
 * already correct -- readdir with withFileTypes gives lstat semantics, so a symlink is neither
 * a file nor a directory -- but nothing said so, and a refactor to stat() would have broken it
 * silently. The second is now enforced with a size limit that fails loudly.
 */

test("a link out of the tree is not followed, and a loop terminates", function () {
  const base = scratchDir("ag-walk-")
  const root = join(base, "root")
  const outside = join(base, "outside")
  mkdirSync(root)
  mkdirSync(outside)
  // a shape the scanner does report when it is really inside the tree
  writeFileSync(join(outside, "secret.js"), "exec(cmd + args)\n")
  symlinkSync(join(outside, "secret.js"), join(root, "linked.js"))
  symlinkSync(outside, join(root, "linked-dir"))
  symlinkSync(root, join(root, "loop"))
  writeFileSync(join(root, "real.js"), "const x = 1\n")

  const files = walk(root, { exts: [".js"], maxFiles: 200 })
  assert.deepEqual(files.map(function (f) { return f.rel }).sort(), ["real.js"], "the walker left the tree")

  const scan = runScan({ root: root, checks: [sourceInjection], readText: makeReader() })
  assert.equal(scan.findings.length, 0, "content from outside the scanned root was reported: " + JSON.stringify(scan.findings))
  rmSync(base, { recursive: true, force: true })
})

test("a file over the size limit is incomplete, never clean", function () {
  const dir = scratchDir("ag-size-")
  writeFileSync(join(dir, "big.js"), "const pad = \"" + "x".repeat(5000) + "\"\n")

  const scan = runScan({ root: dir, checks: [sourceInjection], readText: makeReader({ maxBytes: 512 }) })
  assert.equal(scan.verdict, "incomplete", "an unread file produced a clean verdict")
  assert.equal(scan.findings.length, 0)
  assert.ok(scan.coverage.checksFailed.length > 0, "the failure was not reported")
  assert.match(scan.coverage.checksFailed[0].error, /over the 512 byte limit/)

  // the same file is read normally once it is within the limit
  const ok = runScan({ root: dir, checks: [sourceInjection], readText: makeReader({ maxBytes: 100000 }) })
  assert.notEqual(ok.verdict, "incomplete", "a readable file should not be reported as unread")
  rmSync(dir, { recursive: true, force: true })
})

test("a bundled file is not read before it is skipped", function () {
  const dir = scratchDir("ag-bundle-")
  // not in dist/, which the walker skips by name, so this exercises the check itself
  writeFileSync(join(dir, "app.bundle.js"), "exec(cmd + args)\n")
  const read = []
  const scan = runScan({ root: dir, checks: [sourceInjection], readText: function (abs) { read.push(abs); return makeReader()(abs) } })
  assert.deepEqual(read, [], "generated output was read before being discarded: " + read.join(", "))
  assert.equal(scan.findings.length, 0)
  rmSync(dir, { recursive: true, force: true })
})
