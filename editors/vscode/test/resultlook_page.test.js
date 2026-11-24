// The result page (media/result.js) dressing a grid and drawing the new
// charts, under node in a stand-in DOM: column formats (#1012), rules
// (#1013), sparklines and data bars (#1014), the layout (#1015), the depth
// and map charts (#1016, #1017), linked panes (#1018), a chart preset
// (#1019), the correlation view (#1020) and Send to... (#1021). Each also
// turned off: drawn as before, offering nothing.
const test = require("node:test");
const assert = require("node:assert");
const { FakeChart, loadPage } = require("./pagedom.js");

const NUMERIC = [5, 6, 7, 8, 9];
/// A result of named columns, each [name, type, cells].
function result(id, columns, extra = {}) {
  return {
    type: "result",
    id,
    view: "grid",
    process: "p",
    code: "t",
    millis: 1,
    limit: 10000,
    grid: {
      columns: columns.map(([name, type]) => ({ name, type, typeName: "t", key: false, numeric: NUMERIC.includes(type), temporal: false })),
      cells: columns.map(([, , cells]) => cells),
      rank: columns.map(([, , cells]) => cells.map((_, i) => i)),
      values: columns.map(([, type, cells]) => (NUMERIC.includes(type) ? cells.map((c) => (c === "" ? null : Number(c))) : null)),
      total: columns[0][2].length,
    },
    ...extra,
  };
}

const COLUMNS = [["ret_PCT", 9, ["0.0123", "0.5"]], ["px", 9, ["1", "2"]], ["px_FG", 11, ["red", "bad;colour"]], ["sym_CODE", 11, ["a", "b"]]];

test("a column's suffix formats its cells and its header shows the name without it; off, as q writes them (#1012)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", COLUMNS));
  assert.deepStrictEqual(page.headers().map((h) => h.textContent), ["ret", "px", "px_FG", "sym"]);
  assert.match(page.headers()[0].title, /^ret_PCT: t\. Shown as a fraction as a percent/);
  const [first, second] = page.rows();
  assert.strictEqual(first.children[0].textContent, "1.23%");
  assert.strictEqual(first.children[0].title, "0.0123", "the cell's tooltip is q's text");
  // px_FG colours px, and itself; a value that is no colour colours nothing.
  assert.strictEqual(first.children[1].style.color, "red");
  assert.strictEqual(first.children[2].style.color, "red");
  assert.strictEqual(second.children[1].style.color, undefined);
  assert.match(first.children[3].className, /\bcode\b/);
  assert.deepStrictEqual(page.rendered().dressed, { headers: ["ret", "px", "px_FG", "sym"], formatted: 2, ruled: 0, bars: 0, sparks: 0, frozen: 0 });
  page.send(result("s.2", COLUMNS, { features: { columnFormats: false } }));
  assert.deepStrictEqual(page.headers().map((h) => h.textContent), ["ret_PCT", "px", "px_FG", "sym_CODE"]);
  assert.strictEqual(page.rows()[0].children[0].textContent, "0.0123");
  assert.strictEqual(page.rows()[0].children[1].style.color, undefined);
  assert.strictEqual(page.rendered().dressed.formatted, 0);
});

test("a conditional format colours the cells its rule matches, and says so in the header; off, nothing is (#1013)", () => {
  const page = loadPage(undefined);
  const look = { rules: [{ column: "px", op: ">", value: 1, style: { background: "red", bold: true } }] };
  page.send(result("s.1", [["px", 9, ["1", "2"]]], { look }));
  const [a, b] = page.rows();
  assert.strictEqual(a.children[0].style.backgroundColor, undefined);
  assert.strictEqual(b.children[0].style.backgroundColor, "color-mix(in srgb, #f14c4c 45%, transparent)");
  assert.strictEqual(b.children[0].style.fontWeight, "bold");
  assert.match(page.headers()[0].title, /px > 1: red background, bold/);
  assert.strictEqual(page.rendered().dressed.ruled, 1);
  page.send(result("s.2", [["px", 9, ["1", "2"]]], { look, features: { conditionalFormats: false } }));
  assert.strictEqual(page.rows()[1].children[0].style.backgroundColor, undefined);
  assert.strictEqual(page.rendered().dressed.ruled, 0);
});

