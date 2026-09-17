import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInventory, createInventoryReport } from '../packages/inventory/src/inventory.mjs'

const now = '2026-09-17T08:00:00.000Z'
const pkg = { registry: 'npm', name: '@acme/mcp-tools', version: '1.0.0' }
function record(overrides = {}) {
  return {
    server: 'org.acme/tools', title: 'Acme Tool Suite', packages: [{ ...pkg }], verdict: 'clean',
    evidence: { registryDocument: { status: 'clean', source: 'mcp-census', reason: null, findings: [], provenance: {
      package: { ...pkg }, content: { algorithm: 'sha256', digest: 'a'.repeat(64), scope: 'registry document, exact manifest and directly read hook scripts' }, complete: true,
    } } }, ...overrides,
  }
}
const indexOf = (...records) => ({ generatedAt: now, scanner: 'fixture', snapshot: false, records })
const explicit = (extra = {}) => parseInventory(JSON.stringify([{ package: pkg.name, registry: 'npm', version: '1.0.0', ...extra }]))
const report = (entries = explicit(), index = indexOf(record()), options = {}) => createInventoryReport(entries, index, { generatedAt: now, ...options })

test('parse names, npm versions, scoped packages and explicit JSON without guessing server names', () => {
  const entries = parseInventory('Plain Tool\n\n@acme/mcp-tools@1.0.0\nacme-mcp@2.0.0\norg.acme/tools@1.0.0')
  assert.equal(entries.length, 4)
  assert.deepEqual(entries[1], { id: 'tool-2', name: '@acme/mcp-tools@1.0.0', server: null, package: '@acme/mcp-tools', registry: 'npm', version: '1.0.0' })
  assert.equal(entries[2].package, 'acme-mcp')
  assert.equal(entries[3].package, null)
  assert.equal(entries[3].version, null)
  assert.equal(parseInventory('{"tools":[{"server":"org.acme/tools","version":"1.0.0"}]}')[0].name, 'org.acme/tools')
  assert.deepEqual(parseInventory(' \n '), [])
})

test('reject secret-bearing configurations, unknown fields, invalid types and excessive input', () => {
  for (const text of ['{"mcpServers":{"x":{"env":{"TOKEN":"secret"}}}}', '{"tools":[],"env":{}}', '[{"name":"x","env":{"TOKEN":"secret"}}]', '[{"name":"x","command":"node"}]', '[{"name":3}]', '[{}]', '[null]', '{bad}', 'mcpServers:\n  x: y']) {
    assert.throws(() => parseInventory(text), /格式|只接受|必须|缺少|不能|支持/, text)
  }
  assert.throws(() => parseInventory('a\n'.repeat(501)), /500/)
  assert.throws(() => parseInventory('a'.repeat(1024 * 1024 + 1)), /1 MB/)
  assert.throws(() => parseInventory('中'.repeat(400000)), /1 MB/)
  assert.throws(() => parseInventory(3), /文本/)
})

test('exact package and server matches bind the user version to complete evidence', () => {
  const result = report()
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.generatedAt, now)
  assert.deepEqual(result.summary, { total: 1, matched: 1, needsAttention: 0 })
  assert.equal(result.items[0].state, 'matched')
  assert.equal(result.items[0].input.version, '1.0.0')
  assert.equal(result.items[0].selected.package, pkg.name)
  assert.match(result.items[0].reason, /不是安全认证/)
  assert.match(result.items[0].nextSteps.join(' '), /传递依赖.*运行时/)
  assert.equal(report(parseInventory('[{"server":"org.acme/tools","version":"1.0.0"}]')).items[0].state, 'matched')
})

test('exact server or package identities take priority over similar display names', () => {
  const similar = record({ server: 'other/tools', title: pkg.name, packages: [{ ...pkg, name: 'other-package' }] })
  assert.equal(report(explicit(), indexOf(record(), similar)).items[0].state, 'matched')
  const entries = parseInventory('[{"name":"org.acme/tools","version":"1.0.0"}]')
  const packageCollision = record({ server: 'another/tools', packages: [{ ...pkg, name: 'org.acme/tools' }] })
  assert.equal(report(entries, indexOf(record(), packageCollision)).items[0].selected.server, 'org.acme/tools')
})

