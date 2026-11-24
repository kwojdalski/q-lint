// q notebooks (#857): the `.qnb` format, cell directives, the grid's HTML
// and text, the outputs a cell shows, a chart's output item (#870), and
// Export Notebook. Run after `tsc`;
// nothing here needs an editor or a q process (notebook_q.test.js drives a
// real one).
const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const { NOTEBOOK, QNB_VERSION, QnbError, decodeItem, encodeItem, exportScript, parseQnb, serializeQnb } = require("../out/qnb.js");
const fs = require("node:fs");
const path = require("node:path");
const { CHART_KINDS, cellDirective } = require("../out/celldirectives.js");
const { CHART_MIME, DATA, cellOutputs, chartCellOutputs, escapeHtml, readCellData, tableHtml, tableText } = require("../out/celldata.js");
const { toGrid } = require("../out/grid.js");
const { statements } = require("../out/statements.js");

const SAMPLE = {
  qnb: 1,
  cells: [
    { kind: "markdown", source: ["# Prices", "", "From the rdb."] },
    {
      kind: "code",
      source: ["/ @grid", "select from t"],
      execution: { order: 2, success: true, start: 1700000000000, end: 1700000000012 },
      outputs: [{ items: [{ mime: "text/html", text: "<table></table>" }, { mime: "text/plain", text: "a\n-\n1" }] }],
    },
    { kind: "code", source: ["1+`a"], execution: { order: 3, success: false }, metadata: { tag: "x" } },
    { kind: "code", source: ["print(1)"], language: "python" },
  ],
  metadata: { author: "me" },
};

test("a notebook survives a save and an open unchanged", () => {
  const text = JSON.stringify(SAMPLE, null, 1) + "\n";
  const read = parseQnb(text);
  assert.strictEqual(read.cells.length, 4);
  assert.strictEqual(read.cells[0].source, "# Prices\n\nFrom the rdb.");
  assert.strictEqual(read.cells[3].language, "python");
  assert.strictEqual(serializeQnb(read), text);
  // And again: writing what was read gives the same file.
  assert.strictEqual(serializeQnb(parseQnb(serializeQnb(read))), text);
});

test("fields this extension does not know are kept, so a save loses nothing", () => {
  // Another tool's, or a later q-lint's: a save of what was opened writes them back.
  const file = {
    qnb: 1,
    cells: [
      { kind: "code", source: ["1"], tags: ["slow"], id: "c1" },
      { kind: "markdown", source: ["# a"], id: "c2" },
    ],
    metadata: { author: "me" },
    kernel: { name: "q" },
  };
  const text = JSON.stringify(file, null, 1) + "\n";
  assert.strictEqual(serializeQnb(parseQnb(text)), text);
  // A known field is never written twice.
  assert.deepStrictEqual(JSON.parse(serializeQnb({ cells: [{ kind: "code", source: "2", extra: { source: ["1"], id: "x" } }], extra: { qnb: 9 } })), {
    qnb: QNB_VERSION,
    cells: [{ kind: "code", source: ["2"], id: "x" }],
  });
});

test("source keeps every character, CRLF and trailing newlines included", () => {
  const cells = [{ kind: "code", source: "a:1\r\nb:2\n\n" }, { kind: "code", source: "" }];
  assert.deepStrictEqual(parseQnb(serializeQnb({ cells })).cells, cells);
});

test("empty fields are not written, and q is a code cell's default language", () => {
  const text = serializeQnb({
    cells: [{ kind: "code", source: "1", language: "q", outputs: [], execution: { order: undefined }, metadata: {} }],
    metadata: {},
  });
  assert.deepStrictEqual(JSON.parse(text), { qnb: QNB_VERSION, cells: [{ kind: "code", source: ["1"] }] });
});

test("a file that starts with a byte order mark opens", () => {
  // As Notepad and Windows PowerShell's Set-Content -Encoding UTF8 write one.
  const text = JSON.stringify(SAMPLE, null, 1) + "\n";
  assert.deepStrictEqual(parseQnb("\uFEFF" + text), parseQnb(text));
});

test("an empty file is a new notebook", () => {
  assert.deepStrictEqual(parseQnb(""), { cells: [] });
  assert.deepStrictEqual(parseQnb("  \n"), { cells: [] });
});

