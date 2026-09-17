# Changelog

All notable changes to this package. The version here is the version that shipped; the tarball and
the tag agree with it, and `scripts/release-check.mjs` refuses a release whose section is missing.

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