test('a fuzzy match always requires selection and keeps the user version requirement', () => {
  const entries = parseInventory('[{"name":"Tool Suite","version":"1.0.0"}]')
  const initial = report(entries)
  assert.equal(initial.items[0].state, 'ambiguous')
  assert.equal(initial.items[0].candidates.length, 1)
  const key = initial.items[0].candidates[0].key
  assert.equal(report(entries, indexOf(record()), { selections: { 'tool-1': key } }).items[0].state, 'matched')
  assert.equal(report(entries, indexOf(record()), { selections: { 'tool-1': '' } }).items[0].state, 'ambiguous')
  assert.equal(report(entries, indexOf(record()), { selections: { 'tool-1': 'stale' } }).items[0].state, 'ambiguous')
  const noVersion = parseInventory('Tool Suite')
  const selected = report(noVersion, indexOf(record()), { selections: { 'tool-1': key } })
  assert.equal(selected.items[0].state, 'version_missing')
  assert.equal(selected.items[0].input.version, null)
})

test('multiple packages and registry collisions stay ambiguous until explicitly resolved', () => {
  const other = record({ server: 'other.acme/tools' })
  const initial = report(explicit(), indexOf(record(), other))
  assert.equal(initial.items[0].state, 'ambiguous')
  assert.equal(initial.items[0].candidates.length, 2)
  const key = initial.items[0].candidates[0].key
  assert.equal(report(explicit(), indexOf(record(), other), { selections: { 'tool-1': key } }).items[0].state, 'matched')
  const pypi = record({ server: 'pypi.acme/tools' })
  pypi.packages[0].registry = 'pypi'
  pypi.evidence.registryDocument.provenance.package.registry = 'pypi'
  const noRegistry = explicit({ registry: null })
  assert.equal(report(noRegistry, indexOf(record(), pypi)).items[0].state, 'ambiguous')
  assert.equal(report(explicit(), indexOf(record(), pypi)).items[0].state, 'matched')
  const multi = record({ packages: [{ ...pkg }, { ...pkg, name: 'another-pkg' }] })
  assert.equal(report(parseInventory('[{"server":"org.acme/tools","version":"1.0.0"}]'), indexOf(multi)).items[0].state, 'ambiguous')
})

test('missing, floating and mismatched versions cannot borrow the index version', () => {
  for (const version of [null, '', 'latest', '^1.0.0', '~1.0.0', '1.0', '1.*']) {
    const result = report(explicit({ version }))
    assert.equal(result.items[0].state, 'version_missing', version)
    assert.notEqual(result.items[0].input.version, '1.0.0')
  }
  assert.equal(report(explicit({ version: '2.0.0' })).items[0].state, 'version_mismatch')
  const v2 = record()
  v2.packages[0].version = '2.0.0'
  v2.evidence.registryDocument.provenance.package.version = '2.0.0'
  assert.equal(report(explicit({ version: '2.0.0' }), indexOf(record(), v2)).items[0].state, 'matched')
})

