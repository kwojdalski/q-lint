// Compare Query (#907) as data, and its page: two answers lined up row by
// row with the cells that differ marked, and media/compare.js drawing them
// in a small stand-in for the page's DOM. Run after `tsc`;
// queryacross_vscode.test.js drives the command, queries_q.test.js real q.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { COMPARE_ROWS, compareOutcomes, readCompare } = require("../out/compare.js");

/// A grid answer of columns `{name: [type, cells, raw]}`.
function table(columns, keys = 0) {
  const names = Object.keys(columns);
  const cells = names.map((n) => columns[n][1]);
  return {
    ok: true,
    type: 98,
    text: ["as the console writes it"],
    grid: { count: cells[0].length, keys, names, types: names.map((n) => columns[n][0]), cells, raw: names.map((n) => columns[n][2] ?? []), rank: names.map(() => []) },
  };
}
const side = (process, answer) => ({ process, answer });

test("the setting is on by default, and only false turns it off", () => {
  assert.deepStrictEqual(readCompare((k, f) => f), { enabled: true });
  assert.deepStrictEqual(readCompare((k, f) => (k === "query.compare.enable" ? false : f)), { enabled: false });
});

test("two tables without keys are lined up by place, and differing cells marked", () => {
  const c = compareOutcomes(
    side("a", table({ sym: [11, ["x", "y", "z"]], px: [9, ["1", "2", "3"]] })),
    side("b", table({ sym: [11, ["x", "y"]], px: [9, ["1", "5"]] })),
    -1,
  );
  assert.strictEqual(c.matchedBy, "place");
  assert.deepStrictEqual(c.columns, ["sym", "px"]);
  assert.deepStrictEqual(c.rows, [
    { left: ["x", "1"], right: ["x", "1"], differs: [false, false] },
    { left: ["y", "2"], right: ["y", "5"], differs: [false, true] },
    { left: ["z", "3"], differs: [true, true] },
  ]);
  assert.deepStrictEqual([c.differing, c.onlyLeft, c.onlyRight, c.same, c.lined], [1, 1, 0, false, 3]);
});

test("two tables keyed alike are lined up by key, whatever their order", () => {
  const c = compareOutcomes(
    side("a", table({ k: [11, ["x", "y"]], v: [7, ["1", "2"]] }, 1)),
    side("b", table({ k: [11, ["z", "y", "x"]], v: [7, ["9", "2", "1"]] }, 1)),
    -1,
  );
  assert.strictEqual(c.matchedBy, "key");
  assert.deepStrictEqual(
    c.rows.map((r) => [r.left?.[0], r.right?.[0]]),
    [["x", "x"], ["y", "y"], [undefined, "z"]],
  );
  assert.deepStrictEqual([c.differing, c.onlyLeft, c.onlyRight], [0, 0, 1]);
});

test("a column only one side has differs in every row; the same tables are the same", () => {
  const c = compareOutcomes(side("a", table({ v: [7, ["1"]] })), side("b", table({ v: [7, ["1"]], w: [7, ["2"]] })), -1);
  assert.deepStrictEqual(c.columns, ["v", "w"]);
  assert.deepStrictEqual([c.inLeft, c.inRight], [[true, false], [true, true]]);
  assert.deepStrictEqual(c.rows[0], { left: ["1", ""], right: ["1", "2"], differs: [false, true] });
  assert.strictEqual(c.same, false);
  const same = compareOutcomes(side("a", table({ v: [7, ["1"]] })), side("b", table({ v: [7, ["1"]] })), -1);
  assert.deepStrictEqual([same.same, same.differing], [true, 0]);
});

test("a repeated column name is matched occurrence by occurrence, not to the first of that name (#1964)", () => {
  // flip `a`a!(1 2;3 4) against flip `a`a!(1 2;9 9).
  const twice = (second) => ({ ok: true, type: 98, text: [], grid: { count: 2, keys: 0, names: ["a", "a"], types: [7, 7], cells: [["1", "2"], second.map(String)], raw: [[1, 2], second], rank: [[], []] } });
  const c = compareOutcomes(side("a", twice([3, 4])), side("b", twice([9, 9])), -1);
  assert.deepStrictEqual(c.columns, ["a", "a"]);
  assert.deepStrictEqual(c.rows, [
    { left: ["1", "3"], right: ["1", "9"], differs: [false, true] },
    { left: ["2", "4"], right: ["2", "9"], differs: [false, true] },
  ]);
  assert.deepStrictEqual([c.same, c.differing], [false, 2]);
  assert.strictEqual(compareOutcomes(side("a", twice([3, 4])), side("b", twice([3, 4])), -1).same, true);
  // The second a is a column only that side has.
  const once = compareOutcomes(side("a", twice([3, 4])), side("b", table({ a: [7, ["1", "2"], [1, 2]] })), -1);
  assert.deepStrictEqual([once.columns, once.inLeft, once.inRight, once.same, once.differing], [["a", "a"], [true, true], [true, false], false, 2]);
  const other = compareOutcomes(side("b", table({ b: [7, ["1", "2"], [1, 2]], a: [7, ["1", "2"], [1, 2]] })), side("a", twice([3, 4])), -1);
  assert.deepStrictEqual([other.columns, other.inLeft, other.inRight], [["b", "a", "a"], [true, true, false], [false, true, true]]);
});

