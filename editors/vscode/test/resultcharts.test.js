// The result panel's depth, map and linked charts (media/chartmore.js), run
// under node: the columns each finds, the data it draws, its Chart.js
// configuration and its SVG (#1016, #1017, #1018).
const test = require("node:test");
const assert = require("node:assert");
const M = require("../media/chartmore.js");
const WORLD = require("../media/worldoutline.js");

const NUMERIC = [5, 6, 7, 8, 9];
/// A grid of named columns, each [name, type, cells].
function grid(columns) {
  return {
    columns: columns.map(([name, type]) => ({ name, type, typeName: "t", key: false, numeric: NUMERIC.includes(type), temporal: type >= 12 && type <= 19 })),
    cells: columns.map(([, , cells]) => cells),
    rank: columns.map(() => null),
    values: columns.map(([, type, cells]) => (NUMERIC.includes(type) || (type >= 12 && type <= 19) ? cells.map((c) => (c === "" ? null : Number(c))) : null)),
    total: columns[0][2].length,
  };
}
const look = { colours: ["#3794ff", "#d18616", "#89d185", "#f14c4c", "#b180d7", "#cca700"], foreground: "#ccc", border: "#444", font: "Menlo", up: "#89d185", down: "#f14c4c" };
const all = (g) => [...Array(g.cells[0].length).keys()];

test("an order book by level is found by its column names and drawn as cumulative depth either side of the mid (#1016)", () => {
  const g = grid([["level", 7, ["1", "2", "3"]], ["bidPx", 9, ["99", "98", "97"]], ["bid_size", 7, ["5", "10", "0"]], ["askPx", 9, ["101", "102", ""]], ["askSize", 7, ["4", "6", "8"]]]);
  assert.deepStrictEqual(M.depthColumns(g), { mode: "levels", bp: 1, bs: 2, ap: 3, as: 4 });
  const d = M.depthData(g, all(g));
  assert.strictEqual(d.mid, 100);
  assert.strictEqual(d.spread, 2);
  // A size of zero and a missing price are no level. Each side runs on a
  // twentieth of the prices' range (4) past its last level.
  assert.deepStrictEqual(d.datasets[0].data, [{ x: 97.8, y: 15 }, { x: 98, y: 15 }, { x: 99, y: 5 }]);
  assert.deepStrictEqual(d.datasets[1].data, [{ x: 101, y: 4 }, { x: 102, y: 10 }, { x: 102.2, y: 10 }]);
  assert.deepStrictEqual(d.datasets.map((s) => s.levels), [2, 2]);
  assert.strictEqual(M.depthTitle(d), "mid 100 · spread 2");
  const config = M.depthConfig(d, look);
  assert.strictEqual(config.options.scales.x.type, "linear");
  assert.deepStrictEqual(config.data.datasets.map((s) => [s.stepped, s.borderColor]), [["before", "#89d185"], ["after", "#f14c4c"]]);
});

test("an order book as lists reads the first row shown, and one by side sums sizes at a price (#1016)", () => {
  const lists = grid([["sym", 11, ["a", "b"]], ["bids", 0, ["1.1 1.0", "9 8"]], ["bidSizes", 0, ["2 3", "1 1"]], ["asks", 0, ["1.2 1.3f", "10 11"]], ["askSizes", 0, ["1 1", "1 1"]]]);
  assert.strictEqual(M.depthColumns(lists).mode, "lists");
  const d = M.depthData(lists, [1, 0]);
  assert.strictEqual(d.row, 1);
  assert.strictEqual(d.mid, 9.5);
  const first = M.depthData(lists, [0]);
  assert.deepStrictEqual(first.datasets[0].data.slice(1), [{ x: 1, y: 5 }, { x: 1.1, y: 2 }]);
  const sides = grid([["side", 11, ["buy", "sell", "buy", "x", "S"]], ["price", 9, ["10", "11", "10", "5", "12"]], ["qty", 7, ["1", "2", "3", "4", "5"]]]);
  assert.strictEqual(M.depthColumns(sides).mode, "sides");
  const s = M.depthData(sides, all(sides));
  assert.deepStrictEqual(s.datasets[0].data.slice(1), [{ x: 10, y: 4 }]);
  assert.deepStrictEqual(s.datasets[1].data.slice(0, -1), [{ x: 11, y: 2 }, { x: 12, y: 7 }]);
  assert.strictEqual(M.depthColumns(grid([["px", 9, ["1"]], ["qty", 7, ["1"]]])), null);
  assert.match(M.depthData(grid([["px", 9, ["1"]]]), [0]).note, /needs an order book/);
  assert.match(M.depthData(grid([["bid", 9, ["1"]], ["bs", 7, ["0"]], ["ask", 9, ["2"]], ["as", 7, [""]]]), [0]).note, /empty/);
});

