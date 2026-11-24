// Query modes (#855): how a grid answer becomes the cells, ranks and values
// the result panel shows, CSV, the panel script's own helpers, and what a
// chart draws (media/chartspec.js, which notebook charts share). Run after
// `tsc`; the payloads are what node-q's codec makes of `GRID`'s answer, as
// qclient.test.js gets from a real q.
const test = require("node:test");
const assert = require("node:assert");
const Long = require("long");
const { GRID, readGridAnswer, toGrid, toCsv, csvField, csvText, cellText, typeName, rowCount, appendPage, codePointOrder, sortText } = require("../out/grid.js");
const { RUN } = require("../out/query.js");
const panel = require("../media/result.js");
const charts = require("../media/chartspec.js");

const NULL_GUID = "00000000-0000-0000-0000-000000000000";
const big = Long.fromString("9007199254740993");

/// A payload of one column of `type`, as GRID sends it.
function column(type, cells, raw, rank) {
  return {
    count: cells.length,
    keys: 0,
    names: ["c"],
    types: [type],
    cells: [cells],
    raw: [raw ?? []],
    rank: [rank ?? cells.map((_, i) => i)],
  };
}

const shown = (type, cells, raw, decimals = -1) => toGrid(column(type, cells, raw), decimals).cells[0];
const values = (type, cells, raw) => toGrid(column(type, cells, raw), -1).values[0];

test("the grid lambda keeps nothing on the process, and runs code as RUN does", () => {
  assert.ok(!GRID.includes("::"), GRID);
  assert.ok(!/\bset\b/.test(GRID), GRID);
  assert.ok(GRID.startsWith("{[s;size;limit]") && GRID.endsWith("}"));
  // The same trap, so an error and its trace read the same in both modes.
  const trap = RUN.split("\n").slice(1, 4).join("\n");
  assert.ok(GRID.includes(trap));
  // Continuation lines are indented, as q reads a multi-line lambda.
  for (const line of GRID.split("\n").slice(1)) {
    assert.match(line, /^ /, line);
  }
});

test("the tree is in GRID_TREE only: the lambda sent unless the result panel asks for a tree has none (#928)", () => {
  const { GRID_TREE } = require("../out/grid.js");
  assert.ok(!GRID.includes("g:{[g;e;b;k;v]"), GRID);
  assert.ok(GRID_TREE.includes("g:{[g;e;b;k;v]"), GRID_TREE);
  for (const lambda of [GRID, GRID_TREE]) {
    assert.ok(!lambda.includes("::") && !/\bset\b/.test(lambda));
    assert.ok(lambda.startsWith("{[s;size;limit]") && lambda.endsWith("}"));
    for (const line of lambda.split("\n").slice(1)) {
      assert.match(line, /^ /, line);
    }
  }
});

test("booleans, bytes, chars and symbols show q's text", () => {
  assert.deepStrictEqual(shown(1, ["1", "0"]), ["1", "0"]);
  assert.deepStrictEqual(shown(4, ["01", "ff"]), ["01", "ff"]);
  assert.deepStrictEqual(shown(10, ["a", " "]), ["a", " "]);
  assert.deepStrictEqual(shown(11, ["abc", ""]), ["abc", ""]);
  assert.strictEqual(values(11, ["abc"]), null);
});

test("a guid shows q's text, and a null one as kdb+ writes it", () => {
  const g = "8c680a01-5a49-5aab-5a65-d4bfddb6a661";
  // PeachQ's `string` writes a null guid as "": the raw value mends it.
  assert.deepStrictEqual(shown(2, [g, ""], [g, null]), [g, NULL_GUID]);
});

test("shorts, ints and longs: nulls are blank, infinities 0W and -0W", () => {
  assert.deepStrictEqual(shown(5, ["1", "", "0W"], [1, null, Infinity]), ["1", "", "0W"]);
  // PeachQ writes an infinite int as 2147483647.
  assert.deepStrictEqual(shown(6, ["1", "2147483647", ""], [1, Infinity, null]), ["1", "0W", ""]);
  assert.deepStrictEqual(shown(7, ["5", "-9223372036854775807"], [Long.fromNumber(5), -Infinity]), ["5", "-0W"]);
});

test("a long above 2^53 keeps every digit; its chart value is the nearest double", () => {
  assert.deepStrictEqual(shown(7, ["9007199254740993"], [big]), ["9007199254740993"]);
  assert.deepStrictEqual(values(7, ["9007199254740993"], [big]), [9007199254740992]);
});

test("reals and floats: q's text, or the decimals asked for; nulls blank, infinities 0w", () => {
  const cells = ["3.141593", "", "-0w", "1e+10"];
  const raw = [3.14159265358979, null, -Infinity, 1e10];
  assert.deepStrictEqual(shown(9, cells, raw), cells);
  assert.deepStrictEqual(shown(9, cells, raw, 2), ["3.14", "", "-0w", "10000000000.00"]);
  assert.deepStrictEqual(shown(9, cells, raw, 0), ["3", "", "-0w", "10000000000"]);
  // A real arrives widened; the decimals hide that.
  assert.deepStrictEqual(shown(8, ["1.1", "0w"], [Math.fround(1.1), Infinity], 3), ["1.100", "0w"]);
  assert.deepStrictEqual(values(9, cells, raw), [3.14159265358979, null, null, 1e10]);
});

test("decimals touch no other type", () => {
  assert.deepStrictEqual(shown(7, ["5"], [Long.fromNumber(5)], 2), ["5"]);
  assert.deepStrictEqual(shown(15, ["2026.11.20T10:11:12.123"], [9820.424445868055], 2), ["2026.11.20T10:11:12.123"]);
});