test("floats are compared by their values, whatever decimals the grid shows (#1963)", () => {
  const a = side("a", table({ f: [9, ["1.2345"], [1.2345]] }));
  const b = side("b", table({ f: [9, ["1.2346"], [1.2346]] }));
  assert.strictEqual(compareOutcomes(a, b, -1).differing, 1);
  // To two decimals both show 1.23: each is written in full where they differ.
  const c = compareOutcomes(a, b, 2);
  assert.deepStrictEqual([c.same, c.differing, c.rows[0]], [false, 1, { left: ["1.2345f"], right: ["1.2346f"], differs: [true] }]);
  // Past \P's digits q's own text is the same too.
  const px = (v) => table({ a: [7, ["1", "2"], [1, 2]], px: [9, ["100", "2.5"], [v, 2.5]] });
  const d = compareOutcomes(side("a", px(100.00000001)), side("b", px(100.00000002)), -1);
  assert.deepStrictEqual([d.same, d.differing, d.rows[0].left, d.rows[0].right, d.rows[1]], [false, 1, ["1", "100.00000001f"], ["1", "100.00000002f"], { left: ["2", "2.5"], right: ["2", "2.5"], differs: [false, false] }]);
  assert.deepStrictEqual([compareOutcomes(side("a", px(100.5)), side("b", px(100.5)), 2).same, compareOutcomes(a, a, 2).same], [true, true]);
  // One value written to two processes' \P is one value.
  const p10 = side("b", table({ f: [9, ["1.23450000"], [1.2345]] }));
  assert.deepStrictEqual([compareOutcomes(a, p10, -1).same, compareOutcomes(a, p10, -1).differing], [true, 0]);
  // A timestamp past 2^53 by its digits, however it was decoded; nulls and infinities as themselves.
  const ts = (v) => table({ p: [12, ["2024.01.01D00:00:00.000000001", "", "0W"], [v, null, Infinity]] });
  assert.strictEqual(compareOutcomes(side("a", ts("757382400000000001")), side("b", ts({ toString: () => "757382400000000001" })), -1).same, true);
  assert.strictEqual(compareOutcomes(side("a", ts("757382400000000001")), side("b", table({ p: [12, ["2024.01.01D00:00:00.000000001", "", "0W"], ["757382400000000001", Infinity, null]] })), -1).differing, 2);
  // The floats in a general list's item, which -3! writes to \P.
  const nested = (v) => table({ l: [0, ["1 100f", "`a"], [["F", [1, v]], false]] });
  const n = compareOutcomes(side("a", nested(100.00000001)), side("b", nested(100.00000002)), -1);
  assert.deepStrictEqual([n.same, n.differing, n.rows[0].left, n.rows[0].right], [false, 1, ["1 100.00000001"], ["1 100.00000002"]]);
  assert.strictEqual(compareOutcomes(side("a", nested(7)), side("b", nested(7)), -1).same, true);
});

test("a column of another type is not the same answer, and the page says which (#1963)", () => {
  const long = table({ a: [7, ["1", "2"], [1, 2]], px: [7, ["1", "2"], [1, 2]] });
  const typed = (type) => table({ a: [7, ["1", "2"], [1, 2]], px: [type, ["1", "2"], [1, 2]] });
  const c = compareOutcomes(side("prod", typed(9)), side("uat", long), -1);
  assert.deepStrictEqual([c.same, c.differing, c.retyped], [false, 0, [{ column: "px", left: "float (f)", right: "long (j)" }]]);
  assert.strictEqual(compareOutcomes(side("prod", typed(6)), side("uat", long), -1).same, false);
  assert.deepStrictEqual([compareOutcomes(side("prod", long), side("uat", long), -1).same, compareOutcomes(side("prod", long), side("uat", long), -1).retyped], [true, []]);
  // A minute and a second of one count are two values.
  const time = (type, text) => table({ t: [type, [text], [5]] });
  assert.strictEqual(compareOutcomes(side("a", time(17, "00:05")), side("b", time(18, "00:00:05")), -1).differing, 1);
  // An enumeration's number is its process's own.
  const en = (type) => table({ s: [type, ["a"]] });
  assert.strictEqual(compareOutcomes(side("a", en(20)), side("b", en(21)), -1).same, true);
  const page = loadPage();
  page.send({ type: "compare", id: 1, code: "t", comparison: c });
  assert.strictEqual(page.posted.at(-1).rendered.summary, "px is float (f) on prod and long (j) on uat (rows lined up by place).");
});

