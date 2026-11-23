// The Data Wrangler (#961), data files (#962), the CSV load wizard (#963),
// cell edits (#964), table templates (#965) and the schema diagram (#966)
// through the stand-in `vscode` (vscode_stub.js), with a stand-in `Live`
// that records what would be sent: what each command asks, what it sends
// and where, and each turned off refusing and sending nothing.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const opened = [];
vscode.workspace.openTextDocument = async (what) => (opened.push(what), what);
vscode.window.showTextDocument = async () => {};
let dialog;
vscode.window.showOpenDialog = async () => dialog;
const written = {};
vscode.workspace.fs = { writeFile: async (uri, bytes) => void (written[uri.fsPath] = Buffer.from(bytes).toString("utf8")) };
let clipboard;
vscode.env = { clipboard: { writeText: async (t) => void (clipboard = t) } };
const panels = [];
vscode.window.createWebviewPanel = (type, title) => {
  const panel = {
    type,
    title,
    disposed: false,
    webview: { html: "", cspSource: "vscode-resource:", asWebviewUri: (u) => u },
    reveal() {},
    onDidDispose: (f) => ((panel.onDispose = f), { dispose() {} }),
    dispose() {
      panel.disposed = true;
      panel.onDispose?.();
    },
  };
  panels.push(panel);
  return panel;
};
vscode.ViewColumn = { Active: -1 };

const { ResultTools } = require("../out/resulttools.js");
const { SchemaTools } = require("../out/schemaview.js");
const { RESULT_VIEW } = require("../out/liveconfig.js");
const { DATA_FILES, INLINE_BYTES, fileHandle } = require("../out/datafile.js");
const { SCHEMA, SCHEMA_COMMANDS } = require("../out/schema.js");
const { TABLE_INFO } = require("../out/tableinfo.js");

const payload = {
  count: 2,
  keys: 0,
  names: ["sym", "px"],
  types: [11, 9],
  cells: [["a", "b"], ["1.5", "2"]],
  raw: [[], [1.5, 2]],
  rank: [],
};

/// A stand-in for `Live`: the result on show, the process connected, and
/// what was run, how.
function fakeLive(over = {}) {
  const live = {
    ran: [],
    sent: [],
    shown: { process: "rdb", code: "select from t", payload },
    process: { label: "rdb", host: "localhost", port: 5000, tags: [] },
    resultOnShow: () => live.shown,
    runOnProcess: async (code, label, options) => void live.ran.push({ code, label, options }),
    run: async (code, as, serverTypes, mode) => void live.ran.push({ code, mode }),
    activeProcess: () => live.process,
    activeLabel: () => live.process?.label,
    connectTo: async () => false,
    answers: {},
    borrow: (use) =>
      live.process === undefined
        ? undefined
        : use(
            {
              call: async (lambda, ...args) => {
                const name = lambda === TABLE_INFO ? "TABLE_INFO" : lambda === SCHEMA ? "SCHEMA" : "?";
                live.sent.push([name, ...args]);
                return live.answers[name];
              },
            },
            live.process,
          ),
    ...over,
  };
  return live;
}

function setUp(config = {}, over = {}) {
  stub.reset();
  opened.length = 0;
  panels.length = 0;
  Object.assign(stub.config.user, config);
  const context = stub.newContext();
  const live = fakeLive(over);
  const tools = new ResultTools(context, live);
  const schema = new SchemaTools(context, live);
  return { live, tools, schema, context };
}

const run = (command, ...args) => stub.commands.get(command)(...args);
const infos = () => stub.messages.filter((m) => m[0] === "info").map((m) => m[1]);

