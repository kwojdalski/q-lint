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

/// The buttons in the page's bar and tabs, by their text.
const button = (page, text) => page.body.all((e) => e.tagName === "BUTTON" && e.textContent === text)[0];
const lastRendered = (page) => page.posted.filter((m) => m.type === "rendered").at(-1);

test("the results kept are tabs; choosing one asks for it, and it comes back with its own sort (#920)", () => {
  const page = loadPage(undefined);
  const history = [
    { id: "s.1", process: "p", code: "t", at: 0, rows: 5 },
    { id: "s.2", process: "p", code: "u", at: 1, rows: 3 },
  ];
  const one = { ...result("s.1", 5), history: history.slice(0, 1) };
  page.send(one);
  // One result: no tabs.
  assert.strictEqual(page.body.children[0].hidden, true);
  page.body.all((e) => e.tagName === "TH" && (e.title || "").startsWith("n:"))[0].fire("click");
  assert.deepStrictEqual(page.state.sort, { column: 0, descending: false });
  const two = result("s.2", 3);
  two.grid.columns[0].name = "m";
  page.send({ ...two, history });
  const tabs = page.body.children[0];
  assert.strictEqual(tabs.hidden, false);
  assert.deepStrictEqual(tabs.children.map((t) => t.textContent), ["1. t", "2. u"]);
  assert.strictEqual(tabs.children[1].attributes["aria-selected"], "true");
  assert.strictEqual(page.state.sort, null);
  assert.deepStrictEqual(lastRendered(page).rendered.history, { count: 2, index: 1 });
  tabs.children[0].fire("click");
  assert.deepStrictEqual(page.posted.at(-1), { type: "select", id: "s.2", pick: "s.1" });
  // The extension sends it again: as it was left.
  page.send({ ...one, history });
  assert.deepStrictEqual(page.state.sort, { column: 0, descending: false });
  assert.deepStrictEqual(lastRendered(page).rendered.history, { count: 2, index: 0 });
});

test("Compare marks changed cells with what they were, new rows, and lists the removed ones (#919)", () => {
  const page = loadPage(undefined);
  const m = result("s.2", 3);
  m.diff = {
    process: "p",
    at: 0,
    matchedBy: "place",
    changes: [[0, 1, "7"]],
    changed: 1,
    addedRows: [2],
    addedColumns: [],
    removedColumns: [],
    removed: { columns: ["n"], rows: [["9"]], count: 1 },
  };
  page.send(m);
  // Off until asked for.
  assert.strictEqual(lastRendered(page).rendered.diff, undefined);
  button(page, "Compare").fire("click");
  assert.deepStrictEqual(lastRendered(page).rendered.diff, { changed: 1, added: 1, removed: 1, matchedBy: "place" });
  const [r0, r1, r2] = page.rows();
  assert.doesNotMatch(r0.children[0].className, /changed/);
  assert.match(r1.children[0].className, /changed/);
  assert.strictEqual(r1.children[0].title, "1\nwas: 7");
  assert.strictEqual(r2.className, "added");
  const removed = page.body.all((e) => e.tagName === "DETAILS")[0];
  assert.match(removed.children[0].textContent, /^1 row removed since the previous run/);
  assert.ok(page.body.all((e) => e.className === "diff-summary")[0].textContent.includes("1 changed, 1 added, 1 removed"));
  // The command asks for it too, once.
  const again = loadPage(undefined);
  again.send({ ...m, control: { key: "k.1", action: "compare" } });
  assert.strictEqual(again.state.compare, true);
  again.body.all((e) => e.tagName === "BUTTON" && e.textContent === "Compare")[0].fire("click");
  again.send({ ...m, control: { key: "k.1", action: "compare" } });
  assert.strictEqual(again.state.compare, false);
});

