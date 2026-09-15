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

## Reading

[Clean is a claim about work that was done](docs/articles/2026-09-clean-is-a-claim.md) — five failures, four of them mine, and what the tool does about them. The short version: ask a scanner what it did not do.

## Look at it without installing anything

<https://ciceroyang.github.io/agentgate/> — the evidence index as one browsable page,
rebuilt daily from the live registry. Records are embedded, filtering is local, and there
is nothing to sign up for.

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

Or with docker, which runs the same command in a container:

```sh
docker compose up                            # the service on :8080
docker compose --profile collect run --rm refresh   # rebuild data/index.json
```

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
npm test                              # 98 tests across the three packages
node packages/guard/scripts/regression.mjs   # benign must stay silent, positives must fire
```

## Layout

```
packages/guard     the scanner: engine, eight checks, CLI, corpus, GitHub Action
packages/collect   census, package and repository scanning, the evidence index
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

## Operating this

- [docs/operations/what-i-need.md](docs/operations/what-i-need.md) — what has to be provided before it can be deployed, and what to hand over safely.
- [docs/operations/deployment-runbook.md](docs/operations/deployment-runbook.md) — aliyun plus the 智量.com domain, with the ICP filing caveat called out.
- [docs/operations/trademark-filing.md](docs/operations/trademark-filing.md) — the filing sheet, ready except for the applicant details.
- [docs/operations/outreach-templates.md](docs/operations/outreach-templates.md) — how the first three design partners are approached.
- [docs/operations/plan-b-no-icp.md](docs/operations/plan-b-no-icp.md) — what to do when a mainland server has no ICP filing, which is the one thing that can stop a deployment halfway.
- [deploy/](deploy/) — the Caddyfile and a systemd unit, ready to copy to a server.
- [docs/product/decisions-2026-09.md](docs/product/decisions-2026-09.md) — the four decisions, with numbers: npm, trademark, design partners, pricing.
- [site/index.html](site/index.html) and [site/pricing.html](site/pricing.html) — the landing and pricing pages, self-contained, no external assets.
- [scripts/onboard-server.sh](scripts/onboard-server.sh) — the deployment steps as a script that prints what it would do and only acts with `--apply`.
- [scripts/smoke.mjs](scripts/smoke.mjs) — the post-deployment check: reachable, index present, index recent, records real rather than the sample.

## Status, honestly

This is an open-source core in pieces, not yet a product. There is no runtime gateway,
no SSO or multi-tenancy, and no deployment story. What works is the evidence half: the
collection pipelines run on a schedule, the index derives its verdicts instead of
asserting them, and the scanner has 98 tests including the one that says a crashed check
can never produce `clean`.

## Licence

AGPL-3.0. A commercial licence is available for use the AGPL does not permit. See
[docs/product/b2b.md](docs/product/b2b.md).
