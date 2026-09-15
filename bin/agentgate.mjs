#!/usr/bin/env node
/**
 * The one entry point.
 *
 *   agentgate serve     start the evidence service
 *   agentgate refresh   rebuild the index from public sources
 *   agentgate version
 */
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { start } from "../packages/service/src/start.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function parse(argv) {
  const args = { command: argv[0] || "help", flags: {} }
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.indexOf("--") === 0) args.flags[a.slice(2)] = argv[i + 1] && argv[i + 1].indexOf("--") !== 0 ? argv[++i] : true
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

const args = parse(process.argv.slice(2))
if (args.command === "serve") serve(args.flags)
else if (args.command === "refresh") refresh(args.flags)
else if (args.command === "version") console.log("agentgate 0.1.0")
else {
  console.log("agentgate <command>")
  console.log("")
  console.log("  serve     [--port 8080] [--host 127.0.0.1] [--index path] [--sample path]")
  console.log("  refresh   [--max 300]   fetch public sources and rebuild data/index.json")
  console.log("  version")
}
