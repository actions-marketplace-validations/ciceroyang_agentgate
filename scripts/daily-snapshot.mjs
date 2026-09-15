#!/usr/bin/env node
/**
 * One day of history.
 *
 * The first run has nothing to compare against, and that is the case the documented cron got
 * wrong: it diffed against data/history/previous.json, which does not exist yet, so the diff
 * threw, the && chain stopped before previous.json was written, and the job failed the same way
 * every day after that. The history stayed empty forever. A first snapshot is not a failure; it
 * is the thing the second one compares against.
 *
 *   node scripts/daily-snapshot.mjs [--index data/index.json] [--history data/history] [--date YYYY-MM-DD]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { diffIndex, renderDiff } from "../packages/history/src/diff.mjs"

const argv = process.argv.slice(2)
const argOf = function (name, fallback) {
  const i = argv.indexOf("--" + name)
  return i === -1 ? fallback : argv[i + 1]
}
const quiet = argv.indexOf("--quiet") !== -1
const index = resolve(argOf("index", "data/index.json"))
const history = resolve(argOf("history", "data/history"))
const date = argOf("date", new Date().toISOString().slice(0, 10))

if (!existsSync(index)) {
  console.error("no index at " + index + " -- run refresh first")
  process.exit(1)
}
mkdirSync(history, { recursive: true })
const previousPath = join(history, "previous.json")
let today
try { today = JSON.parse(readFileSync(index, "utf8")) } catch (error) {
  console.error("the index at " + index + " is not readable JSON: " + error.message)
  process.exit(1)
}

let message
if (existsSync(previousPath)) {
  const previous = JSON.parse(readFileSync(previousPath, "utf8"))
  const diff = diffIndex(previous, today)
  writeFileSync(join(history, "diff-" + date + ".md"), renderDiff(diff) + "\n")
  const silent = (diff.silent || []).length
  message = "diff written for " + date + ": " + silent + " silent change(s)"
} else {
  // Do not invent a previous state by comparing against the committed sample: a diff between a
  // sample and a real index is not a change over time, and presenting it as one is the kind of
  // overstatement this project is built to avoid.
  message = "first snapshot: there is nothing to compare against yet, so no diff is written"
}
copyFileSync(index, join(history, date + ".json"))
copyFileSync(index, previousPath)
if (!quiet) console.log(message)
