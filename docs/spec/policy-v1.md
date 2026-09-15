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

## Batches and unparseable input, at the gateway

JSON-RPC allows a batch, and a batch has no top-level `method`. The gateway inspects every
member of one: a batch that contains a forbidden `tools/call` is refused whole and nothing
from it reaches the server. A partial answer would have to be assembled from two speakers,
and a gateway that guesses at a protocol shape is how a policy gets walked around.

The same applies in the other direction: every member of a batch response goes through the
tool filter, so a forbidden tool cannot be advertised by answering a `tools/list` inside an
array.

A leading byte-order mark is removed before parsing. A line that still cannot be parsed is
forwarded unchanged, because the gateway cannot rewrite what it cannot read — but that path
is a known one, and it is why the mark is handled rather than left to chance.

## When there is no policy file

There is no such thing as a policy-less silence. If `--policy` is not given and
`agentgate.policy.json` does not exist next to the scanned root, the check proceeds under a
built-in default and prints that it is doing so. The default is:

```json
{ "version": "agentgate.policy/v1", "threshold": "medium",
  "required": { "pinnedPackages": false, "measuredEvidence": [] },
  "forbidden": { "rules": [], "severities": [], "servers": [], "tools": [] } }
```

It refuses nothing extra, because a tool that invents obligations on the user's behalf is
reporting on itself rather than on the code. The checks still report what they found; the
policy only adds what *you* refuse. If `--policy` names a file that cannot be read, that is
an error (exit 3) rather than a fallback, because a named file that does not load is a typo,
not a default.

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
