# agentgate.policy/v1

A policy file says what a company refuses. It is data, not code: there is no expression
language, no loops and no regular expressions, so a policy can be reviewed by someone who
does not read JSON for a living.

```json
{
  "version": "agentgate.policy/v1",
  "threshold": "high",
  "required": {
    "pinnedPackages": true,
    "measuredEvidence": ["packageManifest"]
  },
  "forbidden": {
    "rules": ["AG-INSTALL-001"],
    "severities": ["critical"],
    "servers": ["internal/*", "acme/legacy-thing"],
    "tools": ["delete_*", "send_money"]
  }
}
```

## Fields

| field | meaning |
| --- | --- |
| `version` | the format version. Defaults to `agentgate.policy/v1`. |
| `threshold` | the severity at which a *local scan* finding fails the check. One of `critical`, `high`, `medium`, `low`, `info`. Defaults to `high`. |
| `required.pinnedPackages` | every declared package must carry a version. |
| `required.measuredEvidence` | evidence blocks that must not be `unmeasured`: `registryDocument`, `packageManifest`, `repository`. |
| `forbidden.rules` | rule identifiers that fail the check regardless of severity. |
| `forbidden.severities` | severities that fail the check regardless of the threshold. |
| `forbidden.servers` | server-name patterns, exact or with a single `*`. |
| `forbidden.tools` | tool-name patterns, exact or with a single `*`. Applied by the runtime gateway: a matching call is refused before the server sees it, and a matching tool is removed from the advertised list. |

## The evaluation rule

The result is one of three values and there is no fourth:

- **`incomplete`** if any check failed to run, or any required evidence is unmeasured.
- **`findings`** if the scan or the index produced something the policy refuses.
- **`clean`** only when checks ran, required evidence was measured, and nothing was refused.

`incomplete` outranks `findings`. An artefact nobody could measure is not thereby
approved, and no threshold can turn a partial answer into a pass.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | clean |
| 1 | findings |
| 2 | incomplete |

## Versioning

The `version` field is checked. A future format adds fields rather than changing the
meaning of these, and an unrecognised `threshold` is an error rather than a default, so a
policy can never quietly become more permissive than it reads.
