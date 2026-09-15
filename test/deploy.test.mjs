import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

/**
 * Deployment drift.
 *
 * A first deploy does not usually fail inside one file. It fails where two files disagree
 * about a port, a path, or which node binary to run — and that only shows up on a machine
 * nobody can test on. Each assertion here is a thing that would have been discovered by a
 * failed demo instead.
 *
 * The two that were real: the Caddyfile serves /var/www/zhiliang and nothing created it, so
 * the brand page would have come up empty; and the systemd unit named /usr/bin/node while the
 * runbook recommends nvm, which does not install there.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const caddy = readFileSync(join(ROOT, "deploy", "Caddyfile"), "utf8")
const unit = readFileSync(join(ROOT, "deploy", "agentgate.service"), "utf8")
const script = readFileSync(join(ROOT, "scripts", "onboard-server.sh"), "utf8")
const bin = readFileSync(join(ROOT, "bin", "agentgate.mjs"), "utf8")

test("the proxy, the unit and the CLI agree on one port", function () {
  const proxied = [...caddy.matchAll(/reverse_proxy\s+127\.0\.0\.1:(\d+)/g)].map(function (m) { return m[1] })
  assert.ok(proxied.length > 0, "the Caddyfile proxies nothing")
  const unitPort = /AGENTGATE_PORT=(\d+)/.exec(unit)[1]
  const cliDefault = /AGENTGATE_PORT\s*\|\|\s*(\d+)/.exec(bin)[1]
  for (const port of proxied) assert.equal(port, unitPort, "Caddy proxies " + port + " but the unit binds " + unitPort)
  assert.equal(unitPort, cliDefault, "the unit binds " + unitPort + " but the CLI defaults to " + cliDefault)
})

test("the unit reads the files that refresh writes", function () {
  const wd = /WorkingDirectory=(\S+)/.exec(unit)[1]
  assert.equal(/AGENTGATE_INDEX=(\S+)/.exec(unit)[1], wd + "/data/index.json")
  assert.equal(/AGENTGATE_SAMPLE=(\S+)/.exec(unit)[1], wd + "/data/sample-index.json")
  // refresh writes ./data beside the caller, so the unit's working directory is what makes
  // those two paths the ones that exist after a refresh
  assert.match(script, /refresh --max/, "onboarding no longer runs a refresh")
})

test("ExecStart names a file the repository actually has", function () {
  const m = /ExecStart=(\S+)\s+(\S+)/.exec(unit)
  const program = m[1]
  assert.ok(bin.indexOf(program) === -1, "sanity: the bin path is not the interpreter path")
  assert.ok(existsSync(join(ROOT, m[2])), "ExecStart runs " + m[2] + ", which does not exist")
})

test("everything the Caddyfile serves is created by the onboarding script", function () {
  const roots = [...caddy.matchAll(/root \* (\S+)/g)].map(function (m) { return m[1] })
  assert.ok(roots.length > 0, "the Caddyfile serves no static directory")
  for (const dir of roots) {
    assert.ok(script.indexOf(dir) !== -1, "the Caddyfile serves " + dir + " but the onboarding script never creates it")
  }
  // and the site built into it is the site this repository builds
  assert.match(script, /build-site\.mjs/, "the static directory is never populated")
})

test("the unit's node path is detected rather than assumed", function () {
  // the runbook recommends nvm; nvm does not install to /usr/bin, so a copied unit fails
  assert.match(script, /NODE_BIN=.*command -v node/, "the onboarding script does not detect node")
  assert.match(script, /s#\^ExecStart=.*#ExecStart=\$NODE_BIN/, "the unit is installed without substituting the real node path")
})

test("the onboarding script is valid shell and its dry run exits clean", function () {
  const scriptPath = join(ROOT, "scripts", "onboard-server.sh")
  const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" })
  assert.equal(syntax.status, 0, syntax.stderr)

  // A bare run is the first thing anyone does on a new machine, and it must not touch it.
  const dry = spawnSync("bash", [scriptPath, "--skip-network"], { encoding: "utf8", timeout: 60000 })
  assert.equal(dry.status, 0, "the dry run failed: " + dry.stderr)
  assert.match(dry.stdout, /DRY-RUN/)
  assert.match(dry.stdout, /would run:/)
  assert.match(dry.stdout, /smoke\.mjs http:\/\/127\.0\.0\.1:/, "the dry run does not end with a smoke check")
})

test("the installer picks the package manager the distribution actually has", function () {
  // Alibaba Cloud Linux is RHEL family: no apt-get, dnf instead, SELinux enforcing. The script
  // called apt-get unconditionally, which stops at the first step on the default Aliyun image.
  // A fake PATH with only what the script needs reproduces that distribution here.
  const bin = mkdtempSync(join(tmpdir(), "ag-bin-"))
  for (const tool of ["uname", "hostname", "id", "sed"]) {
    const from = ["/usr/bin", "/bin"].map(function (d) { return join(d, tool) }).filter(existsSync)[0]
    if (from) symlinkSync(from, join(bin, tool))
  }
  writeFileSync(join(bin, "dnf"), "#!/bin/sh\necho dnf\n", { mode: 0o755 })
  writeFileSync(join(bin, "getenforce"), "#!/bin/sh\necho Enforcing\n", { mode: 0o755 })

  const out = spawnSync("/bin/bash", [join(ROOT, "scripts", "onboard-server.sh"), "--skip-network"], {
    encoding: "utf8", timeout: 60000,
    env: Object.assign({}, process.env, { PATH: bin }),
  })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /包管理器:dnf/, "the script did not detect the package manager")
  assert.match(out.stdout, /would run: dnf install -y git curl/, out.stdout)
  assert.doesNotMatch(out.stdout, /apt-get/, "apt-get was used on a machine that does not have it")
  assert.match(out.stdout, /SELinux: Enforcing/, "SELinux was not reported on a RHEL-family box")
  rmSync(bin, { recursive: true, force: true })
})

/** A PATH with only what the script needs, plus whatever fakes the test supplies. */
function fakeBin(tools, files) {
  const bin = mkdtempSync(join(tmpdir(), "ag-bin-"))
  for (const tool of tools) {
    const from = ["/usr/bin", "/bin"].map(function (d) { return join(d, tool) }).filter(existsSync)[0]
    if (from) symlinkSync(from, join(bin, tool))
  }
  for (const name of Object.keys(files || {})) writeFileSync(join(bin, name), files[name], { mode: 0o755 })
  return bin
}

