# We indexed 11,605 MCP records and could audit 258 of them

*September 2026. The index was built 2026-09-19; the repository census ran the same day. Both scripts
are in the repository and the commands are at the end.*

Every security tool has a word it should be careful with, and the word is "clean". A finding costs
someone attention; a clean result tells them to stop looking. I want to know how often this tool is
in a position to say it at all. So this week I stopped looking at what the scanner found and counted
how much work actually happened — over the whole index, not just the part that is easy to count.

## Two kinds of record, counted apart

The index now carries two things that look alike and are not:

| | records | what it is | can it be clean? |
| --- | ---: | --- | --- |
| registry entries | 2,020 | a server somebody registered, usually with a package | yes, if every required scan ran |
| repository records | 9,585 | a public GitHub repository we read metadata for | **no, by construction** |

11,605 records in total, and **258 of them (2.2%) have a complete coverage block**. Reporting that one
percentage alone would be dishonest in the other direction: repository records cannot be clean, because
nothing published was inspected for them. So the two are counted separately everywhere — on the site,
in the API, and here.

## The registry half: 12.8% of documents could be audited

| what did not run | records | why |
| --- | ---: | --- |
| registry document | 1,762 | `not-audited` |
| package manifest | 11 | `metadata-unavailable` |

1,762 registry entries (87%) never had their document audited, mostly because they list no npm or PyPI
package at all: they are hosted or remote servers, and the first document the pipeline knows how to
read does not exist for them. Of the 2,020 entries, 188 came out clean, 34 findings, and the rest
incomplete for a reason the record states.

That is the least flattering number on this site, which is why it is here.

## The other half: 16,985 repositories, and we knew 95 of them

The registry is one source. So I enumerated a second one completely: every GitHub repository carrying
the `mcp-server` topic with at least one star — 16,985 repositories, 12,328 owners, 580 API requests,
77 minutes, no truncation. (The API refuses to page past 1,000 results for one query, so the
enumeration splits by star bucket and then by push date until every slice fits; it reports a slice it
could not split rather than smoothing it over.)

**95 of those 16,985 repositories (0.6%) had a record in the index.** That is not a rounding error: of
the five companies I wrote to last week, three publish a public MCP server each, and none of them
appeared anywhere in this index.

So each repository was classified by its file tree — one request per repository, and the path that
decided each verdict is kept with it:

| verdict | repositories |
| --- | ---: |
| a server entry file (path contains `mcp`) or an MCP descriptor | **9,585** |
| a manifest but no server entry | 1,817 |
| documentation or examples | 1,509 |
| neither | 3,979 |

A rule is not a measurement, so the 9,585 were sampled: 40 at even intervals, each read by hand. 27
were genuinely MCP servers, 6 were clients, hosts, examples or a control plane, and about 4 were
unclear from the paths alone — roughly **73% precision, so on the order of 7,000 MCP servers that had
no record here at all.**

## What those 9,585 records can and cannot say

They carry what their metadata shows, and nothing else:

- 2,151 declare **no licence**, so the terms of use are unknown;
- 695 have not been pushed in over a year;
- 128 are archived, which means no further fixes;
- and not one is clean. The package half of the chain is `skipped` in every one of those records, with
  the reason written into it: *no package declared in the repository*. That is not a verdict about the
  code; it is a statement that there was no published artifact to inspect.

## What this does not mean

The topic is self-applied: SDKs, clients, documentation and unrelated projects carry it, which is why
7,305 of the 16,985 repositories are not counted as servers at all. The classification is a file-tree
heuristic with a measured error rate, not a judgement, and each record names the path that decided it,
so any single verdict can be checked rather than trusted. And "not clean" is not "bad": for most of
these repositories the honest reading is that nothing was published to inspect.

## Reproduce it

```sh
node scripts/coverage-stats.mjs --index data/index.json
node packages/collect/github-census.mjs --topic mcp-server --min-stars 1 --out data/github-census.json
node packages/collect/scripts/classify-repositories.mjs --census data/github-census.json --out data/repository-classification.json
```

The second and third commands need a GitHub token, and the third takes hours for a full run; it is
incremental, so the next run only looks at repositories whose `pushed_at` moved.

## Why publish the ugly number

Because every clean claim in this ecosystem currently has a denominator nobody publishes. I publish
mine — including the part where 87% of the registry could not be audited, and 99.4% of a GitHub topic
was invisible to me until this week.
