import test from "node:test"
import assert from "node:assert/strict"
import { classifyPaths, planIncremental } from "../scripts/classify-repositories.mjs"

test("the rule keeps the path that decided it, so a reader can check the verdict", function () {
  assert.deepEqual(classifyPaths(["src/mcp_server.py", "pyproject.toml"]),
    { kind: "server-like", matched: "src/mcp_server.py" })
  assert.deepEqual(classifyPaths(["mcp.json", "README.md"]), { kind: "descriptor-only", matched: "mcp.json" })
  assert.deepEqual(classifyPaths(["package.json", "src/index.ts"]),
    { kind: "library/orphan manifest", matched: "package.json" })
  assert.equal(classifyPaths(["docs/guide.md"]).kind, "docs/examples")
  assert.equal(classifyPaths([]).kind, "other")
  // A plain web server is not an MCP server, which is the mistake the first version made.
  assert.equal(classifyPaths(["src/server.ts", "package.json"]).kind, "server-like")
  assert.equal(/mcp/i.test(classifyPaths(["src/server.ts", "package.json"]).matched), false)
})

test("a repository that has not moved keeps its verdict and costs no request", function () {
  const repos = [
    { fullName: "a/one", pushedAt: "2026-09-01T00:00:00Z" },
    { fullName: "a/two", pushedAt: "2026-09-18T00:00:00Z" },
    { fullName: "a/three", pushedAt: null },
  ]
  const previous = {
    "a/one": { kind: "server-like", matched: "src/mcp.py", pushedAt: "2026-09-01T00:00:00Z" },
    "a/two": { kind: "docs/examples", matched: null, pushedAt: "2026-08-01T00:00:00Z" },
  }
  const plan = planIncremental(repos, previous)
  assert.deepEqual(plan.todo.map((r) => r.fullName), ["a/two", "a/three"],
    "what changed, plus anything never classified, and nothing else")
  assert.equal(plan.kept["a/one"].kind, "server-like")
  assert.equal(plan.kept["a/three"], undefined, "a repository never classified is not kept")
})