test("answers that did not all come back are not called the same when their types, keys or cut cells differ (#2075)", () => {
  const cutOff = (answer) => ({ ...answer, grid: { ...answer.grid, count: 1000 } });
  const t = (type, keys = 0) => cutOff(table({ a: [7, ["1", "2"], [1, 2]], px: [type, ["1", "2"], [1, 2]] }, keys));
  const note = " Not every row came back, so only the rows held were compared: raise q-lint.query.gridLimit or turn on Unlimited to compare them all.";
  const page = loadPage();
  const said = (c) => (page.send({ type: "compare", id: 1, code: "t", comparison: c }), page.posted.at(-1).rendered.summary);
  const retyped = compareOutcomes(side("prod", t(9)), side("uat", t(7)), -1);
  assert.deepStrictEqual([retyped.same, retyped.partial], [false, true]);
  assert.strictEqual(said(retyped), "px is float (f) on prod and long (j) on uat (rows lined up by place)." + note);
  assert.strictEqual(said(compareOutcomes(side("prod", t(7, 1)), side("uat", t(7)), -1)), "the table is keyed by a on prod and not keyed on uat (rows lined up by place)." + note);
  const long = `"${"a".repeat(196)}...`;
  const strings = () => cutOff(table({ s: [0, [long, '"b"'], [false, false]] }));
  assert.strictEqual(said(compareOutcomes(side("a", strings()), side("b", strings()), -1)), "1 cell is the same as far as shown, cut at 200 characters, and no further compared (rows lined up by place)." + note);
  // The rows held are the same, and only that.
  assert.strictEqual(said(compareOutcomes(side("prod", t(7)), side("uat", t(7)), -1)), "The rows held are the same." + note);
});

test("tables that are not keyed by the same columns are not the same answer, and the page says how each is keyed (#2008)", () => {
  // ([k:1 2] v:10 20) and ([] k:1 2; v:10 20): the same cells, and not the same value.
  const t = (keys) => table({ k: [7, ["1", "2"], [1, 2]], j: [7, ["3", "4"], [3, 4]], v: [7, ["10", "20"], [10, 20]] }, keys);
  const c = compareOutcomes(side("prod", t(1)), side("uat", t(0)), -1);
  assert.deepStrictEqual([c.same, c.differing, c.onlyLeft, c.onlyRight, c.matchedBy, c.rekeyed], [false, 0, 0, 0, "place", { left: ["k"], right: [] }]);
  const page = loadPage();
  page.send({ type: "compare", id: 1, code: "t", comparison: c });
  assert.strictEqual(page.posted.at(-1).rendered.summary, "the table is keyed by k on prod and not keyed on uat (rows lined up by place).");
  const two = compareOutcomes(side("prod", t(2)), side("uat", t(1)), -1);
  assert.deepStrictEqual([two.same, two.rekeyed], [false, { left: ["k", "j"], right: ["k"] }]);
  page.send({ type: "compare", id: 2, code: "t", comparison: two });
  assert.strictEqual(page.posted.at(-1).rendered.summary, "the table is keyed by k, j on prod and by k on uat (rows lined up by place).");
  // Keyed alike, or neither keyed: nothing to say.
  assert.deepStrictEqual([0, 1, 2, 3].map((k) => [compareOutcomes(side("a", t(k)), side("b", t(k)), -1).same, compareOutcomes(side("a", t(k)), side("b", t(k)), -1).rekeyed]), [[true, undefined], [true, undefined], [true, undefined], [true, undefined]]);
  // Beside a cell that differs.
  const other = table({ k: [7, ["1", "2"], [1, 2]], j: [7, ["3", "4"], [3, 4]], v: [7, ["10", "21"], [10, 21]] }, 0);
  page.send({ type: "compare", id: 3, code: "t", comparison: compareOutcomes(side("prod", t(1)), side("uat", other), -1) });
  assert.strictEqual(page.posted.at(-1).rendered.summary, "1 cell differs, the table is keyed by k on prod and not keyed on uat (rows lined up by place).");
});

