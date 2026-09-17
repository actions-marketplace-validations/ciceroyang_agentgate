# The audit finished on 264 of 2,057 MCP servers

*September 2026. Numbers from the index built 2026-09-17 with scanner `25d846c`. The script that
computes them is in the repository, and the command is at the end.*

Every security tool has a word it should be careful with, and the word is "clean". A finding costs
someone attention; a clean result tells them to stop looking. I want to know how often my own
scanner is in a position to say it at all. So this week I stopped looking at what the scanner
found and counted how much work actually happened.

## The number

2,057 MCP servers in the index. **264 of them, 12.8%, have a complete coverage block** — every
scanner the record requires ran, its output was there, it was readable, and it did not contradict
itself. The other 1,793 do not.

That is the least flattering number on this site, which is why it is here.

## What stopped the rest

Almost all of it is one thing:

| what did not run | records | why |
| --- | --- | ---: |
| registry document | 1,782 | `not-audited` |
| package manifest | 11 | `metadata-unavailable` |

1,782 servers never had their registry document audited. 1,767 of those list no npm or PyPI
package at all — they are hosted or remote servers, and the first document my pipeline knows how to
read does not exist for them. The remaining 11 do publish a package; the registry metadata fetch
failed, which is recorded as a failure and not as an empty result.

None of this says those servers are dangerous. It says my method cannot reach them yet, and I would
rather the index show a hole than show a green square over one.

## Where 1,991 clean servers went

In early September my index said 1,991 of 2,072 servers were clean. The pipeline worked like most
do: it collected what it could, found no findings in what it collected, and published the rest as
clean. The collection knew better — the census had been recording an `audited` flag the whole time,
and the index simply was not reading it.

The day the index started reading it, clean went from 1,991 to 195, and incomplete went from 60 to
1,845. Nothing about the servers changed that day. What changed is that the tool stopped counting
unread material as passing.

The coverage block is the per-record version of that correction. It is now possible to open any
server's page and read which scanner was required, which finished, and the reason attached to the
one that did not — instead of inferring all of that from the absence of findings.

## Running is not the same as being able to grade

There is a second category, and it is the interesting one. In **38 records every required scanner
ran**, the coverage block says `complete`, and the verdict is still `incomplete`.

The reason is the same rule, one level down: those scans returned findings whose severity is
`unknown`. "Unknown" is not the same as "low". It means the check ran and could not determine the
answer, and a severity nobody can rank is treated as unmeasured. So it cannot support a clean
verdict, and it cannot be compared against the threshold either. A scanner that runs can still
leave you unable to grade the result.

## What did turn up

465 findings across 274 servers: 11 critical, 13 high, 28 medium, 17 low, 49 unknown, 347
informational. `clean` means nothing at or above the medium threshold and no unknown severity; it
does not mean the list is empty.

## What complete does not mean

- It does not mean the server is safe. It means the scanners this record requires finished.
- It does not mean every possible check ran; it means the required ones did, and the list is in the
  record.
- It says nothing about the machine the server runs on, its configuration, or its runtime
  behaviour. Those are not public material.
- It is our measurement of public material, not a third-party assessment.

The rule underneath is the point: **an artefact with an unmeasured part is `incomplete`, never
`clean`**. The coverage block exists so that rule is a field you can read, not a promise you have
to take.

## Reproduce it

```sh
node scripts/coverage-stats.mjs --index data/index.json
```

It prints exactly the counts above and exits non-zero if any record claims a verdict its own
coverage block cannot support. The record format is specified in
[docs/spec/scan-execution-v1.md](../spec/scan-execution-v1.md), with a JSON Schema next to it. The
same data is public at [/v1/index/summary](https://app.xn--5kvo87g.com/v1/index/summary) and on
[/evidence.html](https://app.xn--5kvo87g.com/evidence.html).

If you maintain an MCP server, the audit starts with a document you publish — a registry entry, a
package manifest — so publishing one is the first thing that makes this kind of check possible. If
you run these servers, you can put your own list through
[/inventory.html](https://app.xn--5kvo87g.com/inventory.html) and see, per tool, which scanners ran
and which did not.

---

*中文版：[2,057 个 MCP server,审计跑完的是 264 个](2026-09-how-much-of-the-mcp-ecosystem-is-auditable.zh-CN.md)*
