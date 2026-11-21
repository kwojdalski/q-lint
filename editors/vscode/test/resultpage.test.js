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
  setAttribute(name, value) {
    (this.attributes ??= {})[name] = String(value);
  }
  focus() {
    Element.focused = this;
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

test("a page hidden and shown again, which reloads it, is back where its grid was scrolled to", () => {
  // A result tab put behind another, or the q Results view hidden, loses
  // its page; shown again, it reloads from its saved state.
  const first = loadPage(undefined);
  first.send(result("s.1", 1000));
  first.scroller().scrollTop = 500 * ROW;
  first.scroller().fire("scroll");
  const again = loadPage(first.state);
  again.send(result("s.1", 1000));
  assert.strictEqual(again.scroller().scrollTop, 500 * ROW);
  assert.strictEqual(again.rows()[0].children[0].textContent, String(500 - 20));
  // A new result starts at its top.
  const next = loadPage(again.state);
  next.send(result("s.2", 1000));
  assert.strictEqual(next.scroller().scrollTop, 0);
});

test("a column sorts from the keyboard: its header takes the focus, and Enter or Space sorts", () => {
  // The header sorted on a click only: it could not be tabbed to, and a
  // keyboard or screen-reader user could not sort at all.
  const page = loadPage(undefined);
  page.send(result("s.1", 5));
  const header = () => page.body.all((e) => e.tagName === "TH" && (e.title || "").startsWith("n:"))[0];
  assert.strictEqual(header().tabIndex, 0);
  assert.strictEqual(header().attributes["aria-sort"], "none");
  header().fire("keydown", { key: "Enter" });
  assert.strictEqual(page.state.sort.column, 0);
  assert.strictEqual(page.state.sort.descending, false);
  assert.strictEqual(header().attributes["aria-sort"], "ascending");
  // Still focused, though the header was drawn again.
  assert.strictEqual(Element.focused, header());
  header().fire("keydown", { key: " " });
  assert.strictEqual(page.state.sort.descending, true);
  assert.strictEqual(page.rows()[0].children[0].textContent, "4");
  header().fire("keydown", { key: "a" });
  assert.strictEqual(page.state.sort.descending, true);
});
