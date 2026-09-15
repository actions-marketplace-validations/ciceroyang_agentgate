import { createServer } from "node:http"
import { createService } from "./server.mjs"

export function start(options) {
  const service = createService(options)
  const server = createServer(function (req, res) {
    const out = service.handle(req.method, req.url)
    res.writeHead(out.status, { "content-type": out.type })
    res.end(out.body)
  })
  server.listen(options.port || 8080, options.host || "127.0.0.1")
  return server
}
