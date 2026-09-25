import test from "node:test"
import assert from "node:assert/strict"
import { FRAMEWORKS, OWNERS, frameworkById, ownerCounts, renderFrameworkText } from "../src/framework.mjs"

const framework = frameworkById("aicaiq")

test("every entry is complete enough to be read on its own", function () {
  for (const entry of framework.entries) {
    assert.match(entry.id, /^(STA|CCC|LOG|A&A)-\d+\.\d+$/, entry.id)
    assert.equal(typeof entry.topic, "string")
    assert.ok(entry.topic.length > 0, entry.id + " has no topic")
    assert.ok(Object.prototype.hasOwnProperty.call(OWNERS, entry.owner), entry.id + " has owner " + entry.owner)
    assert.ok(entry.weProvide.length > 0, entry.id + " does not say what we provide")
    assert.ok(entry.boundary.length > 0, entry.id + " does not say where it stops")
  }
})

test("identifiers are unique", function () {
  const ids = framework.entries.map(function (e) { return e.id })
  assert.equal(new Set(ids).size, ids.length)
})

test("nothing claims the thing we refuse to claim", function () {
  const forbidden = /已满足|合规通过|认证通过|已认证|完全合规|保证合规/
  for (const entry of framework.entries) {
    assert.equal(forbidden.test(entry.topic), false, entry.id)
    assert.equal(forbidden.test(entry.weProvide), false, entry.id)
  }
})

test("the mapping itself says it is not a compliance conclusion and does not reproduce the source", function () {
  assert.match(framework.note, /不是合规结论/)
  assert.match(framework.source, /不转载官方原文/)
  assert.match(framework.source, /Cloud Security Alliance/)
})

test("the owners add up to the entries", function () {
  const counts = ownerCounts(framework)
  const total = Object.keys(counts).reduce(function (sum, key) { return sum + counts[key] }, 0)
  assert.equal(total, framework.entries.length)
  assert.equal(counts.we + counts.customer + counts["third-party"], framework.entries.length)
})

test("every entry reaches the text output with its owner spelled out", function () {
  const text = renderFrameworkText(framework)
  for (const entry of framework.entries) {
    assert.ok(text.indexOf(entry.id) !== -1, entry.id + " missing from the text")
  }
  assert.match(text, /我们出证据/)
  assert.match(text, /你们自证/)
  assert.match(text, /第三方/)
})

test("the AICM alias resolves to the questionnaire mapping, not to a control-set mapping", function () {
  assert.equal(frameworkById("aicm").id, "aicaiq")
  assert.equal(frameworkById("aicaiq").id, "aicaiq")
})

test("an unknown framework is refused with the ones that exist", function () {
  assert.throws(function () { frameworkById("soc2") }, /不认识的框架：soc2/)
  // The list is the registry. Adding a framework is a deliberate act, so it is asserted rather
  // than discovered.
  assert.deepEqual(Object.keys(FRAMEWORKS), ["aicaiq", "eu-aia"])
})

test("the EU AI Act mapping says which paragraphs it read, and classifies every item", function () {
  const eu = frameworkById("eu-aia")
  // A mapping that does not say what it read is a mapping nobody can check. Article 12(3) and
  // 12(4) are biometric-specific and were not read, so the entry that names them must say so
  // rather than stay silent - silence there would read as coverage.
  assert.match(eu.source, /12\(1\)/)
  assert.match(eu.source, /核对过的段落/)
  for (const entry of eu.entries) {
    assert.ok(Object.prototype.hasOwnProperty.call(OWNERS, entry.owner), entry.id + " owner " + entry.owner)
    assert.ok(entry.boundary.length > 0, entry.id + " has no boundary")
    assert.ok(entry.weProvide.length > 0, entry.id + " has no claim")
    if (entry.owner === "we") assert.ok(entry.evidence.length > 0, entry.id + " claims without evidence")
  }
  const uncovered = eu.entries.find(function (e) { return e.id === "EU-AIA-12.3" })
  assert.match(uncovered.weProvide, /未覆盖/)
  assert.equal(uncovered.owner, "third-party")
})

test("the four domains a questionnaire actually asks about are all present", function () {
  const domains = new Set(framework.entries.map(function (e) { return e.id.split("-")[0] }))
  assert.deepEqual(Array.from(domains).sort(), ["A&A", "CCC", "LOG", "STA"].sort())
})
