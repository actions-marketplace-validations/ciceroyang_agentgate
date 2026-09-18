# Roadmap

*What "an initial working product" means here, so it can be checked rather than felt.*

A product is not a pile of working scripts. The line below is drawn at the point where a
company that has never heard of this can clone it, start it, point it at their own
repository, get a decision with reasons, and see that decision enforced. Everything past
that point is enterprise surface, and it is not in the month.

Every milestone has an acceptance command. A milestone without a passing acceptance
command is not done, however much of it works.

## M1 - Deployment: one command, one system   **done**

*Status: accepted. `node scripts/acceptance.mjs` runs in CI and is green. The Docker
image build is the one part not verified here, because the machine this was written on
has no Docker; the container runs the same command that was verified directly.*

`docker compose up` starts the collector, the index builder and an HTTP service.

```sh
docker compose up
curl -s localhost:8080/v1/servers/<name> | jq .verdict
```

- endpoints: one record, index summary, a badge endpoint for a README
- storage: a single directory, no external database
- acceptance: fresh clone, one command, a record for a known server within ten minutes
- not included: authentication, multiple users, a UI

## M2 - Policy as configuration   **done**

*Status: accepted. `node scripts/acceptance-m2.mjs` runs in CI and is green: a forbidden
rule fails, a compliant repository passes, and required-but-unmeasured evidence exits 2 at
every threshold. The format is specified in `docs/spec/policy-v1.md`.*

A company writes down what it refuses, and the tool evaluates it against evidence.

```sh
agentgate check --policy policy.json --root .
```

- the policy file declares required, forbidden and pinned conditions
- the check reports findings, what it checked and what it could not
- exit codes: 0 pass, 1 a finding at the threshold, 2 something could not be checked
- acceptance: a repository with a forbidden server fails; the same repository with a
  pinned, allowed server passes; an artefact whose manifest is unmeasured exits 2, not 0

## M3 - Enforcement where the work happens   **done**

*Status: accepted. `node scripts/acceptance-m3.mjs` runs in CI and is green: findings and
unmeasured evidence both reach SARIF, unmeasured as an error; the CLI writes the same
SARIF; and the index diff names the changes a version move would not explain. The action
and the example workflow are YAML-validated in CI, which is now a step of its own.*

A pull request that adds a forbidden tool does not merge.

- a GitHub Action runs the policy check and uploads SARIF
- a summary comment names the rule, the file and the reason
- acceptance: on this repository, a deliberately bad pull request fails the check with a
  message that says why, and a clean one passes

## M4 - Runtime gateway (minimum viable)   **done**

*Status: accepted. `node scripts/acceptance-m4.mjs` runs in CI and is green: a real server
process is started through the gateway, an allowed call is served, a forbidden call is
refused with a reason and never reaches the server, the forbidden tool is absent from the
advertised list, and all three decisions are in the log.*

The same policy applies to what has already shipped.

- a local proxy in front of MCP servers that evaluates each tool call against the policy
- refusals carry a reason; everything, allowed or refused, is appended to a log
- acceptance: a call to a forbidden tool is refused and logged; an allowed call passes and
  is logged; the log is what the audit export reads

**M1 through M4 is the initial working product.**

## After the month, and deliberately not in it

- SSO, RBAC, multi-tenancy
- retention policy, audit export, SIEM and ticketing integrations
- a web dashboard
- a hosted offering, billing, support commitments
- deployment charts beyond a single compose file

## What can move the date, and none of it is code

- **A host.** A demo that anyone can open needs a machine and a domain, and those need an
  account rather than a commit.
- **Design partners.** Two or three companies running this on real repositories. Without
  them the acceptance tests are still mine, and mine are the ones most likely to be wrong.
- **Protocol surface.** MCP transports vary, and the gateway has to cover the ones real
  deployments use rather than the one that is convenient to test.

## What 1.0 means, and it is not a date

*Proposed 2026-09-18. Written down because "how far from 1.0" cannot be answered while 1.0 means
"more features".*

1.0 is not a feature count. It is the point where somebody else can put production on this and
say so. Five gates, each one checkable:

| Gate | What has to be true | Today | Distance |
| --- | --- | --- | --- |
| 1. We can show our own work | Zero runtime dependencies, our own SBOM, provenance on every published version, one gate command that runs the acceptances, a rollback path and a restore drill that has actually been run | Passed for the most part: `scripts/verify.sh` prints ALL CHECKS PASSED, the release carries `agentgate.cdx.json`, every version since 0.1.1 has SLSA provenance, and `rollback.md` plus `restore-drill.mjs` exist | **Closed 2026-09-18**: [SECURITY.md](../SECURITY.md), the support window in [compatibility.md](spec/compatibility.md), and private vulnerability reporting switched on |
| 2. The formats are frozen | Every format we ask someone to write down or hand over is versioned, with a deprecation policy and an upgrade path across at least one breaking change | Five specs are named `v1` (`policy`, `inventory`, `scan-execution`, `mcp-server`, `evidence-pack`) and none carries a compatibility promise; no upgrade guide; no supported-versions policy | **Closed 2026-09-18**: every spec declares `frozen` or `provisional`, and [compatibility.md](spec/compatibility.md) plus [upgrade.md](operations/upgrade.md) are held to the code and to the CHANGELOG by [the governance test](../test/governance.test.mjs) |
| 3. Somebody else can run it | The container build is verified rather than asserted, there is a deployment path past one compose file, and the enterprise surface (retention, audit export, SIEM, SSO/RBAC, multi-tenancy) exists for the buyers who require it | The README says it plainly: the Docker image build is unverified, and SSO/SAML, RBAC, multi-tenancy and signed audit export are not implemented | Weeks to months, and only worth starting once gate 4 says which of them a real buyer asks for |
| 4. Somebody else depends on it | One external team runs it in their own CI for a month, with a non-zero exit code wired to a merge | Zero teams. The pilot document says it out loud: the tool is young and only its author uses it | Not ours to schedule. This is the real distance |
| 5. We can stand behind it | A price a customer has actually paid, a support window, billing, and SLA wording | The Team and Enterprise prices are unvalidated hypotheses | Moves with gate 4 |

Gates 1 and 2 were closed on 2026-09-18. Neither was a feature: gate 1 was writing down the
support window and how to report a vulnerability, gate 2 was promising what a version identifier
means and writing the upgrade path for each release. **Gates 3 and 5 are guesses until gate 4
answers them** — which is why building SSO and multi-tenancy now would be building for a buyer
nobody has met.

So the useful form of "how far from 1.0" is: one pilot team, one month, one non-zero exit code in
their CI. Everything in the 0.3 line exists to make that happen. The version number follows it,
not the other way round.

## The rule that does not change

No milestone is accepted on the strength of "it works on my machine". Each one states the
command that proves it, and that command is what gets run.
