# agent-guard

A scanner that cannot report clean about work it did not do.

> The longer story — why this exists, the fail-open bug that prompted it, and the measurements behind the rules — is in [A scanner said "clean" while four of its scanners were dead](https://github.com/ciceroyang/mcp-supply-audit/blob/main/docs/articles/2026-09-scanner-that-said-clean.md).

## The one thing it guarantees

Every scan ends in one of three verdicts: **clean**, **findings**, or **incomplete**. `clean` is emitted only when every check ran to completion. If a check throws, the verdict is `incomplete`, the failure is printed and reaches SARIF as its own error-level result, and the exit code is **2 — at every `--fail-on` level**. Lowering the threshold cannot turn a partial scan into a pass; only an explicit `--allow-incomplete` can, and it still reports `incomplete`.

That invariant is the product. The worst failure mode of a security gate is a green build when the gate did not run, and it is a real one: a scanner crash at INFO severity, below the default reporting floor and below every `--fail-on` value, produced a summary of `info:4 / reported:0`, a score of `100 A`, zero SARIF results and an exit code of 0 (reported upstream as `sattyamjjain/agent-audit-kit#743`). agent-guard is built so that shape of bug cannot exist.

## Verdicts and exit codes

| verdict | when | exit code |
| --- | --- | --- |
| `clean` | every check ran, nothing found | 0 |
| `findings` | a finding at or above `--fail-on` | 1 |
| `incomplete` | at least one check failed to run | 2 |

`0` clean, `1` gated finding, `2` incomplete, `3` bad usage.

## Checks

| check | rules | what it looks at |
| --- | --- | --- |
| `mcp-config` | AG-MCP-001 … 015 | MCP client configs: unpinned `npx`/`uvx`, relative command paths, shell metacharacters, plain `http`, filesystem roots handed to a server, literal credentials in `env` |
| `install-hooks` | AG-INSTALL-001 | `preinstall`/`install`/`postinstall`/`prepare` scripts that fetch-and-exec, decode base64, or run inline code that can fetch, spawn or rewrite files. The inline program is read rather than inferred from its shape, so a print-only install banner is not a finding |
| `content-injection` | AG-INJECT-EN-01…04, ZH-01…03, MIX-01 | instruction-override phrasing in markdown and text |
| `transport` | AG-TRANSPORT-001 … 004 | plain `http` endpoints, remote servers with no authentication, disabled TLS verification, `0.0.0.0` binds |
| `supply-chain` | AG-SUPPLY-001 … 003 | dependencies resolved from a mutable source (git/http/file), versions floating on `*` or `latest`, dependencies with no committed lockfile. A dev or peer dependency is reported at a lower severity than a runtime one, because it never reaches a consumer of the package |
| `tool-description` | AG-TOOL-001, 002 | instruction-override text or invisible unicode in a tool name or description, whether the tools sit at the top level or inside a server entry (`server.json`, `*.tools.json`, `*.mcp.json`) |
| `agent-settings` | AG-HOOK-001, AG-SETTINGS-001…003 | agent settings hooks that reach the network or read credentials, `enableAllProjectMcpServers`, blanket `permissions.allow` rules, model traffic redirected through an env base URL |
| `a2a` | AG-A2A-001 … 006 | A2A agent cards: plain http, disabled signature verification, the `none` algorithm, over-long token lifetimes, internal capabilities exposed as skills, skills without an `inputSchema` |

The injection check carries Chinese patterns and the code-switched form (`Ignore 以上所有 instructions`). Single-language rule sets miss that one, and it is what a bilingual attacker actually writes.

## Measured on real configs

Run over 37 `.mcp.json` files taken from 37 distinct public repositories, **12 produce no findings at all**. The most frequent rules are `AG-MCP-010` (unpinned runner, 11), `AG-TRANSPORT-002` (remote endpoint with no authentication, 9) and `AG-TRANSPORT-001` (plain http, 5).

No rule fires on every config, which is the property that matters for triage: a rule that always fires separates nothing. An earlier version of `AG-MCP-015` did exactly that — it flagged placeholder values such as `GITHUB_PERSONAL_ACCESS_TOKEN` and `${MY_KEY}` as literal credentials. It now requires a value that is neither a reference nor a placeholder, and the false positives went to zero.

A config that exists but cannot be parsed is recorded under `coverage.unparsedFiles` instead of being reported as a security finding: it is a hole in what was assessed, and calling it a finding would overstate what the scan knows.

## Measured against someone else's labels

AgentAuditKit publishes 13 vulnerable-config examples. Run in isolated copies with the label file removed, agent-guard reports findings on **10 of 13**. The three it stays silent on are one Python taint-analysis case and two legal-compliance documents — shapes a config scanner does not read.

That is a coverage statement, not a quality claim: it says which files and structures the tool actually reaches. It is also how the tool grew — the first run caught 6, and the missing pieces showed up as silence rather than as guesses: `.claude/settings.json` was not read at all, and tool descriptions nested inside a server entry were skipped because only a top-level `tools` array was checked.

## Regression

```sh
npm run regression
```

Two numbers on every commit, both committed as data rather than described in prose:

- `corpus/benign/**` — six realistic projects (a pinned local server, a secured remote endpoint, a minimal settings file, a conservative agent card, a locked package, clean docs). **Any finding here fails the run.**
- `corpus/positive/**` — ten projects that should fire, each with an `expect.json` naming the rules it must produce. A missing rule fails the run.

Both run in CI on every push. The outside corpus can be pointed at with `--external <dir>`, which prints recall without gating, since that corpus belongs to someone else and can move:

```sh
node scripts/regression.mjs --external /path/to/published/examples
```

## Use it in CI

As a GitHub Action, one step, no install:

```yaml
- uses: ciceroyang/agent-guard@main
  with:
    path: .
    fail-on: high
    sarif-file: agent-guard.sarif

- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: agent-guard.sarif
```

A copy-paste workflow lives at [`examples/github-actions/code-scanning.yml`](examples/github-actions/code-scanning.yml). The action calls `agent-guard` with `--format sarif` and returns its exit code unchanged, so an incomplete scan fails the step with exit 2 rather than passing it quietly. Pass `checks: mcp-config` to run a subset.

## Usage

```sh
node bin/agent-guard.mjs .                       # console
node bin/agent-guard.mjs . --format sarif -o out.sarif
node bin/agent-guard.mjs . --format json --fail-on high
node bin/agent-guard.mjs . --checks mcp-config
node bin/agent-guard.mjs . --exclude vendor,testdata --fail-on high
```

### Quoted text is reported, not ignored

An instruction-override phrase inside a fenced block or an inline code span is reported at **low** severity with a `(quoted: ...)` marker; the same phrase in ordinary prose keeps its full severity. Security write-ups, READMEs and skill files are full of examples, so suppressing them outright would be a blind spot, and treating them like live instruction text makes the tool unusable on any repository that documents the problem. The finding survives either way.

The same reasoning is why `--exclude` exists: a repository that ships intentional bad examples (this one does, under `corpus/`) can name the paths it does not want scanned. Excluding a path does not turn a crashed check into a pass.

Every report, including SARIF, carries a `coverage` block: which checks were requested, which ran, which failed and why, and which files were read. Coverage is reported, never assumed.

## What it is not

- Not a runtime monitor and not a sandbox. It reads files and says what it saw.
- No network access. Registry and package lookups are not part of this version.
- No auto-fix. A finding names the field and value it came from so it can be checked by hand.

## Test

```sh
node --test
```

Zero runtime dependencies.