function dryRun(bin, args) {
  return spawnSync("/bin/bash", [join(ROOT, "scripts", "onboard-server.sh")].concat(args || []), {
    encoding: "utf8", timeout: 60000,
    env: Object.assign({}, process.env, { PATH: bin }),
  })
}

test("when the repository host is unreachable, the dry run says what to do about it", function () {
  // A mainland server frequently cannot clone github.com, and the clone is the first step.
  const bin = fakeBin(["uname", "hostname", "id", "sed"], {
    curl: "#!/bin/sh\ncase \"$*\" in *github.com*) exit 7 ;; *) echo 200 ;; esac\n",
  })
  const out = dryRun(bin)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /仓库主机 github\.com: 连不上/, out.stdout)
  assert.match(out.stdout, /--repo https:\/\/gitee\.com\//, "no mirror was suggested")
  assert.match(out.stdout, /MCP 官方注册表: 可达/, "a reachable registry was reported as down")
  rmSync(bin, { recursive: true, force: true })
})

test("a custom --repo is what the clone actually uses", function () {
  const out = spawnSync("bash", [join(ROOT, "scripts", "onboard-server.sh"), "--skip-network", "--repo", "https://gitee.com/someone/agentgate"], { encoding: "utf8", timeout: 60000 })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /git clone https:\/\/gitee\.com\/someone\/agentgate/)
  assert.doesNotMatch(out.stdout, /git clone https:\/\/github\.com/, "the mirror was ignored")
})
