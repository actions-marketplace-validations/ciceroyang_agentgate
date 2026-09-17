/**
 * The limits the service imposes on itself, rather than trusting the layer in front of it.
 *
 * Two things worth being explicit about. Behind Caddy every request arrives from 127.0.0.1, so
 * a per-address bucket is effectively one global bucket - which is the honest description of
 * what this can do at this layer, and it still stops a runaway client from taking the process
 * down. And the bucket map is bounded: an unbounded map keyed by a caller-chosen value is a
 * memory leak with extra steps, the same reason metric labels collapse to "/other".
 */

export function createRateLimiter(options) {
  const opts = options || {}
  const perMinute = typeof opts.perMinute === "number" && opts.perMinute > 0 ? opts.perMinute : 0
  const capacity = typeof opts.burst === "number" && opts.burst > 0 ? opts.burst : Math.max(perMinute, 1)
  const maxKeys = typeof opts.maxKeys === "number" && opts.maxKeys > 0 ? opts.maxKeys : 10000
  const idleMs = typeof opts.idleMs === "number" && opts.idleMs > 0 ? opts.idleMs : 10 * 60 * 1000
  const refillPerMs = perMinute / 60000
  const buckets = new Map()

  function evict(nowMs) {
    for (const [key, bucket] of buckets) {
      if (nowMs - bucket.at > idleMs) buckets.delete(key)
    }
    if (buckets.size <= maxKeys) return
    // Still over the cap after idling out: drop the least recently used, oldest first.
    const ordered = Array.from(buckets.entries()).sort(function (a, b) { return a[1].at - b[1].at })
    for (let i = 0; i < ordered.length && buckets.size > maxKeys; i += 1) buckets.delete(ordered[i][0])
  }

  return {
    enabled: perMinute > 0,
    perMinute: perMinute,
    size: function () { return buckets.size },
    allow: function (key, nowMs) {
      if (perMinute === 0) return { allowed: true }
      const now = typeof nowMs === "number" ? nowMs : Date.now()
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { tokens: capacity, at: now }
        buckets.set(key, bucket)
        if (buckets.size > maxKeys) evict(now)
      } else {
        const elapsed = Math.max(0, now - bucket.at)
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs)
        bucket.at = now
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return { allowed: true }
      }
      const waitMs = (1 - bucket.tokens) / refillPerMs
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) }
    },
  }
}

/** Headers that cost nothing and belong on every answer from a service with no cookies or forms. */
export function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  }
}
