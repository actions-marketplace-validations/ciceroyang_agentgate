/**
 * Pull the checkable parts out of an answer.
 *
 * The unit is a sentence with a feature that can be checked against something
 * outside the answer: a link, a number, a date, a citation marker, or a named
 * source. Everything else is opinion, advice or style, and checking it would be
 * theatre.
 */
const DATE = /\b(\d{4})[-/年](\d{1,2})[-/月]?(\d{1,2})?日?\b|\b(\d{4})年(\d{1,2})月\b/
const NUMBER = /\b\d+(?:\.\d+)?\s*(?:%|percent|万|亿|million|billion|人|年|倍|元|美元|美元)?/
const URL = /https?:\/\/[^\s)\]}>,,"'。、!?!?;:]+/
const CITATION = /\[\d{1,2}\]/
const SOURCE = /(根据|据|来源于|出自|according to|study|report|research|survey)/i

/** Keep a URL in one piece while sentences are being cut apart. */
function maskUrls(text) {
  const urls = []
  const masked = String(text).replace(new RegExp(URL.source, "g"), function (m) {
    urls.push(m)
    return " <<u" + (urls.length - 1) + ">> "
  })
  return { masked: masked, urls: urls }
}

function unmask(text, urls) {
  return text.replace(/<<u(\d+)>>/g, function (_, i) { return urls[Number(i)] })
}

export function splitSentences(text) {
  const parts = maskUrls(String(text).replace(/\n+/g, " "))
  return parts.masked
    .split(/(?<=[。!?!?\.;])\s*/)
    .map(function (s) { return unmask(s.trim(), parts.urls) })
    .filter(function (s) { return s.length > 8 })
}

export function classify(sentence) {
  const kinds = []
  if (URL.test(sentence)) kinds.push("url")
  if (CITATION.test(sentence)) kinds.push("citation")
  if (DATE.test(sentence)) kinds.push("date")
  if (NUMBER.test(sentence)) kinds.push("number")
  if (SOURCE.test(sentence)) kinds.push("source")
  return kinds
}

export function extractClaims(text) {
  const out = []
  const sentences = splitSentences(text)
  for (let i = 0; i < sentences.length; i += 1) {
    const kinds = classify(sentences[i])
    if (kinds.length === 0) continue
    out.push({ index: i, text: sentences[i], kinds: kinds })
  }
  return out
}

export function urlsIn(text) {
  return String(text).match(new RegExp(URL.source, "g")) || []
}
