// The result grid to a screen reader (#1187) and a result announced
// (#1188): media/result.js under node in pagedom.js's stand-in DOM. Each
// also turned off: drawn and said as before.
const test = require("node:test");
const assert = require("node:assert");
const { Element, loadPage } = require("./pagedom.js");
const { gridMove, announcement } = require("../media/result.js");

/// A result of two columns over `count` rows: `n` 0 .. count-1 and `s`.
function result(id, count, extra = {}) {
  const n = Array.from({ length: count }, (_, i) => String(i));
  return {
    type: "result",
    id,
    view: "grid",
    process: "p",
    code: "t",
    millis: 12,
    limit: 10000,
    grid: {
      columns: [
        { name: "n", type: 7, typeName: "long (j)", key: false, numeric: true, temporal: false },
        { name: "s", type: 11, typeName: "symbol (s)", key: false, numeric: false, temporal: false },
      ],
      cells: [n, n.map((x) => "s" + x)],
      rank: [n.map((_, i) => i), n.map((_, i) => i)],
      values: [n.map(Number), null],
      total: count,
    },
    ...extra,
  };
}

const table = (page) => page.body.all((e) => e.tagName === "TABLE")[0];
/// The cells that are tab stops, as "row:col" by their aria indices.
const stops = (page) =>
  page.body
    .all((e) => (e.tagName === "TD" || e.tagName === "TH") && e.tabIndex === 0)
    .map((e) => `${e.parent.attributes?.["aria-rowindex"]}:${e.attributes?.["aria-colindex"]}`);

test("the arrows, Home, End and the page keys move the grid's focus, and stop at its edges (#1187)", () => {
  const at = { row: 3, col: 1 };
  assert.deepStrictEqual(gridMove(at, "ArrowUp", false, 10, 3, 5), { row: 2, col: 1 });
  assert.deepStrictEqual(gridMove(at, "ArrowDown", false, 10, 3, 5), { row: 4, col: 1 });
  assert.deepStrictEqual(gridMove(at, "ArrowLeft", false, 10, 3, 5), { row: 3, col: 0 });
  assert.deepStrictEqual(gridMove(at, "ArrowRight", false, 10, 3, 5), { row: 3, col: 2 });
  assert.deepStrictEqual(gridMove(at, "Home", false, 10, 3, 5), { row: 3, col: 0 });
  assert.deepStrictEqual(gridMove(at, "End", false, 10, 3, 5), { row: 3, col: 2 });
  assert.deepStrictEqual(gridMove(at, "Home", true, 10, 3, 5), { row: -1, col: 0 });
  assert.deepStrictEqual(gridMove(at, "End", true, 10, 3, 5), { row: 9, col: 2 });
  assert.deepStrictEqual(gridMove(at, "PageDown", false, 10, 3, 5), { row: 8, col: 1 });
  assert.deepStrictEqual(gridMove(at, "PageDown", false, 6, 3, 5), { row: 5, col: 1 });
  assert.deepStrictEqual(gridMove(at, "PageUp", false, 10, 3, 5), { row: -1, col: 1 });
  // The headers are the top row; nothing goes past an edge.
  assert.deepStrictEqual(gridMove({ row: -1, col: 0 }, "ArrowUp", false, 10, 3, 5), { row: -1, col: 0 });
  assert.deepStrictEqual(gridMove({ row: -1, col: 0 }, "ArrowLeft", false, 10, 3, 5), { row: -1, col: 0 });
  assert.deepStrictEqual(gridMove({ row: 9, col: 2 }, "ArrowDown", false, 10, 3, 5), { row: 9, col: 2 });
  assert.deepStrictEqual(gridMove({ row: -1, col: 0 }, "ArrowDown", false, 0, 3, 5), { row: -1, col: 0 });
  assert.strictEqual(gridMove(at, "a", false, 10, 3, 5), null);
  assert.strictEqual(gridMove(at, "Enter", false, 10, 3, 5), null);
});

test("the grid is a grid: counts over the virtualised rows, row and column indices, column headers (#1187)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", 1000));
  const t = table(page);
  assert.strictEqual(t.attributes.role, "grid");
  // Every row, though few are drawn - and the two header rows.
  assert.strictEqual(t.attributes["aria-rowcount"], "1002");
  assert.strictEqual(t.attributes["aria-colcount"], "2");
  const drawn = page.rows();
  assert.ok(drawn.length < 100, `${drawn.length} rows drawn`);
  assert.strictEqual(drawn[0].attributes.role, "row");
  assert.strictEqual(drawn[0].attributes["aria-rowindex"], "3");
  assert.strictEqual(drawn[0].children[1].attributes.role, "gridcell");
  assert.strictEqual(drawn[0].children[1].attributes["aria-colindex"], "2");
  const headers = page.headers();
  assert.deepStrictEqual(headers.map((h) => [h.attributes.role, h.attributes["aria-colindex"]]), [["columnheader", "1"], ["columnheader", "2"]]);
  assert.strictEqual(headers[0].parent.attributes["aria-rowindex"], "1");
  const spacers = page.body.all((e) => e.className === "spacer");
  assert.ok(spacers.length > 0 && spacers.every((s) => s.attributes.role === "presentation"));
  // Scrolled, a drawn row keeps its index among them all.
  const scroller = page.body.all((e) => e.className === "scroller")[0];
  scroller.scrollTop = 500 * 22;
  scroller.fire("scroll");
  const first = page.rows()[0];
  assert.strictEqual(first.attributes["aria-rowindex"], String(Number(first.children[0].textContent) + 3));
  // A filter changes the count.
  const filter = page.body.all((e) => e.tagName === "INPUT")[0];
  assert.strictEqual(filter.attributes["aria-label"], "Filter n");
  filter.value = "99";
  filter.fire("input");
  assert.strictEqual(t.attributes["aria-rowcount"], String(19 + 2));
});

