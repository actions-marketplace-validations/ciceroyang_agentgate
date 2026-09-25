# A reason that reads as a finding

*September 2026. Everything below is a thing that happened while building [agentgate](https://github.com/ciceroyang/agentgate), with the numbers as they were.*

A scanner has two kinds of output. A finding is a claim about the world: this package does X. A coverage gap is a claim about the scanner: I could not measure this. The second kind is where nearly all of my mistakes live, and they have one shape.

The shape is a gap whose reason reads as a finding — a sentence that sounds like something you discovered about the subject, when the truth is that you never looked.

Here are five of them from one day. Four are in my own code.

## 1. "This repository declares no package"

The index has a component called `packageManifest`. For a long time, every repository record that had no package data carried the reason `no-package-declared-in-repository`.

Read that string back. It is a statement about the repository: *there is no package here.* But nothing in that build had ever opened a package file. The reason was hardcoded — the step that would have looked did not exist yet.

Three of the repositories I happened to check by hand — `firecrawl/firecrawl-mcp-server`, `upstash/context7`, `apify/apify-mcp-server` — all declare a `package.json`. The record said they declared nothing. It was not lying about the file it had: it was answering a question nobody asked.

The replacement says what the build did instead: `package-not-inspected`. That one is allowed to sit next to a full description of the package, because it is not competing with it.

## 2. One word for two opposite facts

4,603 packages in the index were recorded as `metadata-unavailable`. Nothing more. No field said why.

The fetch underneath returned `null` for every failure, so a 404 — *the registry has no such package* — and a timeout — *this run could not reach the registry* — arrived at the record as the same thing. The first is a fact about the package. The second is a fact about my afternoon. Collapsed into one string, the file could not be used to tell a wrong coordinate from a failed fetch, and neither could I.

So I re-asked all 4,603. Every one of them, through different code, and recorded the status codes:

```
4,598   404
    4   network error
    1   405
```

So the answer was 99.9% "the registry does not have this package" — which sounds like the reassuring outcome, and is not the point. The point is the four. Four packages where the failure was mine, indistinguishable from the 4,598, and *not worth retrying together with them* because they are the only ones worth retrying.

A gap that cannot say which kind of gap it is cannot be acted on. It can only be counted.

## 3. Three situations, one string, and the one that was my own policy

An npm package's `postinstall` script is a file inside the package, and I fetch it to read. When that fetch produced nothing, the finding said `install-hook-script-unavailable`: *content could not be fetched.*

That string was covering three distinguishable situations:

- the package does not ship the file (both CDNs say 404)
- the CDN did not answer (worth retrying)
- the hook is the sixth or later in the file, and this step reads the first five, by design

Only the first two had actually happened. I checked, because I wanted to write this section and I did not want to describe an event I had not verified — the third situation has never once occurred in this dataset. The budget is real anyway: a vocabulary you add after the fact is a vocabulary you were flying without.

One of the two records with that finding is `@icloud-calendar-mcp/server`. On a retry the file came back — 3,357 bytes — and reading it added a finding the record could not have had before: `install-hook-script-critical` (critical), next to the `install-time-execution` (high) it already carried. A transient failure had been stored as a permanent fact, and a critical finding spent its whole life filed as a high one.

The other is `@yagyeshvyas/vibeguard`, whose manifest declares `"postinstall": "node scripts/postinstall.js"` while the tarball contains no such file. That is a defect in their package, and under the old rule it could only ever be reported as *I do not know*.

## 4. The one that got it right

Every repository record also carries a component that has never lied: `repositorySource`, always `skipped`, always reason `source-not-read`.

9,781 records. All the same sentence. It reads as a gap because it is one, and it says exactly what the build did — it did not read the source — which is a fact about the build and not a claim about the repository.

That is the model the other three should have followed from the start. The string I want is boring and self-incriminating. The string I keep writing is confident and about someone else.

## 5. The gap that said nothing at all

The four above are reasons that said too much. This one said too little: nothing, anywhere.

The index is rebuilt on a schedule by a command called `refresh`. `refresh` builds the index from several artifacts, and it was not passing the package audit to the builder. So every scheduled rebuild produced an index without the audit in it. 6,199 audited packages went back to *a package is declared here*, on a timer, with no error, no log line, and the audit artifact sitting on disk the whole time.

I found it by accident while checking something else. There was no test that could have caught it, because the failure is not a wrong value — it is a missing one, produced by a code path that is correct for every input it is given.

## 6. Why this is one bug and not five

There is a second system that depends on all of this. Every high or critical finding in the published index has to be read by a person before it ships, and the tool that records that review refuses to accept *any* finding whose provenance is incomplete. It is one gate for the whole batch.

124 findings were waiting. Exactly two had incomplete provenance, so the gate could not open at all — not for the 122 that were fine, not for the two. And one of those two could never become complete, because the rule said that a file the package does not ship is missing evidence. It is not missing evidence. It is the evidence.

That is the cost of an unnamed gap: not one wrong row, but a pipeline that stops and cannot say why.

Once the reasons named themselves, the gate opened, and a person read all 124.

## The rule

**A reason has to describe what the build did. If it describes the world, you have to have checked.**

- `package-not-inspected` — allowed. It says the step did not run.
- `source-not-read` — allowed. It says nothing was read.
- `package-not-found` — allowed, because the registry was actually asked and answered.
- `no-package-declared-in-repository` — not allowed. Nobody looked.

There is a version of this that is just naming discipline, and that version is not worth a blog post. The version that is worth it: the wrong strings are not wrong because they are imprecise. They are wrong because they are *more useful*. "No package declared" tells the reader something they can act on. "Not inspected" tells them they still have work to do, and the person writing the string would rather be helpful than accurate.

That is the whole failure mode. It is not laziness and it does not feel like dishonesty while you are typing it.
