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

Node 20 or newer. No dependencies.

```sh
# 1. enumerate the registry and audit the packages it declares
node packages/collect/mcp-audit.mjs --max 6000 --out census.json --markdown census.md

# 2. run the scanner over the packages the census resolved
node packages/collect/scripts/guard-scan.mjs --census census.json --out guard-scan.json

# 3. join the evidence into the index
node packages/collect/scripts/build-index.mjs --census census.json --guard guard-scan.json --out index.json

# 4. scan a local project
node packages/guard/bin/agent-guard.mjs . --fail-on high

# 5. ask what adding a server would mean, before adding it
node packages/collect/bin/agent-add.mjs --index index.json <server-name>
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
