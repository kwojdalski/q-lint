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

test("a sparkline is drawn from the vector GRID sent, not from the cell's text cut at the console width; one drawn from cut text says so (#3122)", () => {
  const page = loadPage(undefined);
  const whole = Array.from({ length: 100 }, (_, i) => (i < 99 ? i + 0.5 : -500));
  const text = whole.slice(0, 11).join(" ") + " ..";
  const m = result("s.1", [["v", 0, [text, "1 2 3"]], ["w", 0, ["1 2 3 4 5 ..", "4 5 6"]]]);
  m.grid.vectors = [[whole, [1, 2, 3]], null];
  page.send(m);
  const points = (td) => decodeURIComponent(td.style.backgroundImage).match(/ d="([^"]*)"/)[1].match(/[ML]/g);
  const [a, b] = page.rows();
  assert.strictEqual(points(a.children[0]).length, 100, "every value of the vector, the last (the low) among them");
  assert.doesNotMatch(a.children[0].className, /\bcut\b/);
  assert.strictEqual(a.children[0].title, text);
  // No vector for the column: the text's numbers, marked as a part where q cut it.
  assert.strictEqual(points(a.children[1]).length, 4);
  assert.match(a.children[1].className, /\bspark cut\b/);
  assert.match(a.children[1].title, /first 4 values only/);
  assert.doesNotMatch(b.children[1].className, /\bcut\b/);
  assert.strictEqual(b.children[1].title, "4 5 6");
});

test("a column named __proto__ resized sends its width back as the widths' own entry (#1884)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", [["__proto__", 7, ["1", "2"]], ["b", 7, ["3", "4"]]]));
  const handle = page.headers()[0].children.find((c) => c.className === "resize");
  handle.fire("mousedown", { clientX: 100 });
  page.fireWindow("mousemove", { clientX: 150 });
  page.fireWindow("mouseup", {});
  const sent = page.posted.filter((m) => m.type === "look").at(-1);
  assert.deepStrictEqual(Object.keys(sent.layout.widths), ["__proto__"]);
  assert.strictEqual(typeof sent.layout.widths["__proto__"], "number");
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

test("the kind chosen comes back after a book drawn as its depth, or a map (#3137)", () => {
  const page = loadPage(undefined);
  const kind = () => page.body.all((e) => e.tagName === "SELECT")[0];
  const choose = (k) => {
    kind().value = k;
    kind().fire("change");
  };
  const plain = (name) => [["t", 7, ["1", "2", "3"]], [name, 9, ["1", "2", "3"]]];
  page.send(result("s.1", plain("v"), { view: "chart" }));
  choose("bar");
  page.send(result("s.2", BOOK, { view: "chart" }));
  assert.strictEqual(page.rendered().chart.kind, "depth");
  page.send(result("s.3", plain("w"), { view: "chart" }));
  assert.strictEqual(page.rendered().chart.kind, "bar", "not Line: Bar was chosen");
  assert.strictEqual(kind().children.find((o) => o.selected).value, "bar");
  // A map, chosen for one result's positions, is not the next result's kind.
  page.send(result("s.4", [["city", 11, ["Ldn", "NY"]], ["lat", 9, ["51.5", "40.7"]], ["lon", 9, ["-0.1", "-74"]]], { view: "chart" }));
  choose("map");
  assert.strictEqual(page.rendered().chart.kind, "map");
  page.send(result("s.5", plain("x"), { view: "chart" }));
  assert.strictEqual(page.rendered().chart.kind, "bar");
  // A page that never chose: Line, as before.
  const fresh = loadPage(undefined);
  fresh.send(result("s.1", BOOK, { view: "chart" }));
  fresh.send(result("s.2", plain("v"), { view: "chart" }));
  assert.strictEqual(fresh.rendered().chart.kind, "line");
});