test("Wrangle Result applies a step over the result's query on its process, in the grid, and goes on from there (#961)", async () => {
  const { live, tools } = setUp();
  stub.picks.push("$(filter) Filter rows...", "px", ">");
  stub.inputs.push((options) => {
    // The value starts as the first row's literal.
    assert.strictEqual(options.value, "1.5f");
    return "1";
  });
  await run(RESULT_VIEW.wrangle);
  const first = "select from (select from t) where px>1";
  assert.deepStrictEqual(live.ran, [{ code: first, label: "rdb", options: { what: "wrangle query", mode: "grid" } }]);
  assert.strictEqual(tools.wrangleSteps("rdb", first).length, 1);
  // Its answer on show, a column header's menu sorts it: no column asked.
  live.shown = { process: "rdb", code: first, payload };
  stub.picks.push("$(list-ordered) Sort...", "Descending");
  await run(RESULT_VIEW.wrangleColumn, { webviewSection: "column", column: 1 });
  const second = "`px xdesc (select from (select from t) where px>1)";
  assert.strictEqual(live.ran.at(-1).code, second);
  live.shown = { process: "rdb", code: second, payload };
  stub.picks.push("$(code) Show steps as q");
  await run(RESULT_VIEW.wrangle);
  assert.deepStrictEqual(opened.at(-1), { language: "q", content: "/ Wrangled on rdb by q-lint: 2 steps\n{[]\n  w:select from t;\n  w:select from w where px>1;\n  w:`px xdesc w;\n  w}[]\n" });
  stub.picks.push("$(discard) Undo last step");
  await run(RESULT_VIEW.wrangle);
  assert.strictEqual(live.ran.at(-1).code, first);
  stub.picks.push("$(clear-all) Start over");
  await run(RESULT_VIEW.wrangle);
  assert.strictEqual(live.ran.at(-1).code, "select from t");
  // Rename and cast and drop, each from the column's menu.
  live.shown = { process: "rdb", code: "t", payload };
  stub.picks.push("$(edit) Rename column...");
  stub.inputs.push((options) => (assert.strictEqual(options.validateInput("sym"), "The result has a column sym already"), assert.match(options.validateInput("a b"), /plain q name/), "price"));
  await run(RESULT_VIEW.wrangleColumn, { column: 1 });
  assert.strictEqual(live.ran.at(-1).code, "(enlist[`px]!enlist `price) xcol (t)");
  stub.picks.push("$(symbol-type-parameter) Cast column...", "long");
  await run(RESULT_VIEW.wrangleColumn, { column: 1 });
  assert.strictEqual(live.ran.at(-1).code, 'update px:"j"$px from (t)');
  stub.picks.push("$(trash) Drop column");
  await run(RESULT_VIEW.wrangleColumn, { column: 0 });
  assert.strictEqual(live.ran.at(-1).code, "delete sym from (t)");
});

test("a result of a script cannot be wrangled; Escape sends nothing; turned off, the commands refuse (#961)", async () => {
  const { live } = setUp();
  live.shown = { process: "rdb", code: "a:1\nselect from t", payload };
  await run(RESULT_VIEW.wrangle);
  assert.match(infos().at(-1), /cannot be wrangled: the query has more than one statement/);
  live.shown = { process: "rdb", code: "t", payload };
  stub.picks.push(undefined);
  await run(RESULT_VIEW.wrangle);
  live.shown = undefined;
  await run(RESULT_VIEW.wrangle);
  assert.match(infos().at(-1), /no result yet/);
  assert.deepStrictEqual(live.ran, []);
  const off = setUp({ "results.wrangler.enable": false });
  await run(RESULT_VIEW.wrangle);
  await run(RESULT_VIEW.wrangleColumn, { column: 0 });
  assert.deepStrictEqual(infos(), [
    "q-lint: this result panel feature is turned off. Turn it on with the setting q-lint.results.wrangler.enable.",
    "q-lint: this result panel feature is turned off. Turn it on with the setting q-lint.results.wrangler.enable.",
  ]);
  assert.deepStrictEqual(off.live.ran, []);
});

