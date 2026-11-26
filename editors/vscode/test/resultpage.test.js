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
function loadPage(saved, globals = {}) {
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

test("a result run again in place with other columns keeps its filter, sort, pivot and chart picks on the columns they were set on (#3071)", () => {
  // A table of long columns, three rows each.
  const table = (columns) => ({
    ...result("s.1", 3),
    grid: {
      columns: Object.keys(columns).map((name) => ({ name, type: 7, typeName: "long (j)", key: false, numeric: true, temporal: false })),
      cells: Object.values(columns).map((c) => c.map(String)),
      rank: Object.values(columns).map((c) => c.map((v) => [...c].sort((a, b) => a - b).indexOf(v))),
      values: Object.values(columns),
      total: 3,
    },
  });
  const filters = (page) => page.body.all((e) => e.tagName === "INPUT" && e.type === "search");
  const header = (page, name) => page.body.all((e) => e.tagName === "TH" && (e.title || "").startsWith(`${name}:`))[0];
  const one = { time: [900, 901, 902], AAPL: [150, 151, 152], MSFT: [300, 301, 302] };
  const page = loadPage(undefined);
  page.send(table(one));
  filters(page)[1].value = "151";
  filters(page)[1].fire("input");
  header(page, "MSFT").fire("click");
  header(page, "MSFT").fire("click");
  assert.deepStrictEqual(page.state.sort, { column: 2, descending: true });
  // The watched query's next run, under the same id: a column before them.
  page.send(table({ time: one.time, AAA: [151, 7, 8], AAPL: one.AAPL, MSFT: one.MSFT }));
  assert.deepStrictEqual(filters(page).map((f) => f.value), ["", "", "151", ""]);
  assert.deepStrictEqual(page.state.sort, { column: 3, descending: true });
  assert.deepStrictEqual(page.rows().map((r) => r.children.map((c) => c.textContent)), [["901", "7", "151", "301"]]);
  // A column gone takes its filter and the sort on it with it.
  page.send(table({ time: one.time, AAPL: one.AAPL }));
  assert.deepStrictEqual(filters(page).map((f) => f.value), ["", "151"]);
  assert.strictEqual(page.state.sort, null);
  page.send(table({ time: one.time, MSFT: one.MSFT }));
  assert.deepStrictEqual(filters(page).map((f) => f.value), ["", ""]);
  assert.strictEqual(page.rows().length, 3);
  // The pivot, the ticked chart columns and the right axis, the same way.
  const kept = { id: "s.1", names: Object.keys(one).join("\u0000"), pivot: { row: 0, column: -1, value: 2, agg: "max" }, columns: [1, 2], y2: 2, mapSize: 1, mapColour: 2 };
  const again = loadPage(kept);
  again.send(table({ time: one.time, AAA: [151, 7, 8], AAPL: one.AAPL, MSFT: one.MSFT }));
  assert.deepStrictEqual(again.state.pivot, { row: 0, column: -1, value: 3, agg: "max" });
  assert.deepStrictEqual(again.state.columns, [2, 3]);
  assert.deepStrictEqual([again.state.y2, again.state.mapSize, again.state.mapColour], [3, 2, 3]);
  // A pivot one of whose columns is gone starts again; a pick gone is dropped.
  again.send(table({ time: one.time, AAPL: one.AAPL }));
  assert.strictEqual(again.state.pivot, null);
  assert.deepStrictEqual(again.state.columns, [1]);
  assert.deepStrictEqual([again.state.y2, again.state.mapSize, again.state.mapColour], [-1, 1, -1]);
  // The same columns again: nothing moves.
  again.send(table({ time: one.time, AAPL: one.AAPL }));
  assert.deepStrictEqual(again.state.columns, [1]);
  // Every ticked column gone: the chart chooses again, as for a new result.
  again.send(table({ time: one.time, MSFT: one.MSFT }));
  assert.strictEqual(again.state.columns, null);
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

// --- wave two: export formats (#921), paging (#922), pivot (#925), charts
// (#926) and drill-down (#927)

/// A result of a symbol column `s` and a long column `n`, for a pivot.
function symbols(id) {
  const s = ["b", "a", "b", "a"];
  const n = ["1", "2", "3", "4"];
  return {
    ...result(id, 4),
    grid: {
      columns: [
        { name: "s", type: 11, typeName: "symbol (s)", key: false, numeric: false, temporal: false },
        { name: "n", type: 7, typeName: "long (j)", key: false, numeric: true, temporal: false },
      ],
      cells: [s, n],
      rank: [[1, 0, 1, 0], [0, 1, 2, 3]],
      values: [null, n.map(Number)],
      total: 4,
    },
  };
}

test("Pivot sums a numeric column by the first other one, and its controls change it (#925)", () => {
  const page = loadPage(undefined);
  page.send({ ...symbols("s.1"), control: { key: "k.1", action: "view", view: "pivot" } });
  const pivot = lastRendered(page).rendered.pivot;
  assert.deepStrictEqual(pivot, { rows: 2, columns: ["s", "sum"], first: ["a", "6"] });
  // Its aggregation, from its select: the last of the four.
  const selects = page.body.all((e) => e.tagName === "SELECT");
  const as = selects[3];
  as.value = "count";
  as.fire("change");
  assert.deepStrictEqual(lastRendered(page).rendered.pivot.first, ["a", "2"]);
  button(page, "Copy Pivot").fire("click");
  assert.deepStrictEqual(page.posted.at(-1), { type: "copyText", id: "s.1", text: "s,count\na,2\nb,2\n" });
  // Turned off: no Pivot view, and a request for it shows the grid.
  page.send({ ...symbols("s.2"), features: { pivot: false }, control: { key: "k.2", action: "view", view: "pivot" } });
  assert.strictEqual(button(page, "Pivot"), undefined);
  assert.strictEqual(lastRendered(page).rendered.view, "grid");
});

test("Export as... asks the extension for the rows shown, and is gone with export turned off (#921)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", 3));
  button(page, "Export as...").fire("click");
  assert.deepStrictEqual(page.posted.at(-1), { type: "exportAs", id: "s.1", rows: [0, 1, 2] });
  page.send({ ...result("s.1", 3), features: { export: false } });
  assert.strictEqual(button(page, "Export as..."), undefined);
  assert.ok(button(page, "Export to CSV"));
});

