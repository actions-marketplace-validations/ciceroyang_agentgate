import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizePolicy } from "../../policy/src/policy.mjs"
import { decideToolCall, filterTools } from "../src/decide.mjs"

const policy = normalizePolicy({ forbidden: { tools: ["delete_*", "send_money"] } })

test("a forbidden tool is refused with a reason", function () {
  const d = decideToolCall(policy, "delete_file")
  assert.equal(d.allowed, false)
  assert.match(d.reason, /forbidden pattern delete_/)
  assert.equal(decideToolCall(policy, "send_money").allowed, false)
})

test("anything not forbidden is allowed", function () {
  assert.equal(decideToolCall(policy, "read_file").allowed, true)
})

test("a call with no tool name is refused rather than passed through", function () {
  assert.equal(decideToolCall(policy, undefined).allowed, false)
})

test("the tool list is filtered, and what was removed is reported", function () {
  const out = filterTools(policy, [{ name: "read_file" }, { name: "delete_file" }, { name: "send_money" }])
  assert.deepEqual(out.kept.map(function (t) { return t.name }), ["read_file"])
  assert.equal(out.removed.length, 2)
  assert.match(out.removed[0].reason, /forbidden/)
})
