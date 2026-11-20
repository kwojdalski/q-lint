// q notebooks (#857): the `.qnb` format, cell directives, the grid's HTML
// and text, the outputs a cell shows, and Export Notebook. Run after `tsc`;
// nothing here needs an editor or a q process (notebook_q.test.js drives a
// real one).
const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const { NOTEBOOK, QNB_VERSION, QnbError, decodeItem, encodeItem, exportScript, parseQnb, serializeQnb } = require("../out/qnb.js");
const { CHART_KINDS, cellDirective } = require("../out/celldirectives.js");
const { DATA, cellOutputs, escapeHtml, readCellData, tableHtml, tableText } = require("../out/celldata.js");
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

test("a table as text is laid out as q's console lays it out", () => {
  assert.deepStrictEqual(tableText(TABLE), [
    "sym| px    note",
    "---------------------",
    "a  | 1.5   <b>x</b>",
    "bb | 22.25 it's & \"q\"",
  ]);
  const plain = { columns: ["a", "bb"], types: [7, 7], keys: 0, data: [["1"], ["22"]], total: 1 };
  assert.deepStrictEqual(tableText(plain), ["a bb", "----", "1 22"]);
});

test("a cell's outputs follow its mode", () => {
  const table = { ok: true, table: TABLE };
  const [grid] = cellOutputs({ mode: "grid" }, table);
  assert.deepStrictEqual(grid.items.map((i) => i.mime), ["text/html", "text/plain"]);
  const [chart] = cellOutputs({ mode: "chart", chart: "line" }, table);
  assert.deepStrictEqual(chart.items.map((i) => i.mime), ["text/plain"]);
  assert.match(chart.items[0].text, /^line chart: charts arrive with query modes \(L3\)/);
  assert.match(chart.items[0].text, /sym\| px/);
  assert.deepStrictEqual(cellOutputs({ mode: "console" }, { ok: true, type: -7, text: ["2"] }), [
    { kind: "items", items: [{ mime: "text/plain", text: "2" }] },
  ]);
  const notTable = cellOutputs({ mode: "grid" }, { ok: true, type: 7, text: ["1 2 3"] });
  assert.match(notTable[0].items[0].text, /^1 2 3\n\(@grid shows a table; this is not one/);
  // q's generic null shows nothing, as q's console does.
  assert.deepStrictEqual(cellOutputs({ mode: "console" }, { ok: true, type: 101, text: ["::"] }), []);
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
