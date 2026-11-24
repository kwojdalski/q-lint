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
  const time = (rows) => {
    const o = { process: "p", answer: mk(rows), millis: 1 };
    const t = process.hrtime.bigint();
    compareOutcomes(o, o, -1);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  time(10_000);
  const small = time(50_000);
  const big = time(100_000);
  // Before: 125 ms at 50k, 375 ms at 100k, 2.9 s at 200k.
  assert.ok(big < Math.max(small, 20) * 3, `${small} ms at 50k, ${big} ms at 100k`);
});
