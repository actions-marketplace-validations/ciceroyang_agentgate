import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A temporary directory that is removed when the test process exits.
 *
 * `mkdtempSync` alone leaves everything behind. A full gate run puts more than a hundred
 * `ag-*` directories in the shared temporary directory, and on the deployment server they
 * accumulated without anybody noticing (557 of them when this was written) because nothing
 * there ever looks at /tmp. Registering the removal on the process rather than at the end of a
 * test body also means a failing assertion still cleans up after itself.
 */
const made = []
process.on("exit", function () {
  for (const dir of made) {
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) { /* the process is leaving anyway */ }
  }
})

export function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
