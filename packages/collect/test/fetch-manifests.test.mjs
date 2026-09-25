import test from "node:test"
import assert from "node:assert/strict"
import { registryFor, coordinatesFrom, rawUrl } from "../scripts/fetch-manifests.mjs"

test("a manifest path maps to a registry, or to nothing", function () {
  assert.equal(registryFor("package.json"), "npm")
  assert.equal(registryFor("packages/core/package.json"), "npm")
  assert.equal(registryFor("pyproject.toml"), "pypi")
  assert.equal(registryFor("Cargo.toml"), "crates.io")
  assert.equal(registryFor("deep/App.csproj"), "nuget")
  assert.equal(registryFor("Gemfile"), null, "a Gemfile declares no publishable package we can name")
})

test("coordinates come out of the file, never out of the repository name", function () {
  assert.deepEqual(coordinatesFrom("package.json", JSON.stringify({ name: "demo-mcp", version: "1.2.3" })),
    { registry: "npm", name: "demo-mcp", version: "1.2.3" })
  // A manifest with no version yields no version. The policy layer already treats a package without
  // a pinned version as missing evidence; inventing one here would be the opposite of that.
  assert.deepEqual(coordinatesFrom("package.json", JSON.stringify({ name: "demo-mcp" })),
    { registry: "npm", name: "demo-mcp", version: null })
  assert.deepEqual(coordinatesFrom("pyproject.toml", "[project]\nname = \"demo\"\nversion = \"0.1.0\"\n"),
    { registry: "pypi", name: "demo", version: "0.1.0" })
  assert.deepEqual(coordinatesFrom("go.mod", "module github.com/acme/tool\n\ngo 1.22\n"),
    { registry: "go", name: "github.com/acme/tool", version: null })
  const gemfile = coordinatesFrom("Gemfile", "source \"https://rubygems.org\"\ngem \"rails\"\n")
  assert.equal(gemfile.registry, null)
  assert.equal(gemfile.name, null)
})

test("an unreadable manifest is reported, not thrown", function () {
  const broken = coordinatesFrom("package.json", "{ not json")
  assert.equal(broken.name, null)
  assert.equal(broken.version, null)
  assert.equal(typeof broken.unparsed, "string")
})

test("the URL is the one a reader would fetch to check the digest", function () {
  assert.equal(rawUrl("acme/tool", "main", "package.json"),
    "https://raw.githubusercontent.com/acme/tool/main/package.json")
  assert.equal(rawUrl("acme/tool", null, "packages/core/pyproject.toml"),
    "https://raw.githubusercontent.com/acme/tool/HEAD/packages/core/pyproject.toml",
    "a missing default branch is HEAD, not a guess")
})