// The tickerplant log page (media/tplog.js) under node, in test/smallpage.js's
// stand-in DOM: what a keyboard reaches in it.
const test = require("node:test");
const assert = require("node:assert");
const { loadSmallPage } = require("./smallpage.js");

const LOG = { file: "/tp/sym2026.11.23", count: 3, complete: true, size: 100, bytes: 100, tables: ["trade"] };
const ROWS = [0, 1, 2].map((index) => ({ index, fn: "upd", table: "trade", rows: 1 + index, time: "09:0" + index }));

test("a message in the list is a tab stop, picked with Enter or Space, and keeps the focus (#1338)", () => {
  const page = loadSmallPage(["tplog.js"]);
  page.send({ type: "log", port: 5001, log: LOG });
  page.send({ type: "page", offset: 0, size: 200, total: 3, rows: ROWS });
  const rows = () => page.find("tr").slice(1);
  assert.deepStrictEqual(rows().map((r) => r.tabIndex), [0, 0, 0]);
  assert.ok(page.find("tr")[0].tabIndex === undefined, "the heading is not one");
  const shown = () => page.posted.filter((m) => m.type === "show").map((m) => m.index);
  // Enter picks the message, as a click does.
  const second = rows()[1];
  second.focus();
  let prevented = 0;
  second.fire("keydown", { key: "Enter", preventDefault: () => prevented++ });
  assert.deepStrictEqual(shown(), [1]);
  assert.strictEqual(prevented, 1);
  assert.deepStrictEqual(rows().map((r) => [r.className, r.getAttribute("aria-current")]), [["", null], ["picked", "true"], ["", null]]);
  // The rows were drawn again: the one for that message holds the focus.
  assert.notStrictEqual(rows()[1], second);
  assert.strictEqual(page.active(), rows()[1]);
  // Space too, and it does not scroll the page; another key is left alone.
  rows()[2].focus();
  rows()[2].fire("keydown", { key: " ", preventDefault: () => prevented++ });
  assert.deepStrictEqual(shown(), [1, 2]);
  assert.strictEqual(prevented, 2);
  assert.strictEqual(page.active(), rows()[2]);
  rows()[0].fire("keydown", { key: "ArrowDown", preventDefault: () => prevented++ });
  assert.deepStrictEqual(shown(), [1, 2]);
  assert.strictEqual(prevented, 2);
});