test("what was compared only as far as it is shown is not called the same (#1963)", () => {
  // A cell cut at 200 characters: the rest was never sent.
  const long = `"${"a".repeat(196)}...`;
  const strings = () => table({ s: [0, [long, '"b"'], [false, false]] });
  const c = compareOutcomes(side("a", strings()), side("b", strings()), -1);
  assert.deepStrictEqual([c.same, c.differing, c.cut], [false, 0, 1]);
  const page = loadPage();
  page.send({ type: "compare", id: 1, code: "t", comparison: c });
  assert.strictEqual(page.posted.at(-1).rendered.summary, "1 cell is the same as far as shown, cut at 200 characters, and no further compared (rows lined up by place).");
  // A float atom is its console text, to \P: the same to those digits, and said so.
  const atom = (type, text) => ({ ok: true, type, text: [text] });
  const f = compareOutcomes(side("a", atom(-9, "100")), side("b", atom(-9, "100")), -1);
  assert.deepStrictEqual([f.same, f.digits], [true, true]);
  page.send({ type: "compare", id: 2, code: "x", comparison: f });
  assert.match(page.posted.at(-1).rendered.summary, /^a and b gave the same answer to the digits shown\. /);
  // A long's text is the long, and differing text is not the same to any digits.
  assert.deepStrictEqual([compareOutcomes(side("a", atom(-7, "100")), side("b", atom(-7, "100")), -1).digits, compareOutcomes(side("a", atom(-9, "1")), side("b", atom(-9, "2")), -1).digits], [false, false]);
  assert.strictEqual(compareOutcomes(side("a", atom(-9, "1")), { process: "b", error: "down" }, -1).digits, false);
});

test("a text that only ends in .. is whole: a cut is told by how long it left the text (#2010)", () => {
  const twice = (answer, width) => {
    const c = compareOutcomes(side("a", answer), side("b", answer), -1, width);
    return [c.same, c.partial, c.cut];
  };
  const text = (type, ...lines) => ({ ok: true, type, text: lines });
  // `:../.. and `$"a..", at a console 160 wide: each is all of its value.
  assert.deepStrictEqual([twice(text(-11, "`:../.."), 160), twice(text(-11, "`a.."), 160)], [[true, false, 0], [true, false, 0]]);
  // -3! stops one short of the process's \c, which is never under 10: 9 characters may be a cut.
  assert.deepStrictEqual([twice(text(-11, "`aaaaa.."), 160), twice(text(-11, "`aaaaaa.."), 160)], [[true, false, 0], [false, true, 0]]);
  assert.deepStrictEqual(twice(text(-11, `\`${"a".repeat(76)}..`), 160), [false, true, 0]);
  // .Q.S cuts a line at the console's width, whichever line it is; a function's line is cut nowhere else.
  const fn = (line) => text(100, "{[a]", line, " a}");
  assert.deepStrictEqual([twice(fn(" a / and more.."), 40), twice(fn(" a / and more.."), 15), twice(fn(" a.."), 4)], [[true, false, 0], [false, true, 0], [false, true, 0]]);
  // At a width of 1 it leaves a line's last character, then the two dots.
  assert.deepStrictEqual([twice(text(-11, "a.."), 1), twice(text(-11, "`a.."), 1)], [[false, true, 0], [true, false, 0]]);
  // Rows cut at the console's height are one last line of two dots.
  assert.deepStrictEqual([twice(text(0, "1", "`a..", ".."), 160), twice(text(0, "1", "..", "`a.."), 160)], [[false, true, 0], [true, false, 0]]);
  // With no width given, any line that ends so may be one the console cut.
  assert.deepStrictEqual(twice(text(-11, "`a..")), [false, true, 0]);
  // A general column's cell, and a dictionary's key: whole under 9 characters, and possibly cut from there.
  const cells = (...items) => table({ key: [0, items, items.map(() => false)], value: [7, items.map(() => "1"), items.map(() => 1)] }, 1);
  assert.deepStrictEqual(twice(cells("1", "`:../..", "`p`q..", "`x.."), 160), [true, false, 0]);
  assert.deepStrictEqual(twice(cells("1", "`:../..", "`aaaaaa..", `0 1 2 ${"3 ".repeat(35)}..`), 160), [false, false, 2]);
  const page = loadPage();
  page.send({ type: "compare", id: 1, code: "`:../..", comparison: compareOutcomes(side("a", text(-11, "`:../..")), side("b", text(-11, "`:../..")), -1, 160) });
  assert.strictEqual(page.posted.at(-1).rendered.summary, "a and b gave the same answer.");
});

