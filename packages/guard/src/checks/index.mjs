import * as mcpConfig from "./mcp-config.mjs"
import * as installHooks from "./install-hooks.mjs"
import * as contentInjection from "./content-injection.mjs"
import * as transport from "./transport.mjs"
import * as toolDescription from "./tool-description.mjs"
import * as supplyChain from "./supply-chain.mjs"
import * as agentSettings from "./agent-settings.mjs"
import * as a2a from "./a2a.mjs"
import * as sourceInjection from "./source-injection.mjs"

export const ALL_CHECKS = [
  mcpConfig.check,
  installHooks.check,
  contentInjection.check,
  transport.check,
  toolDescription.check,
  supplyChain.check,
  agentSettings.check,
  a2a.check,
  sourceInjection.check,
]
