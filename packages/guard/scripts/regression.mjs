#!/usr/bin/env node
/**
 * Two numbers on every commit: what the tool catches and what it cries wolf about.
 *
 *   corpus/benign/**   must produce zero findings (a false positive fails the run)
 *   corpus/positive/** carries expect.json naming the rules that must fire
 *
 * With --external <dir> it also runs over an outside corpus and prints recall,
 * without gating, because that corpus belongs to someone else and may move.
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, cpSync, unlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { runScan } from "../src/engine.mjs"
import { makeReader } from "../src/fs-scan.mjs"
import { ALL_CHECKS } from "../src/checks/index.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = resolve(HERE, "..", "corpus")
const readText = makeReader()

function scanDir(dir) {
  return runScan({ root: dir, checks: ALL_CHECKS, readText: readText })
}

function dirsOf(kind) {
  const root = join(CORPUS, kind)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(function (d) { return d.isDirectory() })
    .map(function (d) { return join(root, d.name) })
    .sort()
}

let failures = 0

for (const dir of dirsOf("benign")) {
  const name = dir.split("/").pop()
  const result = scanDir(dir)
  if (result.verdict !== "clean") {
    failures += 1
    console.log("FAIL  benign " + name + " -> " + result.verdict + " " + JSON.stringify(result.findings.map(function (f) { return f.rule })))
  } else {
    console.log("ok    benign " + name)
  }
}

for (const dir of dirsOf("positive")) {
  const name = dir.split("/").pop()
  const expect = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8"))
  const result = scanDir(dir)
  const got = new Set(result.findings.map(function (f) { return f.rule }))
  const missing = expect.expectRules.filter(function (r) { return !got.has(r) })
  if (missing.length > 0) {
    failures += 1
    console.log("FAIL  positive " + name + " missing " + JSON.stringify(missing) + " got " + JSON.stringify(Array.from(got).sort()))
  } else {
    console.log("ok    positive " + name + " (" + expect.expectRules.length + " rules expected)")
  }
}

const externalFlag = process.argv.indexOf("--external")
if (externalFlag !== -1 && process.argv[externalFlag + 1]) {
  const src = process.argv[externalFlag + 1]
  const names = readdirSync(src, { withFileTypes: true }).filter(function (d) { return d.isDirectory() }).map(function (d) { return d.name }).sort()
  let caught = 0
  const work = mkdtempSync(join(tmpdir(), "ag-external-"))
  for (const name of names) {
    const dst = join(work, name)
    cpSync(join(src, name), dst, { recursive: true })
    const label = join(dst, "expected-findings.json")
    if (existsSync(label)) unlinkSync(label)
    if (scanDir(dst).findings.length > 0) caught += 1
  }
  console.log("")
  console.log("external corpus: " + caught + " / " + names.length + " examples produced at least one finding")
}

console.log("")
if (failures === 0) console.log("regression: green")
else console.log("regression: " + failures + " failure(s)")
process.exit(failures === 0 ? 0 : 1)
