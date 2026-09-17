**English** · [中文](README.zh-CN.md)

# agentgate

**A control plane for the tools agents run.** Inventory what exists, state the evidence
behind it, decide what is allowed, and enforce that decision in CI and at runtime.

The reason it exists is one rule, and everything here follows from it:

> A verdict of `clean` is only emitted when every check ran. Anything that could not be
> measured is `unmeasured`, and an artefact with an unmeasured part is `incomplete`,
> never `clean`.

A security tool's worst failure is a green build for work nobody did. This project is
built so that cannot happen.

## The four parts

| part | what it does | package |
| --- | --- | --- |
| **inventory** | enumerate the registry, resolve packages, fetch repositories | `packages/collect` |
| **evidence** | join it into one record per server, with the bytes behind every claim | `packages/collect` |
| **policy** | scan configs, hooks, manifests and source for what a company would refuse | `packages/guard` |
| **verification** | check a claim against something outside the claim | `packages/verify` |

## Starting the deployment

Deployment instructions are in
[docs/operations/deployment-runbook.md](docs/operations/deployment-runbook.md).
[docs/verification.md](docs/verification.md) records the first deployment on 2026-09-16,
along with what was checked and what remains unverified.

## Reading

[Clean is a claim about work that was done](docs/articles/2026-09-clean-is-a-claim.md) — five failures, four of them mine, and what the tool does about them. The short version: ask a scanner what it did not do.

## Look at it without installing anything

The service is running at <https://app.xn--5kvo87g.com/> — the landing page, the pricing page,
the browseable evidence index (rebuilt daily) and the API under the same host. The personal site
that was already on that machine is untouched.

