import test from "node:test"
import assert from "node:assert/strict"
import { classifyPaths, planIncremental } from "../scripts/classify-repositories.mjs"

test("the rule keeps the path that decided it, so a reader can check the verdict", function () {
  assert.deepEqual(classifyPaths(["src/mcp_server.py", "pyproject.toml"]),
    { kind: "server-like", matched: "src/mcp_server.py", manifest: "pyproject.toml", descriptor: null })
  assert.deepEqual(classifyPaths(["mcp.json", "README.md"]),
    { kind: "descriptor-only", matched: "mcp.json", manifest: null, descriptor: "mcp.json" })
  assert.deepEqual(classifyPaths(["package.json", "src/index.ts"]),
    { kind: "library/orphan manifest", matched: "package.json", manifest: "package.json", descriptor: null })
  assert.equal(classifyPaths(["docs/guide.md"]).kind, "docs/examples")
  assert.equal(classifyPaths([]).kind, "other")
  // A plain web server is not an MCP server, which is the mistake the first version made.
  assert.equal(classifyPaths(["src/server.ts", "package.json"]).kind, "server-like")
  assert.equal(/mcp/i.test(classifyPaths(["src/server.ts", "package.json"]).matched), false)
})

test("the manifest path is kept, not only used to pick the kind", function () {
  // The kind already encodes whether a manifest exists; the path is what a later step needs in
  // order to read it, and it was being thrown away. Keeping it costs nothing - the file tree was
  // already fetched and parsed - and it is the difference between a record that can say "there is
  // a package here, unread" and one that could say nothing at all.
  assert.equal(classifyPaths(["src/mcp_server.py", "pyproject.toml"]).manifest, "pyproject.toml")
  assert.equal(classifyPaths(["package.json", "src/index.ts"]).manifest, "package.json")
  assert.equal(classifyPaths(["src/mcp_server.py"]).manifest, null, "no manifest in the tree is a checked null")
  assert.equal(classifyPaths(["mcp.json"]).descriptor, "mcp.json")
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
