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

test("a page that lists clears the error a refused filter left (#1793)", () => {
  const page = loadSmallPage(["tplog.js"]);
  page.send({ type: "log", port: 5001, log: LOG });
  page.send({ type: "status", text: "A time of day is HH:MM, HH:MM:SS or HH:MM:SS.mmm.", failed: true });
  page.send({ type: "page", table: "", from: "09:00", to: "", offset: 0, size: 200, total: 3, rows: ROWS });
  const status = page.find("p").find((p) => String(p.className).startsWith("status"));
  assert.deepStrictEqual([status.textContent, status.className], ["", "status"]);
});

test("a refused filter is not what the pager pages: it keeps the filter its rows came from (#1794)", () => {
  const page = loadSmallPage(["tplog.js"]);
  page.send({ type: "log", port: 5001, log: LOG });
  const button = (text) => page.find("button").find((b) => b.textContent === text);
  const [table] = page.find("select");
  const [from, to] = page.find("input");
  table.value = "";
  from.value = "09:00";
  button("Filter").fire("click");
  page.send({ type: "page", table: "", from: "09:00", to: "", offset: 0, size: 200, total: 500, rows: ROWS });
  to.value = "25:99";
  button("Filter").fire("click");
  // The extension refuses it with a status and sends no page.
  page.send({ type: "status", text: "A time of day is HH:MM, HH:MM:SS or HH:MM:SS.mmm.", failed: true });
  button("Page ▶").fire("click");
  const asked = page.posted.filter((m) => m.type === "page").map(({ table, from, to, offset }) => [table, from, to, offset]);
  assert.deepStrictEqual(asked, [["", "09:00", "", 0], ["", "09:00", "25:99", 0], ["", "09:00", "", 200]]);
});

test("the pager pages the filter last applied, not one typed since (#1395)", () => {
  const page = loadSmallPage(["tplog.js"]);
  page.send({ type: "log", port: 5001, log: { ...LOG, tables: ["trade", "quote"] } });
  const button = (text) => page.find("button").find((b) => b.textContent === text);
  const [table] = page.find("select");
  const [from, to] = page.find("input");
  table.value = "trade";
  from.value = "09:00";
  button("Filter").fire("click");
  page.send({ type: "page", table: "trade", from: "09:00", to: "", offset: 0, size: 200, total: 500, rows: ROWS });
  // Changed, but Filter not pressed: the pages are still trade's from 09:00.
  table.value = "quote";
  from.value = "10:00";
  to.value = "11:00";
  button("Page ▶").fire("click");
  page.send({ type: "page", table: "trade", from: "09:00", to: "", offset: 200, size: 200, total: 500, rows: ROWS });
  button("◀ Page").fire("click");
  const asked = page.posted.filter((m) => m.type === "page").map(({ table, from, to, offset }) => [table, from, to, offset]);
  assert.deepStrictEqual(asked, [["trade", "09:00", "", 0], ["trade", "09:00", "", 200], ["trade", "09:00", "", 0]]);
  // Filter applies what the boxes hold.
  button("Filter").fire("click");
  assert.deepStrictEqual(page.posted.at(-1), { type: "page", table: "quote", from: "10:00", to: "11:00", offset: 0 });
});