test("a map finds latitude and longitude, drops rows off the map, sizes by the square root and colours by value or category (#1017)", () => {
  const g = grid([["city", 11, ["Ldn", "NY", "Nowhere", "Tok"]], ["lat", 9, ["51.5", "40.7", "95", "35.7"]], ["lon", 9, ["-0.1", "-74", "0", "139.7"]], ["pop", 7, ["9", "8", "1", "14"]]]);
  assert.deepStrictEqual(M.mapColumns(g), { lat: 1, lon: 2 });
  const plain = M.mapData(g, all(g), { size: -1, colour: -1 }, look);
  assert.strictEqual(plain.dropped, 1);
  assert.deepStrictEqual(plain.datasets[0].data.map((p) => [p.x, p.y, p.r, p.row]), [[-0.1, 51.5, 4, 0], [-74, 40.7, 4, 1], [139.7, 35.7, 4, 3]]);
  const sized = M.mapData(g, all(g), { size: 3, colour: 3 }, look);
  assert.deepStrictEqual(sized.datasets[0].data.map((p) => +p.r.toFixed(3)), [+(3 + 12 * Math.sqrt(1 / 6)).toFixed(3), 3, 15]);
  assert.deepStrictEqual(sized.datasets[0].colours, ["#5688e1", "#3794ff", "#f14c4c"]);
  assert.deepStrictEqual(sized.legend.map((l) => l.label), ["pop 8", "pop 14"]);
  const byCity = M.mapData(g, all(g), { size: -1, colour: 0 }, look);
  assert.deepStrictEqual(byCity.datasets[0].colours, ["#3794ff", "#d18616", "#89d185"]);
  assert.deepStrictEqual(byCity.legend.map((l) => l.label), ["Ldn", "NY", "Tok"]);
  assert.strictEqual(M.mapColumns(grid([["latency", 9, ["1"]], ["lon", 9, ["1"]]])), null);
  const config = M.mapConfig(g, sized, look, WORLD);
  assert.deepStrictEqual([config.options.scales.x.min, config.options.scales.x.max, config.options.scales.y.min, config.options.scales.y.max], [-180, 180, -90, 90]);
  assert.strictEqual(config.plugins[0].id, "qlintWorld");
  assert.strictEqual(config.options.plugins.tooltip.callbacks.label({ raw: { row: 3 } }), "35.7, 139.7  pop 14");
  // The outline is bundled, and draws through the scales it is given.
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (k === "save" || k === "restore" || typeof k === "symbol" ? () => {} : (...a) => calls.push([k, ...a])), set: () => true });
  config.plugins[0].beforeDatasetsDraw({ ctx, scales: { x: { getPixelForValue: (v) => v + 180 }, y: { getPixelForValue: (v) => 90 - v } } });
  assert.ok(WORLD.RINGS.length > 100 && calls.filter((c) => c[0] === "moveTo").length === WORLD.RINGS.length);
});

