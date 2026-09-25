import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function codeFingerprint(urls) {
  return fingerprint(urls.map(url => readFileSync(url, "utf8")))
}

/** Unknown, future-dated and expired observations must be re-read, not re-dated. */
export function reusable(entry, key, timestamp, now = Date.now()) {
  const observed = Date.parse(entry?.[timestamp])
  return Boolean(entry?.cacheKey === key && Number.isFinite(observed) && now >= observed && now - observed < 24 * 60 * 60 * 1000)
}
