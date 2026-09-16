import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const SITE = new URL("../../../site/", import.meta.url)
const ASSETS = new Map([
  ["/inventory-page.mjs", [new URL("inventory-page.mjs", SITE), "text/javascript; charset=utf-8"]],
  ["/inventory.mjs", [new URL("./inventory.mjs", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/inventory-report.mjs", [new URL("./report.mjs", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/favicon.svg", [new URL("favicon.svg", SITE), "image/svg+xml"]],
])

export function renderInventoryPage(template, index) {
  if (!template.includes("__INVENTORY_INDEX__")) throw new Error("inventory template has no data placeholder")
  // Public registry strings can contain closing script tags and replacement tokens.
  const json = JSON.stringify(index).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
  return template.replace("__INVENTORY_INDEX__", function () { return json })
}

export function inventoryResource(path, load) {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }
  if (path === "/inventory.html") {
    const loaded = load()
    if (!loaded) return { status: 503, type: "text/plain; charset=utf-8", body: "没有可用的证据索引，暂时不能生成工具清单报告。", headers }
    const template = readFileSync(new URL("inventory.html", SITE), "utf8")
    return { status: 200, type: "text/html; charset=utf-8", body: renderInventoryPage(template, loaded.data), headers }
  }
  const asset = ASSETS.get(path)
  if (!asset) return null
  return { status: 200, type: asset[1], body: readFileSync(fileURLToPath(asset[0]), "utf8"), headers }
}