test("the heatmap colours a numeric column's cells by value, and its button asks the extension to switch it (#924)", () => {
  const page = loadPage(undefined);
  page.send({ ...result("s.1", 5), heatmap: true });
  const colours = page.rows().map((tr) => tr.children[0].style.backgroundColor);
  assert.match(colours[0], /--vscode-charts-blue.* 6%/);
  assert.match(colours[4], /--vscode-charts-blue.* 56%/);
  assert.strictEqual(lastRendered(page).rendered.heat, 5);
  button(page, "Heatmap").fire("click");
  assert.deepStrictEqual(page.posted.at(-1), { type: "heatmap", id: "s.1" });
  // Off: no colour.
  page.send({ ...result("s.1", 5), heatmap: false });
  assert.strictEqual(page.rows()[4].children[0].style.backgroundColor, undefined);
});

test("Stats shows each column's count, nulls, distinct, min, max and mean over the rows shown (#923)", () => {
  const page = loadPage(undefined);
  page.send({ ...result("s.1", 5), control: { key: "k.1", action: "view", view: "stats" } });
  const r = lastRendered(page).rendered;
  assert.strictEqual(r.view, "stats");
  assert.deepStrictEqual(r.stats, [{ name: "n", type: "long (j)", count: 5, nulls: 0, distinct: 5, min: "0", max: "4", mean: "2" }]);
  // The grid's filter applies.
  button(page, "Grid").fire("click");
  const filter = page.body.all((e) => e.tagName === "INPUT" && e.type === "search")[0];
  filter.value = "4";
  filter.fire("input");
  button(page, "Stats").fire("click");
  assert.deepStrictEqual(lastRendered(page).rendered.stats[0].count, 1);
  assert.match(page.body.all((e) => e.className === "note").at(-1).textContent, /^Over the 1 row shown \(the grid's filters apply\)/);
});

test("Tree shows a dictionary level by level: its entries, then a node's children once opened (#928)", () => {
  const page = loadPage(undefined);
  const tree = {
    key: "",
    text: "",
    type: 99,
    count: 2,
    children: [
      { key: "a", text: "1", type: -7, count: 1, children: [] },
      { key: "b", text: "", type: 0, count: 5, children: [{ key: "0", text: "`x", type: -11, count: 1, children: [] }] },
    ],
  };
  page.send({ ...result("s.1", 2), tree });
  assert.ok(button(page, "Tree"), "a Tree button for a result with a tree");
  button(page, "Tree").fire("click");
  let r = lastRendered(page).rendered;
  assert.strictEqual(r.view, "tree");
  assert.deepStrictEqual(r.tree.labels, ["dictionary of 2", "0 a: 1", "1 b: list of 5"]);
  const twist = page.body.all((e) => e.tagName === "BUTTON" && (e.attributes || {})["aria-label"] === "Open b")[0];
  twist.fire("click");
  r = lastRendered(page).rendered;
  assert.deepStrictEqual(r.tree.labels.slice(2), ["1 b: list of 5", "1/0 0: `x"]);
  assert.deepStrictEqual(page.state.open, ["", "1"]);
  const more = page.body.all((e) => e.className === "tree-more")[0];
  assert.strictEqual(more.textContent, "4 more not sent: the tree is cut at 2,000 nodes");
  // A result without a tree has no Tree view, and falls back to the grid.
  page.send({ ...result("s.2", 2), control: { key: "k.1", action: "view", view: "tree" } });
  assert.strictEqual(button(page, "Tree"), undefined);
  assert.strictEqual(lastRendered(page).rendered.view, "grid");
});

test("statistics and the heatmap turned off: no Stats view or Heatmap button, and a request for Stats shows the grid", () => {
  const page = loadPage(undefined);
  page.send({ ...result("s.1", 3), features: { statistics: false, heatmap: false }, control: { key: "k.1", action: "view", view: "stats" } });
  assert.strictEqual(button(page, "Stats"), undefined);
  assert.strictEqual(button(page, "Heatmap"), undefined);
  assert.strictEqual(lastRendered(page).rendered.view, "grid");
  // On: both offered.
  page.send({ ...result("s.1", 3), features: { statistics: true, heatmap: true } });
  assert.ok(button(page, "Stats") && button(page, "Heatmap"));
});
