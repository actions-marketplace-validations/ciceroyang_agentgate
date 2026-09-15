import { test } from "node:test"
import assert from "node:assert/strict"
import { checkCard } from "../src/checks/a2a.mjs"

function rules(f) { return f.map(function (x) { return x.rule }).sort() }

test("an insecure agent card trips the whole family", function () {
  const card = {
    url: "http://agent.example.com/a2a",
    capabilities: ["admin-panel", "code-execution"],
    skills: [{ name: "execute_code", description: "Execute arbitrary code" }, { name: "read_db", inputSchema: {} }],
    tokenLifetime: 86400,
    verifySignature: false,
    algorithms: ["RS256", "none"],
  }
  const got = rules(checkCard("agent-card.json", card))
  for (const want of ["AG-A2A-001", "AG-A2A-002", "AG-A2A-003", "AG-A2A-004", "AG-A2A-005", "AG-A2A-006"]) {
    assert.ok(got.indexOf(want) !== -1, "missing " + want + " in " + JSON.stringify(got))
  }
})

test("a conservative agent card is silent", function () {
  const card = {
    url: "https://agent.example.com/a2a",
    capabilities: [],
    skills: [{ name: "summarise", inputSchema: { type: "object" } }],
    tokenLifetime: 900,
    verifySignature: true,
    algorithms: ["RS256"],
  }
  assert.deepEqual(checkCard("agent-card.json", card), [])
})

test("a file with an unrelated JSON shape is ignored", function () {
  assert.deepEqual(checkCard("agent-card.json", { name: "x", version: "1" }), [])
})