<https://ciceroyang.github.io/agentgate/> — the landing page. The evidence index is one
browsable page at <https://ciceroyang.github.io/agentgate/evidence.html>, rebuilt daily from
the live registry: records are embedded, filtering is local, and there is nothing to sign up for.
Pricing is at [/pricing.html](https://ciceroyang.github.io/agentgate/pricing.html), and
[/try.html](https://ciceroyang.github.io/agentgate/try.html) walks through using it in ten minutes.

## Quickstart

Node 20 or newer, no dependencies. A repository clone already carries a sample index,
so the service answers immediately; `refresh` replaces it with a current one.

```sh
node bin/agentgate.mjs serve
# agentgate serving http://127.0.0.1:8080

curl -s localhost:8080/health
curl -s localhost:8080/v1/index/summary
curl -s localhost:8080/v1/servers/<name>
curl -s localhost:8080/badge/<name>.svg
```

It is published on npm as `@zhiliangtech/agentgate`. Releases go out from CI when a `v*` tag is
pushed, with provenance — [docs/operations/publish-checklist.md](docs/operations/publish-checklist.md)
is that setup and the record of what was verified.

```sh
npx @zhiliangtech/agentgate check --root .
npx @zhiliangtech/agentgate serve
```

`npx` resolves the `latest` dist-tag; pin a version (`@zhiliangtech/agentgate@0.1.1`) when you need
an exact one.

With no policy file present `check` uses a built-in default that refuses nothing extra, and
`serve` answers from the snapshot the package was published with. `refresh` always writes to
`./data` beside you, never inside the installed package.

Or with docker, which runs the same command in a container:

```sh
docker compose up                            # the service on :8080
docker compose --profile collect run --rm refresh   # rebuild data/index.json and seed the first snapshot
```

## My tool inventory

Start `node bin/agentgate.mjs serve` and open `/inventory.html` on the printed local
address. Paste a tool-name list or choose a text/JSON file, resolve ambiguous matches,
enter the version you actually use, and download a standalone HTML evidence report.
The page compares the list in browser memory against its embedded index snapshot:
it does not upload the list, store it, scan your machine, or execute tools.

For the same workflow without a browser:

```sh
node bin/agentgate.mjs inventory --input examples/inventory/tools.json --out my-tools.html
node bin/agentgate.mjs inventory --input tools.json --index data/index.json --format json
```

An input can be one name per line, a JSON array, or `{ "tools": [...] }`. Each object
accepts only `name`, `server`, `package`, `registry`, and `version`; complete client
configurations and credentials are deliberately not accepted. See the
[inventory input and report guide](docs/spec/inventory-v1.md).

Unmatched, ambiguous, missing-version, different-version, and incomplete-evidence
items stay in the report. A matching version is not proof of what is installed.
The committed sample is explicitly historical and cannot provide a confirmed match;
neither can old evidence without an exact content binding. Even a confirmed evidence
match is not a safety certification or a new scan. Review the checked scopes, findings,
snapshot date, and gaps before deciding what to use.

The command exits zero when it produces a report, **not** when all tools pass; malformed
input or unreadable data exits 2. `--out` refuses to overwrite an existing file.
Use `check`, not `inventory`, for policy enforcement in CI.

### Finding the list in the first place

Nobody has the list by hand. `discover` reads the MCP configuration files that are already
on the machine and prints one line per server, in the format `inventory --input` accepts:

```sh
node bin/agentgate.mjs discover --out tools.txt          # home directory + current directory
node bin/agentgate.mjs discover --roots ~/code/a,~/code/b --format json
```

It never prints an `env` value, a header or an argument, and a remote address is reduced to
its host: paths and query strings carry tokens. A file that exists but cannot be read or
parsed (including `.codex/config.toml`, which this version does not parse) is listed with a
reason and makes the command exit 2, because a list that is missing something is not
printed as a complete one.

### Several repositories at once

```sh
node bin/agentgate.mjs audit --roots ~/code/a,~/code/b,~/code/c --index data/index.json
```

The same scan per directory, one verdict for the set: if any directory is incomplete the
whole audit is incomplete, and a directory that does not exist is an unmeasured repository
rather than a skipped one.

### What changed since last time

```sh
node bin/agentgate.mjs watch --input tools.txt --index data/index.json --archive ./archive
node bin/agentgate.mjs watch --verify --archive ./archive
node bin/agentgate.mjs watch --input tools.txt --index data/index.json --archive ./archive \
  --webhook https://example.invalid/hook --webhook-format wecom
```

Each run appends one line to a chained archive (`prev` is the previous line's hash) and
stores what it saw under `snapshots/<sha256>.json`. `--verify` recomputes the chain and
every retained snapshot and exits 1 on a mismatch. Nothing is sent anywhere unless
`--webhook` names an address; the archive is written before the push, so a chat service
being down cannot lose a capture.

### Handing the answer to a questionnaire

```sh
node bin/agentgate.mjs framework                       # who answers which AI-CAIQ item
node bin/agentgate.mjs inventory --input tools.json --framework aicaiq --out report.html
```

The mapping says, per item, what we provide, where our coverage stops, and whether the
answer is ours, the customer's, or only an independent assessor's. It is a description of
evidence, not a compliance conclusion, and it does not reproduce the official text.

## Policy

A policy says what the company refuses. It is data, not code, and it is specified: see
[docs/spec/policy-v1.md](docs/spec/policy-v1.md).

```json
{
  "version": "agentgate.policy/v1",
  "threshold": "high",
  "required": { "pinnedPackages": true, "measuredEvidence": ["packageManifest"] },
  "forbidden": { "rules": ["AG-INSTALL-001"], "servers": ["internal/*"] }
}
```

```sh
node bin/agentgate.mjs check --policy agentgate.policy.json --root .
```

With no policy file and no `--policy`, the check still runs: it reports what the checks
found and says it is using the built-in default, which refuses nothing extra. Inventing
obligations on the user's behalf would make the result mean less, not more. A policy named
explicitly that cannot be read is still an error, because that is a typo.

The same evaluation can be handed to a person rather than a terminal:

```sh
node bin/agentgate.mjs check --policy agentgate.policy.json --root . --format html --out report.html
```

One static file, printable, no script. Anything that could not be measured gets its own
section above the findings, because a report that buries what it did not check reads as
more complete than it is. That file is the deliverable of the free checkup.

Three outcomes, and `incomplete` outranks `findings`: if a check failed to run, or an
evidence block the policy requires is `unmeasured`, the exit code is **2** however clean
the findings look. No threshold can turn a partial answer into a pass.

| exit | meaning |
| --- | --- |
| 0 | clean |
| 1 | findings |
| 2 | incomplete |

## Enforcement

A pull request that adds something the policy refuses does not merge, and the reason is in
the pull request rather than in a log nobody opens.

```yaml
- uses: ciceroyang/agentgate@main
  with:
    policy: agentgate.policy.json
```

See [examples/github-actions/policy.yml](examples/github-actions/policy.yml). The action
runs the check, writes SARIF for code scanning, comments the human report on the pull
request, and then exits with the check's own code, so an incomplete scan still fails the
build at 2.

## Runtime

The same policy applies to what has already shipped, by putting a gateway in front of the
server instead of pointing the client at it:

```sh
node bin/agentgate.mjs proxy --policy agentgate.policy.json --log calls.jsonl -- \
  npx -y @modelcontextprotocol/server-filesystem /data
```

A tool call the policy refuses is answered locally with a reason and never reaches the
server; a forbidden tool is removed from the advertised list so a client cannot ask for it
at all. Every decision, allowed or refused, is appended to the log, because the log is
what an audit reads.

## History

The index is kept, so two builds can be compared, and the interesting column is the last
one: changes that a release would have explained and did not.

```sh
node bin/agentgate.mjs diff --from previous-index.json --to data/index.json
```

```
  added:           0
  removed:         0
  verdict changed: 1
  package changed: 0
  silent (no version move, different evidence): 1
```

A new finding on an unchanged version is the shape of a package replaced without a
release, a repository edited in place, or a scan that has started seeing something. Nobody
can back-fill that record; it only exists if someone kept looking.

## The pipelines behind the index

```sh
node packages/collect/mcp-audit.mjs --max 6000 --out data/census.json
node packages/collect/scripts/guard-scan.mjs --census data/census.json --out data/guard-scan.json
node packages/collect/scripts/build-index.mjs --census data/census.json --guard data/guard-scan.json --out data/index.json
```

And the scanner on a local project:

```sh
node packages/guard/bin/agent-guard.mjs . --fail-on high
node packages/collect/bin/agent-add.mjs --index data/index.json <server-name>
```

## Test

```sh
npm test
node scripts/bench.mjs 50000 200      # lookups must stay under 10 ms p50
node scripts/measure-verify.mjs       # claim extraction, against a small labelled set
```

```sh
npm test                              # the whole suite; it prints how many ran
node packages/guard/scripts/regression.mjs   # benign must stay silent, positives must fire
```

## Layout

```
packages/guard     the scanner: engine, eight checks, CLI, corpus, GitHub Action
packages/collect   census, package and repository scanning, the evidence index
packages/policy    policy evaluation and human-readable reports
packages/gateway   runtime policy enforcement for MCP servers over stdio
packages/history   index snapshots and change comparisons
packages/service   the read-only evidence API
packages/verify    cross-model claim checking
docs/              architecture and product notes
```

## Verification

Beyond the tests, which are written by the same party as the code,
[docs/verification.md](docs/verification.md) records the checks against things nobody here
wrote: a real MCP server through the gateway, and the list of what is still unverified.

```sh
node scripts/verify-real-server.mjs
```

To check whether the index's `high` and `critical` findings still match recorded human
reviews, run `node scripts/review-criticals.mjs` (the command keeps its original name).
Each review must bind the finding's identity and evidence to an exact package version
and complete scanned-content provenance, including its SHA-256 digest and scope.
Missing or changed bindings require another human review. Legacy approval records are
not automatically upgraded. `--accept` records a completed human review and refuses
incomplete provenance; it does not perform the review or certify third-party code.

## Operating this

- [docs/operations/what-i-need.md](docs/operations/what-i-need.md) — what has to be provided before it can be deployed, and what to hand over safely.
- [docs/operations/deployment-runbook.md](docs/operations/deployment-runbook.md) — aliyun plus the 智量.com domain, with the ICP filing caveat called out.
- [docs/operations/trademark-filing.md](docs/operations/trademark-filing.md) — the filing sheet, ready except for the applicant details.
- [docs/operations/outreach-templates.md](docs/operations/outreach-templates.md) — how the first three design partners are approached.
- [docs/operations/plan-b-no-icp.md](docs/operations/plan-b-no-icp.md) — what to do when a mainland server has no ICP filing, which is the one thing that can stop a deployment halfway.
- [deploy/](deploy/) — the Caddyfile and a systemd unit, ready to copy to a server.
- [docs/product/decisions-2026-09.md](docs/product/decisions-2026-09.md) — the four decisions, with numbers: npm, trademark, design partners, pricing.
- [docs/operations/pilot-package.md](docs/operations/pilot-package.md) — the one-pager to send a prospective design partner: deliverables, timeline, what we ask for, and what we refuse to ask for.
- [site/index.html](site/index.html) and [site/pricing.html](site/pricing.html) — the landing and pricing pages, self-contained, no external assets.
- [scripts/onboard-server.sh](scripts/onboard-server.sh) — the deployment steps as a script that prints what it would do and only acts with `--apply`.
- [scripts/smoke.mjs](scripts/smoke.mjs) — the post-deployment check: reachable, index present, index recent, records real rather than the sample.

## Status, honestly

This is an early open-source core. It includes collection, an evidence index, scanning,
policy checks in CI, a runtime gateway for MCP servers over stdio, historical diffs and
a read-only service. Deployment scripts and a runbook exist; the first server deployment
and its checks are recorded in [docs/verification.md](docs/verification.md). That record
does not establish the current health of the hosted service, and the Docker image build
remains unverified there.

The enterprise capabilities described in the pricing proposal — SSO/SAML, RBAC,
multi-tenancy and signed audit export — are not implemented. Team and Enterprise prices
are hypotheses that have not been validated with customers; the free pilot is intended
to test that demand. See [the product decisions](docs/product/decisions-2026-09.md) and
[the pilot scope](docs/operations/pilot-package.md).

The scanner's suite includes the invariant that a crashed check can never produce
`clean`. Run `npm test` for the current results; this page does not repeat a test count.

## Licence

AGPL-3.0-only. A commercial licence is available for the case the AGPL does not permit:
offering a modified agentgate as a closed service without publishing your changes. See
[docs/product/licensing.md](docs/product/licensing.md).
