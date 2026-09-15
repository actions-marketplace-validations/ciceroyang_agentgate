import { createServer } from "node:http"
import { createService } from "./server.mjs"
import { DEFAULT_PORT, DEFAULT_HOST } from "./defaults.mjs"

export function start(options) {
  const service = options.service || createService(options)
  const server = createServer(function (req, res) {
    let out
    try {
      out = service.handle(req.method, req.url)
    } catch (error) {
      // An exception must not kill the process or look like an answer. It is a 500,
      // and the body says so in the same words the rest of the tool uses.
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ error: "the service failed to answer, which is not a pass", detail: String((error && error.message) || error) }) + "\n")
      return
    }
    res.writeHead(out.status, { "content-type": out.type })
    res.end(out.body)
  })
  // 0 is a valid port that asks the operating system for a free one. "options.port || 8080"
  // quietly turned it into 8080, so a caller asking for an ephemeral port got the default instead.
  const port = options.port === undefined || options.port === null ? DEFAULT_PORT : options.port
  server.listen(port, options.host || DEFAULT_HOST, options.onListening)
  return server
}
