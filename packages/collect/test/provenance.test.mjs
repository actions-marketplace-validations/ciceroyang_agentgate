import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson, contentProvenance, exactNpmManifest, isExactNpmVersion, isNpmPackageName, normalizeHookScriptPath } from '../provenance.mjs'

const identity = { registry: 'npm', name: 'acme-mcp', version: '1.0.0' }
const proof = (input) => contentProvenance({ package: identity, scope: 'test: inspected JSON', input, complete: true })

test('canonical JSON and SHA256 ignore property order at every depth', () => {
  const a = { z: [1, { y: 2, a: 3 }], a: { scripts: { preinstall: 'x', postinstall: 'y' } } }
  const b = { a: { scripts: { postinstall: 'y', preinstall: 'x' } }, z: [1, { a: 3, y: 2 }] }
  assert.equal(canonicalJson(a), canonicalJson(b))
  assert.equal(proof(a).content.digest, proof(b).content.digest)
  assert.match(proof(a).content.digest, /^[a-f0-9]{64}$/)
  assert.equal(proof(a).content.algorithm, 'sha256')
})

test('canonical JSON preserves array order and JSON omission semantics', () => {
  assert.notEqual(proof([1, 2]).content.digest, proof([2, 1]).content.digest)
  assert.equal(canonicalJson({ omitted: undefined, a: [undefined] }), '{"a":[null]}')
})

test('package version and scope are bound even when scanned text is the same', () => {
  const a = proof({ scripts: {} })
  const b = contentProvenance({ package: { ...identity, version: '2.0.0' }, scope: a.content.scope, input: { scripts: {} }, complete: true })
  const c = contentProvenance({ package: identity, scope: 'another inspected scope', input: { scripts: {} }, complete: true })
  assert.notEqual(a.content.digest, b.content.digest)
  assert.notEqual(a.content.digest, c.content.digest)
  assert.throws(() => contentProvenance({ package: identity, scope: '', input: {}, complete: true }), /scope/)
  assert.equal(contentProvenance({ package: { ...identity, version: null }, scope: 'test', input: {}, complete: true }).complete, false)
})

test('exact manifests never resolve latest, a range, or a mismatched version', () => {
  const doc = { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'acme-mcp', version: '1.0.0' }, '2.0.0': { version: '3.0.0' } } }
  assert.equal(exactNpmManifest(doc, '1.0.0'), doc.versions['1.0.0'])
  assert.equal(exactNpmManifest(doc, '1.0.0', 'other-package'), null)
  for (const version of [null, '', 'latest', '^1.0.0', '~1.0.0', '*', '2.0.0', '9.0.0']) assert.equal(exactNpmManifest(doc, version), null)
  assert.equal(isExactNpmVersion('1.0.0-rc.1+build.2'), true)
})

test('npm names and package-relative script paths exclude URL and traversal syntax', () => {
  for (const name of ['acme-mcp', '@acme/server', 'some.package_name']) assert.equal(isNpmPackageName(name), true, name)
  for (const name of [null, '', '.', '..', 'acme/other', '@acme/../other', '/absolute', 'acme%2fother', 'acme?tag=x']) assert.equal(isNpmPackageName(name), false, name)
  assert.equal(normalizeHookScriptPath('./scripts/a.js'), 'scripts/a.js')
  assert.equal(normalizeHookScriptPath('scripts/a.js'), 'scripts/a.js')
  for (const path of [null, '', '.', '..', '../a.js', '/a.js', 'a/../b.js', 'a/%2e%2e/b.js', 'a.js?x', 'a.js#x', String.raw`a\b.js`, 'a//b.js']) assert.equal(normalizeHookScriptPath(path), null, path)
})
