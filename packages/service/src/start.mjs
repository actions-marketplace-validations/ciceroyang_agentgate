import { createServer } from "node:http"
import { createService } from "./server.mjs"

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
  server.listen(options.port || 8080, options.host || "127.0.0.1")
  return server
}
