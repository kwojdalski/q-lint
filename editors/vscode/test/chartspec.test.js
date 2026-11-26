// The axis ticks the result panel's SVG charts share (media/chartspec.js),
// run under node.
const test = require("node:test");
const assert = require("node:assert");
const C = require("../media/chartspec.js");

test("two values a rounding apart tick as one value, at once (#1383)", () => {
  const t = C.ticks(0.3, 0.1 + 0.2);
  assert.ok(t.values.length > 1 && t.values.length < 20, JSON.stringify(t));
  assert.ok(t.values[0] <= 0.3 && t.values[t.values.length - 1] >= 0.3);
  assert.strictEqual(new Set(t.values).size, t.values.length);
});

test("a series past the largest double's range still ticks and draws (#1384)", () => {
  const t = C.ticks(-1e308, 1e308);
  assert.ok(t.values.length > 1 && isFinite(t.step), JSON.stringify(t));
  const grid = { columns: [{ name: "x", numeric: false }, { name: "v", numeric: true }], cells: [["a", "b"], ["-1e308", "1e308"]], values: [null, [-1e308, 1e308]] };
  const d = C.chartData(grid, [0, 1], "line", [1], 20);
  const svg = C.chartSvg(grid, [0, 1], "line", d, { colours: ["#f00"] }, {});
  assert.ok(!svg.includes("NaN"), svg);
});

test("a control character in a label is replaced, so the SVG still parses (#1474)", () => {
  assert.strictEqual(C.xml("a\u0001b\u001f<\u000b￿"), "a�b�&lt;��");
  assert.strictEqual(C.xml("tab\tnl\ncr\r"), "tab\tnl\ncr\r");
  const grid = { columns: [{ name: "sym", numeric: false }, { name: "px", numeric: true }], cells: [["a\u0001b", "c"], ["1", "2"]], values: [null, [1, 2]] };
  const d = C.chartData(grid, [0, 1], "bar", [1], 20);
  const svg = C.chartSvg(grid, [0, 1], "bar", d, { colours: ["#f00"] }, {});
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg), svg);
});

