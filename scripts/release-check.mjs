#!/usr/bin/env node
/**
 * Can this version be released? One command, one verdict, and the gaps named.
 *
 *   node scripts/release-check.mjs [--tag v0.1.1] [--version 0.1.1] [--tests] [--online]
 *                                  [--skip-tests] [--format text|json]
 *
 * Offline by default: the only network access is behind --online, which reports the published
 * dist-tags and whether this version already exists. A dirty working tree and a missing HEAD tag
 * are warnings, not failures - releasing from a workflow dispatch is a legitimate path - while a
 * missing changelog entry, a version that disagrees with its own tag, and a tarball that would
 * carry a generated index or an environment file are failures.
 */
import { existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { classifyPack, changelogHasVersion, pathsFromPackJson, summarize, tagMatches } from "../packages/release/src/release.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function parse(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.indexOf("--") !== 0) continue
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && next.indexOf("--") !== 0) { out[name] = next; i += 1 } else out[name] = true
  }
  return out
}

function run(command, args, settings) {
  return spawnSync(command, args, Object.assign({ cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, settings || {}))
}

const args = parse(process.argv.slice(2))
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const version = String(args.version || pkg.version)
const checks = []
const add = function (level, name, ok, detail) {
  checks.push({ level: level, name: name, ok: ok, detail: detail || name })
}

add("problem", "package.json 的版本与 --version 一致", version === pkg.version, "package.json " + pkg.version + " ≠ " + version)
add("problem", "包名与许可证已声明", Boolean(pkg.name && pkg.license), "缺 name 或 license")
add("problem", "publishConfig 带了 provenance", Boolean(pkg.publishConfig && pkg.publishConfig.provenance === true), "缺少 publishConfig.provenance")

const binVersion = run(process.execPath, [join(ROOT, "bin", "agentgate.mjs"), "version"])
// The CLI prints "agentgate <version>"; what matters is that the number it reports is this one,
// because that is the number a user sees when they ask what they installed.
const reported = String(binVersion.stdout || "").trim().split(" ").pop()
add("problem", "agentgate version 报的是同一个版本", reported === version, "报的是 " + JSON.stringify(String(binVersion.stdout || "").trim()))

if (args.tag !== undefined) {
  const tag = String(args.tag)
  add("problem", "tag 与版本一致", tagMatches(tag, version), tag + " 去掉 v 不等于 " + version)
  const at = run("git", ["tag", "--points-at", "HEAD"])
  add("warning", "HEAD 上已经打了这个 tag", String(at.stdout || "").split("\n").indexOf(tag) !== -1, "HEAD 上没有 " + tag + "（workflow_dispatch 发版可以忽略）")
}

const status = run("git", ["status", "--porcelain"])
add("warning", "工作区干净", String(status.stdout || "").trim() === "", "有未提交的改动，发出去的包与仓库状态不一致")

const changelogPath = join(ROOT, "CHANGELOG.md")
const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : ""
add("problem", "CHANGELOG 里有这个版本的一节", changelogHasVersion(changelog, version), "CHANGELOG.md 里没有 " + version)

const packed = run("npm", ["pack", "--dry-run", "--json"])
let packPaths = null
try {
  packPaths = pathsFromPackJson(packed.stdout || "")
} catch (error) {
  add("problem", "npm pack 能列出内容", false, error.message)
}
if (packPaths) {
  // npm includes package.json unconditionally, so it is not a file that "files" has to explain.
  const classified = classifyPack(packPaths, { allow: (pkg.files || []).concat(["package.json"]) })
  add("problem", "包里没有缺文件", classified.missing.length === 0, "缺：" + classified.missing.join(", "))
  add("problem", "包里没有不该有的东西", classified.leaks.length === 0, classified.leaks.map(function (leak) { return leak.path + "（" + leak.why + "）" }).join("; "))
  add("warning", "包里每个文件都被 files 字段解释", classified.unexplained.length === 0, "未被 files 覆盖：" + classified.unexplained.slice(0, 5).join(", "))
  add("warning", "包的体积合理", packPaths.length < 500, "包里有 " + packPaths.length + " 个文件")
}

if (args.tests === true) {
  const tests = run("npm", ["test", "--silent"])
  add("problem", "测试通过", tests.status === 0, "npm test 退出 " + String(tests.status))
} else {
  checks.push({ level: "warning", name: "测试通过", ok: false, detail: "没有跑测试（用 --tests 跑一次再发）" })
}

let published = null
if (args.online === true) {
  try {
    const encoded = encodeURIComponent(pkg.name)
    const tagsResponse = await fetch("https://registry.npmjs.org/-/package/" + encoded + "/dist-tags")
    const tags = tagsResponse.ok ? await tagsResponse.json() : null
    const versionResponse = await fetch("https://registry.npmjs.org/" + encoded + "/" + version)
    published = { tags: tags, exists: versionResponse.status === 200 }
    add("problem", "这个版本还没有发布过", versionResponse.status === 404, version + " 已经存在于 registry（" + String(versionResponse.status) + "）")
    add("warning", "latest 已经指向这个版本", Boolean(tags && tags.latest === version), "registry 的 dist-tags：" + JSON.stringify(tags))
  } catch (error) {
    add("problem", "能连上 registry", false, String(error && error.message))
  }
}

const verdict = summarize(checks)
if (args.format === "json") {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, version: version, ok: verdict.ok, problems: verdict.problems, warnings: verdict.warnings, checks: checks, published: published }, null, 2) + "\n")
} else {
  for (const check of checks) {
    const mark = check.ok ? "ok  " : check.level === "problem" ? "FAIL" : "warn"
    process.stdout.write(mark + "  " + check.name + (check.ok ? "" : "  -> " + check.detail) + "\n")
  }
  process.stdout.write("\n" + (verdict.ok ? "可以发布：" + version : "还不能发布：" + verdict.problems.length + " 个问题") + "\n")
  if (verdict.warnings.length > 0) process.stdout.write("提醒：" + verdict.warnings.length + " 条（不挡发布）\n")
}
process.exit(verdict.ok ? 0 : 1)
