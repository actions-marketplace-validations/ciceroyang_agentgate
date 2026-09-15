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

## Status, honestly

This is an open-source core in pieces, not yet a product. There is no runtime gateway,
no SSO or multi-tenancy, and no deployment story. What works is the evidence half: the
collection pipelines run on a schedule, the index derives its verdicts instead of
asserting them, and the scanner has 98 tests including the one that says a crashed check
can never produce `clean`.

## Licence

AGPL-3.0. A commercial licence is available for use the AGPL does not permit. See
[docs/product/b2b.md](docs/product/b2b.md).
