/**
 * The tools this server exposes, and what each one is allowed to say.
 *
 * Three rules, the same ones the rest of the project runs on:
 *   - read-only: nothing here writes, installs, runs a scanned tool, or opens a socket;
 *   - no verdict without work: a record whose own coverage block is incomplete is reported as
 *     incomplete, never as clean, and a record written before coverage existed says so;
 *   - not found is not a finding: a missing record means this index does not have it, and says
 *     nothing about whether the server is safe or whether it exists at all.
 *
 * Every tool returns the text a person reads and the same answer as structured data, so a client
 * can show one and reason over the other.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseInventory, createInventoryReport } from "../../inventory/src/inventory.mjs"
import { computeCoverage, renderCoverage } from "../../collect/src/coverage.mjs"
import { runScan } from "../../guard/src/engine.mjs"
import { makeReader } from "../../guard/src/fs-scan.mjs"
import { ALL_CHECKS } from "../../guard/src/checks/index.mjs"
import { loadPolicy, defaultPolicy } from "../../policy/src/policy.mjs"
import { evaluate } from "../../policy/src/evaluate.mjs"

const LIMIT = "This describes the records in the index that was read: not your installation, not the package at runtime, and not a statement that anything is safe."
const SEVERITIES = ["critical", "high", "medium", "low", "unknown", "info"]

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

/**
 * What each tool returns, written from the handler's own return value rather than from intent.
 * `protocol.mjs` puts the `structured` object into `structuredContent`, so this schema describes
 * bytes a caller already receives. A schema that describes something the tool does not send is a
 * claim with nothing behind it, which is what this project exists to point at.
 */
const RECORD_SCHEMA = {
  type: "object",
  description: "One index record, reduced to what a reader can act on.",
  properties: {
    server: { type: ["string", "null"] },
    verdict: { type: "string", description: "clean, findings, incomplete, or unknown when the record says neither" },
    packages: { type: "array", items: { type: "object", properties: {
      registry: { type: ["string", "null"] }, name: { type: ["string", "null"] }, version: { type: ["string", "null"] },
    } } },
    repository: { type: ["string", "null"] },
    generatedAt: { type: ["string", "null"] },
    coverage: { type: ["object", "null"], description: "null when the record was written before records carried a coverage block", properties: {
      state: { type: "string", description: "complete or incomplete" },
      required: { type: ["integer", "null"] }, completed: { type: ["integer", "null"] }, failed: { type: ["integer", "null"] },
      components: { type: "array", items: { type: "object", properties: {
        id: { type: ["string", "null"] }, required: { type: "boolean" }, status: { type: ["string", "null"] }, reason: { type: ["string", "null"] },
      } } },
    } },
    findings: { type: "object", properties: {
      critical: { type: "integer" }, high: { type: "integer" }, medium: { type: "integer" },
      low: { type: "integer" }, unknown: { type: "integer" }, info: { type: "integer" },
    } },
    blocks: { type: "array", items: { type: "object", properties: {
      block: { type: "string" }, status: { type: ["string", "null"] }, reason: { type: ["string", "null"] }, findings: { type: "integer" },
    } } },
  },
}

const INDEX_WARNING = { type: "string", description: "Present only when the server was started with a note about the index it loaded." }

const OUTPUT_LOOKUP = {
  type: "object",
  required: ["found"],
  properties: {
    found: { type: "boolean", description: "false means this index has no such record; it is not a statement that the tool is safe or that it does not exist" },
    multiple: { type: "boolean", description: "present when found is true" },
    record: RECORD_SCHEMA,
    records: { type: "array", items: RECORD_SCHEMA, description: "present instead of record when several matched; at most ten are listed" },
    query: { type: "object", description: "present when found is false, echoing what was asked", properties: {
      server: { type: ["string", "null"] }, package: { type: ["string", "null"] }, version: { type: ["string", "null"] },
    } },
    indexGeneratedAt: { type: ["string", "null"] },
    indexWarning: INDEX_WARNING,
  },
}