test("a value that is not tabular, an error or a process not reached is compared as text", () => {
  const atom = (t) => ({ ok: true, type: -7, text: [t] });
  assert.deepStrictEqual(compareOutcomes(side("a", atom("42")), side("b", atom("42")), -1).same, true);
  const c = compareOutcomes(side("a", atom("42")), { process: "b", error: "could not connect" }, -1);
  assert.deepStrictEqual([c.left, c.right, c.same, c.columns], [
    { process: "a", kind: "text", text: "42" },
    { process: "b", kind: "error", text: "could not connect" },
    false,
    [],
  ]);
  const t = compareOutcomes(side("a", table({ v: [7, ["1"]] })), side("b", { ok: false, error: "type", trace: "" }), -1);
  assert.deepStrictEqual([t.left.kind, t.left.text, t.right.text], ["grid", "as the console writes it", "'type"]);
});

test("at most COMPARE_ROWS rows are kept, and all are counted", () => {
  const n = COMPARE_ROWS + 10;
  const many = (offset) => table({ v: [7, Array.from({ length: n }, (_, i) => String(i + (i >= n - 3 ? offset : 0)))] });
  const c = compareOutcomes(side("a", many(0)), side("b", many(1)), -1);
  assert.strictEqual(c.rows.length, COMPARE_ROWS);
  assert.deepStrictEqual([c.lined, c.differing], [n, 3]);
});

// The page, in a stand-in DOM.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = "";
    this.text = "";
  }
  appendChild(e) {
    this.children.push(e);
    return e;
  }
  set textContent(v) {
    this.text = String(v);
    this.children = [];
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  all(match) {
    const out = [];
    const walk = (e) => e.children.forEach((c) => (match(c) && out.push(c), walk(c)));
    walk(this);
    return out;
  }
}

function loadPage() {
  const posted = [];
  const listeners = [];
  const body = new Element("body");
  const sandbox = {
    document: { body, createElement: (t) => new Element(t) },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) }),
    window: { addEventListener: (type, f) => type === "message" && listeners.push(f) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "media", "compare.js"), "utf8"), sandbox);
  return { body, posted, send: (data) => listeners.forEach((f) => f({ data })) };
}

test("the page draws the two tables side by side, marks what differs, and puts every value in as text", () => {
  const page = loadPage();
  assert.deepStrictEqual(page.posted, [{ type: "ready" }]);
  const comparison = compareOutcomes(
    side("<b>a</b>", table({ sym: [11, ["<img src=x onerror=alert(1)>", "y"]], px: [9, ["1", "2"]] })),
    side("b", table({ sym: [11, ["<img src=x onerror=alert(1)>", "y"]], px: [9, ["1", "3"]] })),
    -1,
  );
  page.send({ type: "compare", id: 1, code: "select from t", comparison });
  const cells = page.body.all((e) => e.tagName === "TD");
  // Two rows, two columns a side and the gap between.
  assert.strictEqual(cells.length, 10);
  assert.deepStrictEqual(
    cells.filter((c) => c.className === "changed").map((c) => c.textContent),
    ["2", "3"],
  );
  assert.strictEqual(cells[0].textContent, "<img src=x onerror=alert(1)>");
  assert.strictEqual(cells[0].children.length, 0);
  assert.ok(page.body.all((e) => e.tagName === "TH").some((th) => th.textContent === "<b>a</b> (2 rows)"));
  assert.deepStrictEqual(page.posted.at(-1), {
    type: "rendered",
    id: 1,
    rendered: { processes: ["<b>a</b>", "b"], rows: 2, marked: 2, summary: "1 cell differs (rows lined up by place)." },
  });
});

test("a cell the page marks says how it differs, not by its colour alone (#1349)", () => {
  const page = loadPage();
  // Lined up by place: the second rows differ in px, and only hdb has `size` and a third row.
  const comparison = compareOutcomes(
    side("rdb", table({ sym: [11, ["a", "b"]], px: [9, ["1", ""]] })),
    side("hdb", table({ sym: [11, ["a", "b", "c"]], px: [9, ["1", "3", "4"]], size: [7, ["10", "20", "30"]] })),
    -1,
  );
  page.send({ type: "compare", id: 1, code: "select from t", comparison });
  const rows = page.body.all((e) => e.tagName === "TR").slice(2);
  const said = (tr) => tr.children.filter((td) => td.className !== "gap").map((td) => [td.className, td.title ?? ""]);
  assert.deepStrictEqual(said(rows[0]), [
    ["", ""],
    ["", ""],
    ["changed", "Differs from hdb: 10"],
    ["", ""],
    ["", ""],
    ["changed", "Differs from rdb: no such column"],
  ]);
  assert.deepStrictEqual(said(rows[1]).filter(([, title]) => title !== ""), [
    ["changed", "Differs from hdb: 3"],
    ["changed", "Differs from hdb: 20"],
    ["changed", "Differs from rdb: (null)"],
    ["changed", "Differs from rdb: no such column"],
  ]);
  assert.deepStrictEqual(said(rows[2]), [
    ["missing", "No such row on rdb"],
    ["missing", "No such row on rdb"],
    ["missing", "No such row on rdb"],
    ["only", "Only on hdb"],
    ["only", "Only on hdb"],
    ["only", "Only on hdb"],
  ]);
});

