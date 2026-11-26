// How a result is dressed, as data (#1012-#1015, #1020, #1021): the page's
// pure helpers (media/gridlook.js), the look kept per result and saved
// query (src/resultlook.ts), the Excel and HTML exports that keep the
// rules, and the Markdown a result is sent as (src/resultreport.ts).
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const L = require("../media/gridlook.js");
const look = require("../out/resultlook.js");
const { exportResult, toHtml } = require("../out/resultexport.js");
const report = require("../out/resultreport.js");

const col = (name, type, extra = {}) => ({ name, type, typeName: "t", key: false, numeric: [5, 6, 7, 8, 9].includes(type), temporal: false, ...extra });

/// A grid of named columns, each [name, type, cells, values?].
function grid(columns) {
  return {
    columns: columns.map(([name, type]) => col(name, type)),
    cells: columns.map(([, , cells]) => cells),
    rank: columns.map(() => null),
    values: columns.map(([, type, cells, values]) => ([5, 6, 7, 8, 9].includes(type) ? values ?? cells.map((c) => (c === "" ? null : Number(c))) : null)),
    total: columns[0][2].length,
  };
}

test("a column's suffix names its format, in any case, with decimals, and the base name is what the header shows (#1012)", () => {
  assert.deepStrictEqual(L.columnFormat("ret_PCT"), { base: "ret", suffix: "PCT", kind: "pct", digits: 2, label: L.SUFFIXES.PCT.label });
  assert.strictEqual(L.columnFormat("ret_pct1").digits, 1);
  assert.strictEqual(L.columnFormat("spread_bps").kind, "bps");
  assert.strictEqual(L.columnFormat("a_b_CCY").base, "a_b");
  assert.strictEqual(L.columnFormat("px_BG").kind, "bg");
  assert.strictEqual(L.columnFormat("px_BG2"), null, "a colour takes no decimals");
  assert.strictEqual(L.columnFormat("px_avg"), null);
  assert.strictEqual(L.columnFormat("_PCT"), null);
  assert.strictEqual(L.columnFormat("PCT"), null);
  const f = (name) => L.columnFormat(name);
  assert.strictEqual(L.formatNumber(f("x_PCT"), 0.0123, "0.0123"), "1.23%");
  assert.strictEqual(L.formatNumber(f("x_PCT0"), 0.5, "0.5"), "50%");
  assert.strictEqual(L.formatNumber(f("x_BPS"), 0.0123, "0.0123"), "123.0 bp");
  assert.strictEqual(L.formatNumber(f("x_CCY"), -1234567.891, "-1234567.891"), "-1,234,567.89");
  assert.strictEqual(L.formatNumber(f("x_NUM"), 1234567, "1234567"), "1,234,567");
  // A long past 2^53 from q's text, not its double; a float past 1e21 not in exponent form (#1647).
  assert.strictEqual(L.formatNumber(f("x_CCY"), 123456789012345678, "123456789012345678"), "123,456,789,012,345,678.00");
  assert.strictEqual(L.formatNumber(f("x_NUM2"), -123456789012345678, "-123456789012345678"), "-123,456,789,012,345,678.00");
  assert.strictEqual(L.formatNumber(f("x_NUM0"), 123456789012345678, "123456789012345678"), "123,456,789,012,345,678");
  // _PCT and _BPS too (#1820).
  assert.strictEqual(L.formatNumber(f("x_PCT"), 2e19, "2e+19"), "2000000000000000000000.00%");
  assert.strictEqual(L.formatNumber(f("x_BPS"), 1e18, "1e+18"), "10000000000000000000000.0 bp");
  assert.strictEqual(L.formatNumber(f("x_CCY"), 1e21, "1e+21"), "1,000,000,000,000,000,000,000.00");
  // A float whose text q's \P or the grid's decimals rounded to an integer's (#1741).
  assert.strictEqual(L.formatNumber(f("x_CCY"), 1234567.891, "1234568"), "1,234,567.89");
  assert.strictEqual(L.formatNumber(f("x_NUM2"), 2.5, "3"), "2.50");
  assert.strictEqual(L.formatNumber(f("x_CCY"), 1.5, "1.5"), "1.50");
  // As q wrote it, digit for digit: a long past 2^53 keeps its digits.
  assert.strictEqual(L.formatNumber(f("x_NUM"), 9007199254740993, "9007199254740993"), "9,007,199,254,740,993");
  assert.strictEqual(L.formatNumber(f("x_NUM2"), 1234.5, "1234.5"), "1,234.50");
  // A null or an infinity is shown as q writes it.
  assert.strictEqual(L.formatNumber(f("x_PCT"), null, ""), "");
  assert.strictEqual(L.formatNumber(f("x_PCT"), null, "0w"), "0w");
});

test("a colour column's value reaches a style only as a hex colour or a name; its target is the column it names, or the row", () => {
  assert.strictEqual(L.cssColour("red"), "red");
  assert.strictEqual(L.cssColour(" #ff8800 "), "#ff8800");
  assert.strictEqual(L.cssColour("#f80c"), "#f80c");
  for (const bad of ["red;background:url(x)", "expression(1)", "#ff888", "rgb(1,2,3)", "", "a"]) {
    assert.strictEqual(L.cssColour(bad), null, bad);
  }
  const g = grid([["px", 9, ["1", "2"]], ["px_BG", 11, ["red", "green"]], ["row_FG", 11, ["blue", ""]], ["sym_PCT", 11, ["a", "b"]]]);
  const formats = L.columnFormats(g);
  assert.strictEqual(formats[0], null);
  assert.strictEqual(formats[1].target, 0);
  assert.strictEqual(formats[2].target, -1);
  // A number format on a column that is no number is no format.
  assert.strictEqual(formats[3], null);
});