test("a grid the process holds more of asks for the next page once, as it reaches the end (#922)", () => {
  const page = loadPage(undefined);
  page.send({ ...result("s.1", 5), more: true, grid: { ...result("s.1", 5).grid, total: 50 } });
  const asked = page.posted.filter((m) => m.type === "more");
  assert.deepStrictEqual(asked, [{ type: "more", id: "s.1" }]);
  assert.ok(button(page, "Load more"));
  assert.match(page.body.all((e) => e.className === "info")[0].textContent, /5 of 50 rows: more as the grid scrolls/);
  // Scrolling again before the page comes asks nothing more.
  page.scroller().fire("scroll");
  assert.strictEqual(page.posted.filter((m) => m.type === "more").length, 1);
  // Without it, nothing is asked, and the cut is said as before.
  const plain = loadPage(undefined);
  plain.send({ ...result("s.1", 5), grid: { ...result("s.1", 5).grid, total: 50 } });
  assert.strictEqual(plain.posted.filter((m) => m.type === "more").length, 0);
  assert.strictEqual(button(plain, "Load more"), undefined);
});

test("a page that could not be fetched for now is asked for again on a scroll, not at once as the grid is drawn again (#1634)", () => {
  const page = loadPage(undefined);
  const held = { ...result("s.1", 5), more: true, paused: true, grid: { ...result("s.1", 5).grid, total: 50 } };
  page.send(held);
  assert.strictEqual(page.posted.filter((m) => m.type === "more").length, 0);
  page.send({ ...result("s.2", 100), more: true, paused: true, grid: { ...result("s.2", 100).grid, total: 500 } });
  page.scroller().scrollTop = 100 * ROW;
  page.scroller().fire("scroll");
  assert.deepStrictEqual(page.posted.filter((m) => m.type === "more"), [{ type: "more", id: "s.2" }]);
});

test("a page added to a grid spread over the scrollbar keeps the rows in view, and asks for no more until scrolled (#1635)", () => {
  const page = loadPage(undefined);
  const held = (n) => ({ ...result("s.1", n), more: true, grid: { ...result("s.1", n).grid, total: 2000000 } });
  page.send(held(700000));
  const scroller = page.scroller();
  scroller.scrollTop = 15000000 - scroller.clientHeight;
  scroller.fire("scroll");
  assert.strictEqual(page.posted.filter((m) => m.type === "more").length, 1);
  const first = page.rows()[0].children[0].textContent;
  page.send(held(710000));
  assert.strictEqual(page.posted.filter((m) => m.type === "more").length, 1, "the new page is not at the end of the view");
  assert.strictEqual(page.rows()[0].children[0].textContent, first);
  // Scrolled to the end again: the next page.
  const again = page.scroller();
  again.scrollTop = 15000000 - again.clientHeight;
  again.fire("scroll");
  assert.strictEqual(page.posted.filter((m) => m.type === "more").length, 2);
});

