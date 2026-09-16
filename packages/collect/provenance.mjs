import { createHash } from 'node:crypto'

/** Canonical JSON: object keys are sorted recursively; array order is significant. */
export function canonicalJson(value) {
  const json = JSON.stringify(value)
  if (json === undefined) throw new TypeError('provenance input must be JSON serializable')
  function encode(item) {
    if (item === null || typeof item !== 'object') return JSON.stringify(item)
    if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']'
    return '{' + Object.keys(item).sort().map((key) => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}'
  }
  return encode(JSON.parse(json))
}

/** npm scan inputs must name a published version, never a tag or version range. */
export function isExactNpmVersion(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)
}

/** Conservative npm names: one package segment, or exactly @scope/package. */
export function isNpmPackageName(name) {
  return typeof name === 'string' && name.length <= 214 && /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/.test(name)
}

/** A package-relative literal path, with no URL syntax or directory traversal. */
export function normalizeHookScriptPath(path) {
  if (typeof path !== 'string') return null
  const clean = path.startsWith('./') ? path.slice(2) : path
  if (!/^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/.test(clean)) return null
  if (clean.split('/').some((part) => part === '.' || part === '..')) return null
  return clean
}

export function exactNpmManifest(document, version, name) {
  if (name !== undefined && !isNpmPackageName(name)) return null
  if (!isExactNpmVersion(version) || !document?.versions || !Object.hasOwn(document.versions, version)) return null
  const manifest = document.versions[version]
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
  if (manifest.version !== undefined && manifest.version !== version) return null
  if (name !== undefined && manifest.name !== undefined && manifest.name !== name) return null
  return manifest
}

/** Hash the scan's inputs, not a registry's claim about an uninspected artifact. */
export function contentProvenance({ package: identity, scope, input, complete }) {
  if (typeof scope !== 'string' || !scope.trim()) throw new TypeError('provenance scope is required')
  const packageIdentity = {
    registry: identity?.registry ?? null,
    name: identity?.name ?? null,
    version: identity?.version ?? null,
  }
  return {
    package: packageIdentity,
    content: {
      algorithm: 'sha256',
      digest: createHash('sha256').update(canonicalJson({ package: packageIdentity, scope, input })).digest('hex'),
      scope,
    },
    complete: complete === true && Object.values(packageIdentity).every((value) => typeof value === 'string' && value.trim().length > 0),
  }
}
