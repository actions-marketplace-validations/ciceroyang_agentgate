import test from "node:test"
import assert from "node:assert/strict"
import { createRateLimiter, securityHeaders } from "../src/limits.mjs"

test("zero means off, so nothing changes unless it is asked for", function () {
  const limiter = createRateLimiter({ perMinute: 0 })
  assert.equal(limiter.enabled, false)
  for (let i = 0; i < 100; i += 1) assert.equal(limiter.allow("a", i).allowed, true)
})

test("a bucket allows its burst and then refuses with a retry hint", function () {
  const limiter = createRateLimiter({ perMinute: 60, burst: 3 })
  const now = 0
  assert.equal(limiter.allow("a", now).allowed, true)
  assert.equal(limiter.allow("a", now).allowed, true)
  assert.equal(limiter.allow("a", now).allowed, true)
  const refused = limiter.allow("a", now)
  assert.equal(refused.allowed, false)
  assert.equal(refused.retryAfterSeconds >= 1, true)
})

test("a second key has its own bucket", function () {
  const limiter = createRateLimiter({ perMinute: 60, burst: 1 })
  assert.equal(limiter.allow("a", 0).allowed, true)
  assert.equal(limiter.allow("a", 0).allowed, false)
  assert.equal(limiter.allow("b", 0).allowed, true)
})

test("tokens come back with time", function () {
  const limiter = createRateLimiter({ perMinute: 60, burst: 1 })
  assert.equal(limiter.allow("a", 0).allowed, true)
  assert.equal(limiter.allow("a", 0).allowed, false)
  assert.equal(limiter.allow("a", 1000).allowed, true, "one second at 60/min is one token")
})

test("the key map is bounded", function () {
  const limiter = createRateLimiter({ perMinute: 60, burst: 1, maxKeys: 2 })
  limiter.allow("a", 0)
  limiter.allow("b", 0)
  limiter.allow("c", 0)
  assert.ok(limiter.size() <= 2, "a caller-chosen key must not grow the map without bound")
})

test("under pressure the oldest bucket goes and the newest stays", function () {
  const limiter = createRateLimiter({ perMinute: 60, burst: 1, maxKeys: 2 })
  limiter.allow("a", 0)
  limiter.allow("b", 1000)
  limiter.allow("c", 2000)
  assert.equal(limiter.size(), 2)
  assert.equal(limiter.allow("c", 2000).allowed, false, "the newest bucket is still the one being counted")
})

test("idle time is what makes a bucket droppable when the cap is reached", function () {
  const limiter = createRateLimiter({ perMinute: 60, burst: 1, maxKeys: 2, idleMs: 1000 })
  limiter.allow("old", 0)
  limiter.allow("kept", 4000)
  limiter.allow("new", 4100)
  assert.equal(limiter.size(), 2)
  assert.equal(limiter.allow("new", 4100).allowed, false, "the newest bucket survived the eviction")
})

test("the security headers are the ones with no downside", function () {
  const headers = securityHeaders()
  assert.equal(headers["x-content-type-options"], "nosniff")
  assert.equal(headers["referrer-policy"], "no-referrer")
  assert.equal(headers["cache-control"], "no-store")
})
