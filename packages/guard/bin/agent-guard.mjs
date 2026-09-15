#!/usr/bin/env node
import { exitCodeFor, runScan } from "../src/engine.mjs"
import { makeReader } from "../src/fs-scan.mjs"
import { toConsole, toJson, toSarif } from "../src/report.mjs"
import { ALL_CHECKS } from "../src/checks/index.mjs"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"))
const ALL = ALL_CHECKS

function parseArgs(argv) {
  const args = { path: ".", format: "console", out: null, failOn: "medium", allowIncomplete: false, checks: null, exclude: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--format") args.format = argv[++i]
    else if (a === "--out" || a === "-o") args.out = argv[++i]
    else if (a === "--fail-on") args.failOn = argv[++i]
    else if (a === "--checks") args.checks = argv[++i].split(",")
    else if (a === "--exclude") args.exclude = argv[++i].split(",")
    else if (a === "--allow-incomplete") args.allowIncomplete = true
    else if (a === "--help") { process.stdout.write("agent-guard [path] [--format console|json|sarif] [--out file] [--fail-on critical|high|medium|low|info] [--checks id,id] [--exclude a,b] [--allow-incomplete]\n"); process.exit(0) }
    else if (a.charAt(0) === "-") { process.stderr.write("unknown option " + a + "\n"); process.exit(3) }
    else args.path = a
  }
  return args
}

export function main(argv) {
  const args = parseArgs(argv)
  const root = resolve(args.path)
  const checks = args.checks ? ALL.filter(function (c) { return args.checks.indexOf(c.id) !== -1 }) : ALL
  const result = runScan({ root: root, checks: checks, readText: makeReader(), exclude: args.exclude })
  const meta = { version: pkg.version, root: root }
  const text = args.format === "json" ? toJson(result, meta) : args.format === "sarif" ? toSarif(result, meta) : toConsole(result, meta)
  if (args.out) writeFileSync(args.out, text)
  else process.stdout.write(text)
  const code = exitCodeFor(result, args.failOn)
  if (code === 2 && args.allowIncomplete) return 0
  return code
}

const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href
if (isMain) process.exit(main(process.argv.slice(2)))