test("temporals show q's text, nanoseconds kept; nulls blank, infinities as kdb+ writes them", () => {
  const cases = [
    [12, "2026.11.20D10:11:12.123456789", Long.fromString("848484672123456789"), "0W"],
    [13, "2026.11", 322, "0W"],
    [14, "2026.11.20", 9820, "0W"],
    [15, "2026.11.20T10:11:12.123", 9820.424445868055, "0w"],
    [16, "-0D01:02:03.000000001", Long.fromString("-3723000000001"), "0W"],
    [17, "10:11", 611, "0W"],
    [18, "10:11:12", 36672, "0W"],
    [19, "10:11:12.123", 36672123, "0W"],
  ];
  for (const [type, text, raw, inf] of cases) {
    // PeachQ's `string` of an infinite temporal is a far date: replaced.
    assert.deepStrictEqual(
      shown(type, [text, "", "2292.04.10D23:47:16.854775807", "x"], [raw, null, Infinity, -Infinity]),
      [text, "", inf, `-${inf}`],
      `type ${type}`,
    );
    const v = values(type, [text, ""], [raw, null]);
    assert.strictEqual(v[0], Number(raw), `type ${type}`);
    assert.strictEqual(v[1], null);
  }
});

test("a general column shows q's text and has no values", () => {
  assert.deepStrictEqual(shown(0, ['"ab"', "1 2 3", "`a`b"]), ['"ab"', "1 2 3", "`a`b"]);
  assert.strictEqual(values(0, ['"ab"']), null);
});

test("columns know their type, keys and whether they chart", () => {
  const grid = toGrid(
    {
      count: 5,
      keys: 1,
      names: ["sym", "px", "time", "note"],
      types: [11, 9, 12, 0],
      cells: [["a", "b"], ["1.5", "2"], ["2026.11.20D00:00:00.000000000", ""], ["x", "y"]],
      raw: [[], [1.5, 2], [Long.fromNumber(0), null], []],
      rank: [[0, 1], [0, 1], [1, 0], []],
    },
    -1,
  );
  assert.deepStrictEqual(
    grid.columns.map((c) => [c.name, c.typeName, c.key, c.numeric, c.temporal]),
    [
      ["sym", "symbol (s)", true, false, false],
      ["px", "float (f)", false, true, false],
      ["time", "timestamp (p)", false, false, true],
      ["note", "list", false, false, false],
    ],
  );
  assert.strictEqual(grid.total, 5);
  assert.strictEqual(rowCount(grid), 2);
  // A column q could not rank is sorted by its text.
  assert.deepStrictEqual(grid.rank, [[0, 1], [0, 1], [1, 0], null]);
  assert.strictEqual(typeName(20), "enum");
  assert.strictEqual(typeName(77), "type 77");
});

test("cellText leaves a cell with no raw value as q wrote it", () => {
  assert.strictEqual(cellText(11, "abc", undefined, 2), "abc");
  assert.strictEqual(cellText(9, "1.5", 1.5, -1), "1.5");
});

test("a grid answer is read; a grid that is not one is dropped, and a shaping error kept", () => {
  const payload = column(7, ["1"], [Long.fromNumber(1)]);
  const ok = readGridAnswer({ ok: true, type: 98, text: ["c", "-", "1"], grid: payload });
  assert.deepStrictEqual(ok.text, ["c", "-", "1"]);
  assert.deepStrictEqual(ok.grid.cells, [["1"]]);
  assert.strictEqual(ok.grid.count, 1);
  // Not tabular: `grid` is ().
  assert.strictEqual(readGridAnswer({ ok: true, type: -7, text: ["2"], grid: [] }).grid, undefined);
  assert.strictEqual(readGridAnswer({ ok: true, type: -7, text: ["2"], grid: null }).grid, undefined);
  assert.deepStrictEqual(readGridAnswer({ ok: true, type: 98, text: [], grid: "par" }).gridError, "par");
  assert.strictEqual(readGridAnswer({ ok: true, type: 98, text: [], grid: { names: ["a"], cells: [] } }).grid, undefined);
  // An error is read as RUN's is.
  assert.deepStrictEqual(readGridAnswer({ ok: false, error: "type", trace: "" }), { ok: false, error: "type", trace: "" });
  assert.throws(() => readGridAnswer(42), /something other than a query result/);
  // A null symbol column name arrives as null.
  assert.deepStrictEqual(readGridAnswer({ ok: true, type: 98, text: [], grid: { ...payload, names: [null] } }).grid.names, [""]);
});

test("CSV quotes a field holding a comma, a quote or a line break, and doubles its quotes", () => {
  assert.strictEqual(csvField("abc"), "abc");
  assert.strictEqual(csvField("a,b"), '"a,b"');
  assert.strictEqual(csvField('say "hi"'), '"say ""hi"""');
  assert.strictEqual(csvField("two\nlines"), '"two\nlines"');
  assert.strictEqual(csvField("cr\r"), '"cr\r"');
  assert.strictEqual(csvField(" padded "), " padded ");
  assert.strictEqual(csvField(""), "");
});

test("CSV is the header and the rows given, as the cells show them", () => {
  const grid = toGrid(
    {
      count: 3,
      keys: 0,
      names: ["s", "px", "str"],
      types: [11, 9, 0],
      cells: [["a", "b", "c"], ["1.5", "", "3.25"], ['"x,y"', '"q"', "1 2"]],
      raw: [[], [1.5, null, 3.25], []],
      rank: [[0, 1, 2], [1, 0, 2], [0, 1, 2]],
    },
    1,
  );
  assert.strictEqual(toCsv(grid), 's,px,str\na,1.5,"""x,y"""\nb,,"""q"""\nc,3.3,1 2\n');
  assert.strictEqual(toCsv(grid, [2, 0]), 's,px,str\nc,3.3,1 2\na,1.5,"""x,y"""\n');
  assert.strictEqual(toCsv(grid, []), "s,px,str\n");
});

