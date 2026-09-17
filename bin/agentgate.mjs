#!/usr/bin/env node
/**
 * The one entry point.
 *
 *   agentgate serve     start the evidence service
 *   agentgate refresh   rebuild the index from public sources
 *   agentgate version
 */
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, spawnSync } from "node:child_process"
import { start } from "../packages/service/src/start.mjs"
import { DEFAULT_PORT, DEFAULT_HOST } from "../packages/service/src/defaults.mjs"
import { runScan } from "../packages/guard/src/engine.mjs"
import { makeReader } from "../packages/guard/src/fs-scan.mjs"
import { ALL_CHECKS } from "../packages/guard/src/checks/index.mjs"
import { loadPolicy, defaultPolicy } from "../packages/policy/src/policy.mjs"
import { evaluate, exitCodeFor } from "../packages/policy/src/evaluate.mjs"
import { toSarif } from "../packages/policy/src/sarif.mjs"
import { toHtmlReport } from "../packages/policy/src/html-report.mjs"
import { diffIndex, renderDiff } from "../packages/history/src/diff.mjs"
import { readLedger, verifyLedger, backfill } from "../packages/history/src/ledger.mjs"
import { createProxy } from "../packages/gateway/src/proxy.mjs"
import { parseInventory, createInventoryReport } from "../packages/inventory/src/inventory.mjs"
import { renderInventoryReport } from "../packages/inventory/src/report.mjs"

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

/** Where the index lives when the user did not say. A refreshed index is written next to the
 *  project (./data), so look there first; an installed package falls back to the snapshot it
 *  was published with, which is why that snapshot has to be in "files". */
