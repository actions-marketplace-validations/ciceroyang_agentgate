import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A temporary directory that is removed when the process exits.
 *
 * These scripts are run by `verify.sh` on every gate and on the deployment server, and they used
 * to leave every working directory behind -- `mkdtempSync` makes a directory and nothing removes
 * it. Registered on the process rather than at the end of the script so an early `process.exit`
 * on a failed check still cleans up.
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
