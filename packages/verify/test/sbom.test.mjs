import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildSbom } from "../src/sbom.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

test("a scoped npm name becomes a purl a consumer can resolve", function () {
  const bom = buildSbom({ name: "@scope/thing", version: "1.2.3" })
  assert.equal(bom.metadata.component.purl, "pkg:npm/%40scope/thing@1.2.3")
  assert.equal(bom.bomFormat, "CycloneDX")
  assert.equal(bom.specVersion, "1.5")
})

test("an unscoped name stays readable", function () {
  assert.equal(buildSbom({ name: "thing", version: "0.0.1" }).metadata.component.purl, "pkg:npm/thing@0.0.1")
})

test("the dependency list is empty and says so in the properties", function () {
  const bom = buildSbom({ name: "a", version: "1.0.0", commit: "abc1234" })
  assert.deepEqual(bom.dependencies[0].dependsOn, [])
  assert.equal(bom.metadata.properties[1].name, "agentgate:third-party-dependencies")
  assert.equal(bom.metadata.properties[1].value, "none")
  assert.equal(bom.metadata.properties[0].value, "abc1234")
})

test("files are components with real SHA-256 hashes", function () {
  const bom = buildSbom({ name: "a", version: "1.0.0", files: [{ path: "bin/x.mjs", text: "hello" }] })
  assert.equal(bom.components.length, 1)
  assert.equal(bom.components[0].name, "bin/x.mjs")
  assert.equal(bom.components[0].hashes[0].alg, "SHA-256")
  assert.match(bom.components[0].hashes[0].content, /^[a-f0-9]{64}$/)
})

test("the same input gives the same document", function () {
  const input = { name: "a", version: "1.0.0", commit: "c", timestamp: "T", files: [{ path: "a", text: "x" }] }
  assert.equal(JSON.stringify(buildSbom(input)), JSON.stringify(buildSbom(input)))
})

test("the SBOM of this repository parses and matches the published version", function () {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "sbom.mjs"), "--stdout"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  const bom = JSON.parse(result.stdout)
  const pkg = JSON.parse(spawnSync(process.execPath, ["-p", "JSON.stringify(require('./package.json'))"], { cwd: ROOT, encoding: "utf8" }).stdout)
  assert.equal(bom.metadata.component.name, pkg.name)
  assert.equal(bom.metadata.component.version, pkg.version)
  assert.ok(bom.components.length > 50, "the shipped source should be in the SBOM")
})
