# Security policy

This project measures other people’s supply chains and asks to be measured the same way. So this
file is short and specific, and everything in it can be checked.

## Reporting a vulnerability

Email **contact@xn--5kvo87g.com** (punycode for `contact@智量.com`), or use GitHub’s private
vulnerability reporting on this repository. If you are not sure whether something is a
vulnerability, report it anyway; a wrong report costs us a reply, a missed one costs a user.

Please include what you ran, what you expected and what happened. A failing command with its
output is more useful than a description of a class of bug.

## What to expect

| When | What |
| --- | --- |
| Within 3 working days | We acknowledge the report and say whether we can reproduce it |
| Within 10 working days | We give an assessment: affected versions, severity, and whether a fix is coming |
| After that | A fix in a patch release, or a written explanation of why we are not changing the behaviour |

There is **no bug bounty**. There is one maintainer, and this is a statement of intent rather than
an SLA. If you want credit in the release notes, say so; if you want to stay anonymous, that is the
default.

## Supported versions

The support window is written down in [docs/spec/compatibility.md](docs/spec/compatibility.md):
the version on the `latest` npm tag, and the minor line before it for 90 days after a new minor
takes `latest`. `next` is a preview with no promise. Fixes go to the newest supported line first.

## In scope

- the CLI (`agentgate`), the read-only service, the MCP server, and the pack builder;
- the published formats: a policy file, an inventory list, a scan-execution record, an evidence
  pack, and anything this project signs or hashes;
- the hosted demo on <https://xn--5kvo87g.com/> and its endpoints.

## Out of scope

- **The servers this project measures.** A vulnerability in a third-party MCP server is that
  server’s to fix. What is ours is whether we reported it accurately: tell us if a record says
  `clean` for something that is not, or if a finding is wrong.
- Anything that requires a hostile environment we do not run, such as the CI runner that
  publishes the package. Report it to GitHub or npm instead.

## What we already do, and how you can check it

- **Zero runtime dependencies.** `scripts/check-zero-deps.mjs` walks every source file and fails
  if anything imports a package. There is no transitive tree to audit.
- **No network on the paths that read your machine.** `discover`, `inventory`, `check`, `pack` and
  `mcp` open no socket; a test preloads a module that throws on network use.
- **Credentials are never read or printed.** Only names, versions and structure are read from
  configuration; a remote address is cut down to its host.
- **Scanned code is never executed.** The scanners read files and metadata; they do not install or
  run what they measure.
- **A crash cannot become a pass.** `clean` is emitted only when every required check ran; anything
  unmeasured makes the result `incomplete` and the exit code 2. This is enforced by a test on the
  invariant, not by a convention.
- **Nothing is published without provenance.** Releases go out through CI with a SLSA provenance
  attestation and our own CycloneDX SBOM attached to the release.

## The honest part

This is a 0.x project with one maintainer and no security review by a third party. Nothing here
has been penetration tested, and the hosted demo is a demo. If you need a vendor who can sign
something today, this is not that vendor yet.

