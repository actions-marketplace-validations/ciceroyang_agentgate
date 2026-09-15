// Fail loudly if anything in this process tries to leave the machine.
//
// Loaded with --require when a test runs the CLI, so a claim like "check never phones home"
// is enforced instead of asserted in prose. Loopback is allowed: binding a listener makes the
// runtime resolve the bind address, and a gateway to 127.0.0.1 is not a gateway to anywhere.
const net = require("node:net")
const dns = require("node:dns")
const isLocal = function (host) {
  if (typeof host !== "string") return false
  if (net.isIP(host) !== 0) return host === "127.0.0.1" || host === "::1" || host.indexOf("127.") === 0
  return host === "localhost"
}
const realFetch = globalThis.fetch
globalThis.fetch = function (input) {
  const url = typeof input === "string" ? input : (input && input.url) || ""
  if (/^https?:\/\/(127\.|\[::1\]|localhost)/.test(url)) return realFetch.apply(this, arguments)
  throw new Error("network access attempted: fetch " + url)
}
const nameNotAddress = function (host) {
  return typeof host === "string" && net.isIP(host) === 0 && host !== "localhost"
}
const realLookup = dns.lookup
dns.lookup = function (host) {
  if (nameNotAddress(host)) throw new Error("network access attempted: dns.lookup(" + host + ")")
  return realLookup.apply(this, arguments)
}
const realPromisesLookup = dns.promises.lookup
dns.promises.lookup = function (host) {
  if (nameNotAddress(host)) throw new Error("network access attempted: dns.promises.lookup(" + host + ")")
  return realPromisesLookup.apply(this, arguments)
}
const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (options) {
  const host = options && typeof options === "object" ? options.host : arguments[1]
  if (host !== undefined && !isLocal(host)) throw new Error("network access attempted: connect " + host)
  return realConnect.apply(this, arguments)
}
