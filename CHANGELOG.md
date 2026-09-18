# Changelog

All notable changes to this package. The version here is the version that shipped; the tarball and
the tag agree with it, and `scripts/release-check.mjs` refuses a release whose section is missing.

## [Unreleased]

- The formats are frozen and the promise is written down:
  [docs/spec/compatibility.md](docs/spec/compatibility.md) says what each version identifier means,
  what may change inside one, how a breaking change is announced, and which versions are supported.
  Every spec now declares `frozen` or `provisional`, and
  [docs/operations/upgrade.md](docs/operations/upgrade.md) carries a section for every released
  version, including the 0.1.1 change that made a stricter exit code look like nothing at all.
- [SECURITY.md](SECURITY.md) says how to report a vulnerability, what to expect, what is in scope,
  and which of our own properties a reporter can check. Private vulnerability reporting on GitHub
  is switched on.
- `test/governance.test.mjs` holds both promises to the code and to each other: the identifiers in
  the policy are the ones the modules export, and the upgrade guide and the CHANGELOG must name the
  same versions.

## [0.3.0] - 2026-09-18

- `agentgate pack` produces a deliverable a vendor can hand to the person reviewing them:
  `pack.json`, `pack.html`, `answers.aicaiq.md`, a per-file `manifest.txt` and a `manifest.sha256`
  seal. Every answer we claim points at evidence in the same directory, every item we could not
  measure is counted at the top of the page, and the command exits 2 rather than 0 when one of our
  answers is only partly measured. `agentgate pack --verify <dir>` recomputes every hash and the
  seal. Spec: [docs/spec/evidence-pack-v1.md](docs/spec/evidence-pack-v1.md), example generated
  from the live index: [docs/samples/evidence-pack-example](docs/samples/evidence-pack-example).
- The AI-CAIQ mapping now covers all 58 items of the four domains a reviewer asks a vendor about
  (STA 19, CCC 11, LOG 21, A&A 7) instead of 16 capability-level entries. 13 are ours, 41 are the
  customer's and 4 belong to an independent assessor; each one names the evidence classes it draws
  on, and a `we` entry with no evidence class fails the test suite. `framework` prints the same
  table, now with the evidence classes.
- Nine evidence classes decide what "measured" means for an answer: tool identity, exact version,
  content digest and scope, package metadata, scan execution, change history, archive integrity,
  coverage accounting and gateway decisions. The implemented classes and the ones the mapping may
  name are compared by a test, so a claim with nothing behind it cannot be added quietly.
- The pack reuses the existing scanner, inventory parser and archive; it adds no new measurement
  and never opens a socket. An explicitly named `--index` is a decision, not a preference: a missing
  file is an error rather than a silent fallback to the packaged sample.

## [0.2.5] - 2026-09-18

- The product moved to <https://xn--5kvo87g.com/> and the personal site that used to live there
  moved to <https://cicero.xn--5kvo87g.com/>. The old host `app.xn--5kvo87g.com` redirects pages to
  the apex and keeps serving `/v1`, `/health` and `/badge` directly. Every link in the README, the
  site pages, `server.json` and `security.txt` follows; no runtime behaviour changed.

## [0.2.4] - 2026-09-18

- `agentgate mcp` serves the index to any MCP client over stdio: four read-only tools
  (`lookup_server`, `inventory_tools`, `coverage_report`, `check_project`) that read the local
  index and never write, upload or run a scanned tool. An incomplete record is reported as
  incomplete, a missing record as missing rather than safe, and an explicitly named index that does
  not exist is not silently replaced by the packaged sample. Spec:
  [docs/spec/mcp-server-v1.md](docs/spec/mcp-server-v1.md).
- The coverage counting moved from `scripts/coverage-stats.mjs` into
  `packages/collect/src/coverage.mjs` so the script and the MCP server report the same numbers.
- `package.json` declares `mcpName: io.github.ciceroyang/agentgate` and `server.json` describes the
  same server for the official MCP Registry, which checks that the npm package and its metadata
  agree.

## [0.2.3] - 2026-09-18

- The publish workflow uses `actions/setup-node@v7` and removes the generated `.npmrc` before
  publishing. v4 exported a placeholder `NODE_AUTH_TOKEN`; npm 11 preferred that placeholder over the
  OIDC trusted-publishing exchange, and the registry answered `404 Not Found - PUT`. No runtime
  change. 0.2.1 and 0.2.2 were GitHub releases only — npm never received either — so this release
  also carries their changes.

## [0.2.2] - 2026-09-18

- The publish workflow clears `NODE_AUTH_TOKEN` for the publish step. `actions/setup-node` writes an
  `_authToken` line into `.npmrc` and exports a placeholder token when `registry-url` is set; npm 11
  preferred that placeholder over the OIDC trusted-publishing flow, and the registry answered
  `404 Not Found - PUT`. No runtime change. 0.2.1 was a GitHub release only — npm never received it,
  so this release also carries 0.2.1's changes.