test("CSV keeps text a spreadsheet would run as a formula as text", () => {
  // A symbol, a string or a column name a spreadsheet opening the file
  // would read as a formula (=, +, -, @, a tab or a carriage return first)
  // is written with a leading quote; a number is written as it is. So is a
  // negative infinity or a negative timespan: `-0W` and `-0D01:00:00` are
  // no number, and a spreadsheet showed #NAME? for them.
  const grid = toGrid(
    {
      count: 3,
      keys: 0,
      names: ["=s", "j", "str", "n"],
      types: [11, 7, 0, 16],
      cells: [
        ["=HYPERLINK(\"http://x\")", "+1", "@SUM(A1)"],
        ["-1", "2", "3"],
        ["-2+3", "-1.5", "\tx"],
        ["-0D01:00:00.000000000", "0D00:00:00.000000000", ""],
      ],
      raw: [[], [-1, 2, 3], [], [-3600e9, 0, null]],
      rank: [[0, 1, 2], [0, 1, 2], [0, 1, 2], [0, 1, 2]],
    },
    -1,
  );
  assert.strictEqual(
    toCsv(grid),
    "'=s,j,str,n\n" +
      "\"'=HYPERLINK(\"\"http://x\"\")\",-1,'-2+3,'-0D01:00:00.000000000\n" +
      "'+1,2,-1.5,0D00:00:00.000000000\n" +
      "'@SUM(A1),3,'\tx,\n",
  );
  // An infinity in a numeric column is text too; a negative number is not.
  const inf = toGrid({ count: 2, keys: 0, names: ["j"], types: [7], cells: [["", "-5"]], raw: [[-Infinity, -5]], rank: [[0, 1]] }, -1);
  assert.strictEqual(toCsv(inf), "j\n'-0W\n-5\n");
});

// --- media/result.js and media/chartspec.js

const sample = () =>
  toGrid(
    {
      count: 4,
      keys: 0,
      names: ["t", "px", "sym"],
      types: [12, 9, 11],
      cells: [["d1", "d2", "d3", "d4"], ["3", "1", "", "2"], ["IBM", "msft", "ibm", "AAPL"]],
      raw: [[1, 2, 3, 4], [3, 1, null, 2], []],
      // As q ranks them: the null float first.
      rank: [[0, 1, 2, 3], [3, 1, 0, 2], [1, 3, 2, 0]],
    },
    -1,
  );

test("the panel sorts by q's ranks, either way, and filters on the text shown", () => {
  const grid = sample();
  assert.deepStrictEqual(panel.visibleRows(grid, [], null), [0, 1, 2, 3]);
  assert.deepStrictEqual(panel.visibleRows(grid, [], { column: 1, descending: false }), [2, 1, 3, 0]);
  assert.deepStrictEqual(panel.visibleRows(grid, [], { column: 1, descending: true }), [0, 3, 1, 2]);
  // Filters ignore case and combine.
  assert.deepStrictEqual(panel.visibleRows(grid, [undefined, "", "ibm"], null), [0, 2]);
  assert.deepStrictEqual(panel.visibleRows(grid, ["d3", "", "ibm"], null), [2]);
  assert.deepStrictEqual(panel.visibleRows(grid, ["", "", "ibm"], { column: 2, descending: false }), [0, 2]);
  // Without ranks, by text.
  grid.rank[2] = null;
  assert.deepStrictEqual(panel.visibleRows(grid, [], { column: 2, descending: false }), [3, 0, 2, 1]);
});

test("sorting either way keeps equal values in their order, as xasc and xdesc do", () => {
  // `s xdesc ([] s:`a`a`b`a)` is rows 2 0 1 3. GRID ranks equal values the
  // same: by their value's place among the column's distinct values.
  const grid = toGrid(
    { count: 4, keys: 0, names: ["s"], types: [11], cells: [["a", "a", "b", "a"]], raw: [[]], rank: [[0, 0, 1, 0]] },
    -1,
  );
  assert.deepStrictEqual(panel.visibleRows(grid, [], { column: 0, descending: false }), [0, 1, 3, 2]);
  assert.deepStrictEqual(panel.visibleRows(grid, [], { column: 0, descending: true }), [2, 0, 1, 3]);
  // By text, where q could not rank the column, the same.
  grid.rank[0] = null;
  assert.deepStrictEqual(panel.visibleRows(grid, [], { column: 0, descending: false }), [0, 1, 3, 2]);
  assert.deepStrictEqual(panel.visibleRows(grid, [], { column: 0, descending: true }), [2, 0, 1, 3]);
});

test("a chart plots the numeric columns, against the first but for a histogram", () => {
  const grid = sample();
  assert.deepStrictEqual(charts.chartable(grid, "line"), [1]);
  assert.deepStrictEqual(charts.chartable(grid, "histogram"), [1]);
  const line = charts.chartData(grid, [0, 1, 2, 3], "line", [1], 10);
  assert.deepStrictEqual(line, { type: "line", labels: ["d1", "d2", "d3", "d4"], datasets: [{ label: "px", column: 1, data: [3, 1, null, 2] }] });
  assert.strictEqual(charts.chartData(grid, [0], "bar", [1], 10).type, "bar");
  // Scatter: x from the first column's values; a null on either side drops the point.
  const scatter = charts.chartData(grid, [0, 1, 2, 3], "scatter", [1], 10);
  assert.deepStrictEqual(scatter.datasets[0].data.map((p) => [p.x, p.y]), [[1, 3], [2, 1], [4, 2]]);
  assert.match(charts.chartData(grid, [0], "line", [], 10).note, /No numeric column/);
});

test("the panel's chart draws the columns ticked, told apart by place, not name", () => {
  // Before any choice, every column it can.
  assert.deepStrictEqual(panel.chartColumns([1, 2], null), { columns: [1, 2] });
  // A keyed table whose key and value columns share a name: unticking one
  // leaves the other.
  assert.deepStrictEqual(panel.chartColumns([0, 1], [1]), { columns: [1] });
  // None ticked: a note that says so, not that there is nothing to chart.
  const none = panel.chartColumns([1, 2], []);
  assert.deepStrictEqual(none.columns, []);
  assert.match(none.note, /No column is ticked/);
  assert.doesNotMatch(none.note, /No numeric column/);
});