test("a rule matches by number on a numeric column, by text on another, top and bottom N with ties, never a null (#1013)", () => {
  const g = grid([["px", 9, ["1", "5", "", "5", "9"]], ["sym", 11, ["ab", "AB", "", "c", "abc"]]]);
  const rows = (rule) => [...L.ruleRows(g, rule)].sort();
  assert.deepStrictEqual(rows({ column: "px", op: ">", value: 4 }), [1, 3, 4]);
  assert.deepStrictEqual(rows({ column: "px", op: "<=", value: 5 }), [0, 1, 3]);
  assert.deepStrictEqual(rows({ column: "px", op: "=", value: 5 }), [1, 3]);
  assert.deepStrictEqual(rows({ column: "px", op: "<>", value: 5 }), [0, 4]);
  assert.deepStrictEqual(rows({ column: "px", op: "top", value: 2 }), [1, 3, 4], "ties with the second greatest are in");
  assert.deepStrictEqual(rows({ column: "px", op: "bottom", value: 1 }), [0]);
  assert.deepStrictEqual(rows({ column: "sym", op: "=", value: "ab" }), [0]);
  assert.deepStrictEqual(rows({ column: "sym", op: "contains", value: "ab" }), [0, 1, 4]);
  assert.deepStrictEqual(rows({ column: "sym", op: ">", value: "a" }), [], "a text column takes no comparison of numbers");
  assert.deepStrictEqual(rows({ column: "nope", op: ">", value: 1 }), []);
  const styles = L.ruleStyles(g, [
    { column: "px", op: ">", value: 4, style: { background: "red" } },
    { column: "px", op: "top", value: 1, style: { background: "green", bold: true } },
    { column: "px", op: ">", value: 0, style: { background: "not-a-colour" } },
  ]);
  assert.strictEqual(styles[1], null);
  assert.deepStrictEqual(styles[0].get(1), { background: L.PALETTE.red });
  assert.deepStrictEqual(styles[0].get(4), { background: L.PALETTE.green, bold: true }, "the later rule's colour wins");
  assert.strictEqual(styles[0].has(2), false);
  assert.strictEqual(L.ruleText({ column: "px", op: "top", value: 3, style: { color: "red", bold: true } }), "px top 3: red text, bold");
});

test("q's text of a numeric vector is read as its numbers, as KDB-X and PeachQ write it (#1014)", () => {
  // Each as `-3!` writes it on both (checked against both interpreters).
  assert.deepStrictEqual(L.parseNumbers("1 2 3"), [1, 2, 3]);
  assert.deepStrictEqual(L.parseNumbers("1 2 3f"), [1, 2, 3]);
  assert.deepStrictEqual(L.parseNumbers("1.5 2.5"), [1.5, 2.5]);
  assert.deepStrictEqual(L.parseNumbers(",1.5"), [1.5]);
  assert.deepStrictEqual(L.parseNumbers(",4i"), [4]);
  assert.deepStrictEqual(L.parseNumbers("0N 7"), [null, 7]);
  assert.deepStrictEqual(L.parseNumbers("0n 1 2"), [null, 1, 2]);
  assert.deepStrictEqual(L.parseNumbers("1 2 3h"), [1, 2, 3]);
  assert.deepStrictEqual(L.parseNumbers("1 0W -0W"), [1, null, null]);
  assert.deepStrictEqual(L.parseNumbers("1e-05 2e+10"), [1e-5, 2e10]);
  assert.deepStrictEqual(L.parseNumbers("`float$()"), []);
  // Cut at \c (`..`) or at 200 characters (`...`): the last number may be part of one.
  assert.deepStrictEqual(L.parseNumbers("6 27 28 .."), [6, 27]);
  assert.deepStrictEqual(L.parseNumbers("1 2 34..."), [1, 2]);
  for (const not of ["2026.01.01 2026.01.02", "`a`b", "101b", "0x0102", "(1;`a)", "abc"]) {
    assert.strictEqual(L.parseNumbers(not), null, not);
  }
  const g = grid([["v", 0, ["1 2 3", ",4", ""]], ["w", 0, ["1 2", "`a`b", ""]], ["x", 9, ["1", "2", "3"]]]);
  assert.strictEqual(L.isNumericList(g, 0), true);
  assert.strictEqual(L.isNumericList(g, 1), false);
  assert.strictEqual(L.isNumericList(g, 2), false);
});

