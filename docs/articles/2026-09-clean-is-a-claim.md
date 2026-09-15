# Clean is a claim about work that was done

*September 2026. Everything below is a thing that happened while building [agentgate](https://github.com/ciceroyang/agentgate), with the numbers as they were.*

"Clean" is the highest-stakes word a security tool emits. A finding costs attention. A clean result tells someone they can stop looking, and it travels: into a pull request, into a review, into an auditor's spreadsheet. So the interesting question about a scanner is not how many rules it has. It is what it does when it fails.

Here are five failures I found this week, four of them in my own work.

## 1. A tool that scored 100/A while four of its scanners were dead

I was running AgentAuditKit 0.6.5 over some real MCP configuration when I noticed its report contradicting itself. One file with invalid UTF-8 crashed four scanners. The summary said so:

```json
{"critical":0,"high":0,"medium":0,"low":0,"info":4,"total":4,"reported":0,"minSeverity":"low"}
```

Four crashed scanners, and `reported: 0`. A scanner failure is recorded at INFO severity; INFO is below the default reporting floor and below every value `--fail-on` accepts. So the crash was invisible, and it was not fatal. `--score` still returned `100 A`. The SARIF output, which is what GitHub code scanning reads, had zero results. `--fail-on low|medium|high|critical` all exited 0. There is no `--fail-on info`, so no flag combination makes a crashed scanner fail a build.

I reported it ([#743](https://github.com/sattyamjjain/agent-audit-kit/issues/743)). It is a good tool; the failure mode is a design accident, not carelessness. But the accident is a common one, and the next section is why I care.

## 2. The same failure, one layer up, in my own service

Building agentgate, I gave the service layer a rule: no index, no answer. It returns 503 and says what to run.

Then I pointed a fuzzer at it and found the shape I had missed. A file that is valid JSON but has no `records` array was accepted, served as HTTP 200, and reported zero servers. That is not a crash. It is worse. A crash is loud. This was a page that said *nothing is wrong* while the thing that knows about wrongness was unreadable.

The fix is one condition. The lesson is that "no index" has more shapes than "no file".

## 3. The sample that passes every check while the real work failed

The repository ships a 300-record sample index so a fresh clone can serve immediately. The deployment is supposed to replace it with a live collection of a few thousand.

Both are valid indexes. Every health check I had written would pass on either. So I added one assertion that only the real thing can satisfy:

```sh
node scripts/smoke.mjs http://127.0.0.1:8080 --expect-min 1000
```

Without it, a machine where the collection silently died would come up green, serving a sample, forever. This is the failure I would have shipped. It is now in the runbook as the check that matters most.

## 4. Seven crashes, found by trying to break it

I ran the whole thing against inputs nobody had written for it: a policy that is null, an array, a string; findings that are not objects; records with no server name; a census row that is `null`. Seven of them crashed with a `TypeError`.

None of those crashes was dangerous on its own: a crash is not a silent pass. But they are the same shape as everything above — the tool stops being able to speak and the surrounding pipeline has to decide what that means, and pipelines tend to decide "fine".

They all have regression tests now, and malformed input makes a result `incomplete` rather than being skipped. `incomplete` is the third verdict, and it outranks `findings`.

## 5. Two quote marks, and the class of mistake I kept making

Twice in one day, a quoting error cost a run.

First, a shell script with `{ echo "failed"; exit 1 }`. Bash needs a semicolon before the closing brace; without it the whole script is a syntax error, and the first thing it prevented was a deployment rehearsal from running at all — which is exactly the rehearsal that would have caught it.

Then, a page builder that assembled HTML by concatenating strings in JavaScript. A double quote inside `id="rows"` ended the string, and the generated file would not parse. I fixed it by moving the HTML into a real file so the generator only replaces one placeholder.

The second fix is the one worth copying: not "be careful with quotes" but *stop hand-assembling the thing and check it mechanically*. The page's generated script is now run against a stub DOM in the test suite, because that is the check that was missing while I made the same mistake twice.

## What the tool does about it

agentgate now ends every scan in one of three words, and the third one is the point:

- **`clean`** — every check ran, every required piece of evidence was measured, nothing was refused.
- **`findings`** — something was refused, with the rule and the reason.
- **`incomplete`** — a check failed to run, or evidence the policy requires is `unmeasured`.

`incomplete` outranks `findings` and exits 2 at every `--fail-on` level. Lowering the threshold cannot turn a partial answer into a pass; the only way through is an explicit `--allow-incomplete`, and the report still says incomplete.

The same rule shows up in the smaller decisions. A config that exists but does not parse is a coverage gap, not a finding. A package whose manifest could not be fetched is `metadata-unavailable` in the published census, never clean — which is why that census reports 216 clean packages out of 245 rather than the 238 it could have claimed. And in the human-readable report, the section listing what could not be measured comes *before* the findings, because a report that buries what it did not check reads as more complete than it is.

## If you are evaluating a scanner

Ask it one question: **what did you not do?**

If the report has findings but no coverage — no record of which checks ran, which files were read, what could not be parsed — the answer is unavailable, and "clean" is a claim about work nobody can show was done.

Then find its own test corpus and its own published numbers and check the method rather than believing the summary. Mine was wrong for exactly as long as I did not.

---

*agentgate is at [github.com/ciceroyang/agentgate](https://github.com/ciceroyang/agentgate) under AGPL-3.0. The browsable evidence index is at [ciceroyang.github.io/agentgate](https://ciceroyang.github.io/agentgate/), and there is a [sample report](https://ciceroyang.github.io/agentgate/report-sample.html) generated from a project that deliberately breaks its own policy.*
