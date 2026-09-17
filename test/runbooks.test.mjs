import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OPS = join(ROOT, "docs", "operations")

function read(name) {
  return readFileSync(join(OPS, name), "utf8")
}

const docs = readdirSync(OPS).filter(function (name) { return name.endsWith(".md") })
const index = read("README.md")

test("every script a runbook tells you to run actually exists", function () {
  const missing = []
  for (const name of docs) {
    const text = read(name)
    for (const match of text.matchAll(/scripts\/[a-z0-9-]+\.(?:mjs|sh)/g)) {
      const target = join(ROOT, match[0])
      if (!existsSync(target)) missing.push(name + " -> " + match[0])
    }
  }
  assert.deepEqual(missing, [], "documentation points at scripts that are not there")
})

test("every operations page is reachable from the index", function () {
  const unlinked = docs.filter(function (name) {
    return name !== "README.md" && index.indexOf(name) === -1
  })
  assert.deepEqual(unlinked, [], "a runbook nobody links to is a runbook nobody finds")
})

test("the incident page covers discovery, triage, the forbidden moves, and a postmortem", function () {
  const text = read("incidents.md")
  assert.match(text, /你怎么知道出事了/)
  assert.match(text, /第一分钟/)
  assert.match(text, /止血优先于根因/)
  assert.match(text, /不要做的事/)
  assert.match(text, /复盘模板/)
  assert.match(text, /复盘记录/)
  // It has to name the mechanisms that actually alert today.
  assert.match(text, /scripts\/healthcheck\.sh/)
  assert.match(text, /history_age/)
  assert.match(text, /没有外部 uptime 监控/)
})

test("the incident page says where a bad ledger is restored from", function () {
  const text = read("incidents.md")
  assert.match(text, /restore-drill\.mjs/)
  assert.match(text, /rollback\.md/)
  assert.match(text, /不要动/)
})

test("key rotation names every credential and how to verify the rotation", function () {
  const text = read("key-rotation.md")
  assert.match(text, /SMTP_PASS/)
  assert.match(text, /agentgate_deploy/)
  assert.match(text, /auth-and-writes/)
  assert.match(text, /npm token list/)
  assert.match(text, /轮换后必须做的事/)
  assert.match(text, /先加后删/)
})

test("the runbooks cross-link instead of duplicating each other", function () {
  assert.match(read("rollback.md"), /incidents\.md/)
  assert.match(read("incidents.md"), /rollback\.md/)
  assert.match(read("deployment-runbook.md"), /rollback\.md|incidents\.md/)
})

test("no runbook ships with a placeholder in it", function () {
  const checked = ["README.md", "incidents.md", "key-rotation.md", "rollback.md", "deployment-runbook.md"]
  for (const name of checked) {
    const text = read(name)
    assert.equal(/\bTODO\b|\bTBD\b|待补|FIXME/.test(text), false, name + " still has a placeholder")
  }
})