test('sample snapshots, legacy evidence and incomplete scans never become matched', () => {
  assert.equal(report(explicit(), { ...indexOf(record()), snapshot: true }).items[0].state, 'insufficient')
  assert.equal(report(explicit(), { ...indexOf(record()), sample: true }).items[0].state, 'insufficient')
  for (const sample of ['true', 'false', 0, null, {}]) assert.equal(report(explicit(), { ...indexOf(record()), sample }).items[0].state, 'insufficient')
  const mutations = [
    (r) => { delete r.evidence.registryDocument.provenance },
    (r) => { r.evidence.registryDocument.provenance.complete = false },
    (r) => { r.evidence.registryDocument.provenance.content.digest = 'bad' },
    (r) => { r.evidence.registryDocument.provenance.content.algorithm = 'sha512' },
    (r) => { r.evidence.registryDocument.provenance.content.scope = '' },
    (r) => { r.evidence.registryDocument.provenance.package.version = '2.0.0' },
    (r) => { r.evidence.registryDocument.provenance.package.registry = 'pypi' },
    (r) => { r.evidence.registryDocument.status = 'unmeasured' },
    (r) => { r.evidence.registryDocument.status = 'check-failed' },
    (r) => { r.evidence.registryDocument.status = 'brand-new-state' },
    (r) => { r.evidence.registryDocument.reason = 'check-failed' },
    (r) => { r.evidence.registryDocument.error = 'checker threw' },
    (r) => { r.evidence.registryDocument.findings = null },
    (r) => { r.evidence.registryDocument.status = 'findings' },
    (r) => { r.evidence = {} },
    (r) => { r.verdict = 'incomplete' },
    (r) => { r.packages.push(null) },
    (r) => { r.packages[0].version = null },
  ]
  for (const change of mutations) {
    const r = record(); change(r)
    assert.equal(report(explicit(), indexOf(r)).items[0].state, 'insufficient', String(change))
  }
})

test('matching preserves a real source timestamp without inventing an expiry window', () => {
  const base = indexOf(record())
  delete base.generatedAt
  const missing = report(explicit(), base)
  assert.equal(missing.items[0].state, 'insufficient')
  assert.equal(missing.items[0].evidenceGeneratedAt, null)
  assert.match(missing.items[0].reason, /生成时间/)
  const oldTime = '2020-01-02T03:04:05.000Z'
  const known = report(explicit(), { ...base, records: [record({ generatedAt: oldTime })] })
  assert.equal(known.items[0].state, 'matched')
  assert.equal(known.items[0].evidenceGeneratedAt, oldTime)
  assert.equal(report().items[0].evidenceGeneratedAt, now)
  assert.equal(report(explicit(), indexOf(record({ generatedAt: 'not-a-date' }))).items[0].state, 'insufficient')
  assert.equal(report(explicit(), { ...base, generatedAt: 'not-a-date' }).items[0].state, 'insufficient')
})

test('duplicate inputs and duplicate index identities are reported instead of silently green', () => {
  assert.ok(report([...explicit(), ...explicit().map((entry) => ({ ...entry, id: 'tool-2' }))]).items.every((item) => item.state === 'insufficient'))
  assert.equal(report(explicit(), indexOf(record(), record())).items[0].state, 'insufficient')
  const duplicatedPackage = record({ packages: [{ ...pkg }, { ...pkg }] })
  assert.equal(report(explicit(), indexOf(duplicatedPackage)).items[0].state, 'insufficient')
  assert.equal(report([{ id: 'tool-1', name: pkg.name, version: '1.0.0', env: { SECRET: 'hidden' } }]).items[0].state, 'insufficient')
  assert.equal(report(explicit(), { records: 'bad' }).items[0].state, 'insufficient')
})

test('findings are allowlisted, remain visible and require attention even when matched', () => {
  const r = record()
  r.evidence.registryDocument.status = 'findings'
  r.evidence.registryDocument.findings = [{ rule: 'hook', severity: 'high', evidence: 'runs install script', env: { SECRET: 'do-not-copy' }, token: 'do-not-copy' }]
  r.evidence.registryDocument.secret = 'do-not-copy'
  r.evidence.registryDocument.provenance.secret = 'do-not-copy'
  const result = report(explicit(), indexOf(r))
  assert.equal(result.items[0].state, 'matched')
  assert.equal(result.summary.matched, 1)
  assert.equal(result.summary.needsAttention, 1)
  assert.equal(result.items[0].findings[0].severity, 'high')
  assert.doesNotMatch(JSON.stringify(result), /do-not-copy|SECRET/)
  r.evidence.registryDocument.findings[0].severity = 'unknown'
  assert.equal(report(explicit(), indexOf(r)).items[0].state, 'insufficient')
})

