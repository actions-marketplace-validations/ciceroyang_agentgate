# agentgate.scan-execution/v1

A verdict of `clean` is a claim about work that ran. This record travels with every index entry
and answers one question: **which scanners were required, which finished, and was their output
there, readable and self-consistent.**

It exists because of a specific failure: a scanner can crash, degrade the crash into a low-severity
finding, and still leave a report that reads as clean — a score of 100, an empty SARIF file, exit
code 0. The summary is then indistinguishable from "ran and found nothing". This record makes those
two states different values.

## Stability

**`agentgate.scan-execution/v1` · frozen.** Field names here are the contract, including the ones
borrowed from the shape discussed in `modelcontextprotocol/registry#1404`, because the point of the
record is that two of them can be compared field by field. A consumer that meets an unknown
`status`, `state` or `semantic_consistency` must treat it as unmeasured, never as complete — that
rule is what lets a value be added without silently upgrading a record to a pass. Rules:
[compatibility.md](compatibility.md).

## The shape

```json
{
  "schemaVersion": "agentgate.scan-execution/v1",
  "subject": { "server": "ai.example/thing", "packages": [{ "registry": "npm", "name": "@scope/thing", "version": "1.2.3" }] },
  "scanner_execution": {
    "components": [
      {
        "id": "registryDocument",
        "required": true,
        "status": "completed",
        "exit_code": null,
        "output_present": true,
        "output_parseable": true,
        "semantic_consistency": "ok",
        "findings": { "critical": 0, "high": 0, "medium": 1, "low": 0, "info": 2 },
        "reason": null
      }
    ],
    "required": 1,
    "completed": 1,
    "failed": 0,
    "state": "complete"
  },
  "digest": { "algorithm": "sha256", "scope": "published package contents", "value": "…", "matches": true },
  "generatedAt": "2026-09-17T00:00:00.000Z"
}
```

| field | meaning |
| --- | --- |
| `subject.server` | the registry entry this record is about. |
| `subject.packages` | the exact packages and versions the components above read. |
| `components[].required` | if true, the record cannot be complete without it. |
| `components[].status` | `completed`, `failed` or `skipped`. Anything unrecognised is treated as `failed`. |
| `components[].output_present` / `output_parseable` | the scanner's own output existed and could be read. |
| `components[].semantic_consistency` | `ok`, `mismatch` or `unverified`. A digest mismatch is `mismatch`. |
| `components[].findings` | counts by severity, so a reader can see what a completed component found without dereferencing the full evidence. |
| `components[].reason` | why a component is not complete, kept verbatim from the scanner. |
| `scanner_execution.state` | `complete` only when every required component is complete **and** no digest is recorded as not matching. |
| `digest.matches` | `false` means the bytes did not bind; that makes the record incomplete, never clean. |

## The three rules

1. **The completion set travels with the receipt.** A free-text scope cannot separate "ran and found
   nothing" from "never ran". The set of required components and their individual outcomes is the
   minimum that closes that gap.
2. **`incomplete` cannot coexist with `clean`.** If any required component failed, is missing, has
   no parseable output, or reports a mismatch, the state is `incomplete` and the entry's verdict is
   `incomplete` regardless of what the findings say. No threshold can turn a partial answer into a
   pass.
3. **A mismatch is unverified, not clean.** When the digest does not bind to the bytes that were
   read, the honest output is "we could not check this", which is a different value from "no
   problems found".

## Where the field names come from

The names inside `scanner_execution` — `required`, `completed`, `failed`, `status`,
`output_present`, `output_parseable`, `semantic_consistency` — follow the shape discussed in
[modelcontextprotocol/registry#1404](https://github.com/modelcontextprotocol/registry/pull/1404)
rather than this repository's camelCase, **on purpose**: the two records can then be compared field
by field instead of argued about in prose. Everything outside that block stays in the repository's
usual style.

## How this repository maps onto it

Each evidence block in an index entry is one component:

| block status | component |
| --- | --- |
| `clean` or `findings` | `status: completed`, output present and parseable, consistency `ok`; the block's findings are counted |
| anything else (`unmeasured`, unknown) | `status: failed`, output present but not parseable, consistency `unverified`, and the block's `reason` is kept verbatim |

The mapping is implemented in [`packages/collect/src/execution.mjs`](../../packages/collect/src/execution.mjs)
and applied by `build-index.mjs`; the schema is [`scan-execution-v1.schema.json`](scan-execution-v1.schema.json).

## What this record does not claim

It does not say a package is safe, and it does not cover what a scanner did not look at. A component
that is `completed` means that scanner finished and its output was readable — nothing more. Coverage
is the list of components, which is why the list is in the record.

## Validating it

`validateScanExecution` in the module above is the reference implementation (no dependencies). The
JSON Schema is provided for other consumers, and a test asserts that the two agree on the required
fields, so the schema cannot drift away from the code that writes the records.
## Where the record appears

| surface | what a reader sees |
| --- | --- |
| index record (`data/index.json`) | `scanExecution` on every record; the verdict is `incomplete` whenever the state is not `complete` |
| SARIF (`check --format sarif`) | `runs[].invocations[].executionSuccessful`, plus one `toolExecutionNotification` per failed component — the conventional place a consumer looks before trusting an empty result list |
| `/v1/index/summary` | `execution: { complete, incomplete, absent, byReason }` next to the verdict counts |
| `/v1/servers` | one word per row: `complete`, `incomplete` or `null` (a record written before this block existed) |
| policy | `required.scanners` names components a company insists on; an incomplete state is already an invariant, so it does not need to be asked for |
| index diff (`agentgate diff`, the daily history page) | `coverage changed`, listing records that stopped being fully measured or started being — a record that became unmeasurable is not explained by any version change, so it gets its own category |

An older index without the block is not treated as complete: it reads as `absent`, and a policy that
names scanners will report it as missing rather than assume the work happened.
