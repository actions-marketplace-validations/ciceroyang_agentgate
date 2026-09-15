#!/usr/bin/env node
/**
 * 部署彩排。
 *
 * 真机部署里能出错的部分有两类：需要服务器的（systemd、Caddy、安全组），和不需要的。
 * 这个脚本把不需要服务器的部分完整跑一遍——建静态站、生成样例报告、检查页面间的链接、
 * 起服务、跑 smoke——在临时目录里，不碰机器。
 *
 * 它不是替代品：systemd 单元和 Caddy 配置只能上机器验。它挡的是另一半。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const work = mkdtempSync(join(tmpdir(), "ag-rehearse-"))
const www = join(work, "www")
let failures = 0
const step = function (name, ok, detail) {
  if (ok) { console.log("ok    " + name); return }
  failures += 1
  console.log("FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 400) : ""))
}

try {
  mkdirSync(www, { recursive: true })

  // 1. 静态站：Caddy 的 root 指向它
  const build = spawnSync(process.execPath, [join(ROOT, "scripts", "build-site.mjs"),
    "--index", join(ROOT, "data", "sample-index.json"), "--out", www,
    "--name", "evidence.html", "--pages", join(ROOT, "site")], { encoding: "utf8" })
  step("静态站建得出来", build.status === 0, build.stderr)
  for (const name of ["index.html", "evidence.html", "pricing.html", "try.html"]) {
    step("有 " + name, existsSync(join(www, name)))
  }

  // 2. 样例报告：证据索引链到它，在线上不能是死链
  spawnSync(process.execPath, [join(ROOT, "bin", "agentgate.mjs"), "check",
    "--root", join(ROOT, "examples", "action-verify"),
    "--policy", join(ROOT, "examples", "action-verify", "agentgate.policy.json"),
    "--format", "html", "--out", join(www, "report-sample.html")], { encoding: "utf8" })
  step("样例报告出得来", existsSync(join(www, "report-sample.html")))

  // 3. 定时任务的第一天:没有可比对象,也必须成功落下基线
  const snap = spawnSync(process.execPath, [join(ROOT, "scripts", "daily-snapshot.mjs"),
    "--index", join(ROOT, "data", "sample-index.json"), "--history", join(work, "history"), "--date", "2026-01-01"], { encoding: "utf8" })
  step("第一份快照落得下来(定时任务第一天)", snap.status === 0, snap.stderr || snap.stdout)
  step("第一次不写 diff,而不是拿样本编一个", !existsSync(join(work, "history", "diff-2026-01-01.md")))

  // 4. 页面之间的链接
  const dead = []
  for (const name of ["index.html", "evidence.html", "pricing.html", "try.html", "report-sample.html"]) {
    if (!existsSync(join(www, name))) continue
    const html = readFileSync(join(www, name), "utf8")
    for (const m of html.matchAll(/href="([a-z0-9-]+\.html)"/g)) {
      if (!existsSync(join(www, m[1]))) dead.push(name + " -> " + m[1])
    }
  }
  step("部署出来的页面之间没有死链", dead.length === 0, dead.join(", "))

  // 4. 服务 + smoke（真实起进程，真实发请求）
  const port = 18000 + Math.floor(Math.random() * 2000)
  const child = spawn(process.execPath, [join(ROOT, "bin", "agentgate.mjs"), "serve",
    "--port", String(port), "--host", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", function (d) { log += d })
  child.stderr.on("data", function (d) { log += d })
  try {
    let up = false
    for (let i = 0; i < 40; i += 1) {
      await new Promise(function (r) { setTimeout(r, 250) })
      try { if ((await fetch("http://127.0.0.1:" + port + "/health")).ok) { up = true; break } } catch (error) { /* not yet */ }
    }
    step("服务起得来", up, log)
    if (up) {
      const smoke = spawnSync(process.execPath, [join(ROOT, "scripts", "smoke.mjs"),
        "http://127.0.0.1:" + port, "--expect-min", "250", "--allow-stale"], { encoding: "utf8" })
      step("smoke 通过", smoke.status === 0, smoke.stdout)
    }
  } finally {
    child.kill("SIGKILL")
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log("")
console.log(failures === 0 ? "彩排通过（systemd 与 Caddy 仍需上机器验）" : "彩排失败：" + failures + " 项")
process.exit(failures === 0 ? 0 : 1)
