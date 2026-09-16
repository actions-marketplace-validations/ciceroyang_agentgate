import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanManifest } from '../scripts/guard-scan.mjs'

const row = { server: 'acme/server', registryType: 'npm', package: 'acme-mcp', version: '1.0.0' }
const manifest = { name: 'acme-mcp', version: '1.0.0', scripts: { postinstall: 'node install.js' }, dependencies: { a: '1', b: '2' } }

test('guard provenance hashes the exact inspected fields and package identity', () => {
  let scanned
  const first = scanManifest(row, manifest, (text, path) => { scanned = { text, path }; return [] })
  assert.deepEqual(JSON.parse(scanned.text), { scripts: manifest.scripts, dependencies: manifest.dependencies })
  assert.equal(scanned.path, 'package.json')
  assert.equal(first.status, 'clean')
  assert.equal(first.provenance.complete, true)
  assert.deepEqual(first.provenance.package, { registry: 'npm', name: row.package, version: row.version })
  assert.match(first.provenance.content.digest, /^[a-f0-9]{64}$/)
  const reordered = scanManifest(row, { ...manifest, dependencies: { b: '2', a: '1' }, description: 'not inspected' }, () => [])
  assert.equal(first.provenance.content.digest, reordered.provenance.content.digest)
  const changed = scanManifest(row, { ...manifest, scripts: { postinstall: 'node other.js' } }, () => [])
  assert.notEqual(first.provenance.content.digest, changed.provenance.content.digest)
  const versioned = scanManifest({ ...row, version: '2.0.0' }, { ...manifest, version: '2.0.0' }, () => [])
  assert.notEqual(first.provenance.content.digest, versioned.provenance.content.digest)
})

test('guard failures remain check-failed with incomplete content evidence', () => {
  const failed = scanManifest(row, manifest, () => { throw new Error('checker failed') })
  assert.equal(failed.status, 'check-failed')
  assert.equal(failed.provenance.complete, false)
  assert.deepEqual(failed.findings, [])
  assert.match(failed.error, /checker failed/)
  assert.equal(failed.provenance.content.digest, scanManifest(row, manifest, () => []).provenance.content.digest)
  assert.equal(scanManifest(row, manifest, () => null).status, 'check-failed')
})

test('guard unavailable or mismatched metadata cannot be reported as complete', () => {
  let calls = 0
  const check = () => { calls += 1; return [] }
  for (const invalid of [null, {}, { ...manifest, name: 'other' }, { ...manifest, version: '2.0.0' }]) {
    const result = scanManifest(row, invalid, check)
    assert.equal(result.status, 'metadata-unavailable')
    assert.equal(result.provenance.complete, false)
  }
  for (const version of ['latest', '^1.0.0', '', null]) assert.equal(scanManifest({ ...row, version }, { ...manifest, version }, check).provenance.complete, false)
  assert.equal(calls, 0)
})

test('guard keeps checker findings without changing their severity', () => {
  const findings = [{ rule: 'hook', severity: 'high', message: 'node install.js' }]
  const result = scanManifest(row, manifest, () => findings)
  assert.equal(result.status, 'findings')
  assert.deepEqual(result.findings, findings)
  assert.equal(result.provenance.complete, true)
})

test('guard rejects unsafe npm names and accepts an exact scoped package', () => {
  let calls = 0
  const check = () => { calls += 1; return [] }
  for (const name of ['../other', '@scope/../other', 'acme/other', 'acme%2fother', String.raw`acme\other`]) {
    const result = scanManifest({ ...row, package: name }, { ...manifest, name }, check)
    assert.equal(result.status, 'metadata-unavailable')
    assert.equal(result.provenance.complete, false)
  }
  assert.equal(calls, 0)
  assert.equal(scanManifest({ ...row, package: '@acme/server' }, { ...manifest, name: '@acme/server' }, check).provenance.complete, true)
})