test("Edit Cell writes the update, shows it, and sends it only on Run, past no production question of its own (#964)", async () => {
  const { live } = setUp();
  stub.inputs.push((options) => (assert.strictEqual(options.value, "t"), "t"), (options) => (assert.strictEqual(options.value, "2f"), "9.5"));
  stub.picks.push((options) => {
    assert.strictEqual(options.message, "Update t on rdb?");
    assert.match(options.items[0].detail, /^update px:\(9\.5\) from `t where \(sym=`b\),\(px~\\:\(2f\)\)\n\nEvery row of t whose sym, px are as in this one is changed/);
    return "Run";
  });
  await run(RESULT_VIEW.editCell, { webviewSection: "cell", column: 1, row: 1 });
  assert.deepStrictEqual(live.ran, [{ code: "update px:(9.5) from `t where (sym=`b),(px~\\:(2f))", label: "rdb", options: { what: "cell edit", askProduction: false } }]);
  // Open in Editor sends nothing; Escape neither.
  stub.inputs.push("t", "1");
  stub.picks.push("Open in Editor");
  await run(RESULT_VIEW.editCell, { column: 1, row: 0 });
  assert.match(opened.at(-1).content, /^\/ An edit of px on rdb, written by q-lint: review it, then run it\.\nupdate px:\(1\) from `t/);
  stub.inputs.push("t", "1");
  stub.picks.push(undefined);
  await run(RESULT_VIEW.editCell, { column: 1, row: 0 });
  stub.inputs.push(undefined);
  await run(RESULT_VIEW.editCell, { column: 1, row: 0 });
  assert.strictEqual(live.ran.length, 1);
  const off = setUp({ "results.editCells.enable": false });
  await run(RESULT_VIEW.editCell, { column: 1, row: 0 });
  assert.match(infos().at(-1), /q-lint\.results\.editCells\.enable/);
  assert.deepStrictEqual(off.live.ran, []);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-files-"));
const csv = path.join(tmp, "trades.csv");
fs.writeFileSync(csv, "sym,px,qty\nAAPL,1.5,10\nMSFT,2,20\n");

test("Open Data File in Grid loads a file by its path on a process here, by its lines elsewhere, always in the grid (#962)", async () => {
  const { live } = setUp();
  await run(DATA_FILES.open, vscode.Uri.file(csv));
  assert.deepStrictEqual(live.ran, [{ code: `("SFJ";enlist ",")0:${fileHandle(csv)}`, mode: "grid" }]);
  live.process = { label: "far", host: "db1", port: 5000, tags: [] };
  await run(DATA_FILES.open, vscode.Uri.file(csv));
  assert.deepStrictEqual(live.ran.at(-1), { code: '("SFJ";enlist ",")0:("sym,px,qty";"AAPL,1.5,10";"MSFT,2,20")', mode: "grid" });
  // Through an SSH tunnel to localhost: elsewhere all the same.
  live.process = { label: "tunnel", host: "localhost", port: 5000, tags: [], ssh: "bastion" };
  await run(DATA_FILES.open, vscode.Uri.file(csv));
  assert.match(live.ran.at(-1).code, /0:\("sym,px,qty"/);
  const big = path.join(tmp, "big.csv");
  fs.writeFileSync(big, `a,b\n${"1,2\n".repeat(INLINE_BYTES / 4 + 1)}`);
  await run(DATA_FILES.open, vscode.Uri.file(big));
  assert.match(stub.messages.at(-1)[1], /cannot read big\.csv by its path, and the file is too large/);
  await run(DATA_FILES.open, vscode.Uri.file(path.join(tmp, "t.parquet")));
  assert.match(infos().at(-1), /is not a CSV, TSV or JSON file/);
  assert.strictEqual(live.ran.length, 3);
  // Not connected, and the user picks no process: nothing.
  live.process = undefined;
  await run(DATA_FILES.open, vscode.Uri.file(csv));
  assert.strictEqual(live.ran.length, 3);
  const off = setUp({ "dataFiles.open.enable": false });
  await run(DATA_FILES.open, vscode.Uri.file(csv));
  assert.match(infos().at(-1), /Open Data File in Grid is turned off\. Turn it on with the setting q-lint\.dataFiles\.open\.enable/);
  assert.deepStrictEqual(off.live.ran, []);
});

test("the CSV load wizard shows the guessed types, takes a change, writes the statement, and runs it only on Run (#963)", async () => {
  const { live } = setUp();
  stub.picks.push(
    (options) => {
      assert.deepStrictEqual(options.items.map((i) => [i.label, i.description]), [
        ["$(check) Done", '("SFJ";enlist ...)0:'],
        ["$(split-horizontal) Delimiter", "comma"],
        ["sym", "S symbol"],
        ["px", "F float"],
        ["qty", "J long"],
      ]);
      return "qty";
    },
    "F",
    "sym",
    "(space)",
    (options) => (assert.strictEqual(options.items[0].description, '(" FF";enlist ...)0:'), "$(check) Done"),
    "Run",
  );
  stub.inputs.push((options) => (assert.strictEqual(options.value, "trades"), "tr"));
  await run(DATA_FILES.wizard, vscode.Uri.file(csv));
  const statement = `tr:(" FF";enlist ",")0:${fileHandle(csv)}`;
  assert.match(opened.at(-1).content, new RegExp(`^/ Load trades\\.csv as tr, written by q-lint's CSV load wizard\\.\\n.*\\n${statement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n$`));
  assert.deepStrictEqual(live.ran, [{ code: statement, label: "rdb", options: { what: "load statement" } }]);
  // Not Run: written, not sent.
  stub.picks.push("$(check) Done", undefined);
  stub.inputs.push("tr");
  await run(DATA_FILES.wizard, vscode.Uri.file(csv));
  assert.strictEqual(live.ran.length, 1);
  // A file picked from the dialog, or none.
  dialog = undefined;
  await run(DATA_FILES.wizard);
  assert.strictEqual(live.ran.length, 1);
  const off = setUp({ "dataFiles.loadWizard.enable": false });
  await run(DATA_FILES.wizard, vscode.Uri.file(csv));
  assert.match(infos().at(-1), /q-lint\.dataFiles\.loadWizard\.enable/);
  assert.deepStrictEqual(off.live.ran, []);
});

