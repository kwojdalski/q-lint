// The result grid's filters in the page (media/result.js) under node, in
// test/pagedom.js's stand-in DOM: what a filter finds, and what it fetches.
const test = require("node:test");
const assert = require("node:assert");
const { loadPage } = require("./pagedom.js");
const panel = require("../media/result.js");

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
const filters = (page) => page.body.all((e) => e.tagName === "INPUT" && /^Filter /.test(e.getAttribute("aria-label") ?? ""));
const type = (input, text) => {
  input.value = text;
  input.fire("input");
};
const shown = (page) => page.rows().map((r) => r.children.map((c) => c.textContent));

test("a filter finds what a formatted cell shows, as well as q's text (#1342)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", [["ret_PCT", 9, ["0.0123", "0.5", "0n"]], ["amount_CCY", 9, ["1234567.891", "50", "2"]], ["sym", 11, ["a", "b", "c"]]]));
  assert.deepStrictEqual(shown(page), [["1.23%", "1,234,567.89", "a"], ["50.00%", "50.00", "b"], ["0n", "2.00", "c"]]);
  const [ret, amount, sym] = filters(page);
  // What the cell shows.
  type(ret, "50.00%");
  assert.deepStrictEqual(shown(page), [["50.00%", "50.00", "b"]]);
  type(ret, "1.2");
  assert.deepStrictEqual(shown(page), [["1.23%", "1,234,567.89", "a"]]);
  // q's own text still does, and a null shows as q wrote it.
  type(ret, "0.5");
  assert.deepStrictEqual(shown(page), [["50.00%", "50.00", "b"]]);
  type(ret, "0N");
  assert.deepStrictEqual(shown(page), [["0n", "2.00", "c"]]);
  type(ret, "");
  type(amount, "1,234");
  assert.deepStrictEqual(shown(page), [["1.23%", "1,234,567.89", "a"]]);
  type(amount, "567.891");
  assert.deepStrictEqual(shown(page), [["1.23%", "1,234,567.89", "a"]]);
  // With another column's filter, each is found its own way.
  type(amount, ".00");
  type(sym, "B");
  assert.deepStrictEqual(shown(page), [["50.00%", "50.00", "b"]]);
  // A filter kept from before finds the next result's cells the same way.
  type(sym, "");
  type(amount, "");
  type(ret, "%");
  page.send(result("s.1", [["ret_PCT", 9, ["0.25", "0n"]], ["amount_CCY", 9, ["1", "2"]], ["sym", 11, ["x", "y"]]], { millis: 2 }));
  assert.deepStrictEqual(shown(page), [["25.00%", "1.00", "x"]]);
});

test("visibleRows matches a cell's text or what `shown` says it shows (#1342)", () => {
  const grid = { cells: [["0.5", "0.25"], ["a", "b"]], rank: [[1, 0], [0, 1]] };
  const pct = (c, r) => (c === 0 ? Number(grid.cells[c][r]) * 100 + "%" : grid.cells[c][r]);
  assert.deepStrictEqual(panel.visibleRows(grid, ["50%"], null), []);
  assert.deepStrictEqual(panel.visibleRows(grid, ["50%"], null, pct), [0]);
  assert.deepStrictEqual(panel.visibleRows(grid, ["0.25"], null, pct), [1]);
  assert.deepStrictEqual(panel.visibleRows(grid, ["%", "B"], null, pct), [1]);
  assert.deepStrictEqual(panel.visibleRows(grid, ["%"], { column: 0, descending: false }, pct), [1, 0]);
});

/// `held` of a million rows, the process holding the rest.
function paged(held) {
  const cells = Array.from({ length: held }, (_, i) => "s" + i);
  const m = result("s.1", [["sym", 11, cells]], { more: true, limit: 1000 });
  m.grid.total = 1000000;
  return m;
}
const scroller = (page) => page.body.all((e) => e.className === "scroller")[0];
const scrollTo = (page, top) => {
  scroller(page).scrollTop = top;
  scroller(page).fire("scroll");
};

test("a filter that leaves few rows does not page the whole result in (#1343)", () => {
  const page = loadPage(undefined);
  const asked = () => page.posted.filter((m) => m.type === "more").length;
  page.send(paged(1000));
  assert.strictEqual(asked(), 0, "at the top of 1,000 rows");
  // (A scroll that leaves the same rows drawn is not kept for the next paint.)
  scrollTo(page, 3);
  // One row matches: it is near the end of the rows shown, and nothing was scrolled.
  type(filters(page)[0], "s999");
  assert.strictEqual(page.rendered().rows, 1);
  assert.strictEqual(asked(), 0);
  // Load more still fetches a page, and the page that comes asks for no other.
  page.button("Load more").fire("click");
  assert.strictEqual(asked(), 1);
  for (let k = 2; k <= 5; k++) {
    page.send(paged(1000 * k));
    // (A browser says the place put back after the redraw as a scroll.)
    scroller(page).fire("scroll");
  }
  assert.strictEqual(page.rendered().rows, 1);
  assert.strictEqual(asked(), 1);
  assert.match(page.body.all((e) => e.className === "info")[0].textContent, /^1 shown, 5,000 of 1,000,000 rows/);
});

test("filtered or not, scrolling to the end of the rows shown asks for the next page, once a scroll (#1343)", () => {
  const page = loadPage(undefined);
  const asked = () => page.posted.filter((m) => m.type === "more").length;
  page.send(paged(1000));
  // "s1", "s10".."s19", "s100".."s199": 111 rows.
  type(filters(page)[0], "s1");
  assert.strictEqual(page.rendered().rows, 111);
  scrollTo(page, 30 * 22);
  assert.strictEqual(asked(), 0, "not at their end yet");
  scrollTo(page, 111 * 22);
  assert.strictEqual(asked(), 1);
  // The next page comes, the grid is put back where it was: no scroll of the reader's.
  page.send(paged(2000));
  scroller(page).fire("scroll");
  assert.strictEqual(asked(), 1);
  // Scrolled on, to the end of what the filter now leaves: "s1000".."s1999" too.
  assert.strictEqual(page.rendered().rows, 1111);
  scrollTo(page, 1111 * 22);
  assert.strictEqual(asked(), 2);
  // Unfiltered, the rows held are near their end as soon as a short page is drawn.
  const plain = loadPage(undefined);
  plain.send(paged(5));
  assert.strictEqual(plain.posted.filter((m) => m.type === "more").length, 1);
});
