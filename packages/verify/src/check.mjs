/**
 * Three outcomes, and no fourth. A claim is supported (something outside the answer
 * backs it), contradicted (something outside the answer conflicts with it), or
 * unchecked (nobody looked, or nothing could look). There is deliberately no
 * confidence number: a score would be a new made-up claim, produced by the tool
 * whose job is to point at made-up claims.
 */
export const SUPPORTED = "supported"
export const CONTRADICTED = "contradicted"
export const UNCHECKED = "unchecked"

export function dateProblem(sentence, now) {
  const today = now || new Date()
  const m = /(\d{4})\s*[-/年]\s*(\d{1,2})/.exec(sentence)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return "month " + month + " does not exist"
  const d = new Date(Date.UTC(year, month - 1, 1))
  if (d.getTime() > today.getTime() + 366 * 24 * 3600 * 1000) return "the date is more than a year ahead of today"
  if (year < 1900) return "the year predates anything checkable"
  return null
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 }

export function invalidMonthName(sentence) {
  const m = /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/.exec(sentence)
  if (!m) return null
  const name = m[1].toLowerCase()
  const known = Object.keys(MONTHS).some(function (k) { return k.indexOf(name) === 0 || name.indexOf(k) === 0 })
  return known ? null : "\"" + m[1] + "\" is not a month"
}

/**
 * A citation marker with no matching reference, or a reference no one can reach.
 * This is the most common shape of a fabricated source and the easiest to settle:
 * either the link resolves or it does not.
 */
export function citationProblems(text, opts) {
  const fetchHead = (opts && opts.fetchHead) || null
  const problems = []
  const markers = text.match(/\[\d{1,2}\]/g) || []
  const urls = text.match(/https?:\/\/[^\s)\]}>,]+/g) || []
  if (markers.length > 0 && urls.length === 0) {
    problems.push({ status: UNCHECKED, what: markers.length + " citation marker(s) and no reference list", detail: "nothing to resolve" })
  }
  return problems.concat(urls.map(function (u) { return { status: "pending", what: u, fetchHead: fetchHead } }))
}

export async function resolveUrl(url, fetchHead) {
  const head = fetchHead || defaultHead
  try {
    const res = await head(url)
    if (res.status === 404 || res.status === 410) return { url: url, status: CONTRADICTED, detail: "the link returns " + res.status }
    if (res.status >= 200 && res.status < 400) return { url: url, status: SUPPORTED, detail: "the link resolves (" + res.status + ")" }
    return { url: url, status: UNCHECKED, detail: "the link returns " + res.status }
  } catch (error) {
    return { url: url, status: UNCHECKED, detail: "could not reach the link: " + String(error.message || error).slice(0, 60) }
  }
}

async function defaultHead(url) {
  const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(10000) })
  return { status: res.status }
}
