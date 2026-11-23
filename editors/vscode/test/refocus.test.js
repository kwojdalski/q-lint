// The keyboard focus over a redraw (media/refocus.js): a page that replaces
// its controls hands the focus to the control made in the place of the one
// that held it. The helper alone, then the pages that redraw through it.
const test = require("node:test");
const assert = require("node:assert");

const { keepFocus } = require("../media/refocus.js");
const { loadSmallPage } = require("./smallpage.js");
const { loadPage, activeIn } = require("./pagedom.js");

/// A document of controls that are in the page while `page` holds them.
function fakeDocument() {
  const document = { body: { tagName: "BODY" }, page: [], focused: undefined };
  Object.defineProperty(document, "activeElement", { get: () => (document.page.includes(document.focused) ? document.focused : document.body) });
  document.control = (extra = {}) => ({ tagName: "BUTTON", focus() { document.focused = this; }, ...extra });
  return document;
}

test("the control redrawn under the name of the one that held the focus takes it", () => {
  const document = fakeDocument();
  const focus = keepFocus(document);
  const draw = (names, disabled = []) => () => {
    document.page = names.map((n) => focus.name(document.control({ title: n, disabled: disabled.includes(n) }), n, n === "next" ? "previous" : undefined));
    return names.length;
  };
  assert.strictEqual(focus.over(draw(["previous", "next"])), 2, "what the redraw returns");
  assert.strictEqual(document.activeElement, document.body, "nothing held the focus: nothing takes it");
  const next = document.page[1];
  next.focus();
  focus.over(draw(["previous", "next"]));
  assert.strictEqual(document.activeElement.title, "next");
  assert.notStrictEqual(document.activeElement, next, "the one drawn now");
  // Drawn disabled, or not at all: the control named to stand in.
  focus.over(draw(["previous", "next"], ["next"]));
  assert.strictEqual(document.activeElement.title, "previous");
  document.page[1].disabled = false;
  document.page[1].focus();
  focus.over(draw(["previous"]));
  assert.strictEqual(document.activeElement.title, "previous");
  // A redraw that leaves the focused control in the page moves nothing.
  const kept = document.activeElement;
  focus.over(() => document.page.push(focus.name(document.control({ title: "other" }), "other")));
  assert.strictEqual(document.activeElement, kept);
  // A redraw that puts the focus somewhere itself keeps it there.
  focus.over(() => {
    draw(["previous", "next"])();
    document.page[1].focus();
  });
  assert.strictEqual(document.activeElement.title, "next");
  document.page[0].focus();
  // A control with no name, and one whose name nothing is drawn under.
  const plain = document.control();
  document.page.push(plain);
  plain.focus();
  focus.over(draw(["previous", "next"]));
  assert.strictEqual(document.activeElement, document.body);
});

test("each names the controls under a container by place and kind", () => {
  const document = fakeDocument();
  const focus = keepFocus(document);
  const draw = (kinds) => () => {
    const controls = kinds.map((k) => document.control({ tagName: k.split(" ")[0], type: k.split(" ")[1] }));
    document.page = controls;
    focus.each({ children: [{ tagName: "LABEL", children: controls.slice(0, 1) }, ...controls.slice(1), { tagName: "SPAN" }] }, "bar");
  };
  focus.over(draw(["SELECT", "INPUT checkbox", "BUTTON"]));
  document.page[1].focus();
  focus.over(draw(["SELECT", "INPUT checkbox", "BUTTON"]));
  assert.strictEqual(document.activeElement, document.page[1]);
  // Another kind of control in that place is not the same control.
  focus.over(draw(["SELECT", "INPUT color", "BUTTON"]));
  assert.strictEqual(document.activeElement, document.body);
});

/// The pages that redraw through refocus.js, by the script that makes their HTML.
const PAGES = { "dashboardview.js": "dashboard.js", "plotsview.js": "plots.js", "resultpanel.js": "result.js" };

test("a page that redraws through refocus.js loads it before its own script", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const [host, script] of Object.entries(PAGES)) {
    const source = fs.readFileSync(path.join(__dirname, "..", "out", host), "utf8");
    const at = (name) => source.indexOf(`file("${name}")`);
    assert.ok(at("refocus.js") >= 0 && at("refocus.js") < at(script), host);
  }
});

const LAYOUT = { type: "layout", name: "Desk", columns: 2, intervals: [0, 5, 60], views: ["table", "line"] };
const tile = (id, extra = {}) => ({ id, query: "q" + id, process: "hdb", view: "table", refresh: 0, ...extra });