test('unmatched reports explain the scope and preserve truncation metadata', () => {
  const result = report(parseInventory('unlisted-tool'), { ...indexOf(record()), truncated: true, total: 300 })
  assert.equal(result.items[0].state, 'unmatched')
  assert.match(result.items[0].reason, /当前索引.*已截断/)
  assert.deepEqual(result.index, { generatedAt: now, scanner: 'fixture', snapshot: false, truncated: true, total: 300 })
})

test('input is treated as inert text; report generation does not mutate inputs or the index', () => {
  globalThis.inventoryExecuted = false
  const entries = parseInventory('globalThis.inventoryExecuted = true\n$(touch /tmp/inventory-must-not-run)\n<script>alert(1)</script>')
  const index = indexOf(record())
  const before = JSON.stringify({ entries, index })
  const result = report(entries, index)
  assert.equal(globalThis.inventoryExecuted, false)
  assert.ok(result.items.every((item) => item.state === 'unmatched'))
  assert.equal(JSON.stringify({ entries, index }), before)
  delete globalThis.inventoryExecuted
})

const component = (overrides = {}) => ({ id: 'registryDocument', required: true, status: 'completed', output_present: true, output_parseable: true, semantic_consistency: 'ok', reason: null, ...overrides })
const coverage = (overrides = {}) => ({
  scanner_execution: { components: [component()], required: 1, completed: 1, failed: 0, state: 'complete', ...overrides },
})

test('a complete coverage block travels with the item, field by field', () => {
  const result = report(explicit(), indexOf(record({ scanExecution: coverage() })))
  assert.equal(result.items[0].state, 'matched')
  assert.equal(result.items[0].execution.state, 'complete')
  assert.equal(result.items[0].execution.required, 1)
  assert.equal(result.items[0].execution.completed, 1)
  assert.equal(result.items[0].execution.failed, 0)
  assert.deepEqual(result.items[0].execution.components[0], {
    id: 'registryDocument', required: true, status: 'completed', output_present: true, output_parseable: true,
    semantic_consistency: 'ok', reason: null, findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  })
})

test('a record whose own coverage block says a scanner did not finish cannot be matched', () => {
  const result = report(explicit(), indexOf(record({ scanExecution: coverage({ state: 'incomplete', completed: 0, failed: 1, components: [component({ status: 'failed', output_parseable: false, semantic_consistency: 'unverified', reason: 'not-in-run' })] }) })))
  assert.equal(result.items[0].state, 'insufficient')
  assert.match(result.items[0].reason, /扫描覆盖块/)
  // The projection still travels so the report can show what did not run.
  assert.equal(result.items[0].execution.state, 'incomplete')
  assert.equal(result.items[0].execution.components[0].reason, 'not-in-run')
})

test('a coverage block that contradicts itself or its counts is not complete', () => {
  const cases = [
    { scanner_execution: { components: [], required: 0, completed: 0, failed: 0, state: 'complete' } },
    coverage({ required: 2, completed: 1, failed: 1 }),
    coverage({ components: [component({ output_parseable: false, semantic_consistency: 'unverified' })] }),
    coverage({ components: [component({ status: 'skipped' })] }),
    coverage({ state: 'incomplete' }),
  ]
  for (const scanExecution of cases) {
    assert.equal(report(explicit(), indexOf(record({ scanExecution }))).items[0].state, 'insufficient', JSON.stringify(scanExecution))
  }
  const badDigest = record({ scanExecution: { ...coverage(), digest: { algorithm: 'sha256', value: 'b'.repeat(64), matches: false } } })
  assert.equal(report(explicit(), indexOf(badDigest)).items[0].state, 'insufficient')
  const malformed = record({ scanExecution: { scanner_execution: { state: 'complete' } } })
  assert.equal(report(explicit(), indexOf(malformed)).items[0].state, 'insufficient')
})

test('records written before scan-execution carry a null execution and still match on block evidence', () => {
  const result = report(explicit(), indexOf(record()))
  assert.equal(result.items[0].state, 'matched')
  assert.equal(result.items[0].execution, null)
})

