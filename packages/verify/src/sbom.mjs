/**
 * Our own SBOM, generated rather than asserted.
 *
 * The product is a supply-chain evidence tool, so its own release should carry the document it
 * asks other people to produce. Zero dependencies make this honest and short: there is no
 * dependency tree to flatten, and the empty dependencies list is a claim the test suite and CI
 * both check rather than a hole someone forgot to fill.
 */
import { createHash } from "node:crypto"

const SPEC_VERSION = "1.5"

function hashOf(text) {
  return createHash("sha256").update(text).digest("hex")
}

function purlOf(name, version) {
  const [namespace, base] = name.charAt(0) === "@" ? name.slice(1).split("/") : [null, name]
  const encoded = namespace ? "%40" + namespace + "/" + base : base
  return "pkg:npm/" + encoded + "@" + version
}

export function buildSbom(options) {
  const opts = options || {}
  const name = String(opts.name || "unknown")
  const version = String(opts.version || "0.0.0")
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: SPEC_VERSION,
    version: 1,
    metadata: {
      timestamp: opts.timestamp || "1970-01-01T00:00:00.000Z",
      tools: [{ vendor: "zhiliang", name: "agentgate", version: version }],
      component: {
        type: "application",
        "bom-ref": purlOf(name, version),
        name: name,
        version: version,
        purl: purlOf(name, version),
        licenses: opts.license ? [{ license: { id: opts.license } }] : [],
      },
      properties: [
        { name: "agentgate:commit", value: String(opts.commit || "unknown") },
        { name: "agentgate:third-party-dependencies", value: "none" },
      ],
    },
    components: [],
    dependencies: [
      { ref: purlOf(name, version), dependsOn: [] },
    ],
  }
  if (Array.isArray(opts.files) && opts.files.length > 0) {
    bom.components = opts.files.map(function (file) {
      return {
        type: "file",
        name: file.path,
        hashes: [{ alg: "SHA-256", content: hashOf(file.text) }],
      }
    })
  }
  return bom
}
