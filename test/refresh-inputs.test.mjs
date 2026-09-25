import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * refresh builds the index the service publishes, and build-index only records the package audit
 * when it is handed --audit. Nothing else notices when that argument goes missing: the index still
 * builds, still validates, and quietly says less than the artifacts on disk can support -- 6,199
 * audited packages would revert to "a package is declared here" with no error anywhere.
 *
 * What this does not cover: it reads the source rather than running refresh, because refresh opens
 * with a live 6,000-server census. It catches the argument being dropped; it cannot catch
 * build-index ignoring an argument it was given. That half is covered by build-index's own tests.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function refreshBody() {
  const source = readFileSync(join(ROOT, "bin", "agentgate.mjs"), "utf8")
  const start = source.indexOf("function refresh(flags) {")
  const end = source.indexOf("function recordsFor(root, indexPath) {")
  assert.ok(start !== -1 && end > start, "refresh() moved; this test needs to be pointed at it again")
  return source.slice(start, end)
}

test("refresh hands the package audit to build-index", function () {
  const body = refreshBody()
  assert.match(body, /package-audit\.json/, "refresh no longer looks for the audit artifact")
  assert.match(body, /indexArgs\.push\("--audit", repoAudit\)/, "refresh finds the audit but does not pass it on")
})

test("the artifacts refresh forwards are the ones its sibling branch already forwards", function () {
  // The audit sits next to the repository records and is guarded the same way. If a future artifact
  // is added, this is the shape it should take rather than an unconditional push.
  const body = refreshBody()
  for (const artifact of ["github-census.json", "repository-classification.json", "package-audit.json"]) {
    assert.match(body, new RegExp(artifact.replace(/\./g, "\\.")), artifact + " is not read by refresh")
  }
})
