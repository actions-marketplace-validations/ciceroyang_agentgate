# Changelog

All notable changes to this package. The version here is the version that shipped; the tarball and
the tag agree with it, and `scripts/release-check.mjs` refuses a release whose section is missing.

## [Unreleased]

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