test("a quote or trade history, a crossed book and rows of no side are not drawn as depth by themselves; Depth is still offered (#3124, #3144)", () => {
  const kinds = (page) => page.body.all((e) => e.tagName === "SELECT")[0].children.map((o) => o.value);
  /// The result of `columns`, its first a time.
  const timed = (id, columns) => {
    const r = result(id, columns, { view: "chart" });
    r.grid.columns[0].temporal = true;
    r.grid.values[0] = r.grid.cells[0].map(Number);
    return r;
  };
  const quotes = [["time", 16, ["1", "2", "3"]], ["bid", 9, ["1.1", "1.2", "1.3"]], ["ask", 9, ["1.2", "1.3", "1.4"]], ["bsize", 7, ["1", "2", "3"]], ["asize", 7, ["3", "2", "1"]]];
  const trades = [["time", 16, ["1", "2", "3"]], ["side", 11, ["B", "S", "B"]], ["price", 9, ["1.1", "1.2", "1.3"]], ["size", 7, ["1", "2", "3"]]];
  for (const history of [quotes, trades]) {
    const page = loadPage(undefined);
    page.send(timed("s.1", history));
    assert.strictEqual(page.rendered().chart.kind, "line", history[1][0]);
    assert.ok(kinds(page).includes("depth"));
  }
  // The same rows with no time before them cross: bids up to 1.3, asks from 1.2.
  const crossed = loadPage(undefined);
  crossed.send(result("s.1", quotes.slice(1), { view: "chart" }));
  assert.strictEqual(crossed.rendered().chart.kind, "line");
  // Nor is the depth of a book carried on to a history that comes after it.
  const page = loadPage(undefined);
  page.send(result("s.1", BOOK, { view: "chart" }));
  assert.strictEqual(page.rendered().chart.kind, "depth");
  page.send(timed("s.2", quotes));
  assert.strictEqual(page.rendered().chart.kind, "line");
  // A side that is neither buy nor sell: no book by itself; chosen, the
  // rows left out are counted.
  const sided = (sides) => [["side", 11, sides], ["price", 9, ["99", "98", "101", "102"]], ["size", 7, ["10", "20", "30", "40"]]];
  page.send(result("s.3", sided(["long", "long", "short", "short"]), { view: "chart" }));
  assert.strictEqual(page.rendered().chart.kind, "line");
  page.send(result("s.4", sided(["B", "long", "S", "short"]).map(([n, t, c]) => [n === "size" ? "qty" : n, t, c]), { view: "chart" }));
  assert.deepStrictEqual([page.rendered().chart.kind, page.rendered().chart.unsided], ["depth", 2]);
  assert.ok(page.body.all((e) => e.className === "note").some((e) => e.textContent === "2 rows have a side that is neither buy nor sell: left out of the book."));
});

test("a histogram of the first column only, then Line, draws the line's columns (#3138)", () => {
  FakeChart.made = [];
  const page = loadPage(undefined, { Chart: FakeChart });
  const kind = () => page.body.all((e) => e.tagName === "SELECT")[0];
  const choose = (k) => {
    kind().value = k;
    kind().fire("change");
  };
  const boxes = () => page.body.all((e) => e.tagName === "INPUT" && e.type === "checkbox");
  page.send(result("s.1", [["px", 9, ["1", "2", "3"]], ["size", 7, ["10", "20", "30"]]], { view: "chart" }));
  choose("histogram");
  assert.strictEqual(boxes().length, 2);
  boxes()[1].checked = false;
  boxes()[1].fire("change");
  assert.deepStrictEqual(page.state.columns, [0]);
  choose("line");
  assert.deepStrictEqual([page.rendered().chart.note, page.rendered().chart.datasets.map((d) => d.label)], [undefined, ["size"]]);
  assert.deepStrictEqual(boxes().map((b) => b.checked), [true]);
  // And the histogram is as it was left.
  choose("histogram");
  assert.deepStrictEqual(boxes().map((b) => b.checked), [true, false]);
});