test("a histogram bins every series over one range", () => {
  assert.deepStrictEqual(charts.histogram([[0, 1, 2, 3, 4, null, Infinity]], 2), { edges: [0, 2, 4], counts: [[2, 3]] });
  assert.deepStrictEqual(charts.histogram([[1, 1, 1]], 10), { edges: [1, 1], counts: [[3]] });
  assert.deepStrictEqual(charts.histogram([[0, 10], [5]], 2), { edges: [0, 5, 10], counts: [[1, 1], [0, 1]] });
  assert.deepStrictEqual(charts.histogram([[null]], 4), { edges: [], counts: [[]] });
  const h = charts.chartData(sample(), [0, 1, 2, 3], "histogram", [1], 2);
  assert.deepStrictEqual(h.labels, ["1 - 2", "2 - 3"]);
  assert.deepStrictEqual(h.datasets[0].data, [1, 2]);
});

test("a temporal axis is labelled in q's notation", () => {
  assert.strictEqual(charts.temporalLabel(12, 848484672123456789), "2026.11.20D10:11:12");
  assert.strictEqual(charts.temporalLabel(13, 322), "2026.11");
  assert.strictEqual(charts.temporalLabel(13, -1), "1999.12");
  assert.strictEqual(charts.temporalLabel(14, 9820), "2026.11.20");
  assert.strictEqual(charts.temporalLabel(15, 9820.5), "2026.11.20T12:00:00");
  assert.strictEqual(charts.temporalLabel(16, -3723000000001), "-0D01:02:03");
  assert.strictEqual(charts.temporalLabel(17, 611), "10:11");
  assert.strictEqual(charts.temporalLabel(18, 36672), "10:11:12");
  assert.strictEqual(charts.temporalLabel(19, 36672123), "10:11:12");
});

const LOOK = { colours: ["#111111", "#222222"], foreground: "#eeeeee", border: "#333333", font: "Menlo" };

test("a scatter's month, date, minute or second axis ticks whole units", () => {
  // Chart.js puts ticks between whole values over a short range: months
  // 322 to 324 had 322.2, 322.4, ... labelled "2026.11.199999999999989".
  for (const type of [13, 14, 17, 18]) {
    const grid = toGrid(
      { count: 3, keys: 0, names: ["t", "y"], types: [type, 9], cells: [["a", "b", "c"], ["1", "2", "3"]], raw: [[322, 323, 324], [1, 2, 3]], rank: [[0, 1, 2], [0, 1, 2]] },
      -1,
    );
    const rows = [0, 1, 2];
    const config = charts.chartConfig(grid, rows, "scatter", charts.chartData(grid, rows, "scatter", [1], 10), LOOK);
    assert.strictEqual(config.options.scales.x.ticks.precision, 0, String(type));
  }
  // A tick between months still names a month.
  assert.strictEqual(charts.temporalLabel(13, 322.4), "2026.11");
  assert.strictEqual(charts.temporalLabel(13, -0.5), "1999.12");
});

test("a chart's configuration takes the theme's colours and the grid's axes", () => {
  const grid = sample();
  const line = charts.chartConfig(grid, [0, 1, 2, 3], "line", charts.chartData(grid, [0, 1, 2, 3], "line", [1], 10), LOOK);
  assert.strictEqual(line.type, "line");
  assert.deepStrictEqual(line.data.labels, ["d1", "d2", "d3", "d4"]);
  assert.strictEqual(line.data.datasets[0].borderColor, "#111111");
  assert.strictEqual(line.options.scales.x.type, "category");
  assert.strictEqual(line.options.scales.x.title.text, "t");
  assert.strictEqual(line.options.plugins.title.display, false);
  assert.strictEqual(line.options.animation, false);
  // A bar is translucent; a scatter is linear, its temporal x axis in q's notation.
  const bar = charts.chartConfig(grid, [0], "bar", charts.chartData(grid, [0], "bar", [1], 10), LOOK);
  assert.strictEqual(bar.data.datasets[0].backgroundColor, "#11111199");
  const scatter = charts.chartConfig(grid, [0, 1], "scatter", charts.chartData(grid, [0, 1], "scatter", [1], 10), LOOK, "Prices");
  assert.strictEqual(scatter.options.scales.x.type, "linear");
  assert.strictEqual(scatter.options.scales.x.ticks.callback(848484672123456789), "2026.11.20D10:11:12");
  assert.deepStrictEqual(scatter.options.plugins.title, { display: true, text: "Prices" });
  const histogram = charts.chartConfig(grid, [0, 1], "histogram", charts.chartData(grid, [0, 1], "histogram", [1], 2), LOOK);
  assert.deepStrictEqual(histogram.options.scales.y.title, { display: true, text: "count" });
});

test("a chart's theme is the editor's variables, with fallbacks, and is set on Chart.js's defaults", () => {
  const vars = { "--vscode-charts-blue": "#0000ff", "--vscode-foreground": "#abcdef" };
  const look = charts.theme((name, fallback) => vars[name] ?? fallback);
  assert.strictEqual(look.colours[0], "#0000ff");
  assert.strictEqual(look.colours[1], "#d18616");
  assert.strictEqual(look.foreground, "#abcdef");
  const Chart = { defaults: { font: {} } };
  charts.applyTheme(Chart, look);
  assert.deepStrictEqual(Chart.defaults, { color: "#abcdef", borderColor: look.border, font: { family: "sans-serif" } });
});

test("what a chart drew is summed up for the extension", () => {
  const grid = sample();
  assert.deepStrictEqual(charts.summary("line", charts.chartData(grid, [0, 1, 2, 3], "line", [1], 10)), {
    kind: "line",
    datasets: [{ label: "px", points: 4 }],
  });
  assert.match(charts.summary("line", charts.chartData(grid, [0], "line", [], 10)).note, /No numeric column/);
});

