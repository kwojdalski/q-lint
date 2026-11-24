// A stand-in DOM for the small pages (media/dashboard.js, plots.js,
// tplog.js): pagedom.js's Element with what those pages build with -
// appendChild, an element emptied by its text - in a document that knows
// which element holds the focus.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Element, activeIn } = require("./pagedom.js");

class PageElement extends Element {
  appendChild(node) {
    this.append(node);
    return node;
  }
  get textContent() {
    return (this.text ?? "") + (this.children ?? []).map((c) => c.textContent ?? "").join("");
  }
  set textContent(text) {
    this.text = String(text);
    this.children = [];
  }
}

/// The page that `files` of media/ make, loaded in turn: its body, what it
/// posted, `send` to deliver a message to it, `active` for the element that
/// holds the focus and `find` for the elements of a tag.
function loadSmallPage(files, globals = {}) {
  const body = new PageElement("body");
  const posted = [];
  const listeners = [];
  Element.focused = undefined;
  const sandbox = {
    document: {
      body,
      createElement: (tag) => new PageElement(tag),
      createElementNS: (_ns, tag) => new PageElement(tag),
      createTextNode: (text) => ({ textContent: text }),
      // Finds nothing: a page that refocuses after drawing again does not here.
      querySelector: () => null,
      get activeElement() {
        return activeIn(body);
      },
    },
    window: { addEventListener: (type, f) => type === "message" && listeners.push(f) },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => {} }),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    unescape,
    encodeURIComponent,
    ...globals,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "media", file), "utf8"), sandbox, { filename: file });
  }
  return {
    body,
    posted,
    send: (data) => listeners.forEach((f) => f({ data })),
    active: () => activeIn(body),
    find: (tag) => body.all((e) => e.tagName === tag.toUpperCase()),
  };
}

module.exports = { PageElement, loadSmallPage };
