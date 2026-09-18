# Compatibility and deprecation policy

*What a version identifier promises, what we are allowed to change inside one, and how a change
gets communicated. Written 2026-09-18 as part of the 1.0 gate “the formats are frozen”.*

A format is frozen when a file you wrote two releases ago still means the same thing today, and
you can tell from this page what will happen to it next. That is the whole promise. It is
deliberately about the artefacts we ask you to write down or hand over, not about the CLI text.

## The formats

| Artefact | Version identifier | Written down in | Stability |
| --- | --- | --- | --- |
| Policy file | `agentgate.policy/v1` | [policy-v1.md](policy-v1.md) | frozen |
| Scan execution record | `agentgate.scan-execution/v1` | [scan-execution-v1.md](scan-execution-v1.md) | frozen |
| Inventory input and report | report field `schemaVersion: 1` | [inventory-v1.md](inventory-v1.md) | frozen |
| MCP server surface | MCP protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05` | [mcp-server-v1.md](mcp-server-v1.md) | frozen |
| Evidence pack | `agentgate.evidence-pack/v1` | [evidence-pack-v1.md](evidence-pack-v1.md) | provisional |

**frozen** means a change needs a new identifier and a migration note. **provisional** means the
shape is published and usable, but it will be reviewed after the first external pilot and a
breaking change there needs only a CHANGELOG entry under `Breaking` plus an entry in
[the upgrade guide](../operations/upgrade.md). The evidence pack is provisional because nobody
outside this repository has handed one to a reviewer yet, and pretending otherwise would be a
claim we cannot support.

The capture ledger, the watch archive and the backup manifest carry their own integer versions
and have no spec yet. They are internal: they may change in a minor release, and anything that
reads them should report an unknown version as unmeasured rather than guess.

## What may change inside a version

1. **Additive only.** A new optional field, a new finding rule, a new evidence class. A reader
   that does not know a field must ignore it.
2. **An unknown value is unmeasured, never clean.** This is the oldest invariant in the project
   and it is also the compatibility rule: a consumer of our records must treat a severity, a
   status or a schema version it does not recognise as “not measured”, and the whole result as
   incomplete. A record we add a value to can therefore never silently upgrade to a pass.
3. **No renames inside a version.** Renaming a field, changing its type, or changing what an
   existing value means are breaking changes, however small they look.

## How a breaking change is made

1. A new version identifier (`/v2`), with the new spec written down before the code ships.
2. The old identifier keeps being **read** for at least one minor release, and the tool says on
   stderr which one it read. Writing switches to the new identifier immediately; the two are never
   silently mixed.
3. An entry under `Breaking` in the CHANGELOG, and a section in
   [the upgrade guide](../operations/upgrade.md) saying who is affected and what to run.

## Deprecation

A `Deprecated` heading in the CHANGELOG, at least one minor release before removal, naming what
replaces it. During that window the deprecated form keeps working and warns on stderr. Removal is
itself a breaking change and follows the section above.

## Product version numbers

| Bump | What it may contain |
| --- | --- |
| patch | fixes, wording, documentation; no format or CLI behaviour change |
| minor | new capability; **while the project is 0.x this may include a breaking change**, always with a `Breaking` heading and an upgrade note |
| major | breaking changes only. Available at 1.0 and after; the 0.x licence to break inside a minor ends there |

## Supported versions

This is the support window referred to by [SECURITY.md](../../SECURITY.md):

- the version on the npm `latest` tag, and
- the minor line before it, for **90 days** after a new minor takes `latest`.

Security fixes go to the newest supported line first, and are backported only when the fix is for
a vulnerability. `next` is a preview: it is where a release is tested, it carries no promise, and
it may be deleted or replaced. Versions deprecated on npm (0.1.0–0.1.2, whose provenance names
commits that no longer exist in this repository) are out of the window entirely.

With one maintainer this is a statement of intent, not an SLA. It is written down so that the
answer to “is this still supported” does not depend on who is asked.

## What this policy does not cover

- **CLI flags and printed text.** Adding a flag is additive; changing what an existing flag does
  is a minor-release change with a CHANGELOG entry, not a breaking format change.
- **The public index JSON** beyond the fields a spec names, and the per-server pages built from it.
- **The hosted demo.** Its endpoints may move; the formats above do not depend on it.