test("a list, one numeric column, is charted against its row number", () => {
  // `3 1 2` in chart mode: GRID sends it as one `value` column.
  const grid = toGrid({ count: 3, keys: 0, names: ["value"], types: [7], cells: [["3", "1", "2"]], raw: [[3, 1, 2]], rank: [[2, 0, 1]] }, -1);
  const rows = [0, 1, 2];
  for (const kind of ["line", "bar", "scatter", "histogram"]) {
    assert.deepStrictEqual(charts.chartable(grid, kind), [0], kind);
  }
  const line = charts.chartData(grid, rows, "line", [0], 10);
  assert.strictEqual(line.note, undefined);
  assert.deepStrictEqual(line.labels, ["0", "1", "2"]);
  assert.deepStrictEqual(line.datasets[0].data, [3, 1, 2]);
  const scatter = charts.chartData(grid, rows, "scatter", [0], 10);
  assert.deepStrictEqual(scatter.datasets[0].data.map((p) => [p.x, p.y]), [[0, 3], [1, 1], [2, 2]]);
  for (const kind of ["line", "scatter"]) {
    const config = charts.chartConfig(grid, rows, kind, charts.chartData(grid, rows, kind, [0], 10), LOOK);
    assert.strictEqual(config.options.scales.x.title.text, "row", kind);
  }
  // A table's first column is still its x axis, never a series.
  assert.deepStrictEqual(charts.chartable(sample(), "line"), [1]);
});

test("a row-number axis and a histogram's count axis tick whole numbers", () => {
  // Two rows, x a symbol: Chart.js ticked rows 0, 0.1, 0.2 ..., and a
  // histogram of counts 1 and 2 ticked counts 1.1, 1.2 ...
  const grid = toGrid({ count: 2, keys: 0, names: ["s", "y"], types: [11, 9], cells: [["a", "b"], ["1", "2"]], raw: [[], [1, 2]], rank: [[0, 1], [0, 1]] }, -1);
  const rows = [0, 1];
  const scatter = charts.chartConfig(grid, rows, "scatter", charts.chartData(grid, rows, "scatter", [1], 10), LOOK);
  assert.strictEqual(scatter.options.scales.x.ticks.precision, 0);
  const histogram = charts.chartConfig(grid, rows, "histogram", charts.chartData(grid, rows, "histogram", [1], 10), LOOK);
  assert.strictEqual(histogram.options.scales.y.ticks?.precision, 0);
  // A numeric x axis, or a y axis of values, keeps its fractions.
  const own = charts.chartConfig(sample(), [0, 1], "line", charts.chartData(sample(), [0, 1], "line", [1], 10), LOOK);
  assert.strictEqual(own.options.scales.y.ticks?.precision, undefined);
});

test("a scatter's ticks under a second apart are told apart by their fraction", () => {
  // Trades within one second: every tick read "2026.11.20D10:11:12".
  const at = (type, values, step) => {
    const grid = toGrid({ count: 2, keys: 0, names: ["t", "y"], types: [type, 9], cells: [["a", "b"], ["1", "2"]], raw: [values, [1, 2]], rank: [[0, 1], [0, 1]] }, -1);
    const config = charts.chartConfig(grid, [0, 1], "scatter", charts.chartData(grid, [0, 1], "scatter", [1], 10), LOOK);
    const ticks = [0, 1, 2].map((i) => ({ value: values[0] + i * step }));
    return ticks.map((t, i) => config.options.scales.x.ticks.callback(t.value, i, ticks));
  };
  assert.deepStrictEqual(at(12, [848484672100000000, 848484672300000000], 1e8), ["2026.11.20D10:11:12.1", "2026.11.20D10:11:12.2", "2026.11.20D10:11:12.3"]);
  assert.deepStrictEqual(at(19, [36672000, 36673000], 250), ["10:11:12.00", "10:11:12.25", "10:11:12.50"]);
  assert.deepStrictEqual(at(16, [-500000000, 0], 250000000), ["-0D00:00:00.50", "-0D00:00:00.25", "0D00:00:00.00"]);
  assert.deepStrictEqual(at(15, [9820.5, 9820.6], 0.5 / 86400), ["2026.11.20T12:00:00.0", "2026.11.20T12:00:00.5", "2026.11.20T12:00:01.0"]);
  // A fraction that rounds up carries into the seconds.
  assert.strictEqual(charts.temporalLabel(19, 36672999.9, 100), "10:11:13.0");
  // A second or more apart, as before.
  assert.deepStrictEqual(at(19, [36672000, 36674000], 1000), ["10:11:12", "10:11:13", "10:11:14"]);
});

test("a histogram of floats spanning more than the largest double counts every value", () => {
  // hi - lo overflowed to Infinity: the edges were NaN and the values
  // counted at bin NaN, so the chart showed no bar.
  const h = charts.histogram([[-1e308, 0, 1e308, 1e308]], 2);
  assert.deepStrictEqual(h.counts, [[1, 3]]);
  assert.ok(h.edges.every(Number.isFinite), String(h.edges));
  assert.deepStrictEqual(h.edges, [-1e308, 0, 1e308]);
});

test("the bins field takes 0 as the fewest bins, not as the default 20", () => {
  assert.strictEqual(panel.binsFrom("0", 20), 1);
  assert.strictEqual(panel.binsFrom("-3", 20), 1);
  assert.strictEqual(panel.binsFrom("7", 20), 7);
  assert.strictEqual(panel.binsFrom("9999", 20), 500);
  // Nothing typed: the default.
  assert.strictEqual(panel.binsFrom("", 20), 20);
});

