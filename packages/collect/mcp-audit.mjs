#!/usr/bin/env node
/**
 * mcp-supply-audit — census and provenance audit for the public MCP server ecosystem.
 *
 * Primary source: the official registry (registry.modelcontextprotocol.io/v0/servers),
 * which is structured (packages, repository, transport) and far less noisy than the
 * GitHub topics. Every verdict carries the exact field/value it came from, so a reader
 * can reproduce it without trusting this tool.
 *
 * Static analysis only. The tool never contacts a server endpoint, never installs or
 * executes a package, and never sends credentials anywhere.
 *
 * @module mcp-supply-audit
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { contentProvenance, exactNpmManifest, isExactNpmVersion, isNpmPackageName, normalizeHookScriptPath } from './provenance.mjs'

export const VERSION = '0.1.0'
export const SCHEMA = 'mcp-supply-audit/v1'
export const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers'

export function defaultHttp(url, headers) {
  return fetch(url, { headers: headers || {}, redirect: 'follow', signal: AbortSignal.timeout(30000) })
    .then(async (res) => ({ status: res.status, url: res.url, text: res.status === 200 ? await res.text() : '' }))
    .catch(() => ({ status: 0, text: '' }))
}

/** Page through the official registry. `max` caps the number of servers read. */
export async function fetchRegistry({ http = defaultHttp, max = Infinity, pageSize = 100, maxPages = 200, onPage = null } = {}) {
  const servers = []
  let cursor = null
  let pages = 0
  for (;;) {
    const url = REGISTRY + '?limit=' + pageSize + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
    const res = await http(url)
    if (res.status !== 200) throw new Error('registry request failed: status ' + res.status)
    const json = JSON.parse(res.text)
    for (const entry of json.servers ?? []) {
      if (servers.length >= max) break
      servers.push(entry.server ?? entry)
    }
    pages += 1
    cursor = json.metadata?.nextCursor ?? null
    if (onPage) onPage(pages, servers.length)
    if (!cursor || servers.length >= max || pages >= maxPages) break
  }
  return { servers, pages, truncated: cursor !== null }
}

function compareVersions(a, b) {
  const pa = String(a ?? '').split('-')[0].split('.').map(Number)
  const pb = String(b ?? '').split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0
    const y = Number.isFinite(pb[i]) ? pb[i] : 0
    if (x !== y) return x < y ? -1 : 1
  }
  const preA = String(a ?? '').includes('-') ? 0 : 1
  const preB = String(b ?? '').includes('-') ? 0 : 1
  return preA - preB
}

/**
 * The registry pages one entry per published version, so a census that audits every
 * entry over-counts and repeats findings. Keep the newest version per server name.
 * @param {Array<object>} servers - raw registry entries.
 * @returns {Array<object>} one entry per server.
 */
export function newestPerServer(servers) {
  const byName = new Map()
  for (const server of servers) {
    const name = server?.name ?? '(unnamed)'
    const current = byName.get(name)
    if (!current || compareVersions(server.version, current.version) > 0) byName.set(name, server)
  }
  return [...byName.values()]
}

/** Normalise a repository URL to `host/path` so two checkouts of the same project match. */
function repoKey(url) {
  if (!url) return null
  const cleaned = String(url).replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '')
  try {
    const parsed = new URL(cleaned)
    const host = parsed.hostname.toLowerCase()
    // A GitHub repository is exactly host/owner/repo, so anything past the second segment is a
    // path inside it. A package whose repository field points at .../issues or
    // .../blob/main/changelog.md names the same repository; comparing the whole path turned ten
    // of those into "mismatch" findings, each dismissible in one line. Other hosts can nest
    // groups (gitlab.com/group/subgroup/repo), so only GitHub is trimmed.
    const path = host === "github.com"
      ? "/" + parsed.pathname.split("/").filter(Boolean).slice(0, 2).join("/")
      : parsed.pathname
    return (host + path).toLowerCase()
  } catch {
    return null
  }
}

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall']

