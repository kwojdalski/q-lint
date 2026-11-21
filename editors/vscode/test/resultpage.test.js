// The result page's webview half (media/result.js), run under node in a
// small stand-in for the page's DOM: what it draws, keeps and says back to
// the extension as the user scrolls, sorts and the page reloads.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROW = 22;

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
  addEventListener(type, f) {
    (this.listeners[type] ??= []).push(f);
  }
  fire(type, event = {}) {
    for (const f of this.listeners[type] ?? []) {
      f({ target: this, preventDefault() {}, ...event });
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

/// A page loaded with `saved` as its webview state: its body, what it
/// posted, its state, and `send` to deliver a message to it.
function loadPage(saved) {
  const posted = [];
  const page = { posted, state: saved };
  const windowListeners = {};
  const body = new Element("body");
  const sandbox = {
    console,
    document: { body, createElement: (t) => new Element(t), createTextNode: (t) => ({ textContent: t }) },
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
  sandbox.self = sandbox;
  sandbox.window = { addEventListener: (type, f) => (windowListeners[type] ??= []).push(f) };
  vm.createContext(sandbox);
  for (const file of ["chartspec.js", "result.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "media", file), "utf8"), sandbox, { filename: file });
  }
  page.body = body;
  page.send = (data) => {
    for (const f of windowListeners.message ?? []) f({ data });
  };
  page.scroller = () => body.all((e) => e.className === "scroller")[0];
  page.rows = () => body.all((e) => e.tagName === "TBODY")[0].children.filter((tr) => tr.className !== "spacer");
  return page;
}

/// A result of one long column `n` holding 0 .. count-1.
function result(id, count) {
  const cells = Array.from({ length: count }, (_, i) => String(i));
  return {
    type: "result",
    id,
    view: "grid",
    process: "p",
    code: "t",
    millis: 1,
    limit: 10000,
    grid: {
      columns: [{ name: "n", type: 7, typeName: "long (j)", key: false, numeric: true, temporal: false }],
      cells: [cells],
      rank: [cells.map((_, i) => i)],
      values: [cells.map(Number)],
      total: count,
    },
  };
}

test("scrolling within the rows drawn keeps them, so a selection in the grid is not lost", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", 1000));
  const scroller = page.scroller();
  const before = page.rows();
  assert.strictEqual(before[0].children[0].textContent, "0");
  // A wheel's notch: the same rows are in range, and the user's selected
  // cells must still be the ones in the page.
  scroller.scrollTop = 3 * ROW;
  scroller.fire("scroll");
  const after = page.rows();
  assert.strictEqual(after.length, before.length);
  assert.ok(after.every((tr, i) => tr === before[i]), "the rows drawn were replaced");
  // Far enough, and they are drawn afresh.
  scroller.scrollTop = 500 * ROW;
  scroller.fire("scroll");
  assert.notStrictEqual(page.rows()[0], before[0]);
  assert.strictEqual(page.rows()[0].children[0].textContent, String(500 - 20));
});