test("a grid of more rows than a page can be tall still scrolls to its last row", () => {
  // 22 px a row: two million rows are 44,000,000 px, past the 33,554,432
  // px Chromium lets an element be, so the last half million could not be
  // scrolled to.
  const count = 2e6;
  const view = 600;
  const top = panel.span(0, view, count);
  assert.strictEqual(top.start, 0);
  assert.ok(top.before + (top.end - top.start) * 22 + top.after <= panel.MAX_HEIGHT);
  const bottom = panel.span(panel.MAX_HEIGHT - view, view, count);
  assert.strictEqual(bottom.end, count);
  assert.ok(bottom.before + (bottom.end - bottom.start) * 22 + bottom.after <= panel.MAX_HEIGHT + 1);
  // The rows drawn are those in view: the spacer above ends at or before it.
  assert.ok(bottom.before <= panel.MAX_HEIGHT - view);
  // A grid that fits is laid out row for row, as before.
  assert.deepStrictEqual(panel.span(220, view, 1000), { start: 0, end: 68, before: 0, after: (1000 - 68) * 22 });
  assert.deepStrictEqual(panel.span(22000, view, 1000), { start: 980, end: 1000, before: 980 * 22, after: 0 });
});

test("a scatter against the row puts each point at its row, filtered or sorted", () => {
  // x a symbol, so the axis is "row". Filtered to rows 3 and 1, the points
  // were drawn at rows 0 and 1: their places in the list shown.
  const grid = toGrid({ count: 4, keys: 0, names: ["s", "y"], types: [11, 9], cells: [["a", "b", "c", "d"], ["1", "2", "3", "4"]], raw: [[], [1, 2, 3, 4]], rank: [[0, 1, 2, 3], [0, 1, 2, 3]] }, -1);
  const scatter = charts.chartData(grid, [3, 1], "scatter", [1], 10);
  assert.deepStrictEqual(scatter.datasets[0].data.map((p) => [p.x, p.y]), [[3, 4], [1, 2]]);
});

test("a histogram's bins over a narrow range of prices are labelled apart", () => {
  // EURUSD between 1.08341 and 1.08349 in 4 bins: every label read
  // "1.08341 - 1.08341", six significant digits being too few.
  const grid = toGrid({ count: 3, keys: 0, names: ["px"], types: [9], cells: [["a", "b", "c"]], raw: [[1.08341, 1.08345, 1.08349]], rank: [[0, 1, 2]] }, -1);
  const h = charts.chartData(grid, [0, 1, 2], "histogram", [0], 4);
  assert.deepStrictEqual(h.labels, ["1.08341 - 1.08343", "1.08343 - 1.08345", "1.08345 - 1.08347", "1.08347 - 1.08349"]);
  // Large values the same, in exponent form.
  const big = toGrid({ count: 2, keys: 0, names: ["n"], types: [7], cells: [["a", "b"]], raw: [[1e15, 1e15 + 4e10]], rank: [[0, 1]] }, -1);
  const labels = charts.chartData(big, [0, 1], "histogram", [0], 2).labels;
  assert.strictEqual(new Set(labels).size, 2, String(labels));
  assert.notStrictEqual(labels[0].split(" - ")[0], labels[0].split(" - ")[1], String(labels));
  // A wide range keeps its short labels.
  assert.deepStrictEqual(charts.chartData(sample(), [0, 1, 2, 3], "histogram", [1], 2).labels, ["1 - 2", "2 - 3"]);
});

test("a long line chart shows a value between two nulls, which no segment draws", () => {
  // Over 200 rows a line has no points, only segments, and a value with a
  // null on each side has none: a column null every other row drew nothing.
  const n = 300;
  const raw = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? i : null));
  const grid = toGrid({ count: n, keys: 0, names: ["i", "px"], types: [7, 9], cells: [raw.map((_, i) => String(i)), raw.map(String)], raw: [raw.map((_, i) => i), raw], rank: [raw.map((_, i) => i), raw.map((_, i) => i)] }, -1);
  const rows = [...Array(n).keys()];
  const config = charts.chartConfig(grid, rows, "line", charts.chartData(grid, rows, "line", [1], 10), LOOK);
  const dataset = config.data.datasets[0];
  const radius = (i) => (typeof dataset.pointRadius === "function" ? dataset.pointRadius({ dataset, dataIndex: i }) : dataset.pointRadius);
  assert.ok(radius(2) > 0, "an isolated value has a point");
  assert.strictEqual(radius(1), 0, "a null has none");
  // A value beside another is drawn by its segment, with no point.
  const full = toGrid({ count: n, keys: 0, names: ["i", "px"], types: [7, 9], cells: [rows.map(String), rows.map(String)], raw: [rows, rows], rank: [rows, rows] }, -1);
  const solid = charts.chartConfig(full, rows, "line", charts.chartData(full, rows, "line", [1], 10), LOOK).data.datasets[0];
  assert.strictEqual(typeof solid.pointRadius === "function" ? solid.pointRadius({ dataset: solid, dataIndex: 5 }) : solid.pointRadius, 0);
});

test("a line or bar chart's tooltip says the cell's value, not Chart.js's three decimals", () => {
  // Chart.js writes a value with at most three decimals and the nearest
  // double: an FX price 1.083415 read 1.083, a long above 2^53 lost digits.
  const grid = toGrid({ count: 3, keys: 0, names: ["d", "px", "n"], types: [11, 9, 7], cells: [["a", "b", "c"], ["1.083415", "1.08342", "1.0835"], ["1", "9007199254740993", "3"]], raw: [[], [1.083415, 1.08342, 1.0835], [1, big, 3]], rank: [[0, 1, 2], [0, 1, 2], [0, 2, 1]] }, -1);
  for (const kind of ["line", "bar"]) {
    // Sorted: the second point drawn is row 2.
    const rows = [0, 2, 1];
    const config = charts.chartConfig(grid, rows, kind, charts.chartData(grid, rows, kind, [1, 2], 10), LOOK);
    const label = config.options.plugins.tooltip.callbacks.label;
    assert.strictEqual(label({ dataset: config.data.datasets[0], dataIndex: 0, raw: 1.083415, formattedValue: "1.083" }), "px: 1.083415");
    assert.strictEqual(label({ dataset: config.data.datasets[1], dataIndex: 2, raw: 9007199254740992, formattedValue: "9,007,199,254,740,992" }), "n: 9007199254740993");
    assert.strictEqual(label({ dataset: config.data.datasets[0], dataIndex: 1, raw: 1.0835, formattedValue: "1.084" }), "px: 1.0835");
  }
});