const OUTPUT_INVENTORY = {
  type: "object",
  required: ["summary", "items"],
  properties: {
    summary: { type: "object", required: ["total", "matched", "needsAttention"], properties: {
      total: { type: "integer" }, matched: { type: "integer" }, needsAttention: { type: "integer" },
    } },
    items: { type: "array", items: { type: "object", properties: {
      id: { type: "string" },
      name: { type: "string" },
      state: { type: "string", description: "the match state; only 'matched' is a confirmed match, and a match is never a safety verdict" },
      label: { type: "string" },
      selected: { type: ["object", "null"], description: "the index record the match resolved to, or null" },
      coverage: { type: ["object", "null"], properties: {
        state: { type: "string" }, required: { type: ["integer", "null"] }, completed: { type: ["integer", "null"] }, failed: { type: ["integer", "null"] },
      } },
      findings: { type: "integer" },
    } } },
    indexWarning: INDEX_WARNING,
  },
}

const OUTPUT_COVERAGE = {
  type: "object",
  description: "The distribution over the whole index. Counts, not percentages: a percentage over this population is the number this project refuses to publish without its denominator.",
  properties: {
    generatedAt: { type: ["string", "null"] }, scanner: { type: ["string", "null"] },
    total: { type: "integer" },
    states: { type: "object", properties: { complete: { type: "integer" }, incomplete: { type: "integer" }, absent: { type: "integer" } } },
    verdicts: { type: "object" }, cross: { type: "object" }, perScanner: { type: "object" }, reasons: { type: "object" }, findings: { type: "object" },
    findingsTotal: { type: "integer" }, requiredRuns: { type: "integer" }, completedRuns: { type: "integer" },
    verdictIncompleteButComplete: { type: "integer" },
    problems: { type: "array" },
    indexWarning: INDEX_WARNING,
  },
}

const OUTPUT_CHECK = {
  type: "object",
  required: ["root", "verdict"],
  properties: {
    root: { type: "string" },
    verdict: { type: "string", description: "clean, findings or incomplete; incomplete is not a pass" },
    policyVersion: { type: "string" },
    findings: { type: "array", items: { type: "object", properties: {
      rule: { type: "string" }, severity: { type: "string" }, file: { type: ["string", "null"] },
      reason: { type: "string" }, message: { type: ["string", "null"] },
    } } },
    coverage: { type: "object", description: "what the policy could not measure: a check that failed, and evidence the index did not have", properties: {
      checksFailed: { type: "array" }, evidenceMissing: { type: "array" },
    } },
    relatedRecords: { type: "integer" },
    indexWarning: INDEX_WARNING,
  },
}