test("a preset kept from a depth chart or a map leaves the series ticked when the kind is changed (#3134)", () => {
  FakeChart.made = [];
  const page = loadPage(undefined, { Chart: FakeChart });
  const kind = () => page.body.all((e) => e.tagName === "SELECT")[0];
  page.send(result("s.1", BOOK, { view: "chart", saved: "q1" }));
  const preset = page.rendered().preset;
  assert.deepStrictEqual([preset.kind, preset.series], ["depth", []]);
  // Run again, the chart kept with the query drawn; then another kind.
  page.send(result("s.2", BOOK, { look: { chart: preset }, saved: "q1" }));
  assert.strictEqual(page.rendered().chart.kind, "depth");
  kind().value = "line";
  kind().fire("change");
  assert.deepStrictEqual([page.rendered().chart.note, page.rendered().chart.datasets.map((d) => d.label)], [undefined, ["bidPx", "bidSize", "askPx", "askSize"]]);
  assert.ok(page.body.all((e) => e.tagName === "INPUT" && e.type === "checkbox").every((b) => b.checked));
});

test("two series of one name are told apart: a colour is one's own, and a preset draws the one it kept (#3135, #3136)", () => {
  FakeChart.made = [];
  const page = loadPage(undefined, { Chart: FakeChart });
  const twice = [["t", 7, ["1", "2"]], ["x", 9, ["1", "2"]], ["x", 9, ["3", "4"]]];
  const swatches = () => page.body.all((e) => e.className === "swatch");
  const boxes = () => page.body.all((e) => e.tagName === "INPUT" && e.type === "checkbox");
  const drawn = () => Array.from(FakeChart.made.filter((c) => !c.destroyed).at(-1).config.data.datasets);
  const lines = () => drawn().map((d) => d.borderColor);
  page.send(result("s.1", twice, { view: "chart", saved: "q1" }));
  const first = swatches()[0].value;
  swatches()[1].value = "#ff0000";
  swatches()[1].fire("change");
  assert.deepStrictEqual(swatches().map((s) => s.value), [first, "#ff0000"]);
  assert.deepStrictEqual(lines(), [first, "#ff0000"]);
  page.button("Save with Query").fire("click");
  assert.deepStrictEqual(page.posted.at(-1).preset, { kind: "line", series: ["x", "x#2"], bins: 20, colours: { "x#2": "#ff0000" } });
  // The second alone, kept and drawn again: the second, in its colour.
  boxes()[0].checked = false;
  boxes()[0].fire("change");
  const preset = page.rendered().preset;
  assert.deepStrictEqual([page.state.columns, preset.series], [[2], ["x#2"]]);
  const again = loadPage(undefined, { Chart: FakeChart });
  again.send(result("s.9", twice, { look: { chart: preset }, saved: "q1" }));
  assert.deepStrictEqual(again.state.columns, [2]);
  assert.deepStrictEqual(drawn().map((d) => [d.borderColor, Array.from(d.data, (p) => (p && typeof p === "object" ? p.y : p))]), [["#ff0000", [3, 4]]]);
  // A keyed table whose key and value share a name: the value is the one
  // the chart draws, so the one the preset names.
  const keyed = result("s.1", [["size", 7, ["100", "200"]], ["size", 7, ["250", "780"]]], { view: "chart", saved: "q2" });
  keyed.grid.columns[0].key = true;
  const own = loadPage(undefined, { Chart: FakeChart });
  own.send(keyed);
  assert.deepStrictEqual(own.rendered().preset.series, ["size"]);
  own.send({ ...keyed, id: "s.2", look: { chart: own.rendered().preset } });
  assert.deepStrictEqual([own.state.columns, own.rendered().chart.note, own.rendered().chart.datasets.map((d) => d.label)], [[1], undefined, ["size"]]);
});