// A URL or the word `curl` inside a console.log notice is not evidence: v0.1 flagged
// exactly that on two real packages. Patterns now run on text with string literals and
// comments stripped, and a bare URL is never evidence by itself.
export function stripStringsAndComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

// `network-module` is checked against the raw text: module names live in strings, and
// mentioning node:http in a warning is not plausible. Everything else runs stripped.
const CRITICAL_PATTERNS = [
  ['process-spawn', /\b(execSync|execFileSync|spawnSync|execFile|spawn|child_process)\b/],
  ['shell-command', /\b(sh|bash|zsh)\s+-c\b|\|\s*(sh|bash|zsh)\b/],
  ['download-tool', /\b(curl|wget)\b/],
  ['decode-and-exec', /\b(eval|Function)\s*\(|base64\s+-d/],
]
const NETWORK_MODULE = /\b(node:https?|node-fetch|axios|undici|got)\b|require\(\s*['"](?:node:)?https?['"]\s*\)/

/**
 * What a network fetch has to be paired with before it is an incident and not a
 * capability. Reaching the network is what a legitimate installer does when it checks for
 * an update or pulls an official binary; a download turns into one when the same script
 * can write the result, run it, or decode it. Each sink is named so the evidence can say
 * what it actually saw rather than only naming the rule.
 */
const NETWORK_SINKS = [
  ['writes files', /\bwriteFile|appendFile|createWriteStream|\brmSync|\bunlinkSync|\bmkdir/],
  ['spawns a process', /child_process|execSync|execFileSync|spawnSync|\bspawn\s*\(|\.exec\s*\(/],
  ['decodes and runs code', /\beval\s*\(|new\s+Function|Buffer\.from\s*\([^)]*base64/],
]
const NETWORK_SINK = new RegExp(NETWORK_SINKS.map(function (s) { return s[1].source }).join("|"))

/** Whether the text can reach the network at all: a capability, not a finding by itself. */
export function networkCapabilityOf(text) {
  return NETWORK_MODULE.test(String(text))
}

/** The named sink that turns a network capability into an incident, or null. */
export function networkSinkOf(text) {
  const subject = stripStringsAndComments(String(text))
  for (const [name, pattern] of NETWORK_SINKS) {
    if (pattern.test(subject)) return name
  }
  return null
}

/**
 * Whether a spawned command can be steered by whatever produced its argument.
 *
 * A literal command (\`execSync('npm run build')\`) runs at install time, but nothing in
 * the repository can change what it runs, so it belongs at install-time-execution rather
 * than critical. A variable, a template or a concatenation can be steered, and that is the
 * case worth calling critical. Strings are the whole point here, so this reads the raw text.
 */
const SPAWN_CALL = /\b(?:execSync|execFileSync|spawnSync|execFile|spawn)\s*\(/g
const LITERAL_ARG = /^\s*(['"\x60])(?:\\.|(?!\1)[\s\S])*\1\s*[),]/
export function spawnIsSteerable(text) {
  const s = String(text)
  const re = new RegExp(SPAWN_CALL.source, "g")
  let match
  while ((match = re.exec(s)) !== null) {
    const rest = s.slice(match.index + match[0].length)
    if (!LITERAL_ARG.test(rest)) return true
  }
  return false
}

/** Whether the text references spawn primitives at all, whether or not we can read the command. */
export function spawnCapabilityOf(text) {
  return /\b(?:execSync|execFileSync|spawnSync|execFile|spawn|child_process)\b/.test(String(text))
}

/** Shell builtins that cannot do anything but print when they are the whole command. */
const SHELL_PRINT_ONLY = /^(?:echo|printf|true|false|:)\b/

/** The quoted program of a bare inline eval, the same strict shape the guard check reads. */
const INLINE_EVAL = /^\s*(?:node\s+(?:-e|--eval)|python[0-9.]*\s+-c)\s+(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")\s*$/

/** Tokens an inline program that only prints is built from. */
const INERT_TOKENS = new Set(["console", "log", "error", "warn", "info", "debug", "process", "stdout", "stderr", "write", "exit", "env", "require", "fs", "path", "node:fs", "node:path", "existsSync", "join", "resolve", "basename", "dirname", "__dirname", "__filename", "try", "catch", "finally", "if", "else", "return", "throw", "new", "typeof", "const", "let", "var", "function", "true", "false", "null", "undefined", "String", "Number", "JSON", "stringify", "parse", "Error", "e", "err"])

/** Anything in inline code that can reach out or change the machine. */
const ACTIVE_INLINE = /child_process|execSync|execFileSync|spawnSync|\bspawn\s*\(|\.exec\s*\(|\bfetch\s*\(|XMLHttpRequest|\baxios\b|\bundici\b|\bwriteFile|appendFile|rmSync|unlinkSync|\beval\s*\(|new\s+Function|Buffer\.from\s*\([^)]*['"]base64|require\s*\(\s*['"](?!(?:node:)?(?:fs|path)['"])/

const ANY_REQUIRE = /\brequire\s*\(|\bimport\s*[({'"]/
const LOCAL_REQUIRE = /require\s*\(\s*['"]\.{1,2}\//
const PRINTS = /\bconsole\s*\.\s*(?:log|error|warn|info)\b|process\s*\.\s*(?:stdout|stderr)\s*\.\s*write/

/**
 * Whether a referenced install script cannot do anything but print.
 *
 * This decides install-time-execution for a hook that only runs one local file: "it runs a
 * program" is not true of a file that logs a notice. A script that requires anything, local
 * or not, is not print-only, because requiring a sibling module runs code we have not read —
 * that is precisely the surface that matters.
 */
export function scriptOnlyPrints(content) {
  const text = String(content)
  if (ANY_REQUIRE.test(text)) return false
  if (spawnCapabilityOf(text) || networkCapabilityOf(text) || ACTIVE_INLINE.test(text)) return false
  return PRINTS.test(text)
}

/**
 * What an install hook does, as far as its command text shows.
 *
 * Declaring a hook is not the same severity as running a program in it. A package whose
 * postinstall is \`echo "installed"\`, or inline code that only prints, is worth listing but is
 * not an execution risk: an install-time-execution row at high should mean a program the
 * consumer's machine will actually run.
 */
export function installHookReads(command, refs) {
  const text = String(command).trim()
  if (SHELL_PRINT_ONLY.test(text) && !/[;&|]/.test(text.replace(/'[^']*'|"[^"]*"/g, ""))) {
    return { severity: "info", note: " (prints a message: it runs no program)" }
  }
  const m = INLINE_EVAL.exec(text)
  if (m) {
    const program = m[1] !== undefined ? m[1] : m[2]
    if (!ACTIVE_INLINE.test(program)) {
      const stripped = program
        .replace(/'(?:[^'\\]|\\.)*'/g, " ")
        .replace(/"(?:[^"\\]|\\.)*"/g, " ")
      const unknown = (stripped.match(/[A-Za-z_$][\w$]*/g) || []).filter(function (t) { return !INERT_TOKENS.has(t) })
      if (unknown.length === 0) return { severity: "info", note: " (evaluates inline code that only prints)" }
    }
  }
  const list = Array.isArray(refs) ? refs : []
  if (list.length > 0 && list.every(function (r) { return typeof r.content === "string" && scriptOnlyPrints(r.content) })) {
    return { severity: "info", note: " (runs a local script that only prints)" }
  }
  return { severity: "high", note: "" }
}

/**
 * First critical pattern the text matches, or null.
 *
 * Two modes, because the same characters mean different things: in a `postinstall`
 * command the quoted argument of `node -e "..."` IS the executed code, so hooks are
 * matched raw; in a referenced script the quoted text is usually data (a notice with a
 * URL), so script content is matched after strings and comments are stripped.
 *
 * `network-module` also needs its sink: a network require on its own is a capability, and
 * the corpus counts a fetch that pipes into a file as the shape worth calling critical.
 * A spawn only reaches critical when its command is steerable: a literal command runs at
 * install time, but nothing in the repository can change what it runs.
 * @param {string} text
 * @param {'hook'|'script'} [mode]
 * @returns {string|null} pattern label.
 */
export function criticalPatternOf(text, mode = 'script') {
  const raw = String(text)
  const subject = mode === 'hook' ? raw : stripStringsAndComments(raw)
  if (mode === 'script' && NETWORK_MODULE.test(raw) && NETWORK_SINK.test(subject)) return 'network-module'
  for (const [label, pattern] of CRITICAL_PATTERNS) {
    if (label === 'process-spawn' && !spawnIsSteerable(raw)) continue
    if (pattern.test(subject)) return label
  }
  return null
}

/** Local script paths an install hook runs, e.g. `node scripts/postinstall.cjs`. */
export function hookScriptRefs(scripts) {
  const refs = new Set()
  for (const hook of INSTALL_HOOKS) {
    const value = scripts?.[hook]
    if (typeof value !== 'string') continue
    // Keep the entire argument, including unsafe URL/path syntax, so a truncated
    // safe-looking prefix cannot be fetched and reported as the referenced file.
    const match = /\bnode\s+((?:"[^"]*"|'[^']*'|[^\s;&|])+)/.exec(value)
    if (!match) continue
    let ref = match[1]
    if (/^"[^"]*"$|^'[^']*'$/.test(ref)) ref = ref.slice(1, -1)
    if (!ref.startsWith('-')) refs.add(ref)
  }
  return [...refs]
}

/**
 * Pure rule engine: one registry server plus whatever package metadata we could fetch.
 * Returns findings, each carrying the field and value that produced it.
 * @param {object} server - registry server.json entry.
 * @param {object|null} pkgMeta - npm document for the declared package, or null.
 * @param {{version?: string}} [declared] - the version the registry declares.
 * @returns {Array<object>} findings.
 */
export function auditPackage(server, pkgMeta, declared = {}, hookScripts = {}) {
  const findings = []
  const add = (rule, severity, evidence) => findings.push({ rule, severity, evidence })
  const packages = Array.isArray(server?.packages) ? server.packages : []

  // One finding per server, not per package: the same server often ships several
  // stdio packages and duplicate rows inflate every count downstream.
  if (packages.some((entry) => entry?.transport?.type === 'stdio')) {
    add('stdio-transport', 'info', 'packages[].transport.type=stdio (runs locally as a child process)')
  }

  if (!pkgMeta) {
    if (packages.length > 0) add('package-metadata-unavailable', 'unknown', 'no registry metadata fetched for ' + packages.map((p) => p.identifier).join(', '))
    return findings
  }

  const declaredVersion = declared.version ?? packages[0]?.version ?? null
  const versionDoc = exactNpmManifest(pkgMeta, declaredVersion, packages[0]?.identifier)
  const latest = pkgMeta['dist-tags']?.latest ?? null

  if (!versionDoc) {
    add('declared-version-not-found', 'unknown', 'exact declared npm version ' + JSON.stringify(declaredVersion) + ' has no matching manifest; no latest fallback was scanned')
    return findings
  }

  const scripts = versionDoc.scripts ?? null
  if (scripts) {
    for (const hook of INSTALL_HOOKS) {
      const value = scripts[hook]
      if (typeof value !== 'string' || value.trim() === '') continue
      const ownRefs = hookScriptRefs({ [hook]: value }).map(function (ref) {
        return { ref, content: normalizeHookScriptPath(ref) !== null ? hookScripts[ref] : undefined }
      })
      const read = installHookReads(value, ownRefs)
      add('install-time-execution', read.severity, 'scripts.' + hook + '=' + JSON.stringify(value) + read.note)
      const label = criticalPatternOf(value, 'hook')
      if (label) {
        add('install-hook-critical', 'critical', 'scripts.' + hook + ' matches ' + label + ': ' + JSON.stringify(value))
        continue
      }
      for (const ref of hookScriptRefs(scripts)) {
        const content = normalizeHookScriptPath(ref) !== null ? hookScripts[ref] : undefined
        if (typeof content !== 'string') {
          add('install-hook-script-unavailable', 'unknown', 'hook runs ' + ref + '; content could not be fetched')
          continue
        }
        const scriptLabel = criticalPatternOf(content)
        if (scriptLabel) {
          add('install-hook-script-critical', 'critical', ref + ' can reach the network and ' + (networkSinkOf(content) || 'do something with it') + ' (' + scriptLabel + ')')
        } else if (networkCapabilityOf(content)) {
          add('install-hook-script-network', 'high', ref + ' can reach the network at install time, but no write, spawn or decode sink was found')
        } else if (spawnCapabilityOf(content)) {
          add('install-hook-script-spawn', 'medium', ref + ' spawns a command at install time, but the command reads as a fixed literal')
        } else {
          const partial = LOCAL_REQUIRE.test(content) ? '; it also requires a local module, so the inspected surface is only part of what runs' : ''
          add('install-hook-script-inspected', 'info', 'hook runs ' + ref + ' (' + content.length + ' bytes): no fetch/spawn/decode pattern found' + partial)
        }
      }
    }
  }

  const repoUrl = typeof versionDoc.repository === 'string' ? versionDoc.repository : versionDoc.repository?.url ?? null
  const registryRepo = server?.repository?.url ?? server?.repository ?? null
  // Whether the registry names a repository is not whether the field is truthy. A registry entry
  // with "repository": {} is truthy and names nothing, and repoKey answers null for it — which
  // was then concatenated into the message, so one record told its maintainer that the registry
  // entry "points at null". Ask repoKey once, and use that answer everywhere below.
  const registryKey = repoKey(registryRepo)
  if (!repoUrl) {
    // The condition is about the package metadata, not the registry entry. Saying "the
    // registry document" told a package whose registry entry names a repository that it had
    // none — a sentence a maintainer dismisses in one line because it is not true. The two
    // cases are also not the same size: with a registry repository we can still find and read
    // the source; without one we cannot locate it at all.
    add('package-repository-missing',
      registryKey ? 'low' : 'medium',
      registryKey
        ? 'the published package declares no repository; the registry entry points at ' + registryKey
        : 'neither the registry entry nor the published package names a repository, so the source could not be located')
  } else {
    const pkgKey = repoKey(repoUrl)
    const regKey = registryKey
    if (pkgKey && regKey && pkgKey !== regKey) {
      add('repository-mismatch', 'medium', 'package repository ' + pkgKey + ' vs registry repository ' + regKey)
    }
  }

  if (latest && declaredVersion && latest !== declaredVersion) {
    add('declared-version-not-latest', 'info', 'registry declares ' + declaredVersion + ', npm latest is ' + latest)
  }
  const deprecated = versionDoc.deprecated ?? pkgMeta.deprecated
  if (deprecated) {
    add('package-deprecated', 'info', 'npm deprecation message: ' + JSON.stringify(String(deprecated).slice(0, 160)))
  }

  const deps = Object.assign({}, versionDoc?.dependencies ?? {}, versionDoc?.optionalDependencies ?? {})
  const risky = Object.keys(deps).filter((name) => /(^|\/)(shelljs|execa|child_process|node-pty|cross-spawn|sudo-prompt)$/.test(name))
  if (risky.length > 0) {
    add('process-spawn-dependency', 'info', 'declared dependencies that can spawn processes: ' + risky.join(', '))
  }
  return findings
}

function npmUrl(name) {
  return 'https://registry.npmjs.org/' + name.replace('/', '%2f')
}

/** Fetch one npm document; returns null on any failure (the caller records unknown). */
/** Fetch a file from a published package (unpkg, then jsdelivr). Read-only. */
export async function fetchHookScript(name, version, path, http = defaultHttp) {
  const clean = normalizeHookScriptPath(path)
  if (!isNpmPackageName(name) || !isExactNpmVersion(version) || clean === null) return null
  const candidates = [
    'https://unpkg.com/' + name + '@' + version + '/' + clean,
    'https://cdn.jsdelivr.net/npm/' + name + '@' + version + '/' + clean,
  ]
  for (const url of candidates) {
    const res = await http(url)
    // defaultHttp exposes the final URL. Do not bind a redirected package,
    // version, path or origin to the package/version that was requested.
    if (res.url !== undefined && res.url !== url) continue
    if (res.status === 200 && typeof res.text === 'string') return res.text
  }
  return null
}

/** Fetch one PyPI JSON document; null on any failure. Read-only. */
export async function fetchPypiDocument(name, http = defaultHttp) {
  const res = await http('https://pypi.org/pypi/' + name + '/json')
  if (res.status !== 200) return null
  try {
    return JSON.parse(res.text)
  } catch {
    return null
  }
}

/**
 * Audit a PyPI package the registry declares. The important difference from npm:
 * PyPI metadata exposes no install hooks, so the install-time dimension is reported
 * as unknown unless the release is sdist-only, in which case installing necessarily
 * builds (and therefore executes) code.
 */
export function auditPypiPackage(server, doc, declared = {}) {
  const findings = []
  const add = (rule, severity, evidence) => findings.push({ rule, severity, evidence })
  const info = doc?.info
  if (!info) {
    add('package-metadata-unavailable', 'unknown', 'PyPI JSON metadata unavailable')
    return findings
  }
  const declaredVersion = declared.version ?? server?.packages?.[0]?.version ?? null
  const urls = Object.assign({}, info.project_urls || {})
  const vcsEntry = Object.entries(urls).find(([, url]) => /github\.com|gitlab\.com|codeberg\.org|bitbucket\.org/i.test(String(url)))
  const homeIsVcs = /github\.com|gitlab\.com/i.test(String(info.home_page || ''))
  const pkgRepo = vcsEntry ? vcsEntry[1] : (homeIsVcs ? info.home_page : null)
  const regRepo = server?.repository?.url ?? server?.repository ?? null
  const regKey = repoKey(regRepo)
  if (!pkgRepo) {
    add('package-repository-missing',
      regKey ? 'low' : 'medium',
      regKey
        ? 'the package metadata names no VCS URL; the registry entry points at ' + regKey
        : 'neither the registry entry nor the package metadata names a VCS URL, so the source could not be located')
  } else if (regKey) {
    const pkgKey = repoKey(pkgRepo)
    if (pkgKey && regKey && pkgKey !== regKey) add('repository-mismatch', 'medium', 'package repository ' + pkgKey + ' vs registry repository ' + regKey)
  }
  const files = (doc.releases || {})[declaredVersion] || []
  const kinds = [...new Set(files.map((file) => file.packagetype).filter(Boolean))]
  if (files.length === 0) {
    add('declared-version-not-found', 'unknown', 'declared version ' + declaredVersion + ' has no files in releases')
  } else if (!kinds.includes('bdist_wheel')) {
    add('pypi-sdist-only', 'medium', 'declared version ships no wheel (' + kinds.join(',') + '); installing builds from source, which executes build code')
  } else {
    add('pypi-install-time-unknown', 'unknown', 'PyPI metadata exposes no install/build hook; wheels unpack without executing code, sdist builds do. files: ' + kinds.join(','))
  }
  if (info.version && declaredVersion && info.version !== declaredVersion) {
    add('declared-version-not-latest', 'info', 'registry declares ' + declaredVersion + ', PyPI latest is ' + info.version)
  }
  if (info.yanked === true) add('package-yanked', 'info', 'the declared version is yanked on PyPI')
  return findings
}

export async function fetchNpmDocument(name, http = defaultHttp) {
  if (!isNpmPackageName(name)) return null
  const res = await http(npmUrl(name))
  if (res.status !== 200) return null
  try {
    return JSON.parse(res.text)
  } catch {
    return null
  }
}

/** Provenance covers the same metadata and direct script texts used by this scan. */
export function registryProvenance(server, doc = null, hookScripts = {}) {
  const pkg = Array.isArray(server?.packages) ? server.packages[0] : null
  const identity = { registry: pkg?.registryType ?? null, name: pkg?.identifier ?? null, version: pkg?.version ?? null }
  if (identity.registry !== 'npm') {
    return contentProvenance({
      package: identity,
      scope: 'registryDocument/v1: registry server and available package metadata only; exact package manifest and install script content not measured for this registry',
      input: { registryServer: server, packageMetadata: doc === null ? { status: 'missing' } : { status: 'present', value: doc } },
      complete: false,
    })
  }
  const manifest = exactNpmManifest(doc, identity.version, identity.name)
  const scripts = hookScriptRefs(manifest?.scripts).map((path) => normalizeHookScriptPath(path) !== null && typeof hookScripts[path] === 'string'
    ? { path, status: 'present', content: hookScripts[path] }
    : { path, status: 'missing' })
  return contentProvenance({
    package: identity,
    scope: 'registryDocument/v1: registry server, exact npm version manifest, npm latest and deprecation metadata, and recognized direct node install-hook script texts; excludes transitive imports and package artifact contents',
    input: {
      registryServer: server,
      registryMetadata: doc ? { status: 'present', latest: doc['dist-tags']?.latest ?? null, deprecated: doc.deprecated ?? null } : { status: 'missing' },
      versionManifest: manifest ? { status: 'present', value: manifest } : { status: 'missing' },
      hookScripts: scripts,
    },
    complete: !!manifest && scripts.every((script) => script.status === 'present'),
  })
}

/** One server's declared first package, with injectable reads for offline verification. */
export async function auditRegistryServer(server, { http = defaultHttp } = {}) {
  const pkg = Array.isArray(server.packages) ? server.packages[0] : null
  const row = {
    server: server.name,
    serverVersion: server.version ?? null,
    version: pkg?.version ?? null,
    package: pkg?.identifier ?? null,
    registryType: pkg?.registryType ?? null,
    repository: server.repository?.url ?? server.repository ?? null,
    audited: false,
    findings: [],
    provenance: registryProvenance(server),
  }
  if (row.registryType === 'npm' && row.package) {
    const doc = await fetchNpmDocument(row.package, http)
    const manifest = exactNpmManifest(doc, row.version, row.package)
    const hookScripts = {}
    for (const ref of hookScriptRefs(manifest?.scripts)) hookScripts[ref] = await fetchHookScript(row.package, row.version, ref, http)
    row.findings = auditPackage(server, doc, { version: row.version }, hookScripts)
    row.provenance = registryProvenance(server, doc, hookScripts)
    row.audited = true
    row.auditKind = 'npm'
  } else if (row.registryType === 'pypi' && row.package) {
    const doc = await fetchPypiDocument(row.package, http)
    row.findings = auditPypiPackage(server, doc, { version: row.version })
    row.provenance = registryProvenance(server, doc)
    row.audited = true
    row.auditKind = 'pypi'
  }
  return row
}

function severityRank(severity) {
  return { critical: 0, high: 1, medium: 2, info: 3, unknown: 4 }[severity] ?? 5
}

export function summarize(rows) {
  const counts = {}
  const servers = { total: rows.length, withFindings: 0, auditedNpm: 0, auditedPypi: 0, withPackage: 0, notAuditedPackages: 0, remoteOnly: 0 }
  const packageTypes = {}
  for (const row of rows) {
    if (row.findings.length > 0) servers.withFindings += 1
    for (const finding of row.findings) counts[finding.rule] = (counts[finding.rule] ?? 0) + 1
    if (!row.package) {
      servers.remoteOnly += 1
      continue
    }
    servers.withPackage += 1
    packageTypes[row.registryType ?? '?'] = (packageTypes[row.registryType ?? '?'] ?? 0) + 1
    if (row.audited) {
      if (row.registryType === 'pypi') servers.auditedPypi += 1
      else servers.auditedNpm += 1
    } else servers.notAuditedPackages += 1
  }
  return { servers, packageTypes, ruleCounts: counts }
}

export function renderMarkdown(payload) {
  const s = payload.summary
  const lines = []
  lines.push('# MCP supply-chain census')
  lines.push('')
  lines.push('Generated ' + payload.generatedAt + ' from ' + payload.source + '.')
  lines.push('')
  lines.push('Enumerated **' + (payload.registry?.entries ?? s.servers.total) + '** registry entries covering **' + s.servers.total + '** unique servers. **' + s.servers.withPackage + '** declare a package (' + Object.entries(s.packageTypes).map(([type, count]) => type + ' ' + count).join(', ') + '); **' + s.servers.remoteOnly + '** are remote-only (no package, out of scope for this audit).')
  lines.push('')
  lines.push('Audited: **' + s.servers.auditedNpm + '** npm and **' + s.servers.auditedPypi + '** PyPI packages. **' + s.servers.notAuditedPackages + '** package-declaring servers use a registry this version does not audit yet and are **not** reported as clean.')
  lines.push('')
  lines.push('| rule | findings |', '| --- | --- |')
  for (const [rule, count] of Object.entries(s.ruleCounts).sort((a, b) => b[1] - a[1])) lines.push('| ' + rule + ' | ' + count + ' |')
  lines.push('')
  const notable = payload.rows
    .filter((row) => row.findings.some((f) => f.severity === 'critical' || f.severity === 'high'))
    .slice(0, 25)
  if (notable.length > 0) {
    lines.push('## Servers with high-severity findings')
    lines.push('')
    lines.push('| server | package | finding | evidence |')
    lines.push('| --- | --- | --- | --- |')
    for (const row of notable) {
      for (const finding of row.findings.filter((f) => f.severity === 'critical' || f.severity === 'high')) {
        lines.push('| ' + row.server + ' | ' + (row.package ?? '-') + ' | ' + finding.rule + ' (' + finding.severity + ') | ' + finding.evidence.replace(/\|/g, '\\|').slice(0, 160) + ' |')
      }
    }
    lines.push('')
  }
  lines.push('## Method and limits')
  lines.push('')
  lines.push('- Source: the official MCP registry; package metadata from the npm registry document of the declared version.')
  lines.push('- Static only: no endpoint is contacted, nothing is installed or executed, no credentials are used.')
  lines.push('- A finding is about the published metadata, not proof of exploitability. `unknown` means the metadata needed to decide was unavailable.')
  lines.push('- Reproduce with `node mcp-audit.mjs --max <n> --out census.json`.')
  return lines.join('\n') + '\n'
}

export function parseArgs(argv) {
  const args = { max: 200, out: null, markdown: null, concurrency: 8, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--max') args.max = Number(argv[++i])
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--markdown') args.markdown = argv[++i]
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i])
    else if (arg === '--json') args.json = true
    else if (arg === '--help') { console.log('node mcp-audit.mjs [--max N] [--out census.json] [--markdown census.md] [--concurrency 8] [--json]'); process.exit(0) }
    else { console.error('unknown option ' + arg); process.exit(2) }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const registry = await fetchRegistry({ max: args.max, onPage: (page, count) => process.stderr.write('  registry page ' + page + ': ' + count + ' servers\n') })
  process.stderr.write('servers: ' + registry.servers.length + (registry.truncated ? ' (truncated at --max)' : '') + '\n')

  const uniqueServers = newestPerServer(registry.servers)
  process.stderr.write('unique servers: ' + uniqueServers.length + '\n')
  const rows = new Array(uniqueServers.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < uniqueServers.length) {
      const index = cursor
      cursor += 1
      rows[index] = await auditRegistryServer(uniqueServers[index])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker))

  const payload = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    source: REGISTRY,
    registry: { entries: registry.servers.length, uniqueServers: uniqueServers.length, pages: registry.pages, truncated: registry.truncated },
    summary: summarize(rows),
    rows,
  }
  if (args.out) writeFileSync(args.out, JSON.stringify(payload, null, 2) + '\n')
  if (args.markdown) writeFileSync(args.markdown, renderMarkdown(payload))
  if (args.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  else process.stdout.write(renderMarkdown(payload))
  const critical = payload.rows.filter((r) => r.findings.some((f) => f.severity === 'critical')).length
  process.stderr.write('servers with critical findings: ' + critical + '\n')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main().catch((error) => { console.error('mcp-supply-audit: ' + error.message); process.exit(1) })
