// The notebook's later features, without an editor or a q process: the
// `/ @process` and `/ @parameters` directives (#950, #947), live values in
// Markdown cells (#949), export to HTML and Jupyter and import from Jupyter
// (#948), the headless run and its command line (#947), and the variables
// view's data (#946). notebookfeatures_q.test.js drives a real q.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");
const { cellDirective } = require("../out/celldirectives.js");
const { LIVE, LIVE_KEY, inlineSpans, liveExpressions, markdownAfter, readLiveValues, scanLive } = require("../out/livemarkdown.js");
const { ERROR_MIME, fromIpynb, markdownHtml, toHtml, toIpynb, IpynbError } = require("../out/qnbconvert.js");
const { INJECTED_KEY, cliProcess, guardedText, injectParameters, parametersCell, parametersOf, parseArgs, passwordVariable, runNotebook, writeAs } = require("../out/qnbrun.js");
const { writes } = require("../out/guard.js");
const { describeVariable, readVariables, bytesText, VARS } = require("../out/notebookvars.js");
const { NOTEBOOK, parseQnb, serializeQnb } = require("../out/qnb.js");

// --- directives

test("/ @process names the process a cell runs on, beside its output mode", () => {
  assert.deepStrictEqual(cellDirective("/ @process rdb\n1+1"), { mode: "console", process: "rdb" });
  assert.deepStrictEqual(cellDirective("/ @grid\n/ @process desk/hdb 2\nt"), { mode: "grid", process: "desk/hdb 2" });
  assert.deepStrictEqual(cellDirective("/ @chart bar\n/ @process r\n/ @title T\nt"), { mode: "chart", chart: "bar", title: "T", process: "r" });
  assert.match(cellDirective("/ @process\n1").problem, /takes the label/);
  // Not a directive below the first statement.
  assert.deepStrictEqual(cellDirective("1\n/ @process rdb"), { mode: "console" });
});

test("/ @parameters marks the parameters cell and takes nothing", () => {
  assert.deepStrictEqual(cellDirective("/ @parameters\nd:2024.01.01"), { mode: "console", parameters: true });
  assert.match(cellDirective("/ @parameters x\nd:1").problem, /takes nothing/);
  assert.match(cellDirective("/ @nope\n1").problem, /`\/ @process <label>` and `\/ @parameters`/);
});

// --- live values

test("a live value's expression runs to its }}, braces and q strings balanced", () => {
  assert.deepStrictEqual(scanLive("{{q: 1+1}} after", 0), { expr: "1+1", end: 10 });
  assert.deepStrictEqual(scanLive("{{q: {x+1} 41}}", 0), { expr: "{x+1} 41", end: 15 });
  assert.deepStrictEqual(scanLive('{{q: count "}}"}}', 0), { expr: 'count "}}"', end: 17 });
  assert.strictEqual(scanLive("{{q: 1+1}", 0), undefined);
  assert.strictEqual(scanLive("{{q:   }}", 0), undefined);
  assert.strictEqual(scanLive("{{q: a\n\nb}}", 0), undefined);
});

test("expressions are found once each, never in code; a q symbol's backtick opens no code span", () => {
  const md = [
    "# {{q: string .z.d}}",
    "Total **{{q: sum t`px}}**, `{{q: in code}}` and {{q: string .z.d}}.",
    "```q",
    "{{q: in a block}}",
    "```",
    "Last {{q: count t}} and \\{{q: escaped}}",
  ].join("\n");
  assert.deepStrictEqual(liveExpressions(md), ["string .z.d", "sum t`px", "count t"]);
  assert.deepStrictEqual(inlineSpans("a `x` {{q: 1}}").map((s) => s.kind), ["code", "live"]);
});

test("an indented code block or an HTML comment holds no live value (#1429)", () => {
  assert.deepStrictEqual(liveExpressions("Para\n\n    {{q: indented}}\n"), []);
  assert.deepStrictEqual(liveExpressions("    {{q: first}}\n\tand {{q: tab}}\n\nAfter {{q: a}}"), ["a"]);
  assert.deepStrictEqual(liveExpressions("<!-- {{q: hidden}} -->"), []);
  assert.deepStrictEqual(liveExpressions("A <!--\n{{q: hidden}}\n--> and {{q: b}}"), ["b"]);
  // Indented under a paragraph line or a list item it is text, and live.
  assert.deepStrictEqual(liveExpressions("Para\n    {{q: lazy}}"), ["lazy"]);
  assert.deepStrictEqual(liveExpressions("- item\n\n    {{q: in list}}"), ["in list"]);
});