test("Save PNG and Save SVG are for a chart that is drawn: off beside a note alone (#3139)", () => {
  FakeChart.made = [];
  const page = loadPage(undefined, { Chart: FakeChart });
  const saves = () => ["Save PNG", "Save SVG"].map((text) => Boolean(page.button(text).disabled));
  page.send(result("s.1", [["t", 7, ["1", "2"]], ["a", 9, ["1", "2"]]], { view: "chart" }));
  assert.deepStrictEqual(saves(), [false, false]);
  page.send(result("s.2", [["sym", 11, ["a", "b"]], ["name", 11, ["x", "y"]]], { view: "chart" }));
  assert.match(page.rendered().chart.note, /No numeric column/);
  assert.deepStrictEqual(saves(), [true, true]);
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

test("linked panes keep a zoom over a result that is still in it, and drop one the points have moved out of (#3128)", () => {
  FakeChart.made = [];
  const page = loadPage(undefined, { Chart: FakeChart });
  const at = (times) => [["time", 7, times], ["a", 9, ["10", "20", "30", "40"]], ["b", 9, ["5", "6", "7", "8"]]];
  page.send(result("s.1", at(["1000", "2000", "3000", "4000"]), { view: "chart", look: { chart: { kind: "linked", series: ["a", "b"], colours: {} } } }));
  const canvas = page.body.all((e) => e.tagName === "CANVAS")[0];
  canvas.fire("mousedown", { offsetX: 1500 });
  canvas.fire("mousemove", { offsetX: 3000 });
  canvas.fire("mouseup", { offsetX: 3000 });
  assert.deepStrictEqual(page.state.zoom, { min: 1500, max: 3000 });
  const panes = () => FakeChart.made.filter((c) => !c.destroyed).map((p) => [p.config.options.scales.x.min, p.config.options.scales.x.max]);
  // Run again, a point later: the zoom is still over the points.
  page.send(result("s.2", at(["2000", "3000", "4000", "5000"]), { view: "chart" }));
  assert.deepStrictEqual(panes(), [[1500, 3000], [1500, 3000]]);
  // The window has moved on: every pane was empty, its axis still 1500 to 3000.
  for (const id of ["s.3", "s.3"]) {
    page.send(result(id, at(["9000", "10000", "11000", "12000"]), { view: "chart" }));
    assert.strictEqual(page.state.kind, "linked");
    assert.deepStrictEqual(panes(), [[undefined, undefined], [undefined, undefined]]);
    assert.strictEqual(page.rendered().linked.range, null);
    const plotted = page.posted.filter((m) => m.type === "plotted").at(-1).data;
    assert.ok(!plotted.includes("Nothing to chart.") && /<path d="M[^"]* L/.test(plotted));
  }
});

test("a series named __proto__ keeps the colour picked for it and the one its preset holds (#2079)", () => {
  const page = loadPage(undefined);
  const columns = [["t", 7, ["1", "2"]], ["__proto__", 9, ["3", "4"]]];
  const chart = { kind: "bar", series: ["__proto__"], colours: JSON.parse('{"__proto__":"#ff0000"}'), bins: 7 };
  page.send(result("s.1", columns, { look: { chart }, saved: "q1" }));
  assert.strictEqual(page.body.all((e) => e.className === "swatch")[0].value, "#ff0000");
  assert.strictEqual(JSON.stringify(page.rendered().preset.colours), '{"__proto__":"#ff0000"}');
  const swatch = page.body.all((e) => e.className === "swatch")[0];
  swatch.value = "#00ff00";
  swatch.fire("change");
  assert.strictEqual(page.body.all((e) => e.className === "swatch")[0].value, "#00ff00");
  page.button("Save with Query").fire("click");
  assert.strictEqual(JSON.stringify(page.posted.at(-1).preset.colours), '{"__proto__":"#00ff00"}');
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

test("a result chosen from the tabs is drawn with its own chart kind and bins, not the last tab's (#1638)", () => {
  const page = loadPage(undefined, { Chart: FakeChart });
  const hist = (ids) => ids.map((id) => ({ id, process: "p", code: id, at: 0, rows: 3 }));
  const colsA = [["x", 9, ["1", "2", "3"]], ["y", 9, ["4", "5", "6"]]];
  const colsB = [["a", 9, ["1", "2", "3"]], ["b", 9, ["4", "5", "6"]]];
  page.send(result("s.1", colsA, { view: "chart", history: hist(["s.1"]) }));
  const kind = page.body.all((e) => e.tagName === "SELECT")[0];
  kind.value = "histogram";
  kind.fire("change");
  const bins = page.body.all((e) => e.tagName === "INPUT" && e.type === "number")[0];
  bins.value = "7";
  bins.fire("change");
  page.send(result("s.2", colsB, { view: "chart", history: hist(["s.1", "s.2"]) }));
  const other = page.body.all((e) => e.tagName === "SELECT")[0];
  other.value = "bar";
  other.fire("change");
  assert.strictEqual(page.rendered().chart.kind, "bar");
  page.send(result("s.1", colsA, { view: "chart", history: hist(["s.1", "s.2"]) }));
  assert.strictEqual(page.rendered().chart.kind, "histogram");
  assert.strictEqual(page.state.bins, 7);
});

test("a 'contains' rule on a formatted column matches the text the cell shows, as the filter does (#1646)", () => {
  const page = loadPage(undefined);
  const look = { rules: [{ column: "ret_PCT", op: "contains", value: "1.23%", style: { bold: true } }] };
  page.send(result("s.1", [["ret_PCT", 9, ["0.0123", "0.5"]]], { look }));
  assert.strictEqual(page.rows()[0].children[0].textContent, "1.23%");
  assert.strictEqual(page.rows()[0].children[0].style.fontWeight, "bold");
  assert.strictEqual(page.rows()[1].children[0].style.fontWeight, undefined);
});

test("a *_BAR column toggled to text draws no bar (#1651)", () => {
  const page = loadPage(undefined);
  const cols = [["px_BAR", 9, ["1", "5"]]];
  page.send(result("s.1", cols));
  assert.strictEqual(page.rendered().dressed.bars, 2);
  page.send(result("s.1", cols, { look: { cellCharts: { px_BAR: "text" } } }));
  assert.strictEqual(page.rendered().dressed.bars, 0);
});

test("a row colour column fills the cells another colour column paints too, under their own colour (#1653)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", [["px", 9, ["1"]], ["px_FG", 11, ["red"]], ["status_BG", 11, ["yellow"]], ["qty", 9, ["2"]]]));
  const [px, fg, , qty] = page.rows()[0].children;
  assert.deepStrictEqual([px.style.backgroundColor, px.style.color], ["yellow", "red"]);
  assert.deepStrictEqual([fg.style.backgroundColor, fg.style.color], ["yellow", "red"]);
  assert.strictEqual(qty.style.backgroundColor, "yellow");
});

test("a formatted column's auto width fits the text its cells show, not q's (#1655)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", [["n_CCY", 9, ["-9876543.25"]], ["r_BPS", 9, ["1"]]]));
  const widths = page.body.all((e) => e.tagName === "COL").map((c) => c.style.width);
  // -9,876,543.25 is 13 characters, 10000.0 bp 10: each and its padding.
  assert.deepStrictEqual(widths, ["15ch", "12ch"]);
});

test("two columns of one name offer no edge to resize, as a width is kept by name (#2508)", () => {
  const page = loadPage(undefined);
  page.send(result("s.1", [["sym", 11, ["a", "b"]], ["sym", 11, ["c", "d"]], ["px", 9, ["1", "2"]]]));
  assert.deepStrictEqual(page.headers().map((h) => h.children.some((c) => c.className === "resize")), [false, false, true]);
  // Dragged past the other sym, nothing moves: the order kept is the grid's.
  page.headers()[1].fire("dragstart", {});
  page.headers()[0].fire("drop", {});
  assert.deepStrictEqual(page.posted.filter((m) => m.type === "look").at(-1).layout.order, ["sym", "sym", "px"]);
  assert.deepStrictEqual(page.rows()[0].children.map((td) => td.textContent), ["a", "c", "1"]);
});
