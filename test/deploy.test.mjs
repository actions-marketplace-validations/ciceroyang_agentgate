import { DEFAULT_PORT } from "../packages/service/src/defaults.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync, mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, copyFileSync } from "node:fs"
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
  const cliDefault = String(DEFAULT_PORT)
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
  for (const tool of ["uname", "hostname", "id", "sed", "node"]) {
    const from = tool === "node" ? process.execPath : ["/usr/bin", "/bin"].map(function (d) { return join(d, tool) }).filter(existsSync)[0]
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
  for (const tool of tools.concat(["node"])) {
    const from = tool === "node" ? process.execPath : ["/usr/bin", "/bin"].map(function (d) { return join(d, tool) }).filter(existsSync)[0]
    if (from) symlinkSync(from, join(bin, tool))
  }
  for (const name of Object.keys(files || {})) { rmSync(join(bin, name), { force: true }); writeFileSync(join(bin, name), files[name], { mode: 0o755 }) }
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

test("every name Caddy serves is a name the runbook tells the user to create", function () {
  // The Caddyfile served five names and the runbook listed three. The two that were missing are
  // the apex and www, so the brand domain would have come up without a certificate while every
  // other step reported success.
  const caddyText = readFileSync(join(ROOT, "deploy", "Caddyfile"), "utf8")
  const served = new Set()
  for (const raw of caddyText.split("\n")) {
    const m = /^([^{]+?)\s*\{$/.exec(raw.trim())
    if (!m) continue
    for (const token of m[1].split(",")) {
      const host = token.trim()
      if (/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(host)) served.add(host)
    }
  }
  assert.ok(served.size >= 2, "the Caddyfile parse found too few names: " + Array.from(served).join(", "))
  // The apex already serves the personal site on that machine. A Caddyfile that claims it would
  // take the site over the moment it is installed, which is not a deploy script\u0027s call to make.
  assert.equal(served.has("xn--5kvo87g.com"), false, "the Caddyfile claims the apex, which is in use")
  assert.equal(served.has("www.xn--5kvo87g.com"), false, "the Caddyfile claims www, which is in use")

  const runbook = readFileSync(join(ROOT, "docs", "operations", "deployment-runbook.md"), "utf8")
  // Only the DNS section counts. The runbook also quotes the whole Caddyfile further down, so a
  // check against the whole file stayed green even with the apex row deleted: the name was still
  // somewhere on the page, just not where somebody would read it and create the record.
  const section = /## 前置([\s\S]*?)\n## /.exec(runbook)
  assert.ok(section, "the runbook has no 前置 section")
  // Split into whole tokens. A substring check would count "www.xn--5kvo87g.com" as containing
  // the apex, so deleting only the apex row would go unnoticed.
  const tokens = section[1].split(/[^a-z0-9.-]+/)
  const missing = Array.from(served).filter(function (host) { return tokens.indexOf(host) === -1 })
  assert.deepEqual(missing, [], "Caddy serves names the runbook DNS section never tells the user to create")

  assert.match(runbook, /没有[^\n]*`try\.`/, "the runbook no longer says there is no try. subdomain")
})

test("the runbook points at the Caddyfile instead of copying it", function () {
  // A hand-copied config drifts, and this one had: it lost the docs. site block and never gained
  // the log-retention or SELinux notes. Somebody following the runbook would have pasted a
  // config with one fewer name than the Caddyfile serves. The file is the single source.
  const runbook = readFileSync(join(ROOT, "docs", "operations", "deployment-runbook.md"), "utf8")
  assert.match(runbook, /deploy\/Caddyfile/, "the runbook no longer points at the real Caddyfile")
  assert.doesNotMatch(runbook, /root \* \/var\/www/, "the runbook has a hand-copied Caddyfile again")
})

test("the docker refresh writes the index the docker service reads", function () {
  // The same failure the package had once, in compose form: a collector that writes somewhere the
  // service does not read looks like a successful refresh and leaves the service on the sample.
  // The two services must mount the same host directory, and the refresh must also seed history,
  // which the Node path does and the docker path did not.
  const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8")
  const mounts = [...compose.matchAll(/-\s+(\.\/data:\S+)/g)].map(function (m) { return m[1] })
  assert.equal(mounts.length, 2, "expected one data mount per service, found " + mounts.length)
  assert.equal(new Set(mounts).size, 1, "the two services mount different directories: " + mounts.join(", "))
  assert.match(compose, /daily-snapshot\.mjs/, "the docker path never builds history")
})

test("--with-caddy still installs the service, and puts the TLS step last", function () {
  // The first version of this flag narrowed the wrong "if node mode" block, so --with-caddy
  // skipped installing the systemd unit entirely. That is the failure this asserts against:
  // adding a step must not remove one.
  const script = join(ROOT, "scripts", "onboard-server.sh")
  const withCaddy = spawnSync("bash", [script, "--skip-network", "--with-caddy"], { encoding: "utf8", timeout: 60000 })
  assert.equal(withCaddy.status, 0, withCaddy.stderr)
  assert.match(withCaddy.stdout, /systemctl enable --now agentgate/, "the service install was skipped")
  assert.match(withCaddy.stdout, /smoke\.mjs http/, "the smoke check was skipped")
  assert.match(withCaddy.stdout, /Caddy（--with-caddy）/, "the Caddy step is missing")
  assert.doesNotMatch(withCaddy.stdout, /这一步没做/, "it still says the TLS step was not done")
  assert.ok(withCaddy.stdout.indexOf("smoke.mjs http") < withCaddy.stdout.indexOf("Caddy（--with-caddy）"),
    "the Caddy step must come after the service is verified")

  const plain = spawnSync("bash", [script, "--skip-network"], { encoding: "utf8", timeout: 60000 })
  assert.match(plain.stdout, /这一步没做/, "without the flag the outstanding step must still be stated")
})

test("--with-caddy appends to an existing Caddyfile instead of replacing it", function () {
  // The target machine already runs Caddy for the personal site on the apex. The first version of
  // this step copied our Caddyfile over /etc/caddy/Caddyfile, which would have taken that site
  // down. It must back up and append, and roll back if the result does not validate.
  const fakeBin = mkdtempSync(join(tmpdir(), "ag-caddy-"))
  writeFileSync(join(fakeBin, "caddy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  for (const tool of ["uname", "hostname", "id", "sed", "node"]) {
    const from = tool === "node" ? process.execPath : ["/usr/bin", "/bin"].map(function (d) { return join(d, tool) }).filter(existsSync)[0]
    if (from) symlinkSync(from, join(fakeBin, tool))
  }
  const fakeRepo = mkdtempSync(join(tmpdir(), "ag-repo-"))
  mkdirSync(join(fakeRepo, "deploy"), { recursive: true })
  copyFileSync(join(ROOT, "deploy", "Caddyfile"), join(fakeRepo, "deploy", "Caddyfile"))

  const out = spawnSync("/bin/bash", [join(ROOT, "scripts", "onboard-server.sh"), "--skip-network", "--with-caddy", "--dir", fakeRepo], {
    encoding: "utf8", timeout: 60000,
    env: Object.assign({}, process.env, { PATH: fakeBin + ":/usr/bin:/bin" }),
  })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /只追加/, "the plan does not mention appending: " + out.stdout.slice(-400))
  assert.doesNotMatch(out.stdout, /cp \S*deploy\/Caddyfile \/etc\/caddy\/Caddyfile$/, "it would overwrite the file")
  assert.match(out.stdout, /备份/, "no backup is taken before the change")
  rmSync(fakeBin, { recursive: true, force: true })
  rmSync(fakeRepo, { recursive: true, force: true })
})

test("a server without a usable node stops at the check, with instructions", function () {
  // Without this the script printed one line and carried on, so every later step failed with
  // "/usr/bin/node: not found" and nothing said why. Node is the one runtime it does not install.
  const bin = mkdtempSync(join(tmpdir(), "ag-node-"))
  for (const tool of ["uname", "hostname", "id", "sed"]) {
    const from = tool === "node" ? process.execPath : ["/usr/bin", "/bin"].map(function (d) { return join(d, tool) }).filter(existsSync)[0]
    if (from) symlinkSync(from, join(bin, tool))
  }
  writeFileSync(join(bin, "node"), "#!/bin/sh\ncase \"$1\" in --version) echo v18.16.0 ;; *) exit 0 ;; esac\n", { mode: 0o755 })

  const dry = spawnSync("/bin/bash", [join(ROOT, "scripts", "onboard-server.sh"), "--skip-network"], {
    encoding: "utf8", timeout: 60000, env: Object.assign({}, process.env, { PATH: bin + ":/usr/bin:/bin" }) })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /太旧/, "an old node was not reported")
  assert.doesNotMatch(dry.stdout, /将执行/, "the dry run carried on and listed commands that cannot run")

  const apply = spawnSync("/bin/bash", [join(ROOT, "scripts", "onboard-server.sh"), "--skip-network", "--apply"], {
    encoding: "utf8", timeout: 60000, env: Object.assign({}, process.env, { PATH: bin + ":/usr/bin:/bin" }) })
  assert.equal(apply.status, 1, "apply did not stop on an unusable node")
  assert.doesNotMatch(apply.stdout, /将执行/, "apply carried on past the missing runtime")
  rmSync(bin, { recursive: true, force: true })
})