test("a column of numeric lists draws sparklines, a numeric column a data bar when asked; the header's menu knows which (#1014)", () => {
  const page = loadPage(undefined);
  const columns = [["v", 0, ["1 2 3", "3 0n 1"]], ["px", 9, ["5", "10"]], ["s", 11, ["a", "b"]]];
  page.send(result("s.1", columns, { look: { cellCharts: { px: "bar" } } }));
  const [a, b] = page.rows();
  assert.match(a.children[0].style.backgroundImage, /^url\("data:image\/svg\+xml,/);
  assert.strictEqual(a.children[0].textContent, "");
  assert.strictEqual(a.children[0].title, "1 2 3");
  assert.match(b.children[1].style.backgroundImage, /^linear-gradient\(to right, transparent 0\.0%, .* 100\.0%, transparent 100\.0%\)$/);
  assert.deepStrictEqual(page.headers().map((h) => JSON.parse(h.attributes["data-vscode-context"]).columnKind), ["list", "numeric", "other"]);
  assert.deepStrictEqual([page.rendered().dressed.sparks, page.rendered().dressed.bars], [2, 2]);
  // A sparkline turned off for its column is text again.
  page.send(result("s.2", columns, { look: { cellCharts: { v: "text" } } }));
  assert.strictEqual(page.rows()[0].children[0].textContent, "1 2 3");
  assert.strictEqual(page.rows()[0].children[1].style.backgroundImage, undefined);
  page.send(result("s.3", columns, { look: { cellCharts: { px: "bar" } }, features: { cellCharts: false } }));
  assert.strictEqual(page.rows()[0].children[0].style.backgroundImage, undefined);
  assert.strictEqual(page.rows()[1].children[1].style.backgroundImage, undefined);
});

test("the layout orders, hides, sizes and freezes columns; moving or resizing one is sent back to be kept (#1015)", () => {
  const page = loadPage(undefined);
  const columns = [["a", 7, ["1", "2"]], ["b", 7, ["3", "4"]], ["c", 7, ["5", "6"]]];
  const layout = { order: ["b", "a"], hidden: ["c"], widths: { a: 120 }, frozen: 1 };
  page.send(result("s.1", columns, { look: { layout } }));
  assert.deepStrictEqual(page.headers().map((h) => h.textContent), ["b", "a"]);
  assert.match(page.headers()[0].className, /\bfrozen\b/);
  assert.strictEqual(page.headers()[0].style.left, "0px");
  assert.strictEqual(page.rows()[0].children[0].textContent, "3");
  assert.match(page.rows()[0].children[0].className, /\bfrozen\b/);
  const cols = page.body.all((e) => e.tagName === "COL");
  assert.deepStrictEqual(cols.map((c) => c.style.width), ["5ch", "120px"]);
  assert.strictEqual(page.rendered().dressed.frozen, 1);
  // Drag a onto b's place.
  page.headers()[1].fire("dragstart", {});
  page.headers()[0].fire("drop", {});
  let sent = page.posted.filter((m) => m.type === "look").at(-1);
  assert.deepStrictEqual(sent.layout.order, ["a", "b", "c"]);
  assert.deepStrictEqual(page.headers().map((h) => h.textContent), ["a", "b"]);
  // Drag b's right edge 50px wider; the click that ends it sorts nothing.
  const handle = page.headers()[1].children.find((c) => c.className === "resize");
  handle.fire("mousedown", { clientX: 100 });
  page.fireWindow("mousemove", { clientX: 150 });
  page.fireWindow("mouseup", {});
  sent = page.posted.filter((m) => m.type === "look").at(-1);
  assert.deepStrictEqual(sent.layout.widths, { a: 120, b: 130 });
  page.headers()[1].fire("click");
  assert.strictEqual(page.state.sort, null);
  // The hidden columns come back from the bar's button.
  page.button("1 hidden").fire("click");
  assert.deepStrictEqual(page.headers().map((h) => h.textContent), ["a", "b", "c"]);
  assert.deepStrictEqual(page.posted.filter((m) => m.type === "look").at(-1).layout.hidden, []);
  // Off: every column, in order, none movable, nothing sent.
  const before = page.posted.length;
  page.send(result("s.2", columns, { look: { layout }, features: { columnLayout: false } }));
  assert.deepStrictEqual(page.headers().map((h) => h.textContent), ["a", "b", "c"]);
  assert.ok(page.headers().every((h) => !h.draggable && !h.children.some((c) => c.className === "resize")));
  assert.strictEqual(page.button("1 hidden"), undefined);
  assert.strictEqual(page.posted.slice(before).filter((m) => m.type === "look").length, 0);
});

const BOOK = [["level", 7, ["1", "2"]], ["bidPx", 9, ["99", "98"]], ["bidSize", 7, ["5", "10"]], ["askPx", 9, ["101", "102"]], ["askSize", 7, ["4", "6"]]];

test("an order book is drawn as its depth by itself; a map is offered for positions; neither while off (#1016, #1017)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", BOOK, { view: "chart" }));
  const kinds = () => page.body.all((e) => e.tagName === "SELECT")[0].children.map((o) => o.value);
  assert.ok(kinds().includes("depth"));
  assert.strictEqual(page.state.kind, "depth");
  assert.deepStrictEqual([page.rendered().chart.kind, page.rendered().chart.mid, page.rendered().chart.spread], ["depth", 100, 2]);
  page.send(result("s.2", BOOK.map(([n, t, c]) => [`${n}x`, t, c]), { view: "chart" }));
  page.send(result("s.3", BOOK, { view: "chart", features: { depthChart: false } }));
  assert.ok(!kinds().includes("depth"));
  assert.notStrictEqual(page.state.kind, "depth");
  const places = [["city", 11, ["Ldn", "NY"]], ["lat", 9, ["51.5", "40.7"]], ["lon", 9, ["-0.1", "-74"]], ["pop", 7, ["9", "8"]]];
  page.send(result("s.4", places, { view: "chart" }));
  assert.ok(kinds().includes("map"));
  page.body.all((e) => e.tagName === "SELECT")[0].value = "map";
  page.body.all((e) => e.tagName === "SELECT")[0].fire("change");
  // Size and colour are chosen of the other columns.
  const selects = page.body.all((e) => e.tagName === "SELECT");
  assert.deepStrictEqual(selects.slice(1).map((s) => s.children.map((o) => o.textContent)), [["(none)", "pop"], ["(none)", "city", "pop"]]);
  assert.deepStrictEqual([page.rendered().chart.kind, page.rendered().chart.dropped], ["map", 0]);
  page.send(result("s.5", places, { view: "chart", features: { mapChart: false } }));
  assert.ok(!kinds().includes("map"));
});

