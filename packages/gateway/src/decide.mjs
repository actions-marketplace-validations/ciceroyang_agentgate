import { matchesServer } from "../../policy/src/policy.mjs"

/**
 * The runtime decision for one tool call.
 *
 * The same vocabulary as the static check: a pattern, and a reason. A refusal always
 * carries why, because a gateway that says "no" without a reason trains people to
 * disable the gateway.
 */
export function decideToolCall(policy, toolName) {
  if (typeof toolName !== "string" || toolName === "") return { allowed: false, reason: "the call has no tool name" }
  for (const pattern of policy.forbiddenTools || []) {
    if (matchesServer(pattern, toolName)) {
      return { allowed: false, reason: "tool " + toolName + " matches the forbidden pattern " + pattern }
    }
  }
  return { allowed: true, reason: null }
}

export function filterTools(policy, tools) {
  const kept = []
  const removed = []
  for (const tool of tools || []) {
    const name = tool && typeof tool.name === "string" ? tool.name : ""
    const decision = decideToolCall(policy, name)
    if (decision.allowed) kept.push(tool)
    else removed.push({ name: name, reason: decision.reason })
  }
  return { kept: kept, removed: removed }
}