/// The declarations of result.css's rule for `selector`, as written.
function cssRule(selector) {
  const css = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "media", "result.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1].split(",").map((s) => s.trim()).includes(selector));
  return found ? found[2] : "";
}

test("the grid's table is laid out by its columns' widths, not by the cells in view", () => {
  // `table-layout: fixed` is ignored on a table whose width is auto: a
  // 150-character cell scrolled into view widened its column from 12ch
  // to 1212 px and squeezed the next to 20 px (headless Chrome), so the
  // columns jumped as the rows were scrolled.
  const table = cssRule("table");
  assert.match(table, /table-layout:\s*fixed/);
  assert.match(table, /(^|;|\s)width:\s*(?!auto)[^;]+;/);
});

test("a key column's sticky header is opaque, though the key shade is translucent", () => {
  // th.key's shade won over the header's background, and a theme's
  // editor.inactiveSelectionBackground is often translucent (VS Code's
  // default is the selection colour at half alpha; #ffffff80 in high
  // contrast): the rows scrolled up showed through the key's header and
  // its filter.
  const head = cssRule("thead th.key");
  assert.match(head, /background:[^;]*var\(--vscode-editor-inactiveSelectionBackground[^;]*,\s*var\(--vscode-editor(GroupHeader-tabs)?-background/);
});

test("Copy Pivot and Copy Matrix write each field as the grid's CSV does, a formula neutralised (#1389)", () => {
  for (const t of ['=HYPERLINK("http://x","y")', "+1+2", "-0W", "@sum", "\tx", "-0.5", "1e-3", "a,b", "plain", ""]) {
    assert.strictEqual(panel.csvCell(t), csvField(csvText(t)), JSON.stringify(t));
  }
  assert.strictEqual(panel.csvCell("=1+1"), "'=1+1");
});

test("a series or column named as an Object member has no colour or width but its own (#1393)", () => {
  for (const name of ["constructor", "valueOf", "toString", "__proto__"]) {
    assert.strictEqual(panel.ownValue({}, name), undefined, name);
  }
  assert.strictEqual(panel.ownValue({ constructor: "#ff0000" }, "constructor"), "#ff0000");
  assert.strictEqual(panel.ownValue(undefined, "px"), undefined);
});

test("a real's raw number is the shortest decimal its float32 reads back as, for exports and rules (#1488)", () => {
  const { toJson } = require("../out/resultexport.js");
  const { xlsxCell } = require("../out/xlsx.js");
  const look = require("../media/gridlook.js");
  // node-q widens 0.1e to the nearest double.
  const wide = Math.fround(0.1);
  assert.strictEqual(wide, 0.10000000149011612);
  const payload = { count: 2, keys: 0, names: ["e", "f"], types: [8, 9], cells: [["0.1", "0w"], ["0.1", "1.5"]], raw: [[wide, Infinity], [wide, 1.5]], rank: [[0, 1], [0, 1]] };
  const { grid } = readGridAnswer({ ok: true, type: 98, text: [], grid: payload });
  assert.deepStrictEqual(grid.raw, [[0.1, Infinity], [wide, 1.5]]);
  assert.match(toJson(grid), /"e": 0\.1,/);
  assert.deepStrictEqual(xlsxCell(8, "0.1", grid.raw[0][0]), { n: 0.1 });
  assert.deepStrictEqual([...look.ruleRows(toGrid(grid, -1), { column: "e", op: "=", value: "0.1" })], [0]);
  // A page of a held result likewise.
  const { readPage } = require("../out/grid.js");
  assert.deepStrictEqual(readPage({ count: 1, names: ["e"], types: [8], cells: [["0.1"]], raw: [[wide]], rank: [[0]] }).raw, [[0.1]]);
  // An unwrapped result, decoded here.
  const { gridOfQ } = require("../out/qformat.js");
  assert.deepStrictEqual(gridOfQ({ kind: "vector", t: 8, attr: 0, v: [wide, null] }, 100).raw, [[0.1, null]]);
});

test("a real that needs nine digits to read back is its nine-digit decimal, not the widened double (#1734)", () => {
  const { realValue } = require("../out/grid.js");
  const { toJson } = require("../out/resultexport.js");
  const x = 0.10993709415197372;
  assert.strictEqual(Math.fround(x), x);
  assert.strictEqual(realValue(x), 0.109937094);
  assert.strictEqual(Math.fround(0.109937094), x);
  const { grid } = readGridAnswer({ ok: true, type: 98, text: [], grid: { count: 1, keys: 0, names: ["r"], types: [8], cells: [["0.1099371"]], raw: [[x]], rank: [[0]] } });
  assert.match(toJson(grid), /"r": 0\.109937094\}/);
  // Shorter still where fewer digits do.
  assert.strictEqual(realValue(Math.fround(0.1)), 0.1);
  assert.strictEqual(realValue(Math.fround(1.5)), 1.5);
  // Every float32 now reads back from what it gives.
  for (let i = 0; i < 20000; i++) {
    const r = Math.fround((Math.random() - 0.5) * 10 ** Math.floor(Math.random() * 20 - 10));
    assert.strictEqual(Math.fround(realValue(r)), r, String(r));
    assert.strictEqual(Number(realValue(r).toPrecision(9)), realValue(r), String(r));
  }
});

test("a page added to a symbol column ranks it in code point order, as q sorts by UTF-8 bytes; the page's text sort too (#1642)", () => {
  const first = { count: 3, keys: 0, names: ["s"], types: [11], cells: [["\uff21"]], raw: [[]], rank: [[0]] };
  const page = { count: 3, names: ["s"], types: [11], cells: [["\u{1f600}", "z"]], raw: [[]], rank: [[1, 0]] };
  // z, fullwidth A, then the emoji.
  assert.deepStrictEqual(appendPage(first, page).rank[0], [1, 2, 0]);
  assert.ok(codePointOrder("\uff21", "\u{1f600}") < 0);
  assert.ok(codePointOrder("a", "ab") < 0);
  assert.strictEqual(codePointOrder("x", "x"), 0);
  const grid = { columns: [{ name: "s" }], cells: [["\u{1f600}", "\uff21", "z"]], rank: [null], values: [null] };
  assert.deepStrictEqual(panel.visibleRows(grid, [], { column: 0, descending: false }), [2, 1, 0]);
});

test("a page added to a string column ranks a cell GRID cut at 197 characters by its characters, not its quote (#1643)", () => {
  const long = '"' + "z".repeat(196) + "...";
  const first = { count: 3, keys: 0, names: ["s"], types: [0], cells: [['"apple"']], raw: [[]], rank: [[0]] };
  const page = { count: 3, names: ["s"], types: [0], cells: [[long, '"mango"']], raw: [[]], rank: [[1, 0]] };
  assert.deepStrictEqual(appendPage(first, page).rank[0], [0, 2, 1]);
  assert.strictEqual(sortText(long), "z".repeat(196));
  // A whole string that ends in dots keeps them; a cut through an escape drops its backslash.
  assert.strictEqual(sortText('"ab..."'), "ab...");
  assert.strictEqual(sortText('"ab\\...'), "ab");
});

test("paging ranks every column exactly as ranking all rows at once does (#1854)", () => {
  const { denseRank } = require("../out/grid.js");
  let seed = 7;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const mk = (n) => {
    const nums = Array.from({ length: n }, () => (rnd(10) === 0 ? null : rnd(40) - 20));
    const syms = Array.from({ length: n }, () => ["b", "a", "\u{1f600}", "Ａ", "aa"][rnd(5)]);
    return {
      count: 1000, names: ["x", "s"], types: [7, 11],
      cells: [nums.map((v) => (v === null ? "0N" : String(v))), syms],
      raw: [nums, []],
      rank: [nums.map((_, i) => i), syms.map((_, i) => i)],
    };
  };
  let grid = { ...mk(30), keys: 0 };
  for (let page = 0; page < 12; page++) {
    grid = appendPage(grid, mk(1 + rnd(40)));
    const raw = grid.raw[0];
    const key = (v) => (v === null ? -Infinity : v);
    assert.deepStrictEqual(grid.rank[0], denseRank(raw.length, (a, b) => (key(raw[a]) < key(raw[b]) ? -1 : key(raw[a]) > key(raw[b]) ? 1 : 0)));
    const s = grid.cells[1];
    assert.deepStrictEqual(grid.rank[1], denseRank(s.length, (a, b) => codePointOrder(s[a], s[b])));
  }
});

test("adding a page to many held rows costs far less than ranking them all again (#1854)", () => {
  const { denseRank } = require("../out/grid.js");
  const held = 400_000;
  const column = (off, n) => Array.from({ length: n }, (_, i) => ((off + i) * 7919) % 1000003);
  const page = (off, n) => {
    const raw = column(off, n);
    const syms = raw.map((v) => "s" + v);
    return { count: 2_000_000, keys: 0, names: ["x", "s"], types: [7, 11], cells: [raw.map(String), syms], raw: [raw, []], rank: [raw.map((_, i) => i), raw.map((_, i) => i)] };
  };
  let grid = appendPage({ ...page(0, 0) }, page(0, held));
  const next = page(held, 5_000);
  let t = process.hrtime.bigint();
  for (let k = 0; k < 3; k++) {
    grid = appendPage(grid, next);
  }
  const append = Number(process.hrtime.bigint() - t) / 3;
  const s = grid.cells[1];
  t = process.hrtime.bigint();
  denseRank(s.length, (a, b) => codePointOrder(s[a], s[b]));
  const all = Number(process.hrtime.bigint() - t);
  // Before, one page re-ranked both columns (about 2 x all).
  assert.ok(append < all / 2, `append ${append / 1e6} ms vs one full ranking ${all / 1e6} ms`);
});

test("a chart past PLOT_POINTS is not built as SVG for q Plots: its SVG would be past the 20 MB the view keeps (#1856)", () => {
  const { plainSvg } = require("../out/plots.js");
  const make = (rows, columns) => ({
    columns: [...Array(columns)].map((_, i) => ({ name: "c" + i, numeric: true, key: false, type: 9, temporal: false })),
    values: [...Array(columns)].map((_, c) => Array.from({ length: rows }, (_, i) => i * (c + 1) * 0.37)),
    cells: [...Array(columns)].map(() => Array.from({ length: rows }, (_, i) => String(i))),
    rank: [...Array(columns)].map(() => null),
  });
  // Just past the bound, the SVG is already more than plainSvg keeps.
  const rows = Math.ceil(panel.PLOT_POINTS / 2) + 1;
  const grid = make(rows, 3);
  const data = charts.chartData(grid, [...Array(rows).keys()], "line", [1, 2], 20);
  assert.ok(panel.chartPoints(data) > panel.PLOT_POINTS);
  const svg = charts.chartSvg(grid, [...Array(rows).keys()], "line", data, { colours: ["#f00", "#0f0"] }, {});
  assert.ok(svg.length >= 20_000_000, String(svg.length));
  assert.strictEqual(plainSvg(svg), false);
  // Counting is cheap next to building it: a million rows of nine series.
  const big = { datasets: [...Array(9)].map(() => ({ data: new Array(1_000_000).fill(1) })) };
  const t = process.hrtime.bigint();
  assert.strictEqual(panel.chartPoints(big), 9_000_000);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 100);
  assert.strictEqual(panel.chartPoints({ panes: [{ data: [1, 2] }, { data: [3] }] }), 3);
  assert.strictEqual(panel.chartPoints({}), 0);
});