test("a range small beside its size still ticks across it: 50 ms of timestamps, 1e12+60 (#1787)", () => {
  const t0 = 8.5e17;
  const t = C.ticks(t0, t0 + 5e7);
  assert.ok(t.step <= 2e7 && t.values.length > 2 && t.values.length < 20, JSON.stringify(t));
  assert.strictEqual(new Set(t.values).size, t.values.length);
  const grid = { columns: [{ name: "time", numeric: false, temporal: true, type: 12 }, { name: "px", numeric: true }], cells: [["a", "b", "c"], ["1", "2", "3"]], values: [[t0, t0 + 2.5e7, t0 + 5e7], [1, 2, 3]] };
  const d = C.chartData(grid, [0, 1, 2], "scatter", [1], 20);
  const cx = (C.chartSvg(grid, [0, 1, 2], "scatter", d, { colours: ["#f00"] }, {}).match(/cx="[^"]*"/g) || []);
  assert.strictEqual(new Set(cx).size, 3, cx.join(" "));
  const big = { columns: [{ name: "i", numeric: false }, { name: "vol", numeric: true }], cells: [["a", "b", "c"], ["1e12", "1e12+30", "1e12+60"]], values: [null, [1e12, 1e12 + 30, 1e12 + 60]] };
  const svg = C.chartSvg(big, [0, 1, 2], "line", C.chartData(big, [0, 1, 2], "line", [1], 20), { colours: ["#f00"] }, {});
  const ys = svg.match(/<path d="M[\d.]+ ([\d.]+) L[\d.]+ ([\d.]+) L[\d.]+ ([\d.]+)/);
  assert.ok(ys && new Set(ys.slice(1)).size === 3, svg);
  const labels = [...svg.matchAll(/text-anchor="end"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.strictEqual(new Set(labels).size, labels.length, labels.join(" "));
});

test("a value on a bin's edge counts in the bin above it, as labelled (#1790)", () => {
  const prices = Array.from({ length: 21 }, (_, i) => +(1 + i * 0.05).toFixed(2));
  assert.deepStrictEqual(C.histogram([prices], 20).counts[0], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
  assert.deepStrictEqual(C.histogram([[0, 0.3, 0.6, 0.7, 1]], 10).counts[0], [1, 0, 0, 1, 0, 0, 1, 1, 0, 1]);
});

test("a date, month, minute or second x axis ticks whole units, each label once (#1791)", () => {
  const M = require("../media/chartmore.js");
  const look = { colours: ["#f00", "#0f0"] };
  const g = (type, vals) => ({ columns: [{ name: "d", numeric: false, temporal: true, type }, { name: "px", numeric: true }], cells: [vals.map(String), ["1", "2", "3"].slice(0, vals.length)], values: [vals, [1, 2, 3].slice(0, vals.length)] });
  const labels = (svg) => [...svg.matchAll(/text-anchor="middle"[^>]*>([^<]*)</g)].map((m) => m[1]).filter((l) => /\d/.test(l));
  for (const [type, vals] of [[14, [9800, 9801]], [13, [318, 319]], [17, [600, 601]], [18, [36000, 36001]]]) {
    const grid = g(type, vals);
    const ls = labels(C.chartSvg(grid, [0, 1], "scatter", C.chartData(grid, [0, 1], "scatter", [1], 20), look, {}));
    assert.ok(ls.length >= 2 && new Set(ls).size === ls.length, type + ": " + ls.join(" | "));
  }
  assert.deepStrictEqual(C.ticks(9800, 9801, true).values.every(Number.isInteger), true);
  const grid = g(14, [9800, 9801, 9802]);
  const ld = M.linkedData(grid, [0, 1, 2], [1]);
  const ls = labels(M.linkedSvg(grid, ld, look, look.colours, {}));
  assert.ok(ls.length >= 2 && new Set(ls).size === ls.length, ls.join(" | "));
  assert.strictEqual(M.linkedConfig(grid, ld, ld.panes[0], "#f00", look, {}, true).options.scales.x.ticks.precision, 0);
});

// A timestamp is whole nanoseconds near 7.6e17: a range under ~11 us was
// taken for one value and widened by half its size, to 2006-2038; and a
// timestamp, timespan or time at 0 ticked a fraction of its unit apart,
// each label written over and over.
test("a timestamp, timespan or time x axis ticks at least one unit, or one double, apart (#2162)", () => {
  const g = (type, vals) => ({ columns: [{ name: "t", numeric: false, temporal: true, type }, { name: "y", numeric: true }], cells: [vals.map(String), vals.map((_, i) => String(i))], values: [vals, vals.map((_, i) => i)] });
  const labels = (grid) => {
    const rows = grid.values[0].map((_, i) => i);
    return [...C.chartSvg(grid, rows, "scatter", C.chartData(grid, rows, "scatter", [1], 20), { colours: ["#f00"] }, {}).matchAll(/text-anchor="middle"[^>]*>([^<]*)</g)].map((m) => m[1]).filter((l) => /\d/.test(l));
  };
  // 2024.01.01D12:00:00 and 2 ns later.
  const t0 = 757425600000000000;
  const stamps = labels(g(12, [t0, t0 + 2]));
  assert.ok(stamps.length >= 2 && stamps.every((l) => /^2024\.01\.01D1[12]:/.test(l)) && new Set(stamps).size === stamps.length, stamps.join(" | "));
  for (const [type, vals] of [[19, [0]], [19, [0, 1]], [16, [0]], [12, [0]]]) {
    const ls = labels(g(type, vals));
    assert.ok(ls.length >= 2 && new Set(ls).size === ls.length, type + ": " + ls.join(" | "));
  }
});

// A .qnb file's chart height "1px;position:fixed;inset:0;..." went into the
// renderer's cssText whole (#1834): only a number in / @height's range is.
test("a notebook chart's height is a number in / @height's range, or the default", () => {
  const { CHART_HEIGHT } = require("../out/celldirectives.js");
  assert.strictEqual(C.chartHeight(450, 300), 450);
  assert.strictEqual(C.chartHeight(CHART_HEIGHT.min, 300), CHART_HEIGHT.min);
  assert.strictEqual(C.chartHeight(CHART_HEIGHT.max, 300), CHART_HEIGHT.max);
  assert.strictEqual(C.chartHeight(CHART_HEIGHT.max + 1, 300), 300);
  assert.strictEqual(C.chartHeight(CHART_HEIGHT.min - 1, 300), 300);
  for (const bad of ["1px;position:fixed;inset:0;z-index:9;background:url(https://evil.example/b)", "450", NaN, Infinity, null, undefined, {}]) {
    assert.strictEqual(C.chartHeight(bad, 300), 300, String(bad));
  }
  assert.match(require("node:fs").readFileSync(require.resolve("../media/chartrenderer.js"), "utf8"), /height:\$\{C\.chartHeight\(spec\.height, HEIGHT\)\}px/);
});

test("a range across zero ticks 0 itself, not the residue of adding the step (#2074)", () => {
  assert.deepStrictEqual(C.ticks(-0.3, 0.2).values, [-0.3, -0.2, -0.1, 0, 0.1, 0.2]);
  assert.ok(C.ticks(-0.0317, -0.0027).values.includes(0));
  const grid = { columns: [{ name: "i", numeric: false }, { name: "pnl", numeric: true }], cells: [["a", "b", "c"], ["-0.3", "-0.1", "0.2"]], values: [null, [-0.3, -0.1, 0.2]] };
  const svg = C.chartSvg(grid, [0, 1, 2], "line", C.chartData(grid, [0, 1, 2], "line", [1], 20), { colours: ["#f00"] }, {});
  assert.doesNotMatch(svg, />-?[\d.]+e-\d+</, svg);
  // Over many ranges, a tick near zero is zero.
  let seed = 2074;
  const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 20000; i++) {
    const a = (next() - 0.7) * Math.pow(10, Math.floor(next() * 8) - 4);
    const b = a + next() * Math.abs(a) * 3;
    const t = C.ticks(a, b);
    for (const v of t.values) {
      assert.ok(v === 0 || Math.abs(v) > t.step * 1e-6, `${a} ${b}: ${v}`);
    }
  }
});

test("a year before 1000 is labelled in four digits, as q writes it (#3146)", () => {
  assert.strictEqual(C.temporalLabel(14, -730119, 1), "0001.01.01");
  assert.strictEqual(C.temporalLabel(14, -365243, 1), "0999.12.31");
  assert.strictEqual(C.temporalLabel(13, -23988, 1), "0001.01");
  assert.strictEqual(C.temporalLabel(15, -730119, 1), "0001.01.01T00:00:00");
  assert.strictEqual(C.temporalLabel(12, -730119 * 86400e9), "0001.01.01D00:00:00");
  assert.strictEqual(C.temporalLabel(14, 9820), "2026.11.20");
});

test("a saved scatter over row numbers ticks whole rows, and a saved histogram whole counts, as on screen (#3142, #3143)", () => {
  const look = { colours: ["#f00"] };
  const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]);
  const grid = { columns: [{ name: "s", numeric: false, type: 11 }, { name: "v", numeric: true, type: 9 }], cells: [["a", "b", "c"], ["1", "3", "2"]], values: [null, [1, 3, 2]] };
  const scatter = texts(C.chartSvg(grid, [0, 1, 2], "scatter", C.chartData(grid, [0, 1, 2], "scatter", [1], 20), look, {}));
  assert.deepStrictEqual(scatter.slice(scatter.indexOf("3") + 1, scatter.indexOf("row")), ["0", "1", "2"]);
  const list = { columns: [{ name: "v", numeric: true, type: 9 }], cells: [["1", "1", "2", "4"]], values: [[1, 1, 2, 4]] };
  const counts = texts(C.chartSvg(list, [0, 1, 2, 3], "histogram", C.chartData(list, [0, 1, 2, 3], "histogram", [0], 3), look, {}));
  assert.deepStrictEqual(counts.slice(0, counts.indexOf("1 - 2")), ["0", "1", "2"]);
});

test("a result with no rows, or only nulls, says so in place of empty axes (#3149)", () => {
  const g = (vals) => ({ columns: [{ name: "s", numeric: false, type: 11 }, { name: "v", numeric: true, type: 9 }, { name: "w", numeric: true, type: 9 }, { name: "x", numeric: true, type: 9 }, { name: "y", numeric: true, type: 9 }], cells: [vals.map(() => "a")].concat([0, 1, 2, 3].map(() => vals.map(String))), values: [null, vals, vals, vals, vals] });
  for (const kind of ["line", "area", "step", "bar", "scatter", "histogram", "candlestick"]) {
    assert.strictEqual(C.chartData(g([]), [], kind, [1], 20).note, "No row to chart.", kind);
    const nulls = C.chartData(g([null, null]), [0, 1], kind, [1], 20);
    assert.strictEqual(nulls.note, kind === "candlestick" ? "No row has all four of open, high, low and close." : "Every value is null.", kind);
    assert.deepStrictEqual(nulls.datasets, []);
    assert.strictEqual(C.chartData(g([null, 2]), [0, 1], kind, [1], 20).note, undefined, kind);
  }
  assert.match(C.chartSvg(g([]), [], "line", C.chartData(g([]), [], "line", [1], 20), { colours: ["#f00"] }, {}), />No row to chart\.</);
  // A column there is none of is still what is said first.
  assert.match(C.chartData({ columns: [{ name: "s", numeric: false }], cells: [[]], values: [null] }, [], "line", [], 20).note, /^No numeric column/);
});

test("candles keep the columns named open, high, low or close when not all four are: the rest take the places left, or the missing one is said (#3125)", () => {
  const g = (...names) => ({ columns: names.map((name, i) => ({ name, numeric: i > 0, type: i > 0 ? 9 : 19 })), cells: names.map(() => ["1"]), values: names.map((_, i) => (i > 0 ? [1] : null)) });
  const names = (grid) => { const at = C.ohlcColumns(grid); return at && at.map((c) => grid.columns[c].name).join(","); };
  // The trade size is no open, and the last price is the close.
  assert.strictEqual(names(g("time", "size", "open", "high", "low", "lastpx")), "open,high,low,lastpx");
  assert.strictEqual(names(g("time", "open", "high", "low", "last", "volume")), "open,high,low,last");
  assert.strictEqual(names(g("time", "first", "high", "low", "close", "volume")), "first,high,low,close");
  assert.strictEqual(names(g("time", "Open", "close", "hi", "lo")), "Open,hi,lo,close");
  // Nothing where the close would be: said, not drawn from the size.
  const none = g("time", "size", "open", "high", "low");
  assert.strictEqual(C.ohlcColumns(none), null);
  assert.strictEqual(C.chartData(none, [0], "candlestick", [], 20).note, "A candle chart needs open, high, low and close columns: no column here is the close.");
  assert.match(C.chartData(g("time", "high", "x"), [0], "candlestick", [], 20).note, /no column here is the open or close\.$/);
  // As before: all four by name or letter, in any order; no name, the first four.
  assert.strictEqual(names(g("time", "size", "c", "l", "h", "o")), "o,h,l,c");
  assert.strictEqual(names(g("time", "a", "b", "c", "d", "e")), "a,b,c,d");
  assert.match(C.chartData(g("time", "a", "b"), [0], "candlestick", [], 20).note, /four numeric columns after the first\.$/);
});
