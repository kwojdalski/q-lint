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
