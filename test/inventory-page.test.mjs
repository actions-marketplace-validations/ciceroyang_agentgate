import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseInventory, createInventoryReport } from "../packages/inventory/src/inventory.mjs";
import { renderInventoryReport } from "../packages/inventory/src/report.mjs";

const pageSource = readFileSync(new URL("../site/inventory-page.mjs", import.meta.url), "utf8");
const template = readFileSync(new URL("../site/inventory.html", import.meta.url), "utf8");

// Only the DOM operations used by this page's event handlers. No layout, HTML parser,
// networking or general browser emulation: real-browser checks cover those separately.
function page() {
  const document = { activeElement: null };
  const downloads = [], blobs = new Map(), revoked = [];
  const find = (node, predicate) => {
    for (const child of node.children) {
      if (predicate(child)) return child;
      const nested = find(child, predicate);
      if (nested) return nested;
    }
    return null;
  };
  class Node {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.parentNode = null; this.dataset = {};
      this.className = ""; this.listeners = {}; this._text = ""; this._value = "";
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name, on) => {
          const names = new Set(this.className.split(/\s+/).filter(Boolean));
          if (on) names.add(name); else names.delete(name);
          this.className = [...names].join(" ");
        },
      };
    }
    set textContent(text) { this.replaceChildren(); this._text = String(text); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set value(value) { this._value = String(value); this.selectionStart = this.selectionEnd = this._value.length; }
    get value() { return this._value; }
    get childElementCount() { return this.children.length; }
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) {
      if (find(this, node => node === document.activeElement)) document.activeElement = null;
      for (const child of this.children) child.parentNode = null;
      this.children = []; this._text = ""; this.append(...children);
    }
    setAttribute(name, value) { this[name] = String(value); }
    removeAttribute(name) { delete this[name]; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    focus() { document.activeElement = this; }
    querySelector(selector) {
      const entry = /^\[data-entry="([^"]+)"\]$/.exec(selector);
      const match = entry ? node => node.dataset.entry === entry[1]
        : selector.startsWith(".") ? node => node.classList.contains(selector.slice(1))
        : node => node.tagName === selector;
      return find(this, match);
    }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    click() { if (this.tagName === "a") downloads.push({ href: this.href, filename: this.download }); }
  }
  document.body = new Node("body");
  document.createElement = tag => new Node(tag);
  document.createTextNode = text => { const node = new Node("#text"); node.textContent = text; return node; };
  document.getElementById = id => find(document.body, node => node.id === id);
  // Seed actual template IDs and initial disabled/hidden flags; generated cards are made
  // exclusively by the production page script.
  for (const match of template.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Node(match[1]); node.id = match[2];
    node.hidden = /\shidden\b/.test(match[0]); node.disabled = /\sdisabled\b/.test(match[0]);
    document.body.append(node);
  }
  const records = ["1.0.0", "2.0.0"].map(version => ({
    server: "acme/tool", verdict: "clean", generatedAt: "2026-09-17T00:00:00Z",
    packages: [{ registry: "npm", name: "@acme/tool", version }],
    evidence: { packageManifest: { status: "clean", source: "fixture", findings: [], provenance: {
      package: { registry: "npm", name: "@acme/tool", version }, complete: true,
      content: { algorithm: "sha256", digest: "a".repeat(64), scope: "package manifest only" },
    } } },
  }));
  const get = document.getElementById;
  get("inventory-index").textContent = JSON.stringify({ snapshot: false, generatedAt: "2026-09-17T00:00:00Z", records });
  // Supply real module exports in place of the browser's two relative imports. The
  // production event registrations, handlers and rendering functions run unchanged.
  const script = pageSource.replace(/^import .+ from "\.\/inventory(?:-report)?\.mjs";\n/gm, "");
  assert.doesNotMatch(script, /^import /m);
  runInNewContext(script, {
    document, parseInventory, createInventoryReport, renderInventoryReport, TextEncoder, Blob, Error,
    URL: {
      createObjectURL: blob => { const url = "blob:local-" + (blobs.size + revoked.length + 1); blobs.set(url, blob); return url; },
      revokeObjectURL: url => { revoked.push(url); blobs.delete(url); },
    },
  });
  const fire = (id, type, target = get(id)) => {
    for (const handler of get(id).listeners[type] || []) handler({ target, preventDefault() {} });
    assert.equal(get("page-error").hidden, true, get("page-error").textContent);
  };
  const load = versions => {
    get("inventory-input").value = JSON.stringify(versions.map(version => ({ name: "acme/tool", version })));
    fire("inventory-form", "submit");
  };
  return { document, get, fire, load, downloads, blobs, revoked };
}

