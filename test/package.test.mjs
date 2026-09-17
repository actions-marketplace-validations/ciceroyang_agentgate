import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"
import { scratchDir } from "./tmpdir.mjs"

/**
 * The package rehearsal.
 *
 * Everything else in this suite runs against the repository, where every file is present and
 * the bin is executable. The tarball is a different artefact: it only carries what "files"
 * says, and a missing file there is invisible until someone installs it. That is how the
 * service came to be published with no index to serve — the fallback lived in data/, and data/
 * was not in the package. This walks the tarball the way a stranger would.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function pack() {
  const work = scratchDir("ag-pack-")
  const run = spawnSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: ROOT, encoding: "utf8" })
  assert.equal(run.status, 0, "npm pack failed: " + run.stderr)
  const meta = JSON.parse(run.stdout)
  const entry = meta[0]
  const tarball = join(work, entry.filename)
  assert.ok(existsSync(tarball), "no tarball at " + tarball)
  return { work, tarball, files: entry.files.map(function (f) { return f.path }) }
}

/** Unpack the tarball into a directory of our own making. bsdtar on macOS has no
 *  --one-top-level, so create the prefix rather than asking tar to. */
function extract(tarball, work) {
  const dest = join(work, "extracted")
  mkdirSync(dest, { recursive: true })
  const untar = spawnSync("tar", ["-xzf", tarball, "-C", dest], { encoding: "utf8" })
  assert.equal(untar.status, 0, "could not extract the tarball: " + untar.stderr)
  const pkgDir = join(dest, "package")
  assert.ok(existsSync(join(pkgDir, "bin", "agentgate.mjs")), "the extracted package has no bin")
  return pkgDir
}

/** Every module reachable by a relative import from an entry file. */
function reachableModules(entry, seen) {
  seen = seen || new Set()
  const rel = entry.slice(ROOT.length + 1)
  if (seen.has(rel)) return seen
  seen.add(rel)
  const text = readFileSync(entry, "utf8")
  const dir = dirname(entry)
  for (const m of text.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
    const target = resolve(dir, m[1])
    if (existsSync(target)) reachableModules(target, seen)
  }
  return seen
}

/** Run the CLI out of the extracted package, from a directory that is not the package. */
function runCli(pkgDir, cwd, args, opts) {
  return spawnSync(process.execPath, [join(pkgDir, "bin", "agentgate.mjs")].concat(args), Object.assign({ cwd: cwd, encoding: "utf8", timeout: 60000 }, opts || {}))
}

test("the published tarball carries every module the CLI imports", function () {
  const { files } = pack()
  for (const required of ["bin/agentgate.mjs", "data/sample-index.json", "README.md", "LICENSE", "site/inventory.html", "site/inventory-page.mjs", "site/favicon.svg", "examples/inventory/tools.json"]) {
    assert.ok(files.indexOf(required) !== -1, "the tarball is missing " + required)
  }
  const missing = []
  for (const rel of reachableModules(join(ROOT, "bin", "agentgate.mjs"))) {
    if (files.indexOf(rel) === -1) missing.push(rel)
  }
  assert.deepEqual(missing, [], "the CLI imports files the package does not ship: " + missing.join(", "))
})

test("installed from a tarball, a first run scans instead of demanding a policy file", function () {
  const { work, tarball } = pack()
  const pkgDir = extract(tarball, work)

  const version = runCli(pkgDir, work, ["version"])
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /agentgate \d+\.\d+\.\d+/)

  // A stranger's project: one .mcp.json, no policy, nothing else.
  const project = join(work, "project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "pkg"] } } }))

  const firstRun = runCli(pkgDir, project, ["check", "--root", project])
  assert.notEqual(firstRun.status, 3, "a missing policy file must not be a hard error on a first run")
  assert.match(firstRun.stdout, /built-in default/, "the run should say which policy it used")
  assert.match(firstRun.stdout, /AG-MCP-010/, "the scan should still report what it found")
  assert.equal(firstRun.status, 1, "a finding at or above the default threshold exits 1")

  // An explicitly named policy that cannot be read is still an error: that is a typo, not a default.
  const badPolicy = runCli(pkgDir, project, ["check", "--root", project, "--policy", join(work, "nope.json")])
  assert.equal(badPolicy.status, 3, "an unreadable policy named on purpose exits 3")
})

test("installed from a tarball, serve answers for the snapshot it was published with", async function () {
  const { work, tarball } = pack()
  const pkgDir = extract(tarball, work)
  const project = join(work, "project")
  mkdirSync(project, { recursive: true })

  const child = spawn(process.execPath, [join(pkgDir, "bin", "agentgate.mjs"), "serve", "--port", "0", "--host", "127.0.0.1"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", function (d) { output += d })
  child.stderr.on("data", function (d) { output += d })

  try {
    // --port 0 asks the operating system for a free one, and the service prints which it got.
    // Guessing a port in a fixed range meant this test could reach whatever else was listening
    // there and assert on a stranger's response. It failed once with "the service answered with
    // an empty index" against a local gateway that was not agentgate at all.
    let port = null
    for (let i = 0; i < 60 && !port; i += 1) {
      await new Promise(function (r) { setTimeout(r, 100) })
      const said = /serving http:\/\/[^:]+:(\d+)/.exec(output)
      if (said) port = Number(said[1])
    }
    assert.ok(port, "the service never said which port it bound:\n" + output)

    let body = null
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch("http://127.0.0.1:" + port + "/health")
        if (res.ok) { body = await res.json(); break }
      } catch (error) { /* not listening yet */ }
      await new Promise(function (r) { setTimeout(r, 100) })
    }
    assert.ok(body, "the service never answered on port " + port + "\n" + output)
    assert.ok(body.index, "something that is not this service answered on port " + port)
    assert.ok(body.records > 0, "the service answered with an empty index: " + JSON.stringify(body))
    const inventory = await fetch("http://127.0.0.1:" + port + "/inventory.html")
    assert.equal(inventory.status, 200, "the installed package must ship the inventory page")
    assert.doesNotMatch(await inventory.text(), /__INVENTORY_INDEX__/)
    for (const asset of ["inventory.mjs", "inventory-report.mjs", "inventory-page.mjs"]) {
      assert.equal((await fetch("http://127.0.0.1:" + port + "/" + asset)).status, 200, asset)
    }
  } finally {
    child.kill("SIGKILL")
  }
})