test("a dashboard tile's control keeps the focus when the layout is drawn again (#1340)", () => {
  const page = loadSmallPage(["refocus.js", "dashboard.js"]);
  const control = (tileIndex, title) => page.find("section")[tileIndex].all((e) => e.title === title)[0];
  page.send({ ...LAYOUT, tiles: [tile("a"), tile("b"), tile("c")] });
  // The interval select of the second tile: a change is answered with a new layout.
  const interval = control(1, "Refresh interval");
  interval.focus();
  interval.value = "5";
  interval.fire("change");
  assert.deepStrictEqual(page.posted.at(-1), { type: "refresh-interval", id: "b", seconds: 5 });
  page.send({ ...LAYOUT, tiles: [tile("a"), tile("b", { refresh: 5 }), tile("c")] });
  assert.strictEqual(page.active(), control(1, "Refresh interval"));
  assert.notStrictEqual(page.active(), interval);
  // A moved tile's arrow goes with the tile; at the end of the row, the other arrow.
  control(0, "Move it later").focus();
  control(0, "Move it later").fire("click");
  page.send({ ...LAYOUT, tiles: [tile("b"), tile("a"), tile("c")] });
  assert.strictEqual(page.active(), control(1, "Move it later"));
  page.active().fire("click");
  page.send({ ...LAYOUT, tiles: [tile("b"), tile("c"), tile("a")] });
  assert.strictEqual(page.active(), control(2, "Move it earlier"));
  // The dashboard's own controls.
  const columns = page.find("header")[0].all((e) => e.tagName === "SELECT")[0];
  columns.focus();
  page.send({ ...LAYOUT, columns: 3, tiles: [tile("b"), tile("c"), tile("a")] });
  assert.strictEqual(page.active().title, "Tiles a row");
  assert.notStrictEqual(page.active(), columns);
  // A removed tile's button has nothing to hand the focus to.
  control(0, "Remove it from the dashboard").focus();
  page.send({ ...LAYOUT, tiles: [tile("c"), tile("a")] });
  assert.strictEqual(page.active(), page.body);
});

test("the q Plots buttons keep the focus from one plot to the next (#1348)", () => {
  const page = loadSmallPage(["refocus.js", "plots.js"]);
  const plot = { kind: "line", process: "hdb", at: 0, code: "select from t", svg: "<svg/>" };
  const button = (title) => page.find("button").filter((b) => b.title === title)[0];
  page.send({ type: "plots", plot, index: 0, count: 3 });
  const next = button("Next plot");
  next.focus();
  next.fire("click");
  assert.deepStrictEqual(page.posted.at(-1), { type: "move", by: 1 });
  page.send({ type: "plots", plot, index: 1, count: 3 });
  assert.strictEqual(page.active(), button("Next plot"));
  assert.notStrictEqual(page.active(), next);
  // The last plot: Next is disabled, and Previous is the way on.
  page.send({ type: "plots", plot, index: 2, count: 3 });
  assert.strictEqual(button("Next plot").disabled, true);
  assert.strictEqual(page.active(), button("Previous plot"));
  // Remove shows another plot, with its own Remove.
  button("Forget this plot").focus();
  page.send({ type: "plots", plot, index: 1, count: 2 });
  assert.strictEqual(page.active(), button("Forget this plot"));
  // The last one removed: no button is left to hold the focus.
  page.send({ type: "plots", index: -1, count: 0 });
  assert.strictEqual(page.active(), page.body);
});

const NUMERIC = [5, 6, 7, 8, 9];
/// A result message of `columns`, each [name, q type, cells].
function result(id, columns, extra = {}) {
  return {
    type: "result",
    id,
    view: "grid",
    process: "hdb",
    code: "t",
    millis: 1,
    limit: 10000,
    grid: {
      columns: columns.map(([name, type]) => ({ name, type, typeName: "t", key: false, numeric: NUMERIC.includes(type), temporal: false })),
      cells: columns.map(([, , cells]) => cells),
      rank: columns.map(([, , cells]) => cells.map((_, i) => i)),
      values: columns.map(([, type, cells]) => (NUMERIC.includes(type) ? cells.map(Number) : null)),
      total: columns[0][2].length,
    },
    ...extra,
  };
}
const TABLE = [["sym", 11, ["a", "b", "a"]], ["px", 9, ["1", "2", "3"]], ["size", 7, ["10", "20", "30"]]];

test("the result bar's buttons keep the focus when used, and a view button says it is the one on (#1344)", () => {
  const page = loadPage(undefined);
  const active = () => activeIn(page.body);
  const diff = { process: "hdb", at: 0, matchedBy: "place", changes: [], changed: 0, addedRows: [], addedColumns: [], removedColumns: [], removed: { columns: [], rows: [], count: 0 } };
  page.send(result("s.1", TABLE, { diff }));
  const pressed = () => Object.fromEntries(["Grid", "Chart", "Stats", "Pivot"].map((v) => [v, page.button(v).getAttribute("aria-pressed")]));
  assert.deepStrictEqual(pressed(), { Grid: "true", Chart: "false", Stats: "false", Pivot: "false" });
  const stats = page.button("Stats");
  stats.focus();
  stats.fire("click");
  assert.deepStrictEqual(pressed(), { Grid: "false", Chart: "false", Stats: "true", Pivot: "false" });
  assert.strictEqual(active(), page.button("Stats"));
  assert.notStrictEqual(active(), stats, "the bar was drawn again");
  // Compare is drawn again too, pressed.
  page.button("Compare").focus();
  page.button("Compare").fire("click");
  assert.strictEqual(active(), page.button("Compare"));
  assert.strictEqual(active().getAttribute("aria-pressed"), "true");
  // A result that arrives while a button is in use leaves the focus on it.
  page.button("Copy as CSV").focus();
  page.send(result("s.1", TABLE, { diff, millis: 2 }));
  assert.strictEqual(active(), page.button("Copy as CSV"));
});
