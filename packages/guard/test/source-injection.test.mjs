import { test } from "node:test"
import assert from "node:assert/strict"
import { checkSource } from "../src/checks/source-injection.mjs"

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