export function listTools() {
  return [
    {
      name: "lookup_server",
      title: "Look up an MCP server's evidence",
      description: "Look up one MCP server, or one package, in the local agentgate evidence index. Use this when you know what you are asking about and want its record: the verdict, the coverage block (which scanners ran, which did not, and why), and the findings. Do not use it to check a list of tools you use; inventory_tools answers that question and returns one line per tool instead. A record that is incomplete is reported as incomplete, never as clean.",
      annotations: READ_ONLY,
      outputSchema: OUTPUT_LOOKUP,
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Registry server name, for example org.example/tools" },
          package: { type: "string", description: "Package name, for example @scope/pkg" },
          version: { type: "string", description: "Exact version, to narrow a package match" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "inventory_tools",
      title: "Match a list of tools against the index",
      description: "Given the MCP servers and agent tools you actually use, report which ones the index has evidence for, which need your exact version, and which it has never measured. Use this to audit a list of what you run; for a single server or package, lookup_server returns the whole record rather than a one-line state. Nothing is uploaded and nothing is executed.",
      annotations: READ_ONLY,
      outputSchema: OUTPUT_INVENTORY,
      inputSchema: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            minItems: 1,
            maxItems: 500,
            description: "One entry per tool: a name, or an object with name/server/package/registry/version.",
            items: { type: ["string", "object"] },
          },
        },
        required: ["tools"],
        additionalProperties: false,
      },
    },
    {
      name: "coverage_report",
      title: "How much of the index was actually measured",
      description: "Report the coverage distribution of the whole index: how many records are fully measured, what stopped the rest, and how many findings came out of the work that ran. Use this before quoting any percentage from this server, because it is the denominator; it is the same number the project quotes in public. It answers a question about the index, not about one tool: for one tool, use lookup_server.",
      annotations: READ_ONLY,
      outputSchema: OUTPUT_COVERAGE,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "check_project",
      title: "Scan a local project for refused configuration",
      description: "Run agentgate's own checks over a local directory: MCP client configuration, hooks, manifests and source patterns a policy would refuse. Use it on a project you can read; it is not a record lookup, so for one server's record use lookup_server and for a list of tools use inventory_tools. It only reads files; it does not install, execute or upload anything, and it does not scan the network.",
      annotations: READ_ONLY,
      outputSchema: OUTPUT_CHECK,
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Directory to check. Defaults to the working directory." },
          policy: { type: "string", description: "Path to an agentgate.policy.json. Defaults to the one in root, or the built-in default." },
          exclude: { type: "string", description: "Comma-separated directories to skip. Defaults to node_modules,.git" },
        },
        additionalProperties: false,
      },
    },
  ]
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function executionOf(record) {
  const exec = record && record.scanExecution && record.scanExecution.scanner_execution
  return exec && typeof exec === "object" ? exec : null
}

function countFindings(record) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, info: 0 }
  for (const block of Object.values((record && record.evidence) || {})) {
    for (const finding of (block && block.findings) || []) {
      const severity = finding && SEVERITIES.indexOf(finding.severity) !== -1 ? finding.severity : "unknown"
      counts[severity] += 1
    }
  }
  return counts
}

/** One record, reduced to what a reader can act on. Nothing here guesses. */
export function describeRecord(record) {
  const exec = executionOf(record)
  const repository = record && record.repository
  return {
    server: textOrNull(record && record.server),
    verdict: record && typeof record.verdict === "string" ? record.verdict : "unknown",
    packages: ((record && record.packages) || []).map(function (p) {
      return { registry: textOrNull(p && p.registry), name: textOrNull(p && p.name), version: textOrNull(p && p.version) }
    }),
    repository: typeof repository === "string" ? repository : textOrNull(repository && repository.url),
    generatedAt: textOrNull(record && record.generatedAt),
    coverage: exec ? {
      state: exec.state === "complete" ? "complete" : "incomplete",
      required: Number.isInteger(exec.required) ? exec.required : null,
      completed: Number.isInteger(exec.completed) ? exec.completed : null,
      failed: Number.isInteger(exec.failed) ? exec.failed : null,
      components: (Array.isArray(exec.components) ? exec.components : []).map(function (c) {
        return { id: textOrNull(c && c.id), required: !c || c.required !== false, status: textOrNull(c && c.status), reason: textOrNull(c && c.reason) }
      }),
    } : null,
    findings: countFindings(record),
    blocks: Object.entries((record && record.evidence) || {}).map(function (entry) {
      return { block: entry[0], status: textOrNull(entry[1] && entry[1].status), reason: textOrNull(entry[1] && entry[1].reason), findings: Array.isArray(entry[1] && entry[1].findings) ? entry[1].findings.length : 0 }
    }),
  }
}

