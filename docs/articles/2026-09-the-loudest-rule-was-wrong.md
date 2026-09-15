# The loudest rule was wrong nine times out of nine

*September 2026. Numbers are from a scan of 14 real repositories, run before contacting any of them.*

I built a scanner that reads other people's code for agent security problems. This week I took its output and prepared to email the maintainers. Then I did the thing I should always do first: I opened the files it pointed at and read them.

The rule that produced the most findings was wrong every single time.

## What it said

`AG-SRC-002` is one regex, and it exists for a good reason. `eval()` on a value that is not a literal is remote code execution waiting for an input path. So:

```js
{ rule: "AG-SRC-002", re: /(?<![.\w])eval\s*\(\s*[A-Za-z_$]/, message: "eval() on a non-literal argument" }
```

Read it as a person: find the word `eval`, an open parenthesis, and an identifier. In a scan of 14 repositories it matched **nine of them**.

## What it actually matched

The first file was `backend/src/mcp/eval/lib.js` in a project I had never heard of. The match, on line 1:

```js
// Pure helpers for the MCP tool-selection eval (plan §9). Kept free of SDK /
```

`eval (p`. The word eval, in a comment, followed by a parenthesis, in prose. A second file in the same repository opened with the same sentence in a block comment.

The second was a Python file, line 670:

```python
def eval(self):
```

`eval(s`. A method that is *named* eval. Not a call to anything.

Nine repositories. The two I opened were prose and a function signature.

## A regex cannot tell code from prose

This is not a subtle bug, and that is the point. The pattern is correct as a pattern and meaningless as a claim about a codebase, because it has no idea which bytes are code.

The rule has a comment above it that I wrote: *"Narrow on purpose. Each pattern is a shape that is almost never correct."* It was wrong in the specific way that matters. The shape is almost never correct *as code*, and the scanner was not reading code. It was reading text.

I had also already fixed this exact mistake once. A different rule has a test called **"a method named exec is not a shell exec"**, because `exec(command)` in a signature was being reported as a shell call. I wrote that test, fixed that rule, and did not look at the rule sitting next to it.

## The fix

Comments are blanked before matching, in place, so offsets and line numbers do not move:

```js
// "exec(`ls ${d}`)" on line 4 must still be reported on line 4, even after the
// comment above it is masked, so masking replaces characters and keeps length.
const code = maskComments(text, ext)
```

Strings are tracked while masking, so a `//` inside a string does not blank the rest of a real line:

```js
const u = "http://x"; exec(`ls ${d}`)   // still a finding
```

Triple-quoted Python strings are masked too. A module docstring beginning *"Run the E2 causal-specific eval on the draft case set"* was the third false positive, and a docstring is prose in exactly the same way a comment is.

A function or method definition is no longer read as a call:

```python
def eval(self):             # a name
def f(): return eval(x)     # a call
```

And an `eval` or `new Function` shape inside a test path is reported as `low`, with the message saying why — the same treatment the shell rule already gave scripts and tests. `new Function("specifier", "return import(specifier)")` in a test that asserts inline JavaScript parses is a real use of the API with a much smaller reach, and saying so is the honest report.

## The second pass

After the fix, three findings remained that were still not code, in a file I had not yet opened:

```js
assert.doesNotThrow(() => new Function(source), "inline JavaScript must parse")
```

Those are in tests, and are now `low`. One more was a docstring. The rule went from **nine repositories to zero**.

The repositories that still carry findings carry them for other reasons: a `postinstall` that evaluates inline code, a remote MCP endpoint configured without authentication, an `.mcp.json` that runs `npx` without a pinned version, a dependency listed as `"latest"`, and a shell command built by interpolating a variable. Fourteen repositories with findings became twelve, and I read the twelve.

## What I take from it

The outreach was never sent. Nine emails describing a bug that was not there would have been worse than nothing: they would have cost the maintainers time, and taught every one of them that this scanner should be ignored.

That is the whole thesis of this project, applied to itself. A finding is a claim, and a claim is worth exactly the work done to verify it. The interesting number is not how many rules a scanner has. It is how many of its findings survived contact with the file.

The exact lines above — the comment, the docstring, `def eval(self):`, the `new Function` in a test — are in the test suite now, each labelled with the repository shape it came from. If someone changes the matcher, those lines are what tell them they broke it.

---

*agentgate is at [github.com/ciceroyang/agentgate](https://github.com/ciceroyang/agentgate) under AGPL-3.0. The fix is commit `dcc5108`. Per-repository detail stays private: naming a project that may have a real weakness is a disclosure decision, not a summary statistic.*
