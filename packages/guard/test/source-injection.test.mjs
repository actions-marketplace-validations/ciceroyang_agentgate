import { test } from "node:test"
import assert from "node:assert/strict"
import { checkSource, maskComments } from "../src/checks/source-injection.mjs"

function rules(f) { return f.map(function (x) { return x.rule }).sort() }

test("interpolated exec is caught", function () {
  assert.deepEqual(rules(checkSource("a.js", "exec(`git clone ${url}`)")), ["AG-SRC-001"])
  assert.deepEqual(rules(checkSource("b.js", "execSync(cmd + args)")), ["AG-SRC-001"])
})

test("python shell shapes are caught", function () {
  assert.deepEqual(rules(checkSource("a.py", "os.system(f\"rm -rf {path}\")")), ["AG-SRC-001"])
  assert.deepEqual(rules(checkSource("b.py", "subprocess.run(cmd, shell=True)")), ["AG-SRC-001"])
})

test("a literal command is not a finding", function () {
  assert.deepEqual(checkSource("a.js", "execSync(\"git status\")"), [])
  assert.deepEqual(checkSource("b.py", "subprocess.run([\"git\", \"status\"])"), [])
})

test("eval on a variable is medium, on a literal it is silent", function () {
  const got = checkSource("a.js", "const result = eval(userInput)")
  assert.equal(got.length, 1)
  assert.equal(got[0].severity, "medium")
  assert.deepEqual(checkSource("b.js", "const n = eval(\"1 + 1\")"), [])
})

test("a method named exec is not a shell exec", function () {
  assert.deepEqual(checkSource("src/db.ts", "db.exec(`SELECT * FROM t WHERE id = ${id}`)"), [])
  assert.deepEqual(checkSource("src/a.js", "re.exec(`${x}`)"), [])
})

test("generated output is skipped", function () {
  assert.deepEqual(checkSource(".smithery/index.cjs", "new Function(a)"), [])
  assert.deepEqual(checkSource("dist/bundle.min.js", "exec(`x ${y}`)"), [])
})

test("shell interpolation is low in a dev path and medium in source", function () {
  const got = checkSource("scripts/report.cjs", "execSync(`find . -name \"${ext}\"`)")
  assert.equal(got[0].severity, "low")
  assert.match(got[0].message, /smaller reach/)
  assert.equal(checkSource("src/index.ts", "execSync(`run ${p}`)")[0].severity, "medium")
})

test("repeats in one file collapse into a single finding with a count", function () {
  const many = checkSource("src/a.ts", "execSync(`a ${x}`)\nexecSync(`b ${y}`)\nexecSync(`c ${z}`)")
  assert.equal(many.length, 1)
  assert.match(many[0].message, /3 occurrences/)
  assert.equal(many[0].severity, "medium")
})

// These four cases are not invented. A run over 14 real repositories produced nine
// "eval() on a non-literal argument" findings, and the ones inspected by hand were the word
// eval in a comment and a method that is *named* eval. Each case below is the shape found in
// the file named in the comment; without these the scanner teaches people to ignore it.

test("the word eval in a comment is not a call", function () {
  // backend/src/mcp/eval/lib.js and run.js in a real repository both begin with this comment.
  assert.deepEqual(checkSource("backend/src/mcp/eval/lib.js", "// Pure helpers for the MCP tool-selection eval (plan §9). Kept free of SDK /"), [])
  assert.deepEqual(checkSource("run.js", "/* MCP tool-selection eval (plan §9) — measures whether a REAL model, given our"), [])
})

test("a function named eval is a definition, not an eval of anything", function () {
  // src/reasongraph/_extraction.py, a real repository, was flagged for this line.
  assert.deepEqual(checkSource("src/reasongraph/_extraction.py", "def eval(self):"), [])
  assert.deepEqual(checkSource("a.js", "  eval(input) {"), [])
  assert.deepEqual(checkSource("a.ts", "function eval(source: string) { return source }"), [])
  // the call is still a call
  assert.deepEqual(rules(checkSource("a.js", "def f() { return eval(userInput) }")), ["AG-SRC-002"])
})

test("code after a // inside a string is not mistaken for a comment", function () {
  assert.deepEqual(rules(checkSource("a.js", "const u = \"http://x\"; exec(\`ls \${d}\`)")), ["AG-SRC-001"])
  assert.deepEqual(rules(checkSource("a.js", "const u = 'https://x/' + p; execSync(\`ls \${d}\`)")), ["AG-SRC-001"])
})

test("masking keeps line numbers and length", function () {
  const src = "one\ntwo // a comment here\nthree eval(x) {\nfour"
  const masked = maskComments(src, ".js")
  assert.equal(masked.length, src.length, "offsets must not move")
  assert.equal(masked.split("\n").length, src.split("\n").length, "line numbers must not move")
  assert.match(masked, /two {18}/, "the comment is blanked, not deleted")
  // a finding still reports the true line of the code it matched
  const got = checkSource("a.js", "// eval(a)\nexec(\`ls \${b}\`)")
  assert.equal(got[0].line, 2)
})

test("a python docstring is prose, not code", function () {
  // tests/eval_causal_cases.py in a real repository opens with this module docstring.
  const doc = '"""Run the E2 causal-specific eval on the draft case set.\nUnlike the 32-case rg eval (whose graph).\n"""\nx = 1'
  assert.deepEqual(checkSource("tests/eval_causal_cases.py", doc), [])
  // a real call after a docstring is still a real call
  assert.deepEqual(rules(checkSource("a.py", 'y = """"""; eval(z)')), ["AG-SRC-002"])
})

test("an eval shape in a test path is reported as low, not as a warning to act on", function () {
  // src/tests/*.test.ts in a real repository use new Function to assert that inline JS parses.
  const inTest = checkSource("src/tests/cli-guards.test.ts", 'const f = new Function("specifier", "return import(specifier)")')
  assert.equal(inTest[0].severity, "low")
  assert.match(inTest[0].message, /smaller reach/)
  assert.equal(checkSource("src/loader.ts", "const f = new Function(spec)")[0].severity, "medium")
})