test("linked panes read every series at the crosshair, zoom together on a drag and show all on a double-click (#1018)", () => {
  FakeChart.made = [];
  const page = loadPage(undefined, { Chart: FakeChart });
  const columns = [["t", 7, ["1", "2", "3", "4"]], ["a", 9, ["10", "20", "30", "40"]], ["b", 9, ["5", "6", "7", "8"]]];
  page.send(result("s.1", columns, { view: "chart", look: { chart: { kind: "linked", series: ["a", "b"], colours: {} } } }));
  assert.strictEqual(page.state.kind, "linked");
  const panes = FakeChart.made.filter((c) => !c.destroyed);
  assert.strictEqual(panes.length, 2);
  assert.deepStrictEqual(panes.map((p) => p.config.options.scales.y.title.text), ["a", "b"]);
  // The x labels on the last pane only.
  assert.deepStrictEqual(panes.map((p) => p.config.options.scales.x.ticks.display), [false, true]);
  const canvases = page.body.all((e) => e.tagName === "CANVAS");
  canvases[0].fire("mousemove", { offsetX: 2.2 });
  assert.deepStrictEqual(page.body.all((e) => e.className === "readout")[0].textContent, "2   a 20  ·  b 6");
  assert.ok(panes.every((p) => p.draws > 0), "every pane draws the crosshair");
  canvases[1].fire("mousedown", { offsetX: 1.5 });
  canvases[1].fire("mousemove", { offsetX: 3 });
  canvases[1].fire("mouseup", { offsetX: 3 });
  assert.deepStrictEqual(panes.map((p) => [p.options.scales.x.min, p.options.scales.x.max]), [[1.5, 3], [1.5, 3]]);
  assert.deepStrictEqual(page.rendered().linked.range, { min: 1.5, max: 3 });
  assert.deepStrictEqual(page.state.zoom, { min: 1.5, max: 3 });
  canvases[0].fire("dblclick");
  assert.deepStrictEqual(panes.map((p) => [p.options.scales.x.min, p.options.scales.x.max]), [[undefined, undefined], [undefined, undefined]]);
  assert.strictEqual(page.rendered().linked.range, null);
  // Kept in the q Plots view as one SVG of both panes.
  const plotted = page.posted.filter((m) => m.type === "plotted").at(-1);
  assert.strictEqual(plotted.format, "linked");
  assert.strictEqual((plotted.data.match(/<svg /g) || []).length, 3);
  page.send(result("s.2", columns, { view: "chart", features: { linkedCharts: false } }));
  assert.ok(!page.body.all((e) => e.tagName === "SELECT")[0].children.some((o) => o.value === "linked"));
});