## [0.2.1] - 2026-09-18

- The Action declares `name: Zhiliang agentgate`. GitHub Marketplace reserves the plain `agentgate`
  name — it collides with an existing account — so the Action could not be published under it.
  `uses: ciceroyang/agentgate@v0.2.1` is unchanged, and no behaviour changed.
- Every index record now carries a `scanExecution` block: which scanners were required, which
  completed, and whether their output was present, readable and self-consistent. A record with a
  failed or unmeasured required component can no longer be `clean`, whatever its findings say.
  Spec: [docs/spec/scan-execution-v1.md](docs/spec/scan-execution-v1.md). The field names inside
  `scanner_execution` follow the shape discussed in
  [modelcontextprotocol/registry#1404](https://github.com/modelcontextprotocol/registry/pull/1404)
  so the two records can be compared field by field.
- The record is surfaced where it is read: SARIF carries `invocations[].executionSuccessful` and one
  tool notification per failed component, `/v1/index/summary` reports coverage counts and reasons,
  `/v1/servers` rows carry the one-word state, and `required.scanners` lets a policy name the
  scanners it insists on.
- The index diff gained a `coverage changed` category: a record that stopped being fully measured
  (or started being) is reported on its own, because no version change explains it.
- `scripts/coverage-stats.mjs` turns an index into the coverage distribution — how many records are
  fully measured, what stopped the rest, and how many findings came out of the work that ran. It
  exits non-zero when a record claims a verdict its own coverage block cannot support, and it is the
  source of the numbers in
  [the coverage article](docs/articles/2026-09-how-much-of-the-mcp-ecosystem-is-auditable.md)
  ([中文](docs/articles/2026-09-how-much-of-the-mcp-ecosystem-is-auditable.zh-CN.md)).
- The inventory report now shows, per tool, which scanners actually ran: the coverage state, the
  required/completed/failed counts and one row per scanner. A record whose own coverage block says a
  required scanner did not finish can no longer reach `matched`, however complete the rest of its
  evidence looks, and a coverage block whose counts disagree with its own components is treated the
  same way. Spec: [docs/spec/inventory-v1.md](docs/spec/inventory-v1.md).

## [0.2.0] - 2026-09-17

- The README (English and Chinese) was rewritten in a plainer voice. No behaviour changed.
- `discover`, `audit`, `watch` and `framework` are in this release; see 0.1.2 below for what they do.
- Productionization P0–P6: /metrics and an optional access log, the health check with mail
  alerts, zero-dependency enforcement with our own SBOM, request limits, backup with a restore
  drill, the release check, and the public security and privacy pages.

  **Use 0.2.0 or later.** The provenance attestations of 0.1.0–0.1.2 name commits that are no
  longer on any branch or tag in this repository, so those versions cannot be checked the way
  this one can.

## [0.1.2] - 2026-09-17

- `agentgate discover`: reads the MCP configuration already on a machine (`.cursor/mcp.json`,
  `claude_desktop_config.json`, a repo's `.mcp.json`, Claude Code's per-project entries) and
  prints one line per server in the format `inventory --input` accepts. It never prints an env
  value, a header or an argument, and a config it cannot parse is listed and turns the exit code
  into 2 rather than being skipped.
- `agentgate audit`: the same scan per directory, one verdict for the set. Any incomplete
  directory makes the whole audit incomplete, and a directory that does not exist is an unmeasured
  repository rather than a skipped one.
- `agentgate watch`: an append-only, hash-chained archive of a tool list, with a diff against the
  previous capture and an optional push to a chat webhook. Nothing is sent anywhere without
  `--webhook`.
- `agentgate framework` and `inventory --framework aicaiq`: which AI-CAIQ v1.1.0 items we can
  supply evidence for, which are the customer's own, and which only an independent assessor can
  sign. It does not reproduce the official questionnaire text.
- Productionization (P0-P6 in docs/operations/productionization.md): observability and alerting,
  supply-chain self-checks with our own SBOM, service hardening, backup with a restore drill,
  release engineering, customer-facing compliance pages, and operations runbooks.

## [0.1.1] - 2026-09-17

- Published by CI with provenance and an SBOM; the tag is the release.
- `agentgate version` reads the version from package.json instead of keeping a second copy,
  which had already drifted once.
- Adoption checks made stricter: an artifact with an unmeasured part is `incomplete`, never
  `clean`.
- `discover`, `audit`, `watch` and the AI-CAIQ mapping (`framework`) arrive after this release.

## [0.1.0] - 2026-09-17

- First public release, published by hand because Trusted Publishing cannot bootstrap a package
  that does not exist yet.
- Inventory, evidence index, policy evaluation with SARIF, the gateway proxy, and the capture
  ledger with a verifiable hash chain.