test("the Markdown after a code cell is read when it runs; the first code cell reads what is above it", () => {
  const cells = ["markdown", "markdown", "code", "markdown", "code", "code", "markdown"].map((kind) => ({ kind }));
  assert.deepStrictEqual(markdownAfter(cells, 2), [0, 1, 3]);
  assert.deepStrictEqual(markdownAfter(cells, 4), []);
  assert.deepStrictEqual(markdownAfter(cells, 5), [6]);
});

test("the live lambda's answer is read by expression; anything else is refused", () => {
  assert.deepStrictEqual(readLiveValues(["a", "b"], [[true, "2"], [false, "type"]]), { a: { text: "2" }, b: { error: "type" } });
  assert.throws(() => readLiveValues(["a"], { ok: 1 }), /1 live values/);
  // One lambda, nothing assigned on the process.
  assert.match(LIVE, /^\{\[es\]/);
  assert.doesNotMatch(LIVE.replace(/\b[rv]:/g, ""), /[a-zA-Z_.]+::?[^:]/);
});

/// media/livemarkdown.js, the renderer's extension, as the editor loads it:
/// an ES module.
async function renderer() {
  const source = fs.readFileSync(path.join(__dirname, "..", "media", "livemarkdown.js"), "utf8");
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

test("the renderer reads expressions as the extension does, and escapes every value", async () => {
  const r = await renderer();
  for (const text of ["{{q: 1+1}}", "{{q: {x+1} 41}}", '{{q: count "}}"}}', "{{q: 1+1}", "{{q: a\n\nb}}", "{{q: sum t`px}}"]) {
    assert.deepStrictEqual(r.scanLive(text, 0), scanLive(text, 0), text);
  }
  const values = { a: { text: "<img src=x onerror=alert(1)>" }, b: { error: "<b>" } };
  assert.strictEqual(r.liveHtml("a", values), '<span class="qlint-live" title="q: a">&lt;img src=x onerror=alert(1)&gt;</span>');
  assert.match(r.liveHtml("b", values), />'&lt;b&gt;<\/span>$/);
  assert.strictEqual(r.liveHtml('<x">', {}), '<code title="Runs when the code cell above this one runs">{{q: &lt;x&quot;&gt;}}</code>');
  // A prototype's name is no value.
  assert.match(r.liveHtml("constructor", {}), /^<code/);
});

test("the renderer reports a prototype's name as having no value, which postMessage can clone (#1391)", async () => {
  const r = await renderer();
  const rules = {};
  const md = { inline: { ruler: { before: (_at, _name, rule) => (rules.inline = rule) } }, renderer: { rules } };
  const heard = [];
  r.extend(md, (expr, value) => heard.push(structuredClone({ expr, value: value ?? null })));
  const env = { outputItem: { metadata: { "q-lint.liveValues": { a: { text: "1" } } } } };
  const html = ["constructor", "toString", "a"].map((expr) => rules.qlint_live([{ meta: { expr } }], 0, {}, env));
  assert.deepStrictEqual(heard, [{ expr: "constructor", value: null }, { expr: "toString", value: null }, { expr: "a", value: { text: "1" } }]);
  assert.match(html[0], /^<code/);
});

test("package.json contributes the live values renderer as an extension of the Markdown renderer", () => {
  const live = pkg.contributes.notebookRenderer.find((r) => r.id === NOTEBOOK.liveRenderer);
  assert.deepStrictEqual(live.entrypoint, { extends: "vscode.markdown-it-renderer", path: "./media/livemarkdown.js" });
  const source = fs.readFileSync(path.join(__dirname, "..", live.entrypoint.path), "utf8");
  assert.match(source, /^export async function activate\(/m);
  assert.match(source, /const LIVE_KEY = "q-lint\.liveValues";/);
  assert.strictEqual(LIVE_KEY, "q-lint.liveValues");
  assert.doesNotMatch(source, /^import /m);
});

// --- export and import

const RUN = {
  cells: [
    { kind: "markdown", source: "# Prices <script>alert(1)</script>\n\nTotal **{{q: sum px}}**, see [docs](https://code.kx.com/q?a=1&b=2) not [this](javascript:alert(1)).\n\n- one\n- `two<`", metadata: { [LIVE_KEY]: { "sum px": { text: "<7.5>" } } } },
    {
      kind: "code",
      source: "/ @grid\nt:([] s:enlist \"</pre><script>\")\nt",
      execution: { order: 1, success: true },
      outputs: [{ items: [{ mime: "text/html", text: "<table><script>alert(1)</script></table>" }, { mime: "text/plain", text: "s\n---\n</pre><script>" }] }],
    },
    { kind: "code", source: "1+`a", execution: { order: 2, success: false }, outputs: [{ items: [{ mime: ERROR_MIME, text: JSON.stringify({ name: "q error", message: "'type", stack: "'type\n  [0] 1+`a" }) }] }] },
    { kind: "code", source: "print(1)", language: "python" },
    { kind: "code", source: "x", outputs: [{ items: [{ mime: "image/png", base64: "iVBORw0KGgo=" }] }] },
  ],
};

test("an HTML export escapes everything from the notebook, copies no output HTML, and runs no script", () => {
  const html = toHtml(RUN, "prices<1>.qnb");
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<title>prices&lt;1&gt;\.qnb<\/title>/);
  assert.match(html, /<h1>Prices &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
  assert.match(html, /<strong><span class="live" title="q: sum px">&lt;7\.5&gt;<\/span><\/strong>/);
  assert.match(html, /<a href="https:\/\/code\.kx\.com\/q\?a=1&amp;b=2">docs<\/a>/);
  assert.match(html, /<li><code>two&lt;<\/code><\/li>/);
  assert.match(html, /<pre class="out">s\n---\n&lt;\/pre&gt;&lt;script&gt;<\/pre>/);
  assert.match(html, /<pre class="out error">&#39;type\n  \[0\] 1\+`a<\/pre>/);
  assert.match(html, /python \[ \]/);
  assert.match(html, /<img class="out" alt="" src="data:image\/png;base64,iVBORw0KGgo=">/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/);
});

test("Markdown without a value shows its expression as written", () => {
  assert.strictEqual(markdownHtml("n is {{q: n}}"), "<p>n is <code>{{q: n}}</code></p>");
  assert.strictEqual(markdownHtml("> quoted *a*\n\n1. x\n2. y"), "<blockquote><p>quoted <em>a</em></p></blockquote>\n<ol><li>x</li><li>y</li></ol>");
  // A link's URL is not read for emphasis; its label is (#1105).
  assert.strictEqual(markdownHtml("[docs](https://code.kx.com/q/ref/_x_/)"), '<p><a href="https://code.kx.com/q/ref/_x_/">docs</a></p>');
  assert.strictEqual(markdownHtml("[*a*](https://x.io/a*b*c) and *b*"), '<p><a href="https://x.io/a*b*c"><em>a</em></a> and <em>b</em></p>');
});

test("a Jupyter export is nbformat 4 with q's kernel, other languages and errors as Jupyter writes them", () => {
  const nb = JSON.parse(toIpynb(RUN));
  assert.strictEqual(nb.nbformat, 4);
  assert.strictEqual(nb.metadata.kernelspec.language, "q");
  assert.deepStrictEqual(nb.cells[0].metadata, RUN.cells[0].metadata);
  assert.deepStrictEqual(nb.cells[1].source, ["/ @grid\n", "t:([] s:enlist \"</pre><script>\")\n", "t"]);
  assert.strictEqual(nb.cells[1].outputs[0].output_type, "execute_result");
  assert.strictEqual(nb.cells[1].outputs[0].execution_count, 1);
  assert.deepStrictEqual(nb.cells[2].outputs[0], { output_type: "error", ename: "q error", evalue: "'type", traceback: ["'type", "  [0] 1+`a"] });
  assert.deepStrictEqual(nb.cells[3].metadata, { vscode: { languageId: "python" } });
  assert.strictEqual(nb.cells[4].outputs[0].output_type, "display_data");
  assert.strictEqual(nb.cells[4].outputs[0].data["image/png"], "iVBORw0KGgo=");
});

test("a notebook exported to Jupyter and imported again is the same notebook", () => {
  const back = fromIpynb(toIpynb(RUN));
  assert.strictEqual(back.cells.length, RUN.cells.length);
  back.cells.forEach((cell, i) => {
    const want = RUN.cells[i];
    assert.strictEqual(cell.kind, want.kind);
    assert.strictEqual(cell.source, want.source);
    assert.strictEqual(cell.language, want.language);
    assert.deepStrictEqual(cell.outputs?.map((o) => o.items), want.outputs?.map((o) => o.items));
    assert.strictEqual(cell.execution?.order, want.execution?.order);
  });
  assert.deepStrictEqual(back.cells[0].metadata, RUN.cells[0].metadata);
  // And it is a .qnb that reads back.
  assert.strictEqual(parseQnb(serializeQnb(back)).cells.length, 5);
});

test("a Python notebook imports with its code as Python, a %%q cell as q, and its outputs kept", () => {
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { language: "python", name: "python3" }, language_info: { name: "python" } },
    cells: [
      { cell_type: "markdown", metadata: {}, source: ["# Title\n", "text"], attachments: { "a.png": {} } },
      { cell_type: "code", execution_count: 3, metadata: {}, source: "import pykx as kx", outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }] },
      { cell_type: "code", execution_count: null, metadata: {}, source: ["%%q\n", "til 3"], outputs: [] },
      { cell_type: "code", metadata: { vscode: { languageId: "q" } }, source: ["1+1"], outputs: [{ output_type: "error", ename: "E", evalue: "v", traceback: ["\u001b[31mred\u001b[0m"] }] },
      { cell_type: "raw", metadata: {}, source: "raw text" },
      { cell_type: "code", metadata: {}, source: "plt.plot()", outputs: [{ output_type: "display_data", data: { "image/png": "iVBO\nRw==", "text/plain": ["<Figure>"] }, metadata: {} }] },
    ],
  };
  const qnb = fromIpynb(JSON.stringify(nb));
  assert.deepStrictEqual(qnb.cells.map((c) => [c.kind, c.language]), [
    ["markdown", undefined],
    ["code", "python"],
    ["code", undefined],
    ["code", undefined],
    ["code", "raw"],
    ["code", "python"],
  ]);
  assert.strictEqual(qnb.cells[0].source, "# Title\ntext");
  assert.deepStrictEqual(qnb.cells[0].extra, { attachments: { "a.png": {} } });
  assert.strictEqual(qnb.cells[1].execution.order, 3);
  assert.deepStrictEqual(qnb.cells[1].outputs[0].items, [{ mime: "application/vnd.code.notebook.stdout", text: "hi\n" }]);
  assert.strictEqual(qnb.cells[2].source, "til 3");
  assert.strictEqual(qnb.cells[3].metadata, undefined);
  assert.strictEqual(JSON.parse(qnb.cells[3].outputs[0].items[0].text).stack, "red");
  assert.deepStrictEqual(qnb.cells[5].outputs[0].items[0], { mime: "image/png", base64: "iVBORw==" });
  // A raw cell goes back to Jupyter as a raw cell (#1107).
  assert.deepStrictEqual(JSON.parse(toIpynb(qnb)).cells[4], { cell_type: "raw", metadata: {}, source: ["raw text"] });
  // What is not a notebook is refused, with why.
  assert.throws(() => fromIpynb("{"), IpynbError);
  assert.throws(() => fromIpynb('{"nbformat": 3, "cells": []}'), /nbformat 3/);
  assert.throws(() => fromIpynb("[]"), /expected a JSON object with "cells"/);
});

test("a heading keeps a # that ends a word, and drops a closing run after a space (#1237)", () => {
  assert.strictEqual(markdownHtml("# Using C#"), "<h1>Using C#</h1>");
  assert.strictEqual(markdownHtml("## Title ##"), "<h2>Title</h2>");
  assert.strictEqual(markdownHtml("# F# and C# #"), "<h1>F# and C#</h1>");
  assert.strictEqual(markdownHtml("# ##"), "<h1></h1>");
});

test("a markdown or raw cell's attachments go back to Jupyter (#1234)", () => {
  const png = { "image/png": "iVBORw==" };
  const nb = {
    nbformat: 4,
    metadata: { kernelspec: { language: "q", name: "qpk" } },
    cells: [
      { cell_type: "markdown", metadata: {}, source: "![x](attachment:a.png)", attachments: { "a.png": png } },
      { cell_type: "raw", metadata: {}, source: "r", attachments: { "b.png": png } },
    ],
  };
  const back = JSON.parse(toIpynb(fromIpynb(JSON.stringify(nb))));
  assert.deepStrictEqual(back.cells[0].attachments, { "a.png": png });
  assert.deepStrictEqual(back.cells[1].attachments, { "b.png": png });
});

test("a jupyterq notebook's code cells are q", () => {
  const qnb = fromIpynb(JSON.stringify({ nbformat: 4, metadata: { kernelspec: { language: "q", name: "qpk" } }, cells: [{ cell_type: "code", source: "til 3", metadata: {}, outputs: [] }] }));
  assert.strictEqual(qnb.cells[0].language, undefined);
});

// --- parameters and the headless run

test("a parameters cell's assignments are its parameters", () => {
  assert.deepStrictEqual(parametersOf("/ @parameters\nd:2024.01.01;\nsyms:`EURUSD`GBPUSD / the pairs\n.cfg.n: 10\nf:{x}\nx::1\n/ a note"), [
    { name: "d", value: "2024.01.01" },
    { name: "syms", value: "`EURUSD`GBPUSD" },
    { name: ".cfg.n", value: "10" },
    { name: "f", value: "{x}" },
  ]);
  // A " /" inside a string is not a comment (#1118).
  assert.deepStrictEqual(parametersOf('path:"/data /hdb"; / where\nq:"a\\" /b"\nn:1 ;'), [
    { name: "path", value: '"/data /hdb"' },
    { name: "q", value: '"a\\" /b"' },
    { name: "n", value: "1" },
  ]);
  const cells = [{ kind: "markdown", source: "/ @parameters" }, { kind: "code", source: "1" }, { kind: "code", source: "/ @parameters\nn:1" }];
  assert.strictEqual(parametersCell(cells), 2);
  assert.strictEqual(parametersCell([{ kind: "code", source: "/ @parameters", language: "python" }]), -1);
});

test("given values go in a cell after the parameters cell, replacing an earlier run's", () => {
  const cells = [{ kind: "code", source: "a:1" }, { kind: "code", source: "/ @parameters\nn:1" }, { kind: "code", source: "n" }];
  const once = injectParameters(cells, { n: "5", s: "`x" });
  assert.deepStrictEqual(once[2], { kind: "code", source: "/ Parameters given to this run.\nn:5;\ns:`x;", metadata: { [INJECTED_KEY]: true } });
  const twice = injectParameters(once, { n: "6" });
  assert.strictEqual(twice.length, 4);
  assert.strictEqual(twice[2].source, "/ Parameters given to this run.\nn:6;");
  // No parameters cell: at the top. No values: none, and an old one goes.
  assert.strictEqual(injectParameters([{ kind: "code", source: "n" }], { n: "1" })[0].metadata[INJECTED_KEY], true);
  assert.deepStrictEqual(injectParameters(once, {}), cells);
});

/// An executor whose connection answers each statement list from `answer`,
/// recording the process each cell went to.
function fakeExecutor(answer) {
  const sent = [];
  const codes = [];
  return {
    sent,
    codes,
    on: async (label, code, use) => {
      sent.push(label ?? "default");
      codes.push(code);
      return use({
        query: async (cut) => answer(cut),
        call: async (lambda, arg) => (lambda.startsWith("{[es]") ? arg.map((e) => [true, `v(${e})`]) : answer(arg)),
        queryGrid: async () => ({ ok: true, type: 98, text: [] }),
      });
    },
  };
}
const SETTINGS = { consoleSize: [25, 80], rows: 1000, rowLimitFrom: "first" };

test("a headless run numbers and runs the q cells, reads live values, and goes where @process says", async () => {
  const qnb = {
    cells: [
      { kind: "markdown", source: "Top {{q: a}}" },
      { kind: "code", source: "/ @parameters\nn:1" },
      { kind: "code", source: "/ @process other\nn*2" },
      { kind: "markdown", source: "n is {{q: n}}", metadata: { keep: 1 } },
      { kind: "code", source: "print(1)", language: "python", outputs: [{ items: [{ mime: "text/plain", text: "1" }] }] },
    ],
  };
  const ex = fakeExecutor((cut) => ({ ok: true, type: -7, text: [cut.join(";")] }));
  const seen = [];
  const run = await runNotebook(qnb, ex, SETTINGS, { n: "5" }, { progress: (c, of) => seen.push(`${c}/${of}`) });
  assert.strictEqual(run.failed, undefined);
  assert.strictEqual(run.ran, 3);
  assert.deepStrictEqual(ex.sent, ["default", "default", "other"]);
  assert.deepStrictEqual(seen, ["2/6", "3/6", "4/6"]);
  const cells = run.qnb.cells;
  assert.strictEqual(cells[2].source, "/ Parameters given to this run.\nn:5;");
  assert.deepStrictEqual(cells.map((c) => c.execution?.order), [undefined, 1, 2, 3, undefined, undefined]);
  assert.deepStrictEqual(cells[0].metadata, { [LIVE_KEY]: { a: { text: "v(a)" } } });
  assert.deepStrictEqual(cells[4].metadata, { keep: 1, [LIVE_KEY]: { n: { text: "v(n)" } } });
  assert.deepStrictEqual(cells[3].outputs, [{ items: [{ mime: "text/plain", text: "n*2" }] }]);
  // A Python cell is left as it was.
  assert.deepStrictEqual(cells[5], qnb.cells[4]);
  // The notebook given is not changed.
  assert.strictEqual(qnb.cells.length, 5);
});

test("the guard reads a cell's live values' expressions with its source (#1088)", async () => {
  const markdown = ["Count {{q: count trade}}", "Gone {{q: delete from `trade}}", "Again {{q: count trade}}"];
  assert.strictEqual(guardedText("/ just a note", markdown), "/ just a note\ncount trade\ndelete from `trade");
  assert.deepStrictEqual(writes(guardedText("/ just a note", markdown)), ["deletes from `trade in place"]);
  assert.strictEqual(guardedText("1+1", []), "1+1");
  // A headless run hands the executor, which guards it, the same text.
  const qnb = { cells: [{ kind: "code", source: "1" }, { kind: "markdown", source: markdown[1] }] };
  const ex = fakeExecutor((cut) => ({ ok: true, type: -7, text: [cut.join(";")] }));
  await runNotebook(qnb, ex, SETTINGS);
  assert.deepStrictEqual(ex.codes, ["1\ndelete from `trade"]);
});

test("a headless run stops at the first cell that fails, and clears what the cells after it showed", async () => {
  const qnb = {
    cells: [
      { kind: "code", source: "1+`a" },
      { kind: "code", source: "2", execution: { order: 9 }, outputs: [{ items: [{ mime: "text/plain", text: "stale" }] }] },
    ],
  };
  const ex = fakeExecutor((cut) => (cut[0] === "1+`a" ? { ok: false, error: "type", trace: "" } : { ok: true, type: -7, text: ["2"] }));
  const run = await runNotebook(qnb, ex, SETTINGS);
  assert.deepStrictEqual(run.failed, { cell: 1, message: "'type" });
  assert.strictEqual(run.qnb.cells[0].execution.success, false);
  assert.strictEqual(JSON.parse(run.qnb.cells[0].outputs[0].items[0].text).message, "'type");
  assert.strictEqual(run.qnb.cells[1].outputs, undefined);
  assert.strictEqual(run.qnb.cells[1].execution, undefined);
  // A process that cannot be had fails its cell with why.
  const refused = await runNotebook({ cells: [{ kind: "code", source: "1" }] }, { on: async () => { throw new Error("no such process"); } }, SETTINGS);
  assert.deepStrictEqual(refused.failed, { cell: 1, message: "no such process" });
  await assert.rejects(runNotebook(qnb, ex, SETTINGS, { "1x": "1" }), /not a q name/);
  await assert.rejects(runNotebook(qnb, ex, SETTINGS, { x: "1\n2" }), /one line of q/);
});

test("a run is written as its target's extension says", () => {
  const qnb = { cells: [{ kind: "code", source: "1" }] };
  assert.match(writeAs(qnb, "/a/run.HTML", "n.qnb"), /^<!doctype html>/);
  assert.strictEqual(JSON.parse(writeAs(qnb, "run.ipynb", "n.qnb")).nbformat, 4);
  assert.strictEqual(parseQnb(writeAs(qnb, "run.qnb", "n.qnb")).cells.length, 1);
});

test("the command line reads its options, and refuses what it cannot run", () => {
  const o = parseArgs(["nb.qnb", "--process", "localhost:5001", "-p", "n", "5", "--param", "d", "2024.01.02", "--row-limit", "0", "--rows-from", "last"]);
  assert.strictEqual(o.output, "nb.out.qnb");
  assert.deepStrictEqual(o.params, { n: "5", d: "2024.01.02" });
  assert.strictEqual(o.rowLimit, 0);
  assert.strictEqual(o.rowsFrom, "last");
  assert.deepStrictEqual(parseArgs(["-h"]), { help: true });
  assert.match(parseArgs(["nb.qnb"]).error, /--process is needed/);
  assert.match(parseArgs(["--process", "h:1"]).error, /no notebook/);
  assert.match(parseArgs(["a.qnb", "b.qnb", "--process", "h:1"]).error, /one notebook at a time/);
  assert.match(parseArgs(["a.qnb", "--process", "h:1", "-p", "n"]).error, /needs a value/);
  assert.match(parseArgs(["a.qnb", "--process", "h:1", "--password", "x"]).error, /unknown option --password/);
  assert.match(parseArgs(["a.qnb", "--process", "h:1", "-p", "a b", "1"]).error, /not a q name/);
});

test("the command line names a process by host:port or by a listed label, and reads a password from the environment", () => {
  const listed = [{ label: "rdb", host: "h", port: 1, tags: ["prod"], user: "u" }];
  assert.strictEqual(cliProcess("rdb", listed), listed[0]);
  assert.deepStrictEqual(cliProcess("[::1]:5001", [], "me", true), { label: "[::1]:5001", host: "::1", port: 5001, tags: [], user: "me", tls: true });
  assert.match(cliProcess("rdb", []).error, /pass --processes/);
  assert.match(cliProcess("hdb", listed).error, /The labels are: rdb/);
  // A tunnelled or scripted process is refused, not dialled at its host (#1401).
  assert.match(cliProcess("t", [{ label: "t", host: "localhost", port: 5000, tags: [], ssh: "bastion" }]).error, /t needs an SSH tunnel \(ssh\), which qnbrun does not run/);
  assert.match(cliProcess("s", [{ label: "s", host: "h", port: 1, tags: [], initFile: "c.q" }]).error, /a connect script/);
  assert.strictEqual(passwordVariable("desk/rdb-1"), "QLINT_Q_PASSWORD_DESK_RDB_1");
});

// --- the variables view's data

test("the variables lambda's answer is read, nulls as nothing", () => {
  const { variables, total } = readVariables({ names: ["t", "f", "d", "sp"], types: [98, 100, -14, 98], counts: [3, 1, 1, 7], sizes: [138, null, 13, NaN], total: 4 });
  assert.strictEqual(total, 4);
  assert.deepStrictEqual(variables, [
    { name: "t", type: 98, count: 3, size: 138 },
    { name: "f", type: 100, count: 1 },
    { name: "d", type: -14, count: 1, size: 13 },
    { name: "sp", type: 98, count: 7 },
  ]);
  assert.deepStrictEqual(readVariables({ names: "a", types: 7, counts: 2, sizes: 30, total: 1 }).variables, [{ name: "a", type: 7, count: 2, size: 30 }]);
  assert.throws(() => readVariables("x"), /globals/);
  assert.match(VARS, /^\{\[lim\]/);
});

test("a variable is described by its kind, count and size", () => {
  assert.strictEqual(describeVariable({ name: "t", type: 98, count: 1500, size: 2048 }), "table · 1,500 rows · 2.0 KB");
  assert.strictEqual(describeVariable({ name: "x", type: 7, count: 3, size: 38 }), "long list · 3 items · 38 B");
  assert.strictEqual(describeVariable({ name: "s", type: -11, count: 1, size: 13 }), "symbol · 13 B");
  assert.strictEqual(describeVariable({ name: "b", type: 10, count: 3, size: 17 }), "string · 3 items · 17 B");
  assert.strictEqual(describeVariable({ name: "f", type: 100, count: 1 }), "function");
  assert.strictEqual(bytesText(5 * 1024 * 1024 * 1024), "5.0 GB");
});

test("package.json contributes the commands, the variables view and their menus", () => {
  const commands = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
  for (const id of [NOTEBOOK.exportHtmlCommand, NOTEBOOK.exportIpynbCommand, NOTEBOOK.importIpynbCommand, NOTEBOOK.runWithParameters, NOTEBOOK.refreshVariables]) {
    assert.strictEqual(commands.get(id)?.category, "q-lint", id);
  }
  const view = pkg.contributes.views["q-lint"].find((v) => v.id === NOTEBOOK.variablesView);
  assert.strictEqual(view.when, "q-lint.notebookActive && config.q-lint.notebook.variables.enable");
  assert.ok(pkg.contributes.menus["view/title"].some((m) => m.command === NOTEBOOK.refreshVariables && m.when.startsWith(`view == ${NOTEBOOK.variablesView} && config.q-lint.notebook.variables.enable`)));
  assert.ok(pkg.contributes.menus["explorer/context"].some((m) => m.command === NOTEBOOK.importIpynbCommand && /ipynb/.test(m.when)));
  const toolbar = pkg.contributes.menus["notebook/toolbar"].filter((m) => m.when.startsWith("notebookType == q-lint-notebook")).map((m) => m.command);
  for (const id of [NOTEBOOK.exportHtmlCommand, NOTEBOOK.exportIpynbCommand, NOTEBOOK.runWithParameters]) {
    assert.ok(toolbar.includes(id), id);
  }
});

test("a line opening with a code span is text, not a fence (#1307)", () => {
  assert.strictEqual(markdownHtml("```a``` is q\n\nnext"), "<p><code>a</code> is q</p>\n<p>next</p>");
  assert.strictEqual(markdownHtml("```q\nx\n```"), "<pre><code>x</code></pre>");
});

test("a fence closes only on a bare run of its own character, at least as long (#1308)", () => {
  assert.strictEqual(markdownHtml("````\n```q\nx\n```\n````\nafter"), "<pre><code>```q\nx\n```</code></pre>\n<p>after</p>");
  assert.strictEqual(markdownHtml("```\n```q\n~~~\n```"), "<pre><code>```q\n~~~</code></pre>");
});

test("a backslash escapes any ASCII punctuation (#1310)", () => {
  assert.strictEqual(markdownHtml("\\<b\\> a\\|b \\& \\~ \\$ \\*x\\*"), "<p>&lt;b&gt; a|b &amp; ~ $ *x*</p>");
  assert.strictEqual(markdownHtml("a\\b"), "<p>a\\b</p>");
});

test("an ordered list keeps its start, and only a 1. or a bullet interrupts a paragraph (#1311)", () => {
  assert.strictEqual(markdownHtml("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.strictEqual(markdownHtml("0. z"), '<ol start="0"><li>z</li></ol>');
  assert.strictEqual(markdownHtml("it ran in\n2024. and then"), "<p>it ran in<br>\n2024. and then</p>");
  assert.strictEqual(markdownHtml("text\n1. one"), "<p>text</p>\n<ol><li>one</li></ol>");
  assert.strictEqual(markdownHtml("text\n- one"), "<p>text</p>\n<ul><li>one</li></ul>");
});

test("a GFM table, as a result is written into a notebook, is a table (#1309)", () => {
  assert.strictEqual(
    markdownHtml("| a | n |\n| --- | ---: |\n| x\\|y | 1 |\n| &lt;b&gt; |\n\nafter"),
    '<table><thead><tr><th>a</th><th style="text-align:right">n</th></tr></thead>' +
      '<tbody><tr><td>x|y</td><td style="text-align:right">1</td></tr><tr><td>&lt;b&gt;</td><td style="text-align:right"></td></tr></tbody></table>\n<p>after</p>',
  );
  // Not a table: the delimiter row has a different count of cells.
  assert.strictEqual(markdownHtml("a | b | c\n--- | ---"), "<p>a | b | c<br>\n--- | ---</p>");
  const { resultMarkdown } = require("../out/resultreport.js");
  const md = resultMarkdown({ at: 0, process: "dev", code: "t", decimals: 2, payload: { count: 1, keys: 0, names: ["s"], types: [11], cells: [["<a>"]], raw: [[]], rank: [[0]] } }).text;
  assert.match(markdownHtml(md), /<table><thead><tr><th>s<\/th><\/tr><\/thead><tbody><tr><td>&lt;a&gt;<\/td><\/tr><\/tbody><\/table>/);
});

test("a PyKX %%q cell with options imports as q, its options a comment (#1267)", () => {
  const cell = (source) => ({ cell_type: "code", metadata: {}, source, outputs: [] });
  const nb = { nbformat: 4, metadata: { kernelspec: { language: "python" } }, cells: [cell("%%q --port 5000\ntil 3"), cell("%%q  \n1"), cell("%%qx\n1")] };
  const qnb = fromIpynb(JSON.stringify(nb));
  assert.deepStrictEqual(qnb.cells.map((c) => [c.language, c.source]), [
    [undefined, "/ %%q --port 5000\ntil 3"],
    [undefined, "1"],
    ["python", "%%qx\n1"],
  ]);
});

test("a failed run drops the live values of the Markdown after the cells it did not run (#1544)", async () => {
  const stale = { [LIVE_KEY]: { y: { text: "999 (from last week)" } } };
  const qnb = {
    cells: [
      { kind: "code", source: "x:1" },
      { kind: "code", source: "'boom" },
      { kind: "markdown", source: "after the failure {{q: y}}", metadata: { keep: 1, ...stale } },
      { kind: "code", source: "y:2" },
      { kind: "markdown", source: "y is {{q: y}}", metadata: stale },
    ],
  };
  const ex = fakeExecutor((cut) => (cut[0] === "'boom" ? { ok: false, error: "boom", trace: "" } : { ok: true, type: -7, text: ["1"] }));
  const run = await runNotebook(qnb, ex, SETTINGS);
  assert.deepStrictEqual(run.failed, { cell: 2, message: "'boom" });
  assert.deepStrictEqual(run.qnb.cells[2].metadata, { keep: 1 });
  assert.deepStrictEqual(run.qnb.cells[4].metadata, {});
  assert.doesNotMatch(toHtml(run.qnb, "n"), /from last week/);
});