test("answers that came back cut are never called the same (#1614)", () => {
  const cut = (rows) => {
    const t = table({ v: [7, ["1", "2"]] });
    t.grid.count = rows;
    return t;
  };
  const c = compareOutcomes(side("p1", cut(20000)), side("p2", cut(20000)), -1);
  assert.deepStrictEqual([c.same, c.partial, c.differing], [false, true, 0]);
  const whole = compareOutcomes(side("p1", cut(2)), side("p2", cut(2)), -1);
  assert.deepStrictEqual([whole.same, whole.partial], [true, false]);
  const atom = (t) => ({ ok: true, type: 0, text: ["a", ".."] });
  assert.deepStrictEqual([compareOutcomes(side("a", atom()), side("b", atom()), -1).same, compareOutcomes(side("a", atom()), side("b", atom()), -1).partial], [false, true]);
  const page = loadPage();
  page.send({ type: "compare", id: 4, code: "x", comparison: c });
  assert.match(page.posted.at(-1).rendered.summary, /^The rows held are the same\. Not every row came back/);
});

test("the page shows two answers that are not tables as text, and says when they are the same", () => {
  const page = loadPage();
  const atom = (t) => ({ ok: true, type: -7, text: [t] });
  page.send({ type: "compare", id: 2, code: "x", comparison: compareOutcomes(side("a", atom("1")), side("b", atom("1")), -1) });
  assert.strictEqual(page.posted.at(-1).rendered.summary, "a and b gave the same answer.");
  page.send({ type: "compare", id: 3, code: "x", comparison: compareOutcomes(side("a", atom("1")), { process: "b", error: "down" }, -1) });
  const pres = page.body.all((e) => e.tagName === "PRE");
  assert.deepStrictEqual(pres.map((p) => [p.className, p.textContent]), [["changed", "1"], ["error", "down"]]);
});

test("Compare Query matches a key repeated on many rows in linear time, in order (#1860)", () => {
  const mk = (rows) => ({ ok: true, type: 99, text: [], grid: { count: rows, keys: 1, names: ["s", "v"], types: [11, 7], cells: [Array.from({ length: rows }, (_, i) => "k" + (i % 10)), Array.from({ length: rows }, (_, i) => String(i))], raw: [[], []], rank: [[], []] } });
  // Best of three, as the diff's twin in resultview.test.js: one garbage
  // collection or a busy machine during a single run can make one size look
  // slow with the code unchanged.
  const time = (rows) => {
    const o = { process: "p", answer: mk(rows), millis: 1 };
    return Math.min(
      ...[0, 1, 2].map(() => {
        const t = process.hrtime.bigint();
        compareOutcomes(o, o, -1);
        return Number(process.hrtime.bigint() - t) / 1e6;
      }),
    );
  };
  time(10_000);
  const small = time(50_000);
  const big = time(100_000);
  // Before: 125 ms at 50k, 375 ms at 100k, 2.9 s at 200k.
  assert.ok(big < Math.max(small, 20) * 3, `${small} ms at 50k, ${big} ms at 100k`);
});

