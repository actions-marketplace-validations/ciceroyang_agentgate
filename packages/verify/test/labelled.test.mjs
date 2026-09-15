import { test } from "node:test"
import assert from "node:assert/strict"
import { measure } from "../../../scripts/measure-verify.mjs"

// Thresholds are floors, not targets: they exist so the numbers cannot quietly get worse.
test("claim extraction stays above the measured floor", async function () {
  const m = await measure()
  assert.ok(m.precision >= 0.9, "precision fell to " + m.precision)
  assert.ok(m.recall >= 0.8, "recall fell to " + m.recall)
  assert.ok(m.defectRate >= 0.8, "defect catch rate fell to " + m.defectRate)
})
