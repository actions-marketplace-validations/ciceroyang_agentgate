#!/usr/bin/env node
/**
 * The first-order step this repository is aiming at: add a tool, show the evidence.
 *
 * Today this only resolves and reports. It does not write a config yet, because the
 * evidence should be visible before anything is written, and because a command that
 * edits configuration files is worth getting right rather than getting first.
 */
import { readFileSync, existsSync } from "node:fs"

function loadIndex(path) {
  if (!existsSync(path)) { console.error("index not found at " + path); process.exit(2) }
  return JSON.parse(readFileSync(path, "utf8"))
}

export function findServer(index, query) {
  const q = String(query).toLowerCase()
  const exact = index.records.filter(function (r) { return r.server.toLowerCase() === q })
  if (exact.length > 0) return exact
  return index.records.filter(function (r) { return r.server.toLowerCase().indexOf(q) !== -1 })
}

export function configSnippet(record) {
  const pkg = record.packages[0]
  if (!pkg) return "# no package is declared for this server; it is remote-only and there is nothing to pin"
  const name = record.server.split("/").pop().replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "server"
  return JSON.stringify({ mcpServers: { [name]: { command: "npx", args: ["-y", pkg.name + "@" + pkg.version] } } }, null, 2)
}

export function render(record) {
  const lines = []
  lines.push(record.server)
  if (record.repository) lines.push("  repository: " + record.repository)
  for (const pkg of record.packages) lines.push("  package:    " + pkg.name + "@" + (pkg.version || "unpinned"))
  lines.push("  verdict:    " + record.verdict.toUpperCase() + (record.verdict === "incomplete" ? "  (something could not be checked; this is not a pass)" : ""))
  lines.push("")
  lines.push("  what was checked:")
  for (const key of Object.keys(record.evidence)) {
    const block = record.evidence[key]
    const detail = block.status === "unmeasured" ? "unmeasured (" + (block.reason || "unknown") + ")" : block.status + ", " + (block.findings || []).length + " finding(s)"
    lines.push("    " + key.padEnd(18) + detail + "   [" + block.source + "]")
    for (const f of (block.findings || []).slice(0, 4)) {
      lines.push("        " + f.severity.toUpperCase().padEnd(9) + f.rule + "  " + String(f.evidence || f.message || "").slice(0, 70))
    }
  }
  lines.push("")
  lines.push("  would add:")
  lines.push(configSnippet(record).split("\n").map(function (l) { return "    " + l }).join("\n"))
  return lines.join("\n")
}

function parse(argv) {
  const args = { index: null, query: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--index") args.index = argv[++i]
    else if (!args.query) args.query = a
    else { console.error("unexpected " + a); process.exit(2) }
  }
  if (!args.index || !args.query) { console.error("usage: agent-add --index <index.json> <server>"); process.exit(2) }
  return args
}

const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href
if (isMain) {
  const args = parse(process.argv.slice(2))
  const index = loadIndex(args.index)
  const matches = findServer(index, args.query)
  if (matches.length === 0) { console.error("no server matches " + args.query); process.exit(1) }
  if (matches.length > 1) {
    console.error(matches.length + " servers match " + args.query + ":")
    for (const m of matches.slice(0, 20)) console.error("  " + m.server + "  " + m.verdict)
    if (matches.length > 20) console.error("  ...")
    process.exit(1)
  }
  process.stdout.write(render(matches[0]) + "\n")
}
