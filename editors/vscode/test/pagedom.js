// A small stand-in for the result page's DOM, to run media/result.js and
// the scripts it loads under node: test/resultlook_page.test.js's harness.
// (test/resultpage.test.js has its own, older one.)
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.listeners = {};
    this.className = "";
    this.textContent = "";
    this.scrollTop = 0;
    this.clientHeight = tag === "div" ? 220 : 0;
  }
  append(...nodes) {
    for (const n of nodes) {
      this.children.push(n);
      n.parent = this;
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) {
    (this.attributes ??= {})[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes?.[name] ?? null;
  }
  focus() {
    Element.focused = this;
  }
  addEventListener(type, f) {
    (this.listeners[type] ??= []).push(f);
  }
  fire(type, event = {}) {
    for (const f of this.listeners[type] ?? []) {
      f({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
  /// Every element under this one, depth first, that `match` accepts.
  all(match) {
    const out = [];
    const walk = (e) => {
      for (const c of e.children ?? []) {
        if (match(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

/// The element that holds the focus in the page under `body`, as
/// document.activeElement has it: the body, once that element left the page.
function activeIn(body) {
  const focused = Element.focused;
  return focused && body.all((e) => e === focused).length > 0 ? focused : body;
}

/// A Chart.js stand-in: it keeps its configuration, counts its draws and
/// updates, and maps pixels to values one to one.
class FakeChart {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;
    this.options = config.options;
    this.draws = 0;
    this.updates = 0;
    this.scales = { x: { getValueForPixel: (px) => px, getPixelForValue: (v) => v } };
    FakeChart.made.push(this);
  }
  draw() {
    this.draws++;
  }
  update() {
    this.updates++;
  }
  destroy() {
    this.destroyed = true;
  }
}
FakeChart.defaults = { font: {} };
FakeChart.made = [];

/// A page loaded with `saved` as its webview state: its body, what it
/// posted, its state, `send` to deliver a message to it and `fireWindow`
/// to fire a window event.
function loadPage(saved, globals = {}) {
  const posted = [];
  const page = { posted, state: saved };
  const windowListeners = {};
  const body = new Element("body");
  const sandbox = {
    console,
    document: { body, createElement: (t) => new Element(t), createTextNode: (t) => ({ textContent: t }), get activeElement() { return activeIn(body); } },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    MutationObserver: class {
      observe() {}
    },
    acquireVsCodeApi: () => ({
      getState: () => page.state,
      setState: (s) => (page.state = JSON.parse(JSON.stringify(s))),
      postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))),
    }),
  };
  Object.assign(sandbox, globals);
  sandbox.self = sandbox;
  sandbox.window = { addEventListener: (type, f) => (windowListeners[type] ??= []).push(f) };
  vm.createContext(sandbox);
  for (const file of ["chartspec.js", "gridlook.js", "worldoutline.js", "chartmore.js", "refocus.js", "result.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "media", file), "utf8"), sandbox, { filename: file });
  }
  page.body = body;
  page.send = (data) => {
    for (const f of windowListeners.message ?? []) f({ data });
  };
  page.fireWindow = (type, event = {}) => {
    for (const f of windowListeners[type] ?? []) f(event);
  };
  page.rows = () => body.all((e) => e.tagName === "TBODY")[0].children.filter((tr) => tr.className !== "spacer");
  page.headers = () => body.all((e) => e.tagName === "TH" && e.parent?.className !== "filters" && e.parent?.parent?.tagName === "THEAD");
  page.button = (text) => body.all((e) => e.tagName === "BUTTON" && e.textContent === text)[0];
  page.rendered = () => posted.filter((m) => m.type === "rendered").at(-1)?.rendered;
  return page;
}

module.exports = { Element, FakeChart, loadPage, activeIn };
