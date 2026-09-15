import { checkManifest as installHookFindings } from "./checks/install-hooks.mjs"
import { checkManifest as supplyChainFindings } from "./checks/supply-chain.mjs"

/**
 * Run the manifest-level checks over one manifest without touching the filesystem,
 * so another tool can reuse the rules instead of re-implementing them.
 */
export function manifestFindings(text, rel) {
  const file = rel || "package.json"
  return installHookFindings(file, text).concat(supplyChainFindings(file, text))
}
