# Verification against something nobody wrote here

*The tests in this repository are written by the same party as the code, against inputs
chosen by that party. This page records the checks that are not that.*

## A real MCP server through the gateway

```sh
node scripts/verify-real-server.mjs
```

Run on 2026-09-15 against `@modelcontextprotocol/server-filesystem`, installed from npm by
`npx` during the run:

```
1.2s  initialize -> {"name":"secure-filesystem-server","version":"0.2.0"}
6.0s  tools/list -> 11 tools
      read_file, read_text_file, read_media_file, read_multiple_files,
      create_directory, list_directory, list_directory_with_sizes,
      directory_tree, search_files, get_file_info, list_allowed_directories

removed by policy: 3  (write_file, edit_file, move_file)
```

The server advertises 14 tools. The client, going through the gateway with
`forbidden.tools: ["write_*", "delete_*", "move_*", "edit_*"]`, is allowed to see 11. The
log records each removal with its reason. This is not a test of the policy language; it is
evidence that the gateway sits in front of a real server, speaks the protocol, and that the
decision reaches the real tool list.

### A caveat worth keeping

The first attempt at this reported zero messages. Nothing was wrong with the gateway: that
run paid for the `npx` download, which outlasted the fifteen-second window the probe
allowed. A gateway is a transparent pipe, so the startup cost of the command it wraps is
the client's handshake timeout, and pointing it at an un-cached `npx` package on a cold
machine can exceed one. Pre-install, or give it time.

## The GitHub Action on a real pull request

It has now run on one. [Pull request #1](https://github.com/ciceroyang/agentgate/pull/1)
was opened with a project that breaks its own policy; the `policy` check went red, the
report named `AG-MCP-010` and `AG-MCP-014`, and the action commented the report on the pull
request. The pull request was closed once that was confirmed.

The workflow that did it is wrong in one way worth recording: run against deliberately
broken input, it failed on every push, which is not a test. `action-verify.yml` now runs
the action with `continue-on-error`, asserts the outcome was failure, asserts the exit code
was 1, and asserts the SARIF names both rules. The enforcement path is exercised on every
push, and it goes red if the action ever lets a breaking project through.

## The deployment itself, rehearsed from a fresh clone

On 2026-09-15 the whole runbook was run against the published repository, not the working
copy: clone, run the tests inside the clone, do a full refresh against the live registry,
write the first history snapshot and diff, start the service, and smoke it with
`--expect-min 1000` so that a service still reading the committed sample would fail.

```
cloned files:  130
tests:         146 pass
refresh:       243 packages, index 2127 records (2039 clean, 66 findings, 22 incomplete)
history:       first snapshot + diff, 1827 added, 1 package changed
smoke:         green, including --expect-min 1000
elapsed:       2m 04s for the collection step
```

That is the deployment as far as it can be exercised without the target server. What it
does not cover: the Docker layer build, TLS issuance, DNS, and the ICP question.

## Still not verified anywhere but on one machine

| item | state |
| --- | --- |
| Docker image build | not run, no Docker here; the build context and the image command were reproduced instead |

| Scale | a 2,142-record index and a single 50,000-rule policy, nothing larger |
| Retrieval quality in `packages/verify` | term overlap, never measured against a labelled set |

Each of these is a place where "it works" currently means "it worked once, for me".