test("a chart preset kept with a saved query draws the same chart again; Save with Query sends the chart drawn (#1019)", () => {
  const page = loadPage(undefined);
  const columns = [["t", 7, ["1", "2"]], ["a", 9, ["1", "2"]], ["b", 9, ["3", "4"]]];
  const chart = { kind: "bar", series: ["b"], colours: { b: "#ff0000" }, bins: 7 };
  page.send(result("s.1", columns, { look: { chart }, saved: "q1" }));
  assert.strictEqual(page.state.view, "chart");
  assert.strictEqual(page.state.kind, "bar");
  assert.deepStrictEqual(page.state.columns, [2]);
  assert.deepStrictEqual(page.rendered().preset, { kind: "bar", series: ["b"], bins: 7, colours: { b: "#ff0000" } });
  const swatch = page.body.all((e) => e.className === "swatch")[0];
  assert.strictEqual(swatch.value, "#ff0000");
  swatch.value = "#00ff00";
  swatch.fire("change");
  page.button("Save with Query").fire("click");
  assert.deepStrictEqual(page.posted.at(-1), { type: "chartPreset", id: "s.1", preset: { kind: "bar", series: ["b"], bins: 7, colours: { b: "#00ff00" } } });
  assert.match(page.button("Save with Query").title, /saved query q1/);
  // Off: the kept chart is not drawn, and nothing offers to keep one.
  page.send(result("s.2", columns, { look: { chart }, features: { chartPresets: false } }));
  assert.strictEqual(page.state.view, "grid");
  page.state.view = "chart";
  page.send(result("s.3", columns, { view: "chart", features: { chartPresets: false } }));
  assert.strictEqual(page.button("Save with Query"), undefined);
  assert.strictEqual(page.body.all((e) => e.className === "swatch").length, 0);
});

test("the correlation view shows the matrix and the pairs of the rows shown; it is offered only with two numeric columns, while on (#1020)", () => {
  const page = loadPage(undefined);
  const columns = [["x", 9, ["1", "2", "3", "4"]], ["y", 9, ["2", "4", "6", "9"]], ["s", 11, ["a", "b", "c", "d"]]];
  page.send(result("s.1", columns, { control: { key: "k1", action: "view", view: "corr" } }));
  assert.strictEqual(page.state.view, "corr");
  const corr = page.rendered().corr;
  assert.deepStrictEqual(corr.names, ["x", "y"]);
  assert.ok(Math.abs(corr.r[0][1] - 0.9943767126843689) < 1e-12);
  const cells = page.body.all((e) => e.tagName === "TD" && e.parent?.parent?.parent?.className === "corr");
  assert.deepStrictEqual(cells.map((c) => c.textContent), ["x", "1.000", "0.994", "y", "0.994", "1.000"]);
  assert.match(cells[2].title, /over 4 rows/);
  page.button("Copy Matrix").fire("click");
  assert.match(page.posted.at(-1).text, /^,x,y\nx,1,0\.99437/);
  const views = () => page.body.all((e) => e.parent?.className === "views").map((b) => b.textContent);
  assert.ok(views().includes("Correlation"));
  page.send(result("s.2", [["x", 9, ["1"]], ["s", 11, ["a"]]]));
  assert.ok(!views().includes("Correlation"));
  page.send(result("s.3", columns, { features: { correlation: false }, control: { key: "k2", action: "view", view: "corr" } }));
  assert.ok(!views().includes("Correlation"));
  assert.strictEqual(page.rendered().view, "grid");
});