test("linked panes share the x axis: the nearest point, the crosshair's reading and a drag's zoom (#1018)", () => {
  const g = grid([["time", 19, ["3000", "1000", "2000", ""]], ["px", 9, ["1.5", "1.25", "", "9"]], ["qty", 7, ["30", "10", "20", "40"]]]);
  g.cells[0] = ["00:00:03.000", "00:00:01.000", "00:00:02.000", ""];
  const d = M.linkedData(g, all(g), [1, 2]);
  assert.strictEqual(d.x, 0);
  assert.deepStrictEqual(d.panes[0].data.map((p) => [p.x, p.y, p.row]), [[1000, 1.25, 1], [2000, null, 2], [3000, 1.5, 0]]);
  assert.strictEqual(M.nearestIndex(d.panes[1].data, 2600), 2);
  assert.strictEqual(M.nearestIndex(d.panes[1].data, 1400), 0);
  assert.strictEqual(M.nearestIndex([], 1), -1);
  assert.deepStrictEqual(M.readout(g, d, 1900), { x: "00:00:02.000", values: [{ label: "px", text: "" }, { label: "qty", text: "20" }] });
  assert.deepStrictEqual(M.zoomRange(2500, 1200, 2000), { min: 1200, max: 2500 });
  assert.strictEqual(M.zoomRange(1000, 1005, 2000), null, "a click is no zoom");
  assert.deepStrictEqual(M.inRange(d.panes[1].data, { min: 1500, max: 3000 }).map((p) => p.x), [2000, 3000]);
  assert.strictEqual(M.xText(g, d, 61000, 1000), "00:01:01");
  const byRow = M.linkedData(grid([["sym", 11, ["a", "b"]], ["px", 9, ["1", "2"]]]), [1, 0], [1]);
  assert.deepStrictEqual(byRow.panes[0].data.map((p) => [p.x, p.row]), [[0, 1], [1, 0]]);
  assert.match(M.linkedData(g, all(g), []).note, /No numeric column/);
  const view = { range: { min: 1000, max: 2000 }, cursor: 1500, drag: null };
  const config = M.linkedConfig(g, d, d.panes[0], "#ff0000", look, view, true);
  assert.deepStrictEqual([config.options.scales.x.min, config.options.scales.x.max], [1000, 2000]);
  assert.deepStrictEqual(config.options.events, [], "the page handles the mouse itself");
  const lines = [];
  const ctx = new Proxy({}, { get: (_, k) => (typeof k === "symbol" ? undefined : (...a) => lines.push([k, ...a])), set: () => true });
  config.plugins[0].afterDatasetsDraw({ ctx, chartArea: { left: 0, right: 100, top: 0, bottom: 50 }, scales: { x: { getPixelForValue: (v) => (v - 1000) / 10 } } });
  assert.deepStrictEqual(lines.filter((l) => l[0] === "moveTo"), [["moveTo", 50, 0]], "the crosshair is drawn where the cursor is");
});

test("each chart's SVG is a document of its own, its text escaped (#1016-#1018)", () => {
  const book = grid([["bid", 9, ["99"]], ["bs", 7, ["5"]], ["ask", 9, ["101"]], ["as", 7, ["4"]]]);
  const depth = M.depthSvg(M.depthData(book, [0]), look, { width: 600, height: 300, background: "#000" });
  assert.match(depth, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="600" height="300"/);
  assert.match(depth, /mid 100 · spread 2/);
  assert.match(depth, /fill="#89d185" fill-opacity="0.3"/);
  const g = grid([["lat", 9, ["51.5"]], ["lon", 9, ["-0.1"]], ["name<&>", 11, ["<b>"]]]);
  const map = M.mapSvg(M.mapData(g, [0], { size: -1, colour: 2 }, look), look, { width: 800, height: 400 }, WORLD);
  assert.match(map, /<path d="M/);
  assert.match(map, /<circle cx="421.8"/);
  assert.ok(map.includes("&lt;b&gt;") && !map.includes("<b>"), "a category's text is escaped");
  const t = grid([["t", 7, ["1", "2", "3"]], ["a", 9, ["1", "2", "3"]], ["b", 9, ["3", "2", "1"]]]);
  const linked = M.linkedSvg(t, M.linkedData(t, [0, 1, 2], [1, 2]), look, ["#ff0000", "#00ff00"], { width: 640, height: 400, range: { min: 1, max: 2 } });
  assert.strictEqual((linked.match(/<svg /g) || []).length, 3, "one SVG of a pane each, in one");
  assert.match(linked, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" x="0" y="200"/);
  assert.match(linked, /stroke="#00ff00"/);
});