test("the CSV load wizard runs on the process it asked about, even when another became active meanwhile (#1293)", async () => {
  const { live } = setUp();
  stub.picks.push("$(check) Done", (options) => (assert.match(options.message ?? options, /on rdb\?/), (live.process = { label: "other", host: "localhost", port: 5001, tags: [] }), "Run"));
  stub.inputs.push("tr");
  await run(DATA_FILES.wizard, vscode.Uri.file(csv));
  assert.deepStrictEqual(live.ran.map((r) => r.label), ["rdb"]);
});

const tableInfo = {
  kind: "table",
  rows: 2,
  bytes: 10,
  partitions: null,
  keys: [],
  ncols: 2,
  cols: ["sym", "px"],
  types: ["s", "f"],
  fkeys: ["", ""],
  attrs: ["", ""],
};

test("Table Templates reads the table, runs a read picked and opens the insert template unsent (#965)", async () => {
  const { live } = setUp();
  live.answers.TABLE_INFO = tableInfo;
  stub.picks.push((options) => (assert.deepStrictEqual(options.items.map((i) => i.label), ["Select first 100", "meta", "Insert template"]), "meta"));
  await run(SCHEMA_COMMANDS.templates, { kind: "table", label: "trade", name: "trade" });
  assert.deepStrictEqual(live.sent, [["TABLE_INFO", "trade", 500]]);
  assert.deepStrictEqual(live.ran, [{ code: "meta trade", mode: undefined }]);
  stub.picks.push("Insert template");
  await run(SCHEMA_COMMANDS.templates, { kind: "table", label: "trade", name: "trade" });
  assert.match(opened.at(-1).content, /^\/ One row for trade/);
  assert.strictEqual(live.ran.length, 1);
  await run(SCHEMA_COMMANDS.templates, { kind: "function", name: "f" });
  assert.match(infos().at(-1), /works on a table of the Process Explorer/);
  const off = setUp({ "processExplorer.tableTemplates.enable": false });
  await run(SCHEMA_COMMANDS.templates, { kind: "table", label: "trade", name: "trade" });
  assert.match(infos().at(-1), /Table Templates is turned off\. Turn it on with the setting q-lint\.processExplorer\.tableTemplates\.enable/);
  assert.deepStrictEqual([off.live.sent, off.live.ran], [[], []]);
});

test("Show Schema Diagram draws the tables and links in a panel with no script; it saves as SVG, copies as Mermaid, and closes when turned off (#966)", async () => {
  const { live, schema } = setUp();
  live.answers.SCHEMA = [
    ["s", "t", "bad"],
    [
      { ...tableInfo, kind: "keyed", keys: ["sym"], cols: ["sym", "nm"], types: ["s", "C"] },
      { ...tableInfo, fkeys: ["s", ""] },
      "type",
    ],
  ];
  await run(SCHEMA_COMMANDS.diagram);
  assert.deepStrictEqual(live.sent, [["SCHEMA", "q Q h j o s", 80, 40]]);
  assert.deepStrictEqual(schema.state(), { process: "rdb", tables: ["s", "t"], links: ["t.sym->s (foreign key)"], failed: ["bad"], svgBytes: schema.state().svgBytes });
  const html = panels[0].webview.html;
  assert.match(html, /default-src 'none'; style-src vscode-resource:; img-src vscode-resource:;/);
  assert.ok(!/<script/.test(html));
  assert.match(html, /2 tables on rdb, 1 link\./);
  assert.match(html, /Not read: bad \(type\)/);
  assert.match(html, /<svg xmlns/);
  const target = vscode.Uri.file(path.join(tmp, "schema.svg"));
  await run(SCHEMA_COMMANDS.saveSvg, target);
  assert.match(written[target.fsPath], /^<svg[^>]*>\n<style>\.box\{/);
  await run(SCHEMA_COMMANDS.mermaid);
  assert.match(clipboard, /^erDiagram\n/);
  // Turned off: the panel is closed, and the commands refuse.
  stub.config.user["processExplorer.schemaDiagram.enable"] = false;
  stub.changeConfig("q-lint.processExplorer.schemaDiagram.enable");
  assert.strictEqual(panels[0].disposed, true);
  assert.strictEqual(schema.state(), undefined);
  const sent = live.sent.length;
  await run(SCHEMA_COMMANDS.diagram);
  await run(SCHEMA_COMMANDS.mermaid);
  assert.match(infos().at(-1), /the schema diagram is turned off\. Turn it on with the setting q-lint\.processExplorer\.schemaDiagram\.enable/);
  assert.strictEqual(live.sent.length, sent);
  // Not connected: says so, reads nothing.
  const none = setUp({}, { process: undefined });
  await run(SCHEMA_COMMANDS.diagram);
  assert.match(infos().at(-1), /connect to a q process first/);
  assert.deepStrictEqual(none.live.sent, []);
});