function formatRecord(record) {
  const d = describeRecord(record)
  const lines = []
  lines.push((d.server || "(no server name)") + " - verdict " + d.verdict + (d.verdict === "incomplete" ? " (this is not a pass)" : ""))
  if (d.coverage) {
    lines.push("coverage: " + d.coverage.state + " - required " + d.coverage.required + ", completed " + d.coverage.completed + ", failed " + d.coverage.failed)
    for (const c of d.coverage.components) lines.push("  " + c.id + ": " + c.status + (c.reason ? " (" + c.reason + ")" : ""))
  } else {
    lines.push("coverage: no coverage block. The record was written before records carried one, and an unrecorded part is not a pass.")
  }
  if (d.packages.length) lines.push("packages: " + d.packages.map(function (p) { return [p.registry, p.name, p.version].filter(Boolean).join(" ") }).join(", "))
  lines.push("findings: " + SEVERITIES.map(function (s) { return s + " " + d.findings[s] }).join(", "))
  if (d.blocks.length) lines.push("blocks: " + d.blocks.map(function (b) { return b.block + "=" + b.status + (b.findings ? " (" + b.findings + ")" : "") }).join(", "))
  if (d.generatedAt) lines.push("evidence generated: " + d.generatedAt)
  lines.push(LIMIT)
  return lines.join("\n")
}