test("Send to... sends the rows shown to the extension, while on (#1021)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", [["x", 9, ["1", "2", "3"]]]));
  page.state.filters = [];
  page.button("Send to...").fire("click");
  assert.deepStrictEqual(page.posted.at(-1), { type: "send", id: "s.1", rows: [0, 1, 2] });
  page.send(result("s.2", [["x", 9, ["1"]]], { features: { sendResult: false } }));
  assert.strictEqual(page.button("Send to..."), undefined);
});

test("a hidden column's filter and sort are not in force, and are again once it is shown (#1633)", () => {
  const page = loadPage(undefined);
  const cols = [["sym", 11, ["b", "a", "c"]], ["px", 9, ["1", "2", "3"]]];
  page.send(result("s.1", cols));
  page.headers()[0].fire("click");
  const input = page.body.all((e) => e.tagName === "INPUT")[0];
  input.value = "a";
  input.fire("input");
  assert.strictEqual(page.rendered().rows, 1);
  page.send(result("s.1", cols, { look: { layout: { order: [], hidden: ["sym"], widths: {}, frozen: 0 } } }));
  assert.deepStrictEqual(page.headers().map((h) => h.textContent), ["px"]);
  assert.strictEqual(page.rendered().rows, 3, "no box is left to see the filter by");
  assert.deepStrictEqual(page.rows().map((tr) => tr.children[0].textContent), ["1", "2", "3"], "nor the sort");
  page.button("1 hidden").fire("click");
  assert.strictEqual(page.rendered().rows, 1);
});

test("a new run whose columns are all in the kept hidden list draws them, and offers no hidden ones to show (#1652)", () => {
  const page = loadPage(undefined);
  const lay = { order: [], hidden: ["a"], widths: {}, frozen: 0 };
  page.send(result("s.1", [["a", 7, ["1"]], ["b", 7, ["2"]]], { look: { layout: lay } }));
  assert.deepStrictEqual(page.headers().map((h) => h.textContent), ["b"]);
  page.send(result("s.2", [["a", 7, ["1", "2"]]], { look: { layout: lay } }));
  assert.deepStrictEqual(page.headers().map((h) => h.textContent), ["a"]);
  assert.strictEqual(page.rows()[0].children.length, 1);
  assert.strictEqual(page.button("1 hidden"), undefined);
});

test("going back to a result's tab restores its own filter, not one typed on another run of the same columns (#1637)", () => {
  const page = loadPage(undefined);
  const hist = (ids) => ids.map((id) => ({ id, process: "p", code: "q", at: 0, rows: 3 }));
  const cols = [["sym", 11, ["apple", "banana", "cherry"]], ["px", 9, ["1", "2", "3"]]];
  const filter = (text) => {
    const box = page.body.all((e) => e.tagName === "INPUT")[0];
    box.value = text;
    box.fire("input");
  };
  page.send(result("s.1", cols, { history: hist(["s.1"]) }));
  filter("apple");
  page.send(result("s.2", cols, { history: hist(["s.1", "s.2"]) }));
  filter("an");
  page.send(result("s.1", cols, { history: hist(["s.1", "s.2"]) }));
  assert.strictEqual(page.body.all((e) => e.tagName === "INPUT")[0].value, "apple");
  assert.strictEqual(page.rendered().rows, 1);
  page.send(result("s.2", cols, { history: hist(["s.1", "s.2"]) }));
  assert.strictEqual(page.body.all((e) => e.tagName === "INPUT")[0].value, "an");
});