// ([k:til 20]a:til 20) against ([k:reverse til 20]a:reverse til 20), each
// cut at 10 rows: every key is on both, and was called only on one side.
test("a row whose key the other side did not send, as it came back cut, is not compared, not only on one side (#2158)", () => {
  const keyed = (ks, total) => {
    const t = table({ k: [7, ks.map(String), ks], a: [7, ks.map(String), ks] }, 1);
    t.grid.count = total;
    return t;
  };
  const up = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const down = [19, 18, 17, 16, 15, 14, 13, 12, 11, 10];
  const c = compareOutcomes(side("a", keyed(up, 20)), side("b", keyed(down, 20)), -1);
  assert.deepStrictEqual([c.same, c.partial, c.differing, c.onlyLeft, c.onlyRight, c.uncompared], [false, true, 0, 0, 0, 20]);
  const page = loadPage();
  const said = (comparison) => (page.send({ type: "compare", id: 1, code: "t", comparison }), page.posted.at(-1).rendered.summary);
  assert.match(said(c), /^The rows held are the same\. Not every row came back/);
  // Drawn as not compared, not as only on one side.
  const cells = page.body.all((e) => e.tagName === "TR").slice(2)[0].children.filter((td) => td.className !== "gap");
  assert.deepStrictEqual(cells.map((td) => [td.className, td.title]), [
    ["", "Not compared: not among the rows b sent"],
    ["", "Not compared: not among the rows b sent"],
    ["missing", "Not among the rows b sent"],
    ["missing", "Not among the rows b sent"],
  ]);
  // A key the whole other side does not have is only on this one; with a cell that differs, the rest is counted.
  const whole = compareOutcomes(side("a", keyed([1, 2], 2)), side("b", keyed([2, 3], 3)), -1);
  assert.deepStrictEqual([whole.onlyLeft, whole.onlyRight, whole.uncompared], [0, 1, 1]);
  const t = keyed([1, 2], 9);
  t.grid.raw[1] = [1, 5];
  t.grid.cells[1] = ["1", "5"];
  assert.match(said(compareOutcomes(side("a", t), side("b", keyed([2, 3], 9)), -1)), /^1 cell differs, 2 rows not compared, as the other side did not send them \(rows lined up by key\)\./);
});

// 1%3 on a process at \P 3 and on one at \P 7 wrote 0.333 and 0.3333333:
// the same value, called different. Text that agrees to the digits the
// fewer of the two wrote cannot be told the same or different.
test("floats written to two processes' \\P that agree as far as the fewer digits go are neither the same nor different (#2159)", () => {
  const atom = (type, text) => ({ ok: true, type, text: [text] });
  const both = (type, ta, tb) => compareOutcomes(side("a", atom(type, ta)), side("b", atom(type, tb)), -1);
  const p = both(-9, "0.333", "0.3333333");
  assert.deepStrictEqual([p.same, p.toDigits], [false, 1]);
  assert.deepStrictEqual([both(9, "1e+03 0.333", "1000.5 0.3333333").toDigits, both(99, "`a`b!0.333 0.143", "`a`b!0.3333333 0.1428571").toDigits], [1, 1]);
  // A float apart at the fewer digits, another type's text, or text around the numbers that differs: different.
  assert.deepStrictEqual(
    [both(-9, "0.333", "0.334"), both(-9, "0.333", "0.3343333"), both(-7, "1", "2"), both(0, "(0.333;`a)", "(0.3333333;`b)"), both(0, "(`a0.333;1)", "(`a0.3333333;1)"), both(-14, "2024.01.01", "2024.01.02")].map((c) => [c.same, c.toDigits]),
    [[false, 0], [false, 0], [false, 0], [false, 0], [false, 0], [false, 0]],
  );
  const page = loadPage();
  page.send({ type: "compare", id: 1, code: "1%3", comparison: p });
  assert.strictEqual(page.posted.at(-1).rendered.summary, "a and b wrote the same answer as far as the fewer digits written go: their \\P differs, so whether they are the same cannot be told. Compare enlist of it to compare its every digit.");
  // A cell GRID sent only as text, a column of dictionaries: not counted as differing.
  const dicts = (text) => table({ a: [98, [text]] });
  const c = compareOutcomes(side("a", dicts("`a`b!0.333 0.143")), side("b", dicts("`a`b!0.3333333 0.1428571")), -1);
  assert.deepStrictEqual([c.same, c.differing, c.toDigits], [false, 0, 1]);
  page.send({ type: "compare", id: 2, code: "t", comparison: c });
  assert.strictEqual(page.posted.at(-1).rendered.summary, "1 cell is the same as far as the fewer digits written go, as the processes' \\P differs, and no further compared (rows lined up by place).");
  // A symbol's text is all of it.
  const syms = (text) => table({ s: [11, [text]] });
  assert.deepStrictEqual([compareOutcomes(side("a", syms("0.1")), side("b", syms("0.10")), -1)].map((x) => [x.differing, x.toDigits]), [[1, 0]]);
});