test("a result paged past gridLimit and then stopped is not said to be cut at the limit (#1644)", () => {
  const page = loadPage(undefined);
  page.send({ ...result("s.1", 4), limit: 2, more: false, grid: { ...result("s.1", 4).grid, total: 10 } });
  assert.strictEqual(page.body.all((e) => e.className === "info")[0].textContent, "4 of 10 rows: no more were fetched");
  page.send({ ...result("s.2", 2), limit: 2, grid: { ...result("s.2", 2).grid, total: 10 } });
  assert.strictEqual(page.body.all((e) => e.className === "info")[0].textContent, "2 of 10 rows: cut at q-lint.query.gridLimit (2)");
});

test("a double-clicked cell asks to drill down from it, and carries its menu context; off, neither (#927)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", 3));
  const cell = page.rows()[2].children[0];
  assert.deepStrictEqual(JSON.parse(cell.attributes["data-vscode-context"]), { webviewSection: "cell", column: 0, row: 2, preventDefaultContextMenuItems: false });
  const body = page.body.all((e) => e.tagName === "TBODY")[0];
  body.fire("dblclick", { target: cell });
  assert.deepStrictEqual(page.posted.at(-1), { type: "drill", id: "s.1", column: 0, row: 2 });
  // With the run it drew, which a watched query's next run changes under the same id (#2504).
  page.send({ ...result("s.1", 3), run: 7 });
  page.body.all((e) => e.tagName === "TBODY")[0].fire("dblclick", { target: page.rows()[1].children[0] });
  assert.deepStrictEqual(page.posted.at(-1), { type: "drill", id: "s.1", run: 7, column: 0, row: 1 });
  const copy = page.body.all((e) => e.tagName === "BUTTON" && e.textContent === "Copy as CSV")[0];
  copy.fire("click");
  assert.deepStrictEqual([page.posted.at(-1).type, page.posted.at(-1).run], ["copy", 7]);
  page.send(result("s.1", 3));
  page.send({ ...result("s.2", 3), features: { drilldown: false, editCells: false } });
  const off = page.rows()[0].children[0];
  assert.strictEqual(off.attributes?.["data-vscode-context"], undefined);
  assert.strictEqual((page.body.all((e) => e.tagName === "TBODY")[0].listeners.dblclick ?? []).length, 0);
});

test("a cell carries its menu context for Edit Cell, and a column header for Wrangle Column, only while each is on (#961, #964)", () => {
  const page = loadPage(undefined);
  page.send({ ...result("s.1", 3), features: { drilldown: false } });
  const cell = page.rows()[1].children[0];
  assert.deepStrictEqual(JSON.parse(cell.attributes["data-vscode-context"]), { webviewSection: "cell", column: 0, row: 1, preventDefaultContextMenuItems: false });
  // Each names the result it is of, by its run (#2076).
  page.send({ ...result("s.1", 3), run: 7, features: { drilldown: false } });
  assert.strictEqual(JSON.parse(page.rows()[1].children[0].attributes["data-vscode-context"]).run, 7);
  assert.strictEqual(JSON.parse(page.body.all((e) => e.tagName === "TH" && e.attributes?.["data-vscode-context"] !== undefined)[0].attributes["data-vscode-context"]).run, 7);
  page.send({ ...result("s.1", 3), features: { drilldown: false } });
  // Edit Cell is a menu item only: a double-click still drills down, and that is off.
  assert.strictEqual((page.body.all((e) => e.tagName === "TBODY")[0].listeners.dblclick ?? []).length, 0);
  const header = page.body.all((e) => e.tagName === "TH" && e.attributes?.["data-vscode-context"] !== undefined)[0];
  assert.deepStrictEqual(JSON.parse(header.attributes["data-vscode-context"]), { webviewSection: "column", column: 0, columnKind: "numeric", preventDefaultContextMenuItems: false });
  // The header's menu also offers conditional formats, cell charts and the layout (#1013-#1015).
  page.send({ ...result("s.2", 3), features: { drilldown: false, editCells: false, wrangler: false, conditionalFormats: false, cellCharts: false, columnLayout: false } });
  assert.strictEqual(page.rows()[0].children[0].attributes?.["data-vscode-context"], undefined);
  assert.strictEqual(page.body.all((e) => e.tagName === "TH" && e.attributes?.["data-vscode-context"] !== undefined).length, 0);
});