test("version edits update the candidate and preview while preserving the active input and caret", () => {
  const p = page(); p.load(["1.0.0"]);
  const select = p.get("tool-candidate-0"), version = p.get("tool-version-0");
  assert.match(select.value, /1\.0\.0/);
  version.focus(); version.value = "2.0.0"; version.selectionStart = version.selectionEnd = 2;
  p.fire("inventory-items", "input", version);
  assert.equal(p.get("tool-version-0"), version, "typing must not replace the input node");
  assert.equal(p.document.activeElement, version);
  assert.equal(version.selectionStart, 2);
  assert.equal(version.selectionEnd, 2);
  assert.match(select.value, /2\.0\.0/);
  assert.match(select.children.find(option => option.value === select.value).textContent, /2\.0\.0/);
  const card = p.get("inventory-items").querySelector('[data-entry="tool-1"]');
  assert.match(card.querySelector(".version-reference").textContent, /2\.0\.0/);
  p.fire("preview-button", "click");
  assert.match(p.get("report-preview").srcdoc, /目录版本<\/th><td>2\.0\.0/);
});

test("a version edit that creates or resolves duplicates refreshes both rows", () => {
  const p = page(); p.load(["1.0.0", "2.0.0"]);
  const cards = ["tool-1", "tool-2"].map(id => p.get("inventory-items").querySelector('[data-entry="' + id + '"]'));
  for (const card of cards) assert.match(card.querySelector(".state").textContent, /版本与证据对应/);
  const version = p.get("tool-version-1"); version.focus(); version.value = "1.0.0";
  p.fire("inventory-items", "input", version);
  for (const card of cards) {
    assert.match(card.querySelector(".state").textContent, /证据不足/);
    assert.match(card.querySelector(".item-reason").textContent, /重复/);
    assert.equal(card.querySelector("select").value, "");
  }
  assert.equal(p.document.activeElement, version);
  version.value = "2.0.0";
  p.fire("inventory-items", "input", version);
  for (const card of cards) {
    assert.match(card.querySelector(".state").textContent, /版本与证据对应/);
    assert.doesNotMatch(card.querySelector(".item-reason").textContent, /重复/);
  }
});

test("editing the source inventory revokes the old download and clears the old preview", () => {
  const p = page(); p.load(["1.0.0"]);
  p.fire("preview-button", "click");
  assert.equal(p.get("download-button").disabled, false);
  assert.match(p.get("report-preview").srcdoc, /工具清单/);
  p.fire("download-button", "click");
  assert.equal(p.downloads.length, 1);
  const oldUrl = p.downloads[0].href;
  assert.ok(p.blobs.has(oldUrl));
  p.get("inventory-input").value = "different/tool";
  p.fire("inventory-input", "input");
  assert.equal(p.get("download-button").disabled, true);
  assert.equal(p.get("preview-section").hidden, true);
  assert.equal(p.get("results-section").hidden, true);
  assert.equal(p.get("report-preview").srcdoc, undefined);
  assert.ok(p.revoked.includes(oldUrl));
  assert.equal(p.blobs.has(oldUrl), false);
  // Even invoking the handler directly cannot export stale data after invalidation.
  p.fire("download-button", "click");
  assert.equal(p.downloads.length, 1);
});