// GRID makes a list a table of one column named value, and a dictionary a
// keyed table of key and value: 1 2 3 against flip(enlist`value)!enlist 1 2 3
// was "the same answer", though q's ~ says they differ.
test("a list and a table, or a dictionary and a keyed table, of the same cells are not the same answer (#2163)", () => {
  const as = (type, answer, text) => ({ ...answer, type, text });
  const values = () => table({ value: [7, ["1", "2", "3"], [1, 2, 3]] });
  const list = compareOutcomes(side("a", as(7, values(), ["1 2 3"])), side("b", as(98, values(), ["value", "-----", "1", "2", "3"])), -1);
  assert.deepStrictEqual([list.same, list.reshaped], [false, { left: "a list", right: "a table" }]);
  const pairs = () => table({ key: [11, ["a", "b"]], value: [7, ["1", "2"], [1, 2]] }, 1);
  const dict = (s) => side(s, as(99, pairs(), ["a| 1", "b| 2"]));
  const keyed = (s) => side(s, as(99, pairs(), ["key| value", "---| -----", "a  | 1", "b  | 2"]));
  const c = compareOutcomes(dict("a"), keyed("b"), -1);
  assert.deepStrictEqual([c.same, c.reshaped], [false, { left: "a dictionary", right: "a keyed table" }]);
  // A dictionary of a table's rows is a dictionary still.
  assert.strictEqual(compareOutcomes(side("a", as(99, pairs(), [" | x", "-| -", "a| 1"])), dict("b"), -1).reshaped, undefined);
  assert.deepStrictEqual([compareOutcomes(dict("a"), dict("b"), -1).same, compareOutcomes(keyed("a"), keyed("b"), -1).same], [true, true]);
  const page = loadPage();
  page.send({ type: "compare", id: 1, code: "x", comparison: c });
  assert.strictEqual(page.posted.at(-1).rendered.summary, "the answer is a dictionary on a and a keyed table on b (rows lined up by key).");
  // Text of two types is two answers, an enumeration's number aside.
  const atom = (type, text) => ({ ok: true, type, text: [text] });
  assert.deepStrictEqual([compareOutcomes(side("a", atom(-7, "1")), side("b", atom(-9, "1")), -1).same, compareOutcomes(side("a", atom(20, "`sym$`a")), side("b", atom(21, "`sym$`a")), -1).same], [false, true]);
});

// `/data/hdb/x.. is 14 characters ending in .., as -3! leaves a text it cut
// at a \c of 15: with \c unknown, the same answer on both was said to be cut.
test("a text that ends in .. where q may or may not have cut it is said to be unknown, not cut (#2164)", () => {
  const text = (type, ...lines) => ({ ok: true, type, text: lines });
  const c = compareOutcomes(side("a", text(-11, "`/data/hdb/x..")), side("b", text(-11, "`/data/hdb/x..")), -1, 160);
  assert.deepStrictEqual([c.same, c.partial, c.unsureCut], [false, true, true]);
  const page = loadPage();
  const said = (comparison) => (page.send({ type: "compare", id: 1, code: "x", comparison }), page.posted.at(-1).rendered.summary);
  assert.strictEqual(said(c), "Each answer's text is the same, and ends in .. as q writes a value it cut at the process's console width (\\c), which q-lint is not told: whether the rest is the same cannot be told.");
  // A line the console cut at the width asked for, or rows past its height, is cut.
  const sure = compareOutcomes(side("a", text(0, "1", "`a..", "..")), side("b", text(0, "1", "`a..", "..")), -1, 160);
  assert.deepStrictEqual([sure.partial, sure.unsureCut], [true, false]);
  assert.match(said(sure), /^The part of each answer that came back is the same; the text was cut at the console size/);
});

// 30 30#til 900: each row's item is 79 characters, cut at \c 80, and the
// page said the cells were cut at 200 characters.
test("a cell q cut at its console width is not said to be cut at 200 characters (#2165)", () => {
  const item = `${Array.from({ length: 30 }, (_, i) => i).join(" ")}`.slice(0, 77) + "..";
  const long = `"${"a".repeat(196)}...`;
  const cells = (...items) => table({ x: [0, items, items.map(() => false)] });
  const page = loadPage();
  const said = (c) => (page.send({ type: "compare", id: 1, code: "t", comparison: c }), page.posted.at(-1).rendered.summary);
  const c = compareOutcomes(side("a", cells(item)), side("b", cells(item)), -1);
  assert.deepStrictEqual([c.same, c.cut, c.consoleCut], [false, 1, 1]);
  assert.strictEqual(said(c), "1 cell is the same as far as shown, ending in .. as q writes an item it cut at the process's console width (\\c), and no further compared (rows lined up by place).");
  const both = compareOutcomes(side("a", cells(item, long, item)), side("b", cells(item, long, item)), -1);
  assert.strictEqual(said(both), "1 cell is the same as far as shown, cut at 200 characters, and no further compared, 2 cells are the same as far as shown, ending in .. as q writes an item it cut at the process's console width (\\c), and no further compared (rows lined up by place).");
});