function resolveIndex(flags) {
  const candidates = [
    flags.index || process.env.AGENTGATE_INDEX,
    join(process.cwd(), "data", "index.json"),
    join(ROOT, "data", "index.json"),
    join(process.cwd(), "data", "sample-index.json"),
    join(ROOT, "data", "sample-index.json"),
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return { path: resolve(c), why: c === candidates[0] && (flags.index || process.env.AGENTGATE_INDEX) ? "chosen" : "found" }
  return { path: resolve(candidates[0] || join(process.cwd(), "data", "index.json")), why: "none" }
}

function serve(flags) {
  const chosen = resolveIndex(flags)
  const indexPath = chosen.path
  const samplePath = resolve(flags.sample || process.env.AGENTGATE_SAMPLE || join(ROOT, "data", "sample-index.json"))
  const requested = flags.port !== undefined ? flags.port : (process.env.AGENTGATE_PORT !== undefined ? process.env.AGENTGATE_PORT : DEFAULT_PORT)
  const port = Number(requested)
  const host = flags.host || process.env.AGENTGATE_HOST || DEFAULT_HOST
  const which = existsSync(indexPath) ? indexPath : (existsSync(samplePath) ? samplePath + " (committed sample)" : "none")
  const server = start({
    indexPath: indexPath, samplePath: samplePath, port: port, host: host,
    historyPath: flags.history || process.env.AGENTGATE_HISTORY || join(dirname(resolve(indexPath)), "history"),
    // Print the port the socket actually got. With --port 0 the requested port is not the one
    // anything can connect to, and a caller that cannot learn it has to guess.
    onListening: function () {
      const bound = server.address() && server.address().port
      console.log("agentgate serving http://" + host + ":" + bound)
      console.log("index: " + which)
      console.log("my tools: http://" + host + ":" + bound + "/inventory.html")
      console.log("routes: /health /v1/index/summary /v1/servers /v1/servers/:name /badge/:name.svg")
    },
  })
}

function refresh(flags) {
  const max = String(flags.max || 300)
  // Written next to the caller, not inside the package: an installed package may be read-only,
  // and a refresh should never scribble under node_modules.
  const dataDir = process.env.AGENTGATE_DATA || join(process.cwd(), "data")
  const run = function (label, script, args) {
    process.stderr.write("[refresh] " + label + "\n")
    const out = spawnSync(process.execPath, [script].concat(args), { stdio: "inherit", cwd: ROOT })
    if (out.status !== 0) { console.error("[refresh] " + label + " failed with exit " + out.status); process.exit(out.status || 1) }
  }
  run("census", join(ROOT, "packages", "collect", "mcp-audit.mjs"), ["--max", "6000", "--out", join(dataDir, "census.json"), "--markdown", join(dataDir, "census.md")])
  run("guard-scan", join(ROOT, "packages", "collect", "scripts", "guard-scan.mjs"), ["--census", join(dataDir, "census.json"), "--max", max, "--out", join(dataDir, "guard-scan.json")])
  // The deployed commit is the cheapest honest identifier of "which scanner ran". It moves when
  // the rules move, which is what a later diff needs to know.
  let scanner = "unknown"
  try { scanner = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() } catch (error) { scanner = "unknown" }
  run("index", join(ROOT, "packages", "collect", "scripts", "build-index.mjs"), ["--census", join(dataDir, "census.json"), "--guard", join(dataDir, "guard-scan.json"), "--scanner", scanner, "--out", join(dataDir, "index.json")])
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
  const policyPath = flags.policy || join(root, "agentgate.policy.json")
  let policy
  let policyNote = null
  if (!flags.policy && !existsSync(policyPath)) {
    policy = defaultPolicy()
    policyNote = "built-in default: nothing extra is refused. Write " + join(root, "agentgate.policy.json") + " to refuse specific rules, servers or tools."
  } else {
    try { policy = loadPolicy(policyPath) } catch (error) {
      console.error("policy: " + error.message)
      process.exit(3)
    }
  }
  const exclude = String(flags.exclude || "node_modules,.git").split(",").filter(Boolean)
  let checks = ALL_CHECKS
  if (flags.checks) {
    // A named check that does not exist is an error, not a silently skipped one: running three of
    // four checks and reporting on the fourth is the failure this whole project is about.
    const wanted = String(flags.checks).split(",").map(function (s) { return s.trim() }).filter(Boolean)
    const known = ALL_CHECKS.map(function (c) { return c.id })
    const unknown = wanted.filter(function (w) { return known.indexOf(w) === -1 })
    if (unknown.length > 0) {
      console.error("checks: no such check: " + unknown.join(", ") + "\nknown: " + known.join(", "))
      process.exit(3)
    }
    checks = ALL_CHECKS.filter(function (c) { return wanted.indexOf(c.id) !== -1 })
  }
  const scan = runScan({ root: root, checks: checks, readText: makeReader(), exclude: exclude })
  const records = recordsFor(root, flags.index || process.env.AGENTGATE_INDEX)
  const result = evaluate({ policy: policy, scan: scan, records: records })
  const lines = []
  lines.push("policy " + result.policyVersion + "   root " + root)
  if (checks !== ALL_CHECKS) lines.push("checks " + checks.map(function (c) { return c.id }).join(", ") + " (of the " + ALL_CHECKS.length + " available: this run measured less, and the verdict says so)")
  if (policyNote) lines.push(policyNote)
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
  const rendered = format === "sarif" ? toSarif(result, { version: "0.1.0" })
    : format === "json" ? JSON.stringify(result, null, 2)
    : format === "html" ? toHtmlReport(result, { root: root, policy: policy, generatedAt: new Date().toISOString() })
    : human
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

/**
 * The capture ledger: one chained line per index build.
 *
 * Exit 0 means the chain and every retained snapshot re-hash. Exit 1 means the record has been
 * edited. A missing snapshot is reported separately: pruning old content is a storage decision,
 * and the chain still proves the capture happened.
 */
function history(flags) {
  const dir = flags.history || "data/history"
  const maxAge = flags["max-age"] !== undefined ? Number(flags["max-age"]) : null
  if (flags.backfill) {
    const added = backfill(dir)
    console.log(added.length === 0 ? "nothing to backfill" : "backfilled " + added.length + " capture(s) from the day archives")
  }
  const result = verifyLedger(dir, maxAge !== null ? { maxAgeHours: maxAge } : {})
  const coverage = result.coverage
  if (flags.format === "json") {
    process.stdout.write(JSON.stringify({ ok: result.ok, problems: result.problems, notRetained: result.notRetained, coverage: coverage, entries: result.entries }, null, 2) + "\n")
    process.exit(result.ok ? 0 : 1)
  }
  console.log("captures: " + coverage.captures + " over " + coverage.days + " day(s), " + (coverage.first || "(none)") + " .. " + (coverage.last || "(none)") + (result.ageHours !== null ? " (last " + result.ageHours.toFixed(1) + "h ago)" : ""))
  if (coverage.gaps.length > 0) console.log("missing day(s): " + coverage.gaps.join(", "))
  if (result.notRetained.length > 0) console.log("snapshot(s) no longer retained: " + result.notRetained.length)
  for (const entry of result.entries.slice(-5)) {
    console.log("  " + entry.capturedAt + "  " + entry.records + " records  clean " + entry.counts.clean + " / findings " + entry.counts.findings + " / incomplete " + entry.counts.incomplete + "  " + (entry.scanner || "(no scanner)") + "  " + String(entry.sha256).slice(0, 12))
  }
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error("FAIL  " + problem)
    process.exit(1)
  }
  console.log("chain verified: every line's prev matches the line before it, and every retained snapshot hashes to what was recorded")
  process.exit(0)
}

const args = parse(process.argv.slice(2))
function inventory(flags) {
  try {
    if (typeof flags.input !== "string") throw new Error("请用 --input 指定工具清单（文本或 JSON），不会自动读取你的配置。")
    const format = flags.format || "html"
    if (!["html", "json"].includes(format)) throw new Error("清单报告格式只支持 html 或 json。")
    if (flags.out !== undefined && typeof flags.out !== "string") throw new Error("--out 需要一个输出文件路径。")
    if (flags.index !== undefined && typeof flags.index !== "string") throw new Error("--index 需要一个索引文件路径。")
    const chosen = resolveIndex(flags)
    // An explicit index must never silently fall back to the committed sample.
    const indexPath = flags.index || process.env.AGENTGATE_INDEX || chosen.path
    if (statSync(flags.input).size > 1024 * 1024) throw new Error("工具清单不能超过 1 MB。")
    const entries = parseInventory(readFileSync(flags.input, "utf8"))
    const index = JSON.parse(readFileSync(indexPath, "utf8"))
    if (!index || !Array.isArray(index.records)) throw new Error("证据索引缺少 records 列表，无法生成报告。")
    const report = createInventoryReport(entries, index, { generatedAt: new Date().toISOString() })
    const rendered = format === "json" ? JSON.stringify(report, null, 2) : renderInventoryReport(report)
    if (flags.out) {
      if ([flags.input, indexPath].some(function (p) { return resolve(p) === resolve(flags.out) })) throw new Error("报告不能覆盖输入清单或证据索引。")
      // Reports can contain a private inventory. Do not overwrite a previous report implicitly.
      writeFileSync(flags.out, rendered + "\n", { flag: "wx", mode: 0o600 })
      console.log("清单报告已保存：" + resolve(flags.out))
      console.log("共 " + report.summary.total + " 项；需要补充或确认 " + report.summary.needsAttention + " 项。报告生成不代表安全通过。")
    } else process.stdout.write(rendered + "\n")
    // This is report generation, not the policy check command: unknowns are retained in the report.
  } catch (error) {
    console.error("inventory: " + error.message)
    process.exitCode = 2
  }
}
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

if (args.command === "inventory") inventory(args.flags)
else if (args.command === "check") check(args.flags)
else if (args.command === "proxy") proxy(args.flags, args.rest)
else if (args.command === "diff") diff(args.flags)
else if (args.command === "serve") serve(args.flags)
else if (args.command === "refresh") refresh(args.flags)
else if (args.command === "history") history(args.flags)
else if (args.command === "version") console.log("agentgate 0.1.0")
else {
  console.log("agentgate <command>")
  console.log("")
  console.log("  inventory --input tools.txt [--index data/index.json] [--format html|json] [--out report.html]")
  console.log("  check     --policy policy.json [--root .] [--index data/index.json] [--format console|sarif|json|html] [--out file]")
  console.log("  diff      --from old-index.json --to new-index.json [--format json|md] [--out file]")
  console.log("  proxy     --policy policy.json [--log calls.jsonl] -- <server command> [args...]")
  console.log("  serve     [--port 8080] [--host 127.0.0.1] [--index path] [--sample path]")
  console.log("  refresh   [--max 300]   fetch public sources and rebuild data/index.json")
  console.log("  history   [--history data/history] [--backfill] [--max-age 26] [--format json]   verify the chained capture ledger")
  console.log("  version")
}