test("one tab stop, moved by the arrow keys with the focus, scrolling to a row out of view (#1187)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", 1000));
  const t = table(page);
  // The first header is the stop to begin with.
  assert.deepStrictEqual(stops(page), ["1:1"]);
  const key = (k, extra = {}) => t.fire("keydown", { key: k, target: Element.focused, ...extra });
  key("ArrowDown");
  assert.deepStrictEqual(stops(page), ["3:1"]);
  assert.strictEqual(Element.focused.textContent, "0");
  key("ArrowRight");
  assert.deepStrictEqual(stops(page), ["3:2"]);
  assert.strictEqual(Element.focused.textContent, "s0");
  key("End", { ctrlKey: true });
  assert.strictEqual(Element.focused.textContent, "s999");
  assert.ok(page.state.top > 900 * 22, "scrolled to the last row");
  assert.deepStrictEqual(stops(page), ["1002:2"]);
  key("Home", { ctrlKey: true });
  assert.strictEqual(Element.focused, page.headers()[0]);
  assert.strictEqual(page.state.top > 900 * 22, true, "a header needs no scroll");
  assert.deepStrictEqual(stops(page), ["1:1"]);
  // A cell clicked or tabbed to is where the arrows go on from.
  const cell = page.rows()[3].children[1];
  t.fire("focusin", { target: cell });
  assert.deepStrictEqual(stops(page), [`${cell.parent.attributes["aria-rowindex"]}:2`]);
  // Its row scrolled out of the rows drawn: its column's header holds the
  // stop, so Tab still reaches the grid.
  const scroller = page.body.all((e) => e.className === "scroller")[0];
  scroller.scrollTop = 0;
  scroller.fire("scroll");
  assert.deepStrictEqual(stops(page), ["1:2"]);
  scroller.scrollTop = 980 * 22;
  scroller.fire("scroll");
  // A filter box keeps its own keys.
  const filter = page.body.all((e) => e.tagName === "INPUT")[0];
  key("ArrowLeft", { target: filter });
  assert.deepStrictEqual(stops(page), [`${cell.parent.attributes["aria-rowindex"]}:2`]);
  // Enter on a header still sorts.
  key("Home", { ctrlKey: true });
  page.headers()[0].fire("keydown", { key: "Enter" });
  assert.strictEqual(page.state.sort.column, 0);
});

test("off, the grid is the plain table it was: no roles, every header a tab stop, no keys (#1187)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", 50, { features: { accessibleGrid: false } }));
  const t = table(page);
  assert.strictEqual(t.attributes, undefined);
  assert.deepStrictEqual(page.headers().map((h) => [h.tabIndex, h.attributes.role]), [[0, undefined], [0, undefined]]);
  assert.strictEqual(page.rows()[0].attributes, undefined);
  assert.strictEqual(page.rows()[0].children[0].tabIndex, undefined);
  assert.strictEqual((t.listeners.keydown ?? []).length, 0);
  // On again, without a reload: the next post draws it as a grid.
  page.send(result("s.1", 50));
  assert.strictEqual(table(page).attributes.role, "grid");
});

/// The page's live region, when it has one.
test("the chart's kind select has a name: it is the one control there with no label (#1347)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", 5, { view: "chart" }));
  const selects = page.body.all((e) => e.tagName === "SELECT" && e.parent?.className === "controls");
  assert.strictEqual(selects.length, 1, "the kind, straight under the controls");
  assert.deepStrictEqual(selects[0].children.slice(0, 2).map((o) => o.value), ["line", "bar"]);
  assert.strictEqual(selects[0].getAttribute("aria-label"), "Chart kind");
});

const region = (page) => page.body.all((e) => e.attributes?.["aria-live"] === "polite")[0];

test("a new result is announced once in a polite live region; off, there is none (#1188)", () => {
  assert.strictEqual(announcement({ total: 1000, cells: [] }, 12), "1,000 rows in 12 ms");
  assert.strictEqual(announcement({ total: 1, cells: [] }, 0), "1 row in 0 ms");
  const page = loadPage(undefined);
  assert.strictEqual(region(page), undefined, "nothing until a result");
  page.send(result("s.1", 1000));
  const live = region(page);
  assert.strictEqual(live.attributes.role, "status");
  assert.strictEqual(live.attributes["aria-atomic"], "true");
  assert.strictEqual(live.textContent, "1,000 rows in 12 ms");
  // The same result posted again - a setting changed, the page reloaded -
  // is not said again.
  live.textContent = "";
  page.send(result("s.1", 1000));
  assert.strictEqual(live.textContent, "");
  page.send(result("s.2", 1, { millis: 3 }));
  assert.strictEqual(live.textContent, "1 row in 3 ms");
  page.send(result("s.3", 5, { features: { announce: false } }));
  assert.strictEqual(live.hidden, true);
  assert.strictEqual(live.textContent, "");
  const off = loadPage(undefined);
  off.send(result("s.1", 5, { features: { announce: false } }));
  assert.strictEqual(region(off), undefined);
});

test("package.json contributes both settings, on by default (#1187, #1188)", () => {
  const pkg = require("../package.json");
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  for (const f of ["accessibleGrid", "announce"]) {
    const s = props[`q-lint.results.${f}.enable`];
    assert.deepStrictEqual([s?.type, s?.default], ["boolean", true], f);
  }
});