test("a file that is not a notebook is refused with what is wrong, never read as empty", () => {
  const refused = (text, pattern) => assert.throws(() => parseQnb(text), (e) => e instanceof QnbError && pattern.test(e.message));
  refused("{", /not JSON/);
  refused("[]", /expected a JSON object/);
  refused('{"cells": []}', /format version/);
  refused('{"qnb": 2, "cells": []}', /format 2, written by a newer q-lint; this one reads format 1/);
  refused('{"qnb": 1}', /"cells" is missing/);
  refused('{"qnb": 1, "cells": [{"kind": "raw", "source": []}]}', /cell 1: "kind" is "raw"/);
  refused('{"qnb": 1, "cells": [{"kind": "code", "source": [1]}]}', /cell 1: "source" is not a list of lines/);
  refused('{"qnb": 1, "cells": [{"kind": "code", "source": [], "outputs": [{"items": [{"mime": "x"}]}]}]}', /cell 1, output 1, item 1 has neither/);
  refused('{"qnb": 1, "cells": [{"kind": "code", "source": [], "execution": {"order": "1"}}]}', /execution.order" is not a number/);
});

test("output bytes are kept as text when UTF-8 and as base64 when not", () => {
  const text = encodeItem("text/plain", Buffer.from("zażółć", "utf8"));
  assert.deepStrictEqual(text, { mime: "text/plain", text: "zażółć" });
  const binary = encodeItem("image/png", Uint8Array.from([0x89, 0x50, 0xff, 0x00]));
  assert.deepStrictEqual(binary, { mime: "image/png", base64: "iVD/AA==" });
  assert.deepStrictEqual([...decodeItem(binary)], [0x89, 0x50, 0xff, 0x00]);
  assert.strictEqual(Buffer.from(decodeItem(text)).toString("utf8"), "zażółć");
});

test("directives on a cell's first lines choose its output", () => {
  assert.deepStrictEqual(cellDirective("1+1"), { mode: "console" });
  assert.deepStrictEqual(cellDirective("/ @grid\nt"), { mode: "grid" });
  assert.deepStrictEqual(cellDirective("\n/@console\nt"), { mode: "console" });
  for (const kind of CHART_KINDS) {
    assert.deepStrictEqual(cellDirective(`/ @chart ${kind}\nt`), { mode: "chart", chart: kind });
  }
  // The last one wins, and one after the code is an ordinary comment.
  assert.deepStrictEqual(cellDirective("/ @grid\n/ @chart bar\nt"), { mode: "chart", chart: "bar" });
  assert.deepStrictEqual(cellDirective("t\n/ @grid"), { mode: "console" });
  assert.deepStrictEqual(cellDirective("/ a note\n/ @grid\nt"), { mode: "console" });
});

test("a directive that is not one is a problem, not a silent default", () => {
  assert.match(cellDirective("/ @chart\nt").problem, /takes one of line, bar, scatter, histogram\./);
  assert.match(cellDirective("/ @chart pie\nt").problem, /was given "pie"/);
  assert.match(cellDirective("/ @grd\nt").problem, /`\/ @grd` is not a cell directive/);
  assert.match(cellDirective("/ @grid wide\nt").problem, /takes nothing after it/);
  assert.match(cellDirective("/ @title\n/ @chart bar\nt").problem, /takes the chart's title/);
  assert.match(cellDirective("/ @chart bar\n/ @height 50\nt").problem, /100 to 2000, and was given "50"/);
  assert.match(cellDirective("/ @chart bar\n/ @height tall\nt").problem, /was given "tall"/);
  assert.match(cellDirective("/ @grid\n/ @title Prices\nt").problem, /`\/ @title` is for a chart, and this cell has no `\/ @chart`/);
  assert.match(cellDirective("/ @height 400\nt").problem, /`\/ @height` is for a chart/);
});

test("a chart takes a title and a height, before or after its kind", () => {
  assert.deepStrictEqual(cellDirective("/ @title Daily volume, by sym\n/ @chart bar\n/ @height 400\nt"), {
    mode: "chart",
    chart: "bar",
    title: "Daily volume, by sym",
    height: 400,
  });
  assert.deepStrictEqual(cellDirective("/ @chart line\n/ @height 2000\nt"), { mode: "chart", chart: "line", height: 2000 });
});

test("directives are comments: the cell's statements leave them out", () => {
  assert.deepStrictEqual(statements("/ @chart line\nselect from t"), ["select from t"]);
});

test("the data lambda keeps nothing on the process", () => {
  assert.ok(!DATA.includes("::"), DATA);
  assert.ok(!/\bset\b/.test(DATA), DATA);
  assert.ok(DATA.startsWith("{[s;rows;size]") && DATA.endsWith("}"));
});

const TABLE = {
  columns: ["sym", "px", "note"],
  types: [11, 9, 0],
  keys: 1,
  data: [["a", "bb"], ["1.5", "22.25"], ["<b>x</b>", "it's & \"q\""]],
  total: 2,
};

test("a table answer is read; anything else is refused", () => {
  const raw = { ok: true, table: true, columns: ["a", "b"], types: [7, 11], keys: 0, data: [["1", "2"], ["x", "y"]], total: 5 };
  assert.deepStrictEqual(readCellData(raw), {
    ok: true,
    table: { columns: ["a", "b"], types: [7, 11], keys: 0, data: [["1", "2"], ["x", "y"]], total: 5 },
  });
  assert.deepStrictEqual(readCellData({ ok: true, table: false, type: -7, text: ["2"] }), { ok: true, type: -7, text: ["2"] });
  assert.deepStrictEqual(readCellData({ ok: false, error: "type", trace: "" }), { ok: false, error: "type", trace: "" });
  assert.throws(() => readCellData(1), /something other than a cell result/);
  assert.throws(() => readCellData({ ok: true, table: true, columns: ["a"], data: [] }), /0 columns of data for 1 column names/);
});

test("every name and value in the grid is escaped, and it holds no script", () => {
  assert.strictEqual(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  const evil = { columns: ["<script>alert(1)</script>"], types: [11], keys: 0, data: [["<img src=x onerror=alert(1)>"]], total: 1 };
  const html = tableHtml(evil);
  assert.ok(!/<script/i.test(html), html);
  assert.ok(!/<img/i.test(html), html);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  const good = tableHtml(TABLE);
  assert.ok(good.includes("<td>&lt;b&gt;x&lt;/b&gt;</td>"), good);
  assert.ok(good.includes("it&#39;s &amp; &quot;q&quot;"));
  // Numbers right-aligned, the key column marked, the theme's colours used.
  assert.ok(good.includes('<td class="n">22.25</td>'));
  assert.ok(good.includes('<th class="k">sym</th>'));
  assert.match(good, /var\(--vscode-editor-foreground/);
  assert.ok(!good.includes("Showing"));
});

test("a cut table says so, in the grid and in its text", () => {
  const cut = { ...TABLE, total: 25000 };
  assert.ok(tableHtml(cut).includes('<div class="qnb-note">Showing the first 2 of 25,000 rows.</div>'));
  assert.strictEqual(tableText(cut).at(-1), "Showing the first 2 of 25,000 rows.");
});

test("a table cut to its last rows says last, in a grid cell and a chart cell (#889)", () => {
  const [grid] = cellOutputs({ mode: "grid" }, { ok: true, table: { ...TABLE, total: 25000 } }, "last");
  assert.ok(grid.items[0].text.includes('<div class="qnb-note">Showing the last 2 of 25,000 rows.</div>'));
  assert.strictEqual(grid.items[1].text.split("\n").at(-1), "Showing the last 2 of 25,000 rows.");
  const [chart] = chartCellOutputs({ mode: "chart", chart: "line" }, GRID_ANSWER, "last");
  assert.strictEqual(JSON.parse(chart.items[0].text).note, "Showing the last 2 of 3 rows.");
  assert.strictEqual(chart.items[1].text.split("\n").at(-1), "Showing the last 2 of 3 rows.");
  // A table that was not cut says nothing, whichever end it counts from.
  const [whole] = cellOutputs({ mode: "grid" }, { ok: true, table: TABLE }, "last");
  assert.ok(!whole.items[0].text.includes("Showing"));
});

test("a table as text is laid out as q's console lays it out", () => {
  assert.deepStrictEqual(tableText(TABLE), [
    "sym| px    note",
    "---| ----------------",
    "a  | 1.5   <b>x</b>",
    "bb | 22.25 it's & \"q\"",
  ]);
  const plain = { columns: ["a", "bb"], types: [7, 7], keys: 0, data: [["1"], ["22"]], total: 1 };
  assert.deepStrictEqual(tableText(plain), ["a bb", "----", "1 22"]);
});

test("a string cell holding a newline or a tab stays on its row in the text table (#1496)", () => {
  const t = { columns: ["s", "n"], types: [0, 7], keys: 0, data: [["a\nb", "c\td"], ["1", "2"]], total: 2 };
  assert.deepStrictEqual(tableText(t), ["s    n", "------", "a\\nb 1", "c\\td 2"]);
});

test("a table of every row is laid out as text, however many rows it has", () => {
  // q-lint.notebook.rowLimit 0 sends every row: far more than a call takes arguments.
  const rows = 300000;
  const big = { columns: ["i"], types: [7], keys: 0, data: [Array.from({ length: rows }, (_, i) => String(i))], total: rows };
  const text = tableText(big);
  assert.strictEqual(text.length, rows + 2);
  assert.deepStrictEqual(text.slice(0, 3), ["i", "------", "0"]);
  assert.strictEqual(text.at(-1), String(rows - 1));
});

test("a long value is cut between characters, never inside one", () => {
  // 498 letters then an emoji, two UTF-16 units: the cut at 499 falls between them.
  const value = "a".repeat(498) + "\u{1F600}" + "b".repeat(10);
  const table = { columns: ["s"], types: [0], keys: 0, data: [[value]], total: 1 };
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(tableText(table)[2], lone);
  assert.doesNotMatch(tableHtml(table), lone);
  assert.ok(tableText(table)[2].endsWith("a…"));
});

test("a cell's outputs follow its mode", () => {
  const table = { ok: true, table: TABLE };
  const [grid] = cellOutputs({ mode: "grid" }, table);
  assert.deepStrictEqual(grid.items.map((i) => i.mime), ["text/html", "text/plain"]);
  assert.deepStrictEqual(cellOutputs({ mode: "console" }, { ok: true, type: -7, text: ["2"] }), [
    { kind: "items", items: [{ mime: "text/plain", text: "2" }] },
  ]);
  const notTable = cellOutputs({ mode: "grid" }, { ok: true, type: 7, text: ["1 2 3"] });
  assert.match(notTable[0].items[0].text, /^1 2 3\n\(@grid shows a table; this is not one/);
  // q's generic null shows nothing, as q's console does.
  assert.deepStrictEqual(cellOutputs({ mode: "console" }, { ok: true, type: 101, text: ["::"] }), []);
});

/// A GRID answer for a table of a timestamp and a float column, as
/// readGridAnswer gives it.
const GRID_ANSWER = {
  ok: true,
  type: 98,
  text: ["t px", "----"],
  grid: {
    count: 3,
    keys: 0,
    names: ["t", "px"],
    types: [12, 9],
    cells: [["2024.01.01D00:00:00.000000000", "2024.01.02D00:00:00.000000000"], ["1.5", ""]],
    raw: [[757382400000000000, 757468800000000000], [1.5, null]],
    rank: [[0, 1], [1, 0]],
  },
};

test("a chart cell's output is the chart, and the table as text beside it", () => {
  const [part] = chartCellOutputs({ mode: "chart", chart: "line", title: "Prices", height: 400 }, GRID_ANSWER);
  assert.deepStrictEqual(part.items.map((i) => i.mime), [CHART_MIME, "text/plain"]);
  assert.strictEqual(CHART_MIME, "application/vnd.q-lint.chart+json");
  const spec = JSON.parse(part.items[0].text);
  assert.strictEqual(spec.kind, "line");
  assert.strictEqual(spec.title, "Prices");
  assert.strictEqual(spec.height, 400);
  assert.strictEqual(spec.note, "Showing the first 2 of 3 rows.");
  // The panel's grid, less the ranks only its sorting uses.
  const { rank, ...grid } = toGrid(GRID_ANSWER.grid, -1);
  assert.deepStrictEqual(spec.grid, grid);
  assert.deepStrictEqual(spec.grid.values[1], [1.5, null]);
  assert.strictEqual(spec.grid.columns[0].temporal, true);
  assert.deepStrictEqual(part.items[1].text.split("\n"), [
    "t                             px",
    "---------------------------------",
    "2024.01.01D00:00:00.000000000 1.5",
    "2024.01.02D00:00:00.000000000",
    "Showing the first 2 of 3 rows.",
  ]);
  // No title or height asked for, none written.
  const [plain] = chartCellOutputs({ mode: "chart", chart: "bar" }, GRID_ANSWER);
  assert.deepStrictEqual(Object.keys(JSON.parse(plain.items[0].text)).sort(), ["grid", "kind", "note"]);
});

test("a chart cell whose value is no table shows it as text, and an error as an error", () => {
  const atom = chartCellOutputs({ mode: "chart", chart: "line" }, { ok: true, type: -7, text: ["2"] });
  assert.match(atom[0].items[0].text, /^2\n\(@chart shows a table; this is not one/);
  const par = chartCellOutputs({ mode: "chart", chart: "line" }, { ok: true, type: 98, text: ["+`a!..."], gridError: "par" });
  assert.match(par[0].items[0].text, /could not shape this as a table: 'par\./);
  assert.deepStrictEqual(chartCellOutputs({ mode: "chart", chart: "line" }, { ok: false, error: "type", trace: "" }), [
    { kind: "error", name: "q error", message: "'type", stack: "" },
  ]);
  assert.deepStrictEqual(chartCellOutputs({ mode: "chart", chart: "line" }, { ok: true, type: 101, text: ["::"] }), []);
});

test("a chart's output item survives a save and an open", () => {
  const [part] = chartCellOutputs({ mode: "chart", chart: "scatter", title: "zażółć <b>" }, GRID_ANSWER);
  // As the serializer does: each item's bytes in, each item's bytes out.
  const outputs = [{ items: part.items.map((i) => encodeItem(i.mime, Buffer.from(i.text, "utf8"))) }];
  assert.ok(outputs[0].items.every((i) => i.text !== undefined), "kept as text, not base64");
  const text = serializeQnb({ cells: [{ kind: "code", source: "/ @chart scatter\nt", outputs }] });
  const [cell] = parseQnb(text).cells;
  const back = cell.outputs[0].items.map((i) => ({ mime: i.mime, text: Buffer.from(decodeItem(i)).toString("utf8") }));
  assert.deepStrictEqual(back, part.items);
  assert.strictEqual(serializeQnb(parseQnb(text)), text);
});

test("an error shows q's message, and its trace as the stack", () => {
  assert.deepStrictEqual(cellOutputs({ mode: "console" }, { ok: false, error: "type", trace: "  [1]  1+`a\n        ^\n" }), [
    { kind: "error", name: "q error", message: "'type", stack: "'type\n  [1]  1+`a\n        ^" },
  ]);
  assert.deepStrictEqual(cellOutputs({ mode: "grid" }, { ok: false, error: "foo", trace: "" }), [
    { kind: "error", name: "q error", message: "'foo", stack: "" },
  ]);
});

test("an export is a script whose statements are the cells' statements, in order", () => {
  const cells = [
    { kind: "markdown", source: "# Title\n\\\nend" },
    { kind: "code", source: "/ @grid\na:1\nf:{[x]\n  x+a}" },
    { kind: "code", source: "  f 2" },
    { kind: "code", source: "b:1\n/\nopen comment" },
    { kind: "code", source: "c:1\n\\\nd:1\n\\\ne:1" },
    { kind: "code", source: "   " },
    { kind: "code", source: "x", language: "python" },
    { kind: "code", source: "g:2" },
  ];
  const script = exportScript(cells, "prices.qnb");
  assert.strictEqual(
    script,
    [
      "/ Exported by q-lint from prices.qnb.",
      "",
      "/", "# Title", " \\", "end", "\\",
      "",
      "/ @grid", "a:1", "f:{[x]", "  x+a}",
      "",
      "f 2",
      "",
      "b:1", "/", "open comment", "\\",
      "",
      "c:1", "/", "d:1", " \\", "e:1", "\\",
      "",
      "/", "python cell:", "x", "\\",
      "",
      "g:2",
      "",
    ].join("\n"),
  );
  const fromCells = cells
    .filter((c) => c.kind === "code" && c.language === undefined)
    .flatMap((c) => statements(c.source));
  assert.deepStrictEqual(statements(script), fromCells);
});

test("package.json contributes the notebook type and its export command", () => {
  const [notebook] = pkg.contributes.notebooks;
  assert.strictEqual(notebook.type, NOTEBOOK.type);
  assert.deepStrictEqual(notebook.selector, [{ filenamePattern: "*.qnb" }]);
  assert.ok(pkg.activationEvents.includes(`onNotebook:${NOTEBOOK.type}`));
  assert.ok(pkg.contributes.commands.some((c) => c.command === NOTEBOOK.exportCommand));
});

test("package.json contributes the chart renderer, for the chart item's type, from the extension's own files", () => {
  const [renderer] = pkg.contributes.notebookRenderer;
  assert.strictEqual(renderer.id, NOTEBOOK.renderer);
  assert.deepStrictEqual(renderer.mimeTypes, [CHART_MIME]);
  assert.strictEqual(renderer.requiresMessaging, "optional");
  const entry = path.join(__dirname, "..", renderer.entrypoint);
  const source = fs.readFileSync(entry, "utf8");
  // Every import is a file beside it, shipped with the extension: no network.
  const imports = [...source.matchAll(/^import\s+(?:[^"']*from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepStrictEqual(imports, ["./vendor/chart.umd.min.js", "./chartspec.js"]);
  for (const file of imports) {
    assert.ok(fs.existsSync(path.join(path.dirname(entry), file)), file);
  }
  assert.doesNotMatch(source, /https?:\/\//);
  assert.match(source, /^export function activate\(/m);
});

test("a title on a cell whose /@chart a later /@grid replaces does not say it has no /@chart", () => {
  // The last directive wins, so the cell draws no chart - but it has one.
  const problem = cellDirective("/ @chart line\n/ @title Prices\n/ @grid\nt").problem;
  assert.doesNotMatch(problem, /has no `\/ @chart`/);
  assert.match(problem, /`\/ @title` is for a chart, and this cell's `\/ @grid` after its `\/ @chart` draws none/);
  assert.match(cellDirective("/ @chart bar\n/ @console\n/ @height 400\nt").problem, /`\/ @console` after its `\/ @chart` draws none/);
});

test("export: a lone / inside a comment is indented, so no q nests a block comment there", () => {
  const script = exportScript([
    { kind: "markdown", source: "a path:\n/\nthe root" },
    { kind: "code", source: "a:1\n/\nnot code\n/ \n\\" },
    { kind: "code", source: "b:2\n\\\n/" },
  ]);
  assert.strictEqual(script, "/\na path:\n /\nthe root\n\\\n\na:1\n/\nnot code\n / \n\\\n\nb:2\n/\n /\n\\\n");
});

test("fields this extension does not know are kept on an output, an item and a run too", () => {
  // Saved by a later q-lint, or another tool: the README promises a save of
  // what was opened writes the same file.
  const file = {
    qnb: 1,
    cells: [
      { kind: "markdown", source: ["# a"], language: "markdown" },
      {
        kind: "code",
        source: ["1"],
        execution: { order: 1, success: true, start: 1, end: 2, host: "h" },
        outputs: [{ items: [{ mime: "text/plain", text: "1", note: "n" }], id: "o1" }],
      },
    ],
  };
  const text = JSON.stringify(file, null, 1) + "\n";
  assert.strictEqual(serializeQnb(parseQnb(text)), text);
});

test("a cell that opens with a qDoc comment runs: @param and its kin are documentation, not directives", () => {
  const documented = "/ @param x long\n/ @return long\n/ @throws type\nf:{x+1}";
  assert.deepStrictEqual(cellDirective(documented), { mode: "console" });
  assert.deepStrictEqual(cellDirective("/ @private\n/ @eg f 1\nf:{x}"), { mode: "console" });
  // A directive before the documentation still counts; a misspelt one is still caught.
  assert.deepStrictEqual(cellDirective("/ @grid\n/ @param t table\nt"), { mode: "grid" });
  assert.match(cellDirective("/ @grd\nt").problem, /not a cell directive/);
});

test("an indented lone / or \\ on a cell's first line opens no block comment and ends nothing (#1563)", () => {
  const { statements } = require("../out/statements.js");
  for (const first of [" /", " \\", "\t/"]) {
    const script = exportScript([{ kind: "code", source: `${first}\na:1` }, { kind: "code", source: "b:2" }]);
    assert.deepStrictEqual(statements(script), ["a:1", "b:2"], script);
  }
  assert.strictEqual(exportScript([{ kind: "code", source: " /\n x:1" }]), "/ /\nx:1\n");
});