export function createToolHandlers(options) {
  const index = options && options.index && typeof options.index === "object" ? options.index : null
  const indexNote = textOrNull(options && options.indexNote)
  const indexWarning = textOrNull(options && options.indexWarning)
  const records = index && Array.isArray(index.records) ? index.records : []
  const warn = function (out) {
    if (!indexWarning) return out
    return { text: indexWarning + "\n" + out.text, structured: Object.assign({ indexWarning: indexWarning }, out.structured) }
  }

  const requireIndex = function () {
    if (index) return
    throw new Error("no evidence index is loaded" + (indexNote ? ": " + indexNote : "") + " - run agentgate refresh, or start this server with --index <path>")
  }

  const lookupServer = function (args) {
    const server = textOrNull(args && args.server)
    const pkg = textOrNull(args && args.package)
    const version = textOrNull(args && args.version)
    if (!server && !pkg) throw new Error("give a server name or a package name")
    requireIndex()
    const matches = records.filter(function (record) {
      if (server && record.server !== server) return false
      if (pkg) {
        const packages = Array.isArray(record.packages) ? record.packages : []
        if (!packages.some(function (p) { return p && p.name === pkg && (!version || p.version === version) })) return false
      }
      return true
    })
    const query = { server: server, package: pkg, version: version }
    if (matches.length === 0) {
      const asked = [server, pkg && (version ? pkg + "@" + version : pkg)].filter(Boolean).join(" / ")
      return {
        text: "no record for " + asked + " in this index (" + ((index.generatedAt || "date unknown")) + ").\nThis index not having it is not a statement that the tool is safe, or that it does not exist. " + LIMIT,
        structured: { found: false, query: query, indexGeneratedAt: index.generatedAt || null },
      }
    }
    if (matches.length > 1) {
      const listed = matches.slice(0, 10).map(describeRecord)
      const lines = [matches.length + " records match; narrow it with an exact server, package and version:"]
      for (const d of listed) lines.push("  " + d.server + " - " + d.verdict + " - " + (d.packages.map(function (p) { return [p.name, p.version].filter(Boolean).join("@") }).join(", ") || "no package"))
      if (matches.length > listed.length) lines.push("  ... and " + (matches.length - listed.length) + " more")
      return { text: lines.join("\n"), structured: { found: true, multiple: true, records: listed } }
    }
    return { text: formatRecord(matches[0]), structured: { found: true, multiple: false, record: describeRecord(matches[0]) } }
  }

  const inventoryTools = function (args) {
    const list = args && args.tools
    if (!Array.isArray(list) || list.length === 0) throw new Error("tools must be a non-empty array of names or objects")
    if (list.length > 500) throw new Error("at most 500 tools at a time")
    requireIndex()
    let entries
    try { entries = parseInventory(JSON.stringify(list)) } catch (error) { throw new Error("could not read the list: " + error.message) }
    const report = createInventoryReport(entries, index)
    const items = report.items.map(function (item) {
      return {
        id: item.id,
        name: item.input.name || item.input.server || item.input.package || item.id,
        state: item.state,
        label: item.label,
        selected: item.selected,
        coverage: item.execution ? { state: item.execution.state, required: item.execution.required, completed: item.execution.completed, failed: item.execution.failed } : null,
        findings: item.findings.length,
      }
    })
    const summary = {
      total: items.length,
      matched: items.filter(function (i) { return i.state === "matched" }).length,
      needsAttention: items.filter(function (i) { return i.state !== "matched" || i.findings > 0 }).length,
    }
    const lines = [summary.total + " tools: " + summary.matched + " matched, " + summary.needsAttention + " need attention"]
    for (const item of items) {
      lines.push("  " + item.name + " - " + item.label + (item.coverage ? " - coverage " + item.coverage.state + " " + item.coverage.completed + "/" + item.coverage.required : ""))
    }
    lines.push(LIMIT)
    return { text: lines.join("\n"), structured: { summary: summary, items: items } }
  }

  const coverageReport = function () {
    requireIndex()
    const stats = computeCoverage(index)
    return { text: renderCoverage(stats) + "\n" + LIMIT, structured: stats }
  }

  const checkProject = function (args) {
    const root = resolve(String((args && args.root) || "."))
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("not a directory: " + root)
    const policyPath = args && args.policy ? resolve(String(args.policy)) : join(root, "agentgate.policy.json")
    let policy = null
    let policyNote = null
    if ((args && args.policy) || existsSync(policyPath)) {
      policy = loadPolicy(policyPath)
    } else {
      policy = defaultPolicy()
      policyNote = "built-in default policy: nothing extra is refused"
    }
    const exclude = String((args && args.exclude) || "node_modules,.git").split(",").map(function (s) { return s.trim() }).filter(Boolean)
    const scan = runScan({ root: root, checks: ALL_CHECKS, readText: makeReader(), exclude: exclude })
    const name = readPackageName(root)
    const related = name ? records.filter(function (r) {
      return (r.packages || []).some(function (p) { return p && p.name === name })
    }) : []
    const result = evaluate({ policy: policy, scan: scan, records: related })
    const lines = []
    lines.push("policy " + result.policyVersion + " - root " + root)
    if (policyNote) lines.push(policyNote)
    if (name && related.length === 0) lines.push("no index record matches the package " + name + "; the policy's index rules measured nothing here")
    for (const f of result.findings) {
      lines.push("  " + String(f.severity).toUpperCase() + "  " + f.rule + "  " + (f.file || "") + "  " + f.reason)
    }
    if (result.findings.length === 0) lines.push("  nothing refused")
    for (const c of result.coverage.checksFailed) lines.push("  CHECK FAILED: " + c.id + " -> " + c.error)
    for (const m of result.coverage.evidenceMissing.slice(0, 10)) lines.push("  not measured: " + m.server + " / " + m.block + " -> " + m.reason)
    lines.push("verdict: " + result.verdict.toUpperCase() + (result.verdict === "incomplete" ? " (this is not a pass)" : ""))
    lines.push(LIMIT)
    return {
      text: lines.join("\n"),
      structured: {
        root: root,
        verdict: result.verdict,
        policyVersion: result.policyVersion,
        findings: result.findings.map(function (f) { return { rule: f.rule, severity: f.severity, file: f.file || null, reason: f.reason, message: f.message || null } }),
        coverage: result.coverage,
        relatedRecords: related.length,
      },
    }
  }

  return {
    callTool: async function (name, args) {
      if (name === "lookup_server") return warn(lookupServer(args || {}))
      if (name === "inventory_tools") return warn(inventoryTools(args || {}))
      if (name === "coverage_report") return warn(coverageReport())
      if (name === "check_project") return warn(checkProject(args || {}))
      throw new Error("no such tool: " + name)
    },
  }
}

function readPackageName(root) {
  const path = join(root, "package.json")
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return textOrNull(parsed && parsed.name)
  } catch (error) {
    return null
  }
}