test("a sparkline is an SVG data URL broken at nulls; a data bar spans from zero (#1014)", () => {
  const url = L.sparkUrl([1, null, 3, 2], "#3794ff");
  assert.match(url, /^url\("data:image\/svg\+xml,/);
  const svg = decodeURIComponent(url.slice('url("data:image/svg+xml,'.length, -2));
  assert.match(svg, /<path d="M0\.00 18\.00M66\.67 2\.00L100\.00 10\.00"/);
  assert.match(svg, /stroke="#3794ff"/);
  assert.strictEqual(L.sparkUrl([null, null], "#000"), null);
  assert.ok(!/["]/.test(url.slice(5, -2)), "no quote in the URL breaks the CSS");
  assert.deepStrictEqual(L.barLevels([0, 5, 10, null]), [[0, 0], [0, 0.5], [0, 1], null]);
  assert.deepStrictEqual(L.barLevels([-5, 5]), [[0, 0.5], [0.5, 1]]);
  assert.deepStrictEqual(L.barLevels([0, 0]), [null, null]);
  assert.match(L.barBackground([0.25, 0.5], "#3794ff"), /^linear-gradient\(to right, transparent 25\.0%, color-mix\(in srgb, #3794ff 45%, transparent\) 25\.0%/);
});

test("the layout orders, hides and freezes columns by name, a name twice taking its next column (#1015)", () => {
  const g = grid([["a", 7, ["1"]], ["b", 7, ["1"]], ["a", 7, ["1"]], ["c", 7, ["1"]]]);
  assert.deepStrictEqual(L.displayColumns(g, undefined), [0, 1, 2, 3]);
  assert.deepStrictEqual(L.displayColumns(g, { order: ["c", "a", "gone"], hidden: [] }), [3, 0, 1, 2]);
  assert.deepStrictEqual(L.displayColumns(g, { order: ["c", "a", "a"], hidden: ["b"] }), [3, 0, 2]);
  assert.deepStrictEqual(L.moveColumn(g, { order: [], hidden: [] }, 3, 0), ["c", "a", "b", "a"]);
  // Hidden columns keep their place after the ones moved.
  assert.deepStrictEqual(L.moveColumn(g, { order: [], hidden: ["b"] }, 2, 0), ["c", "a", "a", "b"]);
  assert.deepStrictEqual(L.displayColumns(g, { order: L.moveColumn(g, { order: [], hidden: ["b"] }, 2, 0), hidden: ["b"] }), [3, 0, 2]);
  assert.deepStrictEqual(L.frozenOffsets(["10ch", "80px", "5ch"], 3), ["0px", "10ch", "calc(10ch + 80px)"]);
  assert.deepStrictEqual(L.frozenOffsets(["10ch"], 0), []);
});

test("a column is not moved past another of its name, and neither is resized by itself (#2508)", () => {
  // `cols 0!kt` of a keyed table with key sym and value sym px.
  const g = grid([["sym", 11, ["a"]], ["sym", 11, ["b"]], ["px", 9, ["1"]]]);
  const at = (order) => L.displayColumns(g, { order, hidden: [] });
  // The second sym to the front, or the first to the end: each would draw
  // the other one there, so nothing moves.
  assert.deepStrictEqual(at(L.moveColumn(g, { order: [], hidden: [] }, 1, 0)), [0, 1, 2]);
  assert.deepStrictEqual(at(L.moveColumn(g, { order: [], hidden: [] }, 0, 2)), [0, 1, 2]);
  // A move that keeps the two in their order is made, and draws as asked.
  assert.deepStrictEqual(at(L.moveColumn(g, { order: [], hidden: [] }, 2, 0)), [2, 0, 1]);
  assert.deepStrictEqual(at(L.moveColumn(g, { order: [], hidden: [] }, 1, 2)), [0, 2, 1]);
  const f = grid([["sym", 11, ["a"]], ["px", 9, ["1"]], ["sym", 11, ["b"]]]);
  assert.deepStrictEqual(L.displayColumns(f, { order: L.moveColumn(f, { order: [], hidden: [] }, 2, 0), hidden: [] }), [0, 1, 2]);
  assert.deepStrictEqual([0, 1, 2].map((i) => L.repeatedName(f, i)), [true, false, true]);
});

test("a layout that would hide every column draws them all: a new run of only hidden columns is not a grid of none (#1652)", () => {
  const g = grid([["a", 7, ["1"]], ["a", 7, ["1"]]]);
  assert.deepStrictEqual(L.displayColumns(g, { order: [], hidden: ["a"] }), [0, 1]);
  assert.deepStrictEqual(L.displayColumns(grid([["a", 7, ["1"]], ["b", 7, ["1"]]]), { order: [], hidden: ["a"] }), [1]);
});

test("the correlation matrix is Pearson's over the rows where both values are there, keys left out (#1020)", () => {
  const g = grid([["x", 9, ["1", "2", "3", "4"]], ["y", 9, ["2", "4", "6", "9"]], ["z", 9, ["4", "3", "", "1"]], ["k", 9, ["1", "1", "1", "1"]], ["s", 11, ["a", "b", "c", "d"]]]);
  const c = L.correlation(g, [0, 1, 2, 3]);
  assert.deepStrictEqual(c.names, ["x", "y", "z", "k"]);
  assert.strictEqual(c.r[0][0], 1);
  assert.ok(Math.abs(c.r[0][1] - 0.9943767126843689) < 1e-12, String(c.r[0][1]));
  assert.strictEqual(c.r[1][0], c.r[0][1]);
  assert.strictEqual(c.n[0][2], 3, "the null row is left out of the pair");
  assert.ok(Math.abs(c.r[0][2] - -1) < 1e-12, String(c.r[0][2]));
  assert.strictEqual(c.r[0][3], null, "a column that does not vary has no correlation");
  assert.deepStrictEqual(L.correlation(g, [0]).r[0][1], null, "one row is too few");
  const keyed = { ...g, columns: g.columns.map((col, i) => (i === 0 ? { ...col, key: true } : col)) };
  assert.deepStrictEqual(L.correlation(keyed, [0, 1, 2, 3]).names, ["y", "z", "k"]);
  const pairs = L.correlationPairs(c);
  assert.strictEqual(`${pairs[0].a}-${pairs[0].b}`, "x-z", "the strongest first, by its size");
  assert.strictEqual(pairs.at(-1).r, null);
});

test("values near the largest or the smallest double still correlate: 1e200 does not square to Infinity, 1e-200 to 0 (#2077)", () => {
  const g = grid([["a", 9, ["1e200", "2e200", "3e200"]], ["b", 9, ["1e200", "2e200", "3.1e200"]], ["c", 9, ["1e-200", "2e-200", "3e-200"]], ["d", 9, ["3e-200", "2e-200", "1e-200"]]]);
  const c = L.correlation(g, [0, 1, 2]);
  const r = (x, y) => c.r[x][y];
  assert.ok([0, 1, 2, 3].every((i) => Math.abs(r(i, i) - 1) < 1e-12), JSON.stringify(c.r));
  // As 1 2 3 and 1 2 3.1 correlate.
  assert.ok(Math.abs(r(0, 1) - 0.9996222851612185) < 1e-12, String(r(0, 1)));
  assert.ok(Math.abs(r(0, 2) - 1) < 1e-12 && Math.abs(r(2, 3) - -1) < 1e-12, JSON.stringify(c.r));
  assert.ok(L.correlationPairs(c).every((p) => p.r !== null && Number.isFinite(p.r)));
  // An infinity leaves no correlation to tell, not NaN.
  const inf = grid([["x", 9, ["1", "2", "0w"]], ["y", 9, ["1", "2", "3"]]]);
  inf.values[0][2] = Infinity;
  assert.strictEqual(L.correlation(inf, [0, 1, 2]).r[0][1], null);
});

test("a column that does not vary has no correlation even when its mean is off by rounding (#1386)", () => {
  const g = grid([["fee", 9, ["0.1", "0.1", "0.1"]], ["rate", 9, ["0.7", "0.7", "0.7"]], ["sq", 9, ["0", "1", "4"]]]);
  const c = L.correlation(g, [0, 1, 2]);
  assert.deepStrictEqual(c.r, [[null, null, null], [null, null, null], [null, null, 1]]);
});

test("a stored look keeps only what it can hold, and moves with a renamed saved query (#1013-#1015, #1019)", () => {
  const stored = {
    trades: {
      rules: [{ column: "px", op: ">", value: 1, style: { background: "red" } }, { column: "px", op: "top", value: 1.5, style: { bold: true } }, { column: "px", op: "~", value: 1, style: { bold: true } }, { column: "px", op: "=", value: 1, style: { background: "url(x)" } }],
      cellCharts: { px: "bar", v: "spark", w: "pie" },
      layout: { order: ["b", 1], hidden: ["c"], widths: { a: 120, b: 3, c: "9", d: 2400 }, frozen: 2 },
      chart: { kind: "line", series: ["px"], colours: { px: "#ff0000", qty: "red" }, bins: 900 },
    },
    junk: "x",
    empty: {},
  };
  const looks = look.parseLooks(stored);
  assert.deepStrictEqual(Object.keys(looks), ["trades"]);
  assert.deepStrictEqual(looks.trades.rules, [{ column: "px", op: ">", value: 1, style: { background: "red" } }]);
  assert.deepStrictEqual(looks.trades.cellCharts, { px: "bar", v: "spark" });
  // A width past the bounds is brought to them, not dropped (#1641).
  assert.deepStrictEqual(looks.trades.layout, { order: ["b"], hidden: ["c"], widths: { a: 120, b: 24, d: 2000 }, frozen: 2 });
  assert.strictEqual(look.parseLayout({ frozen: 55 }).frozen, 50);
  assert.deepStrictEqual(looks.trades.chart, { kind: "line", series: ["px"], colours: { px: "#ff0000" } });
  const renamed = look.renamedLook(looks, "trades", "fills");
  assert.deepStrictEqual(Object.keys(renamed), ["fills"]);
  assert.deepStrictEqual(look.withoutLook(renamed, "fills"), {});
  assert.deepStrictEqual(look.withLook({ a: { layout: looks.trades.layout } }, "a", {}), {});
  assert.deepStrictEqual(look.lookParts(looks.trades, { rules: false, cellCharts: true, layout: false, chart: false }), { cellCharts: { px: "bar", v: "spark" } });
  let l = look.withRule({}, { column: "a", op: "<", value: 0, style: { color: "red" } });
  l = look.withRule(l, { column: "b", op: "<", value: 0, style: { color: "red" } });
  assert.deepStrictEqual(look.withoutRules(l, "a").rules.map((r) => r.column), ["b"]);
  assert.deepStrictEqual(look.withoutRules(look.withoutRules(l, "a"), "b"), {});
  assert.deepStrictEqual(look.withCellChart(look.withCellChart({}, "a", "bar"), "a", undefined), {});
  assert.strictEqual(look.ruleValueProblem("top", "0", true), "A count: a whole number from 1.");
  assert.strictEqual(look.ruleValueProblem(">", "abc", true), "A number, such as 100 or -0.5.");
  assert.strictEqual(look.ruleValueProblem(">", "-0.5", true), undefined);
  assert.strictEqual(look.ruleValueProblem("=", "AAPL", false), undefined);
  assert.strictEqual(look.ruleValue(">", " 2.5 ", true), 2.5);
  assert.strictEqual(look.ruleValue("=", "a b", false), "a b");
});

/// The files of a zip, by name.
function unzip(buffer) {
  const out = {};
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30);
    const comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

const PAYLOAD = { count: 3, keys: 0, names: ["sym", "px"], types: [11, 9], cells: [["a", "b<c", "c"], ["1", "5", "9"]], raw: [[], [1, 5, 9]], rank: [[0, 1, 2], [0, 1, 2]] };

test("the Excel export writes each rule as Excel's own conditional formatting, the later rule first (#1013)", () => {
  const rules = [
    { column: "px", op: ">", value: 4, style: { background: "red" } },
    { column: "px", op: "bottom", value: 1, style: { color: "green", bold: true } },
    { column: "sym", op: "contains", value: 'b"<', style: { background: "blue" } },
    { column: "sym", op: ">", value: 1, style: { background: "blue" } },
    { column: "gone", op: "=", value: 1, style: { bold: true } },
  ];
  const files = unzip(exportResult("xlsx", PAYLOAD, -1, undefined, rules).data);
  const sheet = files["xl/worksheets/sheet1.xml"];
  // An empty cell is no number: Excel would take it for 0 (#1266).
  assert.match(sheet, /<\/sheetData><conditionalFormatting sqref="B2:B4"><cfRule type="expression" dxfId="0" priority="5"><formula>AND\(ISNUMBER\(B2\),B2&gt;4\)<\/formula><\/cfRule><\/conditionalFormatting>/);
  // Bottom 1 of every row the grid holds, not only of those written (#1648).
  assert.match(sheet, /<cfRule type="expression" dxfId="1" priority="4"><formula>AND\(ISNUMBER\(B2\),B2&lt;=1\)<\/formula><\/cfRule>/);
  // contains: in any case, with no wildcards, never an empty cell (#1266).
  assert.match(sheet, /<conditionalFormatting sqref="A2:A4"><cfRule type="expression" dxfId="2" priority="3"><formula>AND\(LEN\(A2\)&gt;0,ISNUMBER\(FIND\(LOWER\(&quot;b&quot;&quot;&lt;&quot;\),LOWER\(A2\)\)\)\)<\/formula>/);
  assert.strictEqual((sheet.match(/<conditionalFormatting /g) || []).length, 3, "a comparison of numbers on text, and a missing column, are left out");
  assert.match(files["xl/styles.xml"], /<dxfs count="3"><dxf><fill><patternFill patternType="solid"><bgColor rgb="FFF14C4C"\/><\/patternFill><\/fill><\/dxf><dxf><font><b\/><color rgb="FF89D185"\/><\/font><\/dxf>/);
  assert.match(files["xl/styles.xml"], /<\/cellStyles><dxfs /, "dxfs come after cellStyles, as the schema orders them");
  // With no rules, the workbook is as before.
  const plain = unzip(exportResult("xlsx", PAYLOAD, -1).data);
  assert.ok(!/conditionalFormatting|dxfs/.test(plain["xl/worksheets/sheet1.xml"] + plain["xl/styles.xml"]));
});

test("Excel's conditional formats match the cells the grid's rules do (#1266)", () => {
  const { xlsxRules } = require("../out/resultlook.js");
  const letter = (i) => "ABCD"[i];
  const rule = (column, op, value) => ({ column, op, value, style: { bold: true } });
  const out = xlsxRules(
    [rule("s", "=", "Ab"), rule("s", "<>", "Ab"), rule("d", "=", "2024.01.02"), rule("d", "contains", "2024"), rule("n", "contains", "1"), rule("n", "<", "x"), rule("n", "<", 5)],
    ["s", "d", "n"],
    [false, false, true],
    letter,
    4,
    [true, false, false],
  ).formatting;
  assert.deepStrictEqual(out.map((f) => /<formula>(.*)<\/formula>/.exec(f)[1]), [
    "AND(LEN(A2)&gt;0,EXACT(A2,&quot;Ab&quot;))",
    "AND(LEN(A2)&gt;0,NOT(EXACT(A2,&quot;Ab&quot;)))",
    "AND(ISNUMBER(C2),C2&lt;5)",
  ]);
});

test("a rule value's control characters stay out of Excel's sheet XML, and one over 255 characters is split into literals Excel takes (#2660)", () => {
  const { xlsxRules } = require("../out/resultlook.js");
  const rule = (value) => ({ column: "s", op: "contains", value, style: { bold: true } });
  const long = "a".repeat(300) + '"';
  const out = xlsxRules([rule("35=D\u0001"), rule(long)], ["s"], [false], () => "A", 4, [true]).formatting;
  const formulas = out.map((f) => /<formula>(.*)<\/formula>/.exec(f)[1]);
  assert.strictEqual(formulas[0], "AND(LEN(A2)&gt;0,ISNUMBER(FIND(LOWER(&quot;35=D&quot;),LOWER(A2))))");
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(out.join("")));
  const literals = formulas[1].replace(/&quot;/g, '"').match(/"(?:[^"]|"")*"/g);
  assert.deepStrictEqual(literals.map((l) => l.slice(1, -1).replace(/""/g, '"').length), [255, 46]);
  assert.strictEqual(literals.map((l) => l.slice(1, -1).replace(/""/g, '"')).join(""), long);
  assert.match(formulas[1], /&quot;&amp;&quot;/);
});

test("a text rule on a general list of strings is left out of Excel, which holds the strings without their quotes (#1411)", () => {
  const strings = { count: 2, keys: 0, names: ["s", "m"], types: [0, 0], cells: [['"abc"', '"x"'], ["1", "`a"]], raw: [[], []], rank: [[0, 1], [0, 1]] };
  const grid = { columns: [col("s", 0), col("m", 0)], cells: strings.cells, rank: [null, null], values: [null, null], total: 2 };
  const rules = [{ column: "s", op: "=", value: '"abc"', style: { bold: true } }, { column: "m", op: "=", value: "1", style: { bold: true } }];
  // The grid matches the text as shown, quotes and all.
  assert.deepStrictEqual([...L.ruleStyles(grid, rules)[0].keys()], [0]);
  const sheet = unzip(exportResult("xlsx", strings, -1, undefined, rules).data)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<t xml:space="preserve">abc<\/t>/);
  // Only the rule on the column Excel holds as shown is kept.
  assert.strictEqual((sheet.match(/<conditionalFormatting /g) || []).length, 1);
  assert.match(sheet, /<conditionalFormatting sqref="B2:B3">/);
});

test("the HTML export is one escaped table, the cells a rule matches styled as the grid styles them (#1013)", () => {
  const html = toHtml(PAYLOAD, -1, [2, 1], [{ column: "px", op: ">", value: 4, style: { background: "red", bold: true } }]);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<th>sym<\/th><th class="n">px<\/th>/);
  assert.match(html, /<tr><td>c<\/td><td class="n" style="background:#f14c4c;font-weight:bold">9<\/td><\/tr>\n<tr><td>b&lt;c<\/td><td class="n" style="background:#f14c4c;font-weight:bold">5<\/td><\/tr>/);
  assert.ok(!/<script/i.test(toHtml({ ...PAYLOAD, cells: [["<script>x</script>", "b", "c"], ["1", "2", "3"]] }, -1)));
  assert.strictEqual(exportResult("html", PAYLOAD, -1).rows, 3);
});

test("a query with 200k backtick runs still gets a fence: the runs are not spread into one call (#2663)", () => {
  const code = `s in ${"`a".repeat(200000)} and "\`\`\`\`"`;
  assert.strictEqual(report.fenceFor(code), "`````");
});

test("a result sent to a notebook or a report is its query in a fence it cannot close, its rows as a table, and its chart (#1021)", () => {
  assert.strictEqual(report.fenceFor("select from t"), "```");
  assert.strictEqual(report.fenceFor("a:\"```\" , \"````\""), "`````");
  assert.strictEqual(report.markdownText("my*proc_1"), "my\\*proc\\_1");
  const out = report.resultMarkdown({ process: "rdb", code: "select from t\n", at: Date.UTC(2026, 10, 22, 9, 30, 5), payload: PAYLOAD, rows: [2, 0], decimals: -1 }, "img/c.svg");
  assert.strictEqual(out.rows, 2);
  assert.strictEqual(
    out.text,
    "**Result** from rdb at 2026-11-22 09:30:05 UTC\n\n```q\nselect from t\n```\n\n| sym | px |\n| --- | ---: |\n| c | 9 |\n| a | 1 |\n\n![chart](img/c.svg)\n\n",
  );
  const html = report.resultMarkdown({ process: "p", code: "t", at: 0, payload: { ...PAYLOAD, cells: [["<img src=x onerror=alert(1)>", "a&b", "c"], ["1", "2", "3"]] }, decimals: -1 });
  assert.match(html.text, /\| \\<img src=x onerror=alert\(1\)\\> \| 1 \|\n\| a\\&b \| 2 \|/);
  const many = { ...PAYLOAD, count: 600, cells: [Array(600).fill("a"), Array(600).fill("1")], raw: [[], Array(600).fill(1)], rank: [[], []] };
  const cut = report.resultMarkdown({ process: "p", code: "t", at: 0, payload: many, decimals: -1 });
  assert.strictEqual(cut.rows, report.MAX_ROWS);
  assert.match(cut.text, /_The first 500 of 600 rows\._/);
  // Rows a filter picked are not the first of the result (#1649).
  const held = { ...PAYLOAD, count: 1000, cells: [["a", "b", "c", "d", "e"], ["1", "2", "3", "4", "5"]], raw: [[], [1, 2, 3, 4, 5]] };
  assert.match(report.resultMarkdown({ process: "p", code: "t", at: 0, payload: held, rows: [4, 3], decimals: -1 }).text, /_The 2 rows the grid's filters show, of the 5 held; the result has 1,000\._/);
  const many1 = { ...many, count: 700 };
  assert.match(report.resultMarkdown({ process: "p", code: "t", at: 0, payload: many1, rows: [...Array(550).keys()], decimals: -1 }).text, /_The first 500 of the 550 rows the grid's filters show, of the 600 held; the result has 700\._/);
  const taken = new Set(["daily-images/chart-20261122-093005.svg"]);
  assert.strictEqual(report.imagePath("/r/daily.md", Date.UTC(2026, 10, 22, 9, 30, 5), (p) => taken.has(p)), "daily-images/chart-20261122-093005-2.svg");
  assert.strictEqual(report.linkTarget("a b/(c).svg"), "a%20b/%28c%29.svg");
  assert.strictEqual(report.linkTarget("Q#1 report-images/chart?.svg"), "Q%231%20report-images/chart%3F.svg");
});

test("a rule compares 0w and -0w as the infinities they are; only a null matches nothing (#1645)", () => {
  const g = grid([["px", 9, ["5", "0w", "-0w", ""]]]);
  g.values[0] = [5, null, null, null];
  const rows = (op, value) => [...L.ruleRows(g, { column: "px", op, value, style: { bold: true } })];
  assert.deepStrictEqual(rows(">", 1), [0, 1]);
  assert.deepStrictEqual(rows("<", 1), [2]);
  assert.deepStrictEqual(rows("top", 1), [1]);
  assert.deepStrictEqual(rows("bottom", 1), [2]);
  assert.deepStrictEqual(rows("<>", 5), [1, 2]);
});

test("Excel's top and bottom N rank every row the grid holds, not only the filtered rows written (#1648)", () => {
  const top = [{ column: "px", op: "top", value: 1, style: { bold: true } }];
  // Filtered to px < 9: the grid colours no cell shown, 9 being the top.
  const sheet = unzip(exportResult("xlsx", PAYLOAD, -1, [0, 1], top).data)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<formula>AND\(ISNUMBER\(B2\),B2&gt;=9\)<\/formula>/);
  assert.ok(!/top10/.test(sheet));
  // 0w is the top: no number in Excel matches, only its text (#2090); and
  // with it not written, nothing.
  const infinite = { ...PAYLOAD, cells: [["a", "b", "c"], ["1", "0w", "9"]], raw: [[], [1, Infinity, 9]] };
  assert.match(unzip(exportResult("xlsx", infinite, -1, undefined, top).data)["xl/worksheets/sheet1.xml"], /<conditionalFormatting sqref="B2:B4"><cfRule type="expression" dxfId="0" priority="1"><formula>B2=&quot;0w&quot;<\/formula>/);
  assert.ok(!/conditionalFormatting/.test(unzip(exportResult("xlsx", infinite, -1, [0, 2], top).data)["xl/worksheets/sheet1.xml"]));
});

test("Excel colours the 0w and -0w cells the grid's rules colour, a top N of them too (#2090)", () => {
  // ([] px:0w 5 3 -0w 2f; n:0W 5 3 -0W 2), px > 1 red and n top 1 green.
  const p = {
    count: 5, keys: 0, names: ["px", "n"], types: [9, 7],
    cells: [["0w", "5", "3", "-0w", "2"], ["0W", "5", "3", "-0W", "2"]],
    raw: [[Infinity, 5, 3, -Infinity, 2], [Infinity, 5, 3, -Infinity, 2]],
    rank: [[4, 3, 2, 0, 1], [4, 3, 2, 0, 1]],
  };
  const rules = [{ column: "px", op: ">", value: 1, style: { background: "red" } }, { column: "n", op: "top", value: 1, style: { color: "green" } }, { column: "px", op: "<=", value: 2, style: { bold: true } }, { column: "n", op: "bottom", value: 2, style: { bold: true } }];
  const g = require("../out/grid.js").toGrid(p, -1);
  assert.deepStrictEqual(L.ruleStyles(g, rules).map((m) => [...m.keys()].sort()), [[0, 1, 2, 3, 4], [0, 3, 4]]);
  const sheet = unzip(exportResult("xlsx", p, -1, undefined, rules).data)["xl/worksheets/sheet1.xml"];
  const formulas = [...sheet.matchAll(/<formula>([^<]*)<\/formula>/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<"));
  assert.deepStrictEqual(formulas, ['OR(AND(ISNUMBER(A2),A2>1),A2="0w")', 'B2="0w"', 'OR(AND(ISNUMBER(A2),A2<=2),A2="-0w")', 'OR(AND(ISNUMBER(B2),B2<=2),B2="-0w")']);
});

test("Excel colours a long it holds as text, past 2^53, as the grid's rule does (#2459)", () => {
  // ([] id:5 1700000000000000123 9007199254740993), id > 100 and id top 1.
  const p = {
    count: 3, keys: 0, names: ["id"], types: [7],
    cells: [["5", "1700000000000000123", "9007199254740993"]],
    raw: [[5, "1700000000000000123", "9007199254740993"]],
    rank: [[0, 2, 1]],
  };
  const rules = [{ column: "id", op: ">", value: 100, style: { background: "red" } }, { column: "id", op: "top", value: 1, style: { bold: true } }];
  const g = require("../out/grid.js").toGrid(p, -1);
  assert.deepStrictEqual([...L.ruleStyles(g, rules.slice(0, 1))[0].keys()].sort(), [1, 2]);
  const sheet = unzip(exportResult("xlsx", p, -1, undefined, rules).data)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<t xml:space="preserve">1700000000000000123<\/t>/);
  const formulas = [...sheet.matchAll(/<formula>([^<]*)<\/formula>/g)].map((m) => m[1].replace(/&gt;/g, ">"));
  assert.deepStrictEqual(formulas, [
    "OR(AND(ISNUMBER(A2),A2>100),AND(ISTEXT(A2),IFERROR(VALUE(A2)>100,FALSE)))",
    "OR(AND(ISNUMBER(A2),A2>=1700000000000000000),AND(ISTEXT(A2),IFERROR(VALUE(A2)>=1700000000000000000,FALSE)))",
  ]);
  // A column of longs Excel holds as numbers is as before.
  const small = unzip(exportResult("xlsx", { ...p, cells: [["5", "6", "7"]], raw: [[5, 6, 7]] }, -1, undefined, rules.slice(0, 1)).data)["xl/worksheets/sheet1.xml"];
  assert.match(small, /<formula>AND\(ISNUMBER\(A2\),A2&gt;100\)<\/formula>/);
});

test("correlation reads at most CORR_BUDGET row-pairs, over every step-th row past it, and says so (#1857)", () => {
  const columns = 20;
  const make = (rows) => ({
    columns: [...Array(columns)].map((_, i) => ({ name: "c" + i, numeric: true, key: false, type: 9 })),
    values: [...Array(columns)].map((_, c) => Float64Array.from({ length: rows }, (_, i) => Math.sin(i * (c + 1)))),
    cells: [...Array(columns)].map(() => []),
  });
  // Best of three: one garbage collection or a busy machine during a single
  // run can make one size look slow with the code unchanged.
  const time = (rows) => {
    const g = make(rows);
    const all = [...Array(rows).keys()];
    let c;
    const ms = Math.min(
      ...[0, 1, 2].map(() => {
        const t = process.hrtime.bigint();
        c = L.correlation(g, all);
        return Number(process.hrtime.bigint() - t) / 1e6;
      }),
    );
    return { ms, c };
  };
  const small = time(200_000);
  const big = time(800_000);
  // Rows x columns^2 grew four times with the rows (3.8x to 4x measured);
  // now it is bounded. The rows read are the same count at both sizes, but
  // every 9th of 800k rows is read further apart in memory than every 3rd
  // of 200k: under load that alone made the bounded code 2.6x.
  assert.ok(big.ms < small.ms * 3, `${small.ms} ms at 200k, ${big.ms} ms at 800k`);
  const pairs = (columns * (columns + 1)) / 2;
  assert.ok(big.c.used * pairs <= L.CORR_BUDGET);
  assert.strictEqual(big.c.of, 800_000);
  assert.strictEqual(big.c.step, Math.ceil((800_000 * pairs) / L.CORR_BUDGET));
  // Within the budget every row is read, as before.
  const exact = L.correlation(make(1000), [...Array(1000).keys()]);
  assert.strictEqual(exact.step, 1);
  assert.strictEqual(exact.used, 1000);
  assert.strictEqual(exact.n[0][1], 1000);
  // A budget given is the one kept: every other row of four.
  const g = grid([["x", 9, ["1", "2", "3", "4"]], ["y", 9, ["2", "4", "6", "9"]]]);
  assert.deepStrictEqual({ ...L.correlation(g, [0, 1, 2, 3], 6), r: undefined, columns: undefined, names: undefined }, { r: undefined, columns: undefined, names: undefined, n: [[2, 2], [2, 2]], used: 2, of: 4, step: 2 });
});

test("a look, a cell chart, a width and a chart colour are kept under the name __proto__, and a name the looks do not hold has no look (#1884)", () => {
  const layout = { order: ["a"], hidden: [], widths: {}, frozen: 1 };
  // Kept as the map's own entry, so it is in what is stored and read back.
  const kept = look.withLook({}, "__proto__", { layout });
  assert.deepStrictEqual(Object.keys(kept), ["__proto__"]);
  assert.strictEqual(Object.getPrototypeOf(kept), Object.prototype);
  const back = look.parseLooks(JSON.parse(JSON.stringify(kept)));
  assert.deepStrictEqual(look.lookOf(back, "__proto__"), { layout });
  assert.deepStrictEqual(Object.keys(look.withLook(back, "__proto__", {})), []);
  assert.deepStrictEqual(look.lookOf(look.renamedLook(back, "__proto__", "daily"), "daily"), { layout });
  assert.deepStrictEqual(look.lookOf(look.renamedLook(look.withLook({}, "daily", { layout }), "daily", "__proto__"), "__proto__"), { layout });
  // A name no look is kept under: not what every object inherits.
  for (const name of ["__proto__", "constructor", "toString"]) {
    assert.strictEqual(look.lookOf(look.parseLooks({}), name), undefined);
    assert.deepStrictEqual(look.renamedLook({}, name, "x"), {});
  }
  // Columns named so keep theirs too.
  const parsed = look.parseLook(JSON.parse('{"cellCharts":{"__proto__":"bar","px":"spark"},"layout":{"order":[],"hidden":[],"widths":{"__proto__":120},"frozen":0},"chart":{"kind":"line","series":[],"colours":{"__proto__":"#ff0000"}}}'));
  assert.deepStrictEqual(Object.keys(parsed.cellCharts), ["__proto__", "px"]);
  assert.deepStrictEqual(Object.entries(parsed.layout.widths), [["__proto__", 120]]);
  assert.deepStrictEqual(Object.entries(parsed.chart.colours), [["__proto__", "#ff0000"]]);
  assert.deepStrictEqual(Object.entries(look.withCellChart({}, "__proto__", "bar").cellCharts), [["__proto__", "bar"]]);
  assert.strictEqual(look.withCellChart(look.withCellChart({}, "__proto__", "bar"), "__proto__", undefined).cellCharts, undefined);
});
