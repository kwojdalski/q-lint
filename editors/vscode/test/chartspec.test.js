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
