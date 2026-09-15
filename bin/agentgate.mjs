#!/usr/bin/env node
/**
 * The one entry point.
 *
 *   agentgate serve     start the evidence service
 *   agentgate refresh   rebuild the index from public sources
 *   agentgate version
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { start } from "../packages/service/src/start.mjs"
import { runScan } from "../packages/guard/src/engine.mjs"
import { makeReader } from "../packages/guard/src/fs-scan.mjs"
import { ALL_CHECKS } from "../packages/guard/src/checks/index.mjs"
import { loadPolicy } from "../packages/policy/src/policy.mjs"
import { evaluate, exitCodeFor } from "../packages/policy/src/evaluate.mjs"
import { toSarif } from "../packages/policy/src/sarif.mjs"
import { diffIndex, renderDiff } from "../packages/history/src/diff.mjs"
import { createProxy } from "../packages/gateway/src/proxy.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function parse(argv) {
  const args = { command: argv[0] || "help", flags: {}, rest: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--") { args.rest = argv.slice(i + 1); break }
    if (a.indexOf("--") === 0) args.flags[a.slice(2)] = argv[i + 1] && argv[i + 1].indexOf("--") !== 0 ? argv[++i] : true
    else args.rest.push(a)
  }
  return args
}

function serve(flags) {
  const indexPath = resolve(flags.index || process.env.AGENTGATE_INDEX || join(ROOT, "data", "index.json"))
  const samplePath = resolve(flags.sample || process.env.AGENTGATE_SAMPLE || join(ROOT, "data", "sample-index.json"))
  const port = Number(flags.port || process.env.AGENTGATE_PORT || 8080)
  const host = flags.host || process.env.AGENTGATE_HOST || "127.0.0.1"
  start({ indexPath: indexPath, samplePath: samplePath, port: port, host: host })
  const which = existsSync(indexPath) ? indexPath : (existsSync(samplePath) ? samplePath + " (committed sample)" : "none")
  console.log("agentgate serving http://" + host + ":" + port)
  console.log("index: " + which)
  console.log("routes: /health /v1/index/summary /v1/servers /v1/servers/:name /badge/:name.svg")
}

function refresh(flags) {
  const max = String(flags.max || 300)
  const dataDir = join(ROOT, "data")
  const run = function (label, script, args) {
    process.stderr.write("[refresh] " + label + "\n")
    const out = spawnSync(process.execPath, [script].concat(args), { stdio: "inherit", cwd: ROOT })
    if (out.status !== 0) { console.error("[refresh] " + label + " failed with exit " + out.status); process.exit(out.status || 1) }
  }
  run("census", join(ROOT, "packages", "collect", "mcp-audit.mjs"), ["--max", "6000", "--out", join(dataDir, "census.json"), "--markdown", join(dataDir, "census.md")])
  run("guard-scan", join(ROOT, "packages", "collect", "scripts", "guard-scan.mjs"), ["--census", join(dataDir, "census.json"), "--max", max, "--out", join(dataDir, "guard-scan.json")])
  run("index", join(ROOT, "packages", "collect", "scripts", "build-index.mjs"), ["--census", join(dataDir, "census.json"), "--guard", join(dataDir, "guard-scan.json"), "--out", join(dataDir, "index.json")])
  console.log("[refresh] done: " + join(dataDir, "index.json"))
}

function readPackageName(root) {
  const p = join(root, "package.json")
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, "utf8")).name || null } catch (error) { return null }
}

function recordsFor(root, indexPath) {
  if (!indexPath || !existsSync(indexPath)) return null
  let index
  try { index = JSON.parse(readFileSync(indexPath, "utf8")) } catch (error) { return null }
  const name = readPackageName(root)
  if (!name) return []
  return (index.records || []).filter(function (r) {
    return (r.packages || []).some(function (p) { return p.name === name })
  })
}

function check(flags) {
  const root = resolve(flags.root || ".")
  let policy
  try { policy = loadPolicy(flags.policy || join(root, "agentgate.policy.json")) } catch (error) {
    console.error("policy: " + error.message)
    process.exit(3)
  }
  const exclude = String(flags.exclude || "node_modules,.git").split(",").filter(Boolean)
  const scan = runScan({ root: root, checks: ALL_CHECKS, readText: makeReader(), exclude: exclude })
  const records = recordsFor(root, flags.index || process.env.AGENTGATE_INDEX)
  const result = evaluate({ policy: policy, scan: scan, records: records })
  const lines = []
  lines.push("policy " + result.policyVersion + "   root " + root)
  lines.push("")
  for (const f of result.findings) {
    lines.push("  " + String(f.severity).toUpperCase().padEnd(9) + f.rule + "  " + (f.file || "") + "  " + f.reason)
    lines.push("            " + String(f.message).slice(0, 100))
  }
  if (result.findings.length === 0) lines.push("  nothing refused")
  if (result.coverage.evidenceMissing.length > 0) {
    lines.push("")
    lines.push("  could not be measured:")
    for (const m of result.coverage.evidenceMissing.slice(0, 10)) lines.push("    " + m.server + " / " + m.block + " -> " + m.reason)
    if (result.coverage.evidenceMissing.length > 10) lines.push("    ... and " + (result.coverage.evidenceMissing.length - 10) + " more")
  }
  if (result.coverage.checksFailed.length > 0) {
    lines.push("")
    for (const c of result.coverage.checksFailed) lines.push("  CHECK FAILED: " + c.id + " -> " + c.error)
  }
  lines.push("")
  lines.push("  verdict: " + result.verdict.toUpperCase() + (result.verdict === "incomplete" ? "  (this is not a pass)" : ""))
  const human = lines.join("\n")
  const format = flags.format || "console"
  const rendered = format === "sarif" ? toSarif(result, { version: "0.1.0" }) : format === "json" ? JSON.stringify(result, null, 2) : human
  if (flags.out) {
    writeFileSync(flags.out, rendered + "\n")
    process.stdout.write(human + "\n")
  } else {
    process.stdout.write(rendered + "\n")
  }
  process.exit(exitCodeFor(result))
}

function diff(flags) {
  if (!flags.from || !flags.to) { console.error("usage: agentgate diff --from old-index.json --to new-index.json"); process.exit(3) }
  const from = JSON.parse(readFileSync(flags.from, "utf8"))
  const to = JSON.parse(readFileSync(flags.to, "utf8"))
  const d = diffIndex(from, to)
  const text = (flags.format === "json") ? JSON.stringify(d, null, 2) : renderDiff(d)
  if (flags.out) writeFileSync(flags.out, text + "\n")
  process.stdout.write(text + "\n")
  process.exit(d.silent.length > 0 ? 1 : 0)
}

const args = parse(process.argv.slice(2))
function proxy(flags, rest) {
  if (rest.length === 0) { console.error("usage: agentgate proxy --policy policy.json [--log calls.jsonl] -- <server command> [args...]"); process.exit(3) }
  let policy
  try { policy = loadPolicy(flags.policy || "agentgate.policy.json") } catch (error) { console.error("policy: " + error.message); process.exit(3) }
  const logPath = flags.log || "agentgate-calls.jsonl"
  process.stderr.write("agentgate proxy: " + rest.join(" ") + "\n")
  process.stderr.write("agentgate proxy: refusals logged to " + logPath + "\n")
  createProxy({
    command: rest[0],
    args: rest.slice(1),
    policy: policy,
    logPath: logPath,
    out: process.stdout,
    input: process.stdin,
    onExit: function (code, stats) {
      process.stderr.write("agentgate proxy: " + JSON.stringify(stats) + "\n")
      process.exit(code === null ? 0 : code)
    },
  })
}

if (args.command === "check") check(args.flags)
else if (args.command === "proxy") proxy(args.flags, args.rest)
else if (args.command === "diff") diff(args.flags)
else if (args.command === "serve") serve(args.flags)
else if (args.command === "refresh") refresh(args.flags)
else if (args.command === "version") console.log("agentgate 0.1.0")
else {
  console.log("agentgate <command>")
  console.log("")
  console.log("  check     --policy policy.json [--root .] [--index data/index.json] [--format console|sarif|json] [--out file]")
  console.log("  diff      --from old-index.json --to new-index.json [--format json|md] [--out file]")
  console.log("  proxy     --policy policy.json [--log calls.jsonl] -- <server command> [args...]")
  console.log("  serve     [--port 8080] [--host 127.0.0.1] [--index path] [--sample path]")
  console.log("  refresh   [--max 300]   fetch public sources and rebuild data/index.json")
  console.log("  version")
}