test("the chart offers area, step and candles, a right axis and image buttons only while charts are on (#926)", () => {
  const page = loadPage(undefined);
  const twoSeries = {
    ...result("s.1", 3),
    view: "chart",
    grid: {
      columns: ["t", "a", "b"].map((name) => ({ name, type: 7, typeName: "long (j)", key: false, numeric: true, temporal: false })),
      cells: [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]],
      rank: [[0, 1, 2], [0, 1, 2], [0, 1, 2]],
      values: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
      total: 3,
    },
  };
  page.send(twoSeries);
  const options = () => page.body.all((e) => e.tagName === "SELECT")[0].children.map((o) => o.value);
  assert.deepStrictEqual(options(), ["line", "bar", "scatter", "histogram", "area", "step", "candlestick", "linked"]);
  assert.ok(button(page, "Save PNG") && button(page, "Save SVG"));
  assert.strictEqual(page.body.all((e) => e.tagName === "SELECT").length, 2);
  // A request for an image, with no chart drawn here (no Chart.js), answers empty.
  page.send({ ...twoSeries, control: { key: "k.1", action: "image", format: "svg" } });
  assert.deepStrictEqual(page.posted.at(-1), { type: "image", id: "s.1", format: "svg", data: "", key: "k.1" });
  page.send({ ...twoSeries, features: { charts: false, linkedCharts: false } });
  assert.deepStrictEqual(options(), ["line", "bar", "scatter", "histogram"]);
  assert.strictEqual(button(page, "Save PNG"), undefined);
  assert.strictEqual(page.body.all((e) => e.tagName === "SELECT").length, 1);
});

test("a chart drawn is sent to the q Plots view as SVG while plots are on; off, it is not (#970)", () => {
  // A stand-in Chart.js, so the page draws.
  class Chart {
    constructor() {}
    destroy() {}
  }
  Chart.defaults = { font: {} };
  const page = loadPage(undefined, { Chart });
  const chart = {
    ...result("p.1", 3),
    view: "chart",
    grid: {
      columns: ["t", "a"].map((name) => ({ name, type: 7, typeName: "long (j)", key: false, numeric: true, temporal: false })),
      cells: [["1", "2", "3"], ["4", "5", "6"]],
      rank: [[0, 1, 2], [0, 1, 2]],
      values: [[1, 2, 3], [4, 5, 6]],
      total: 3,
    },
  };
  page.send(chart);
  const plotted = page.posted.filter((m) => m.type === "plotted");
  assert.strictEqual(plotted.length, 1);
  assert.strictEqual(plotted[0].id, "p.1");
  assert.strictEqual(plotted[0].format, "line");
  assert.match(plotted[0].data, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^]*<\/svg>$/);
  page.send({ ...chart, id: "p.2", features: { plots: false } });
  assert.strictEqual(page.posted.filter((m) => m.type === "plotted").length, 1);
});

test("Pivot draws at most PIVOT_ROWS rows and says how many it has; Copy Pivot copies them all (#1859)", () => {
  const { PIVOT_ROWS } = require("../media/result.js");
  const rows = 50_000;
  const ids = Array.from({ length: rows }, (_, i) => `id${String(i).padStart(6, "0")}`);
  const n = ids.map((_, i) => String(i));
  const page = loadPage(undefined);
  page.send({
    ...result("s.1", rows),
    grid: {
      columns: [
        { name: "id", type: 11, typeName: "symbol (s)", key: false, numeric: false, temporal: false },
        { name: "n", type: 7, typeName: "long (j)", key: false, numeric: true, temporal: false },
      ],
      cells: [ids, n],
      rank: [ids.map((_, i) => i), ids.map((_, i) => i)],
      values: [null, n.map(Number)],
      total: rows,
    },
    control: { key: "k.1", action: "view", view: "pivot" },
  });
  const pivot = lastRendered(page).rendered.pivot;
  assert.strictEqual(pivot.rows, rows);
  assert.strictEqual(pivot.drawn, PIVOT_ROWS);
  const lines = page.body.all((e) => e.tagName === "TR" && e.parent?.parent?.className === "pivot");
  assert.strictEqual(lines.length, PIVOT_ROWS + 1);
  assert.ok(page.body.all((e) => e.className === "note" && /The first 2,000 of its 50,000 rows are drawn; Copy Pivot copies them all\./.test(e.textContent)).length === 1);
  button(page, "Copy Pivot").fire("click");
  assert.strictEqual(page.posted.at(-1).text.split("\n").length, rows + 2);
});
