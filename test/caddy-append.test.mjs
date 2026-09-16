import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

/**
 * Appending into a Caddyfile that belongs to somebody else.
 *
 * The two cases that bite are dull ones: a file whose last line has no newline (the first line of
 * our block would be glued onto it) and running twice (the block must be replaced, not stacked).
 * Both are cheap to get right here and expensive to discover on a live machine.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(ROOT, "scripts", "caddy-append.sh")
const MARK = "# agentgate-managed-begin"

function setup(destContent) {
  const dir = mkdtempSync(join(tmpdir(), "ag-append-"))
  const dest = join(dir, "Caddyfile")
  if (destContent !== null && destContent !== undefined) writeFileSync(dest, destContent)
  const block = join(dir, "block")
  writeFileSync(block, [MARK, "app.xn--5kvo87g.com {", "  respond \"ok\"", "}", "# agentgate-managed-end", ""].join("\n"))
  return { dir: dir, dest: dest, block: block }
}
const run = function (s) { return spawnSync("bash", [SCRIPT, s.dest, s.block], { encoding: "utf8" }) }

test("a last line without a newline does not swallow the first line of the block", function () {
  const s = setup("xn--5kvo87g.com {\n  file_server\n}")   // no trailing newline
  const out = run(s)
  assert.equal(out.status, 0, out.stderr)
  const lines = readFileSync(s.dest, "utf8").split("\n")
  const at = lines.indexOf(MARK)
  assert.notEqual(at, -1, "the marker is not on a line of its own:\n" + lines.join("\n"))
  assert.equal(lines[at - 1], "}", "the original last line was not left alone")
  rmSync(s.dir, { recursive: true, force: true })
})

test("running twice replaces the block instead of stacking it", function () {
  const s = setup("xn--5kvo87g.com {\n  file_server\n}\n")
  run(s)
  run(s)
  const text = readFileSync(s.dest, "utf8")
  assert.equal(text.split(MARK).length - 1, 1, "the block is there more than once")
  assert.equal(text.split("agentgate-managed-end").length - 1, 1)
  assert.match(text, /^xn--5kvo87g\.com \{/m, "the original site was removed")
  rmSync(s.dir, { recursive: true, force: true })
})

test("a missing Caddyfile is created, and a backup is kept when one exists", function () {
  const fresh = setup(null)
  assert.equal(existsSync(fresh.dest), false)
  assert.equal(run(fresh).status, 0)
  assert.match(readFileSync(fresh.dest, "utf8"), new RegExp(MARK))
  rmSync(fresh.dir, { recursive: true, force: true })

  const existing = setup("xn--5kvo87g.com {\n  file_server\n}\n")
  run(existing)
  const backups = readFileSync(existing.dest, "utf8")
  assert.match(backups, /xn--5kvo87g\.com/, "the original content was lost")
  const dir = spawnSync("ls", [join(existing.dir)], { encoding: "utf8" }).stdout
  assert.match(dir, /Caddyfile\.bak\./, "no backup was taken")
  rmSync(existing.dir, { recursive: true, force: true })
})
