// The result panel's extension side for #1012-#1021 (src/resultpanel.ts),
// under a stand-in `vscode`: the look sent with a result and kept per tab
// and per saved query, the column commands, chart presets, the
// correlation view, and sending a result to a notebook or a report. Each
// feature also turned off: its command refuses, the page is offered none
// of it, and nothing is kept, written or sent. And what package.json
// contributes for each.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const pkg = require("../package.json");

const OFF = (feature) => `q-lint: this result panel feature is turned off. Turn it on with the setting q-lint.results.${feature}.enable.`;

/// A stand-in `vscode`, fresh for each test: settings from `config`; the
/// answers quick picks, input boxes and modal messages give, in turn.
function fakeVscode(config = {}) {
  const pages = [];
  const listeners = { config: [] };
  const said = [];
  const files = {};
  const answers = { picks: [], inputs: [], warnings: [], infos: [] };
  const commandsRun = [];
  const state = new Map();
  const edits = [];
  const disposable = { dispose() {} };
  class Uri {
    constructor(path) {
      this.path = path;
      this.fsPath = path;
    }
    static joinPath(base, ...parts) {
      const all = [base.path, ...parts].join("/").split("/");
      const out = [];
      for (const p of all) {
        if (p === "..") out.pop();
        else if (p !== "" || out.length === 0) out.push(p);
      }
      return new Uri(out.join("/") || "/");
    }
    static parse(text) {
      return new Uri(text);
    }
    toString() {
      return this.path;
    }
  }
  const makeWebview = () => {
    const webview = {
      posted: [],
      html: "",
      options: {},
      cspSource: "vscode-resource:",
      asWebviewUri: (u) => u,
      postMessage(m) {
        webview.posted.push(JSON.parse(JSON.stringify(m)));
        return Promise.resolve(true);
      },
      onDidReceiveMessage(f) {
        webview.receive = f;
        return disposable;
      },
    };
    return webview;
  };
  const notebook = (path, cells) => ({ uri: new Uri(path), notebookType: "q-lint-notebook", cellCount: cells });
  const vscode = {
    Uri,
    ViewColumn: { Beside: -2 },
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookCellData: class {
      constructor(kind, value, languageId) {
        Object.assign(this, { kind, value, languageId });
      }
    },
    NotebookEdit: { insertCells: (index, cells) => ({ index, cells }) },
    WorkspaceEdit: class {
      set(uri, list) {
        this.uri = uri;
        this.list = list;
      }
    },
    commands: {
      registerCommand: (id, f) => {
        vscode.commands[id] = f;
        return disposable;
      },
      executeCommand: async (id, ...args) => {
        commandsRun.push([id, ...args]);
        if (id === "q-lint.saveQuery" && answers.savedAs !== undefined) {
          state.set("q-lint.savedQueries", [...(state.get("q-lint.savedQueries") ?? []), { name: answers.savedAs, code: args[0].code }]);
        }
      },
    },
    env: { clipboard: { writeText: async () => {} } },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerWebviewViewProvider: () => disposable,
      createWebviewPanel: () => {
        const panel = { webview: makeWebview(), reveal() {}, dispose() {}, onDidDispose: () => disposable };
        pages.push(panel.webview);
        return panel;
      },
      showInformationMessage: async (m, ...items) => {
        said.push(m);
        return answers.infos.shift();
      },
      showWarningMessage: async (m, options, ...items) => {
        said.push(m);
        if (options && options.detail) said.push(options.detail);
        return answers.warnings.shift();
      },
      showErrorMessage: async (m) => said.push(m),
      showQuickPick: async (items) => {
        const want = answers.picks.shift();
        const list = await items;
        return typeof want === "function" ? list.find(want) : want === undefined ? undefined : list.find((i) => i.label === want);
      },
      showInputBox: async (options) => {
        const v = answers.inputs.shift();
        if (v !== undefined && options.validateInput) {
          const problem = options.validateInput(v);
          if (problem) throw new Error(`invalid input ${v}: ${problem}`);
        }
        return v;
      },
      showSaveDialog: async () => answers.saveTo,
      showOpenDialog: async () => answers.openTo,
      visibleNotebookEditors: [],
    },
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => (key in config ? config[key] : fallback),
        inspect: () => ({}),
        update: async () => {},
      }),
      onDidChangeConfiguration: (f) => {
        listeners.config.push(f);
        return disposable;
      },
      workspaceFolders: undefined,
      notebookDocuments: [],
      applyEdit: async (edit) => {
        edits.push(edit);
        return true;
      },
      fs: {
        writeFile: async (uri, bytes) => {
          files[uri.path] = Buffer.from(bytes).toString("utf8");
        },
        readFile: async (uri) => {
          if (!(uri.path in files)) throw new Error("ENOENT");
          return Buffer.from(files[uri.path], "utf8");
        },
        readDirectory: async (uri) => {
          const prefix = `${uri.path}/`;
          const names = Object.keys(files).filter((p) => p.startsWith(prefix)).map((p) => [p.slice(prefix.length), 1]);
          if (names.length === 0) throw new Error("ENOENT");
          return names;
        },
        createDirectory: async () => {},
      },
    },
  };
  const context = {
    extensionUri: new Uri("/ext"),
    subscriptions: [],
    workspaceState: { get: (k, d) => (state.has(k) ? JSON.parse(JSON.stringify(state.get(k))) : d), update: async (k, v) => void state.set(k, JSON.parse(JSON.stringify(v))) },
  };
  return { vscode, pages, listeners, said, files, answers, commandsRun, state, edits, context, config, notebook };
}

function loadModes(fake) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "vscode" ? fake.vscode : load.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (/[\\/]out[\\/]/.test(key)) {
        delete require.cache[key];
      }
    }
    const { QueryModes } = require("../out/resultpanel.js");
    return new QueryModes(fake.context);
  } finally {
    Module._load = load;
  }
}

/// A GRID payload of named columns, each [name, type, cells, raw].
const payload = (columns) => ({
  count: columns[0][2].length,
  keys: 0,
  names: columns.map((c) => c[0]),
  types: columns.map((c) => c[1]),
  cells: columns.map((c) => c[2]),
  raw: columns.map((c) => c[3] ?? []),
  rank: columns.map((c) => c[2].map((_, i) => i)),
});
const COLUMNS = [["sym", 11, ["a", "b", "c"]], ["px", 9, ["1", "5", "9"], [1, 5, 9]], ["v", 0, ["1 2", "3 4", ",5"]]];
const result = (code = "select from t", columns = COLUMNS) => ({ process: "p", code, millis: 1, answer: { ok: true, type: 98, text: [], grid: payload(columns) } });
const live = { mode: "grid", resultsLocation: "editor", gridLimit: 10000, gridDecimals: -1 };
const tick = () => new Promise((r) => setImmediate(r));
const last = (fake) => fake.pages[0].posted.at(-1);

test("a conditional format is built from the column's menu and its picks, sent with the result, and dropped again (#1013)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result(), live);
  fake.answers.picks.push(">", "Red background");
  fake.answers.inputs.push("4");
  await fake.vscode.commands["q-lint.addResultConditionalFormat"]({ webviewSection: "column", column: 1 });
  assert.deepStrictEqual(last(fake).look.rules, [{ column: "px", op: ">", value: 4, style: { background: "red" } }]);
  // A text column is offered only the comparisons of text.
  fake.answers.picks.push((i) => {
    assert.ok(!["top", ">"].includes(i.label));
    return i.label === "contains";
  }, "Bold");
  fake.answers.inputs.push("b");
  await fake.vscode.commands["q-lint.addResultConditionalFormat"]("sym");
  assert.deepStrictEqual(last(fake).look.rules.at(-1), { column: "sym", op: "contains", value: "b", style: { bold: true } });
  // A rule given whole, as a keybinding can.
  await fake.vscode.commands["q-lint.addResultConditionalFormat"]({ column: 1 }, { op: "top", value: 1, style: { color: "green" } });
  assert.strictEqual(last(fake).look.rules.length, 3);
  await fake.vscode.commands["q-lint.addResultConditionalFormat"]({ column: 0 }, { op: "top", value: 1, style: { color: "green" } });
  assert.match(fake.said.at(-1), /not a rule sym can take/);
  await fake.vscode.commands["q-lint.clearResultConditionalFormats"]({ column: 1 });
  assert.deepStrictEqual(last(fake).look.rules.map((r) => r.column), ["sym"]);
  // Exported to Excel with the rules on show.
  const target = new fake.vscode.Uri("/out.html");
  await fake.vscode.commands["q-lint.exportResultsAs"]("html", target);
  assert.match(fake.files["/out.html"], /<td style="font-weight:bold">b<\/td>/);
});

test("data bars and sparklines toggle per column; the column must fit (#1014)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result(), live);
  await fake.vscode.commands["q-lint.toggleResultDataBar"]({ column: 1 });
  assert.deepStrictEqual(last(fake).look.cellCharts, { px: "bar" });
  await fake.vscode.commands["q-lint.toggleResultDataBar"]({ column: 1 });
  assert.strictEqual(last(fake).look.cellCharts, undefined);
  await fake.vscode.commands["q-lint.toggleResultSparkline"]({ column: 2 });
  assert.deepStrictEqual(last(fake).look.cellCharts, { v: "text" });
  await fake.vscode.commands["q-lint.toggleResultDataBar"]({ column: 0 });
  assert.match(fake.said.at(-1), /does not fit/);
  // From the palette: only the columns that fit are offered.
  fake.answers.picks.push((i) => {
    assert.strictEqual(i.label, "v");
    return true;
  });
  await fake.vscode.commands["q-lint.toggleResultSparkline"]();
  assert.strictEqual(last(fake).look.cellCharts, undefined);
});

test("a saved query's result keeps its layout and rules, and its next run - and the next run of any code - starts from them (#1015)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.expectSaved("trades", "select from t");
  modes.show(result(), live);
  modes.expectSaved(undefined);
  assert.strictEqual(last(fake).saved, "trades");
  await fake.vscode.commands["q-lint.hideResultColumn"]({ column: 2 });
  await fake.vscode.commands["q-lint.freezeResultColumns"]({ column: 1 });
  // The page moved a column and resized one.
  const page = fake.pages[0];
  page.receive({ type: "look", id: last(fake).id, layout: { order: ["px", "sym", "v"], hidden: ["v"], widths: { px: 140 }, frozen: 2 } });
  await tick();
  const kept = fake.state.get("q-lint.savedQueryLooks");
  assert.deepStrictEqual(kept, { trades: { layout: { order: ["px", "sym", "v"], hidden: ["v"], widths: { px: 140 }, frozen: 2 } } });
  // Run again from Saved Queries: drawn as it was left.
  modes.expectSaved("trades", "select from t");
  modes.show(result(), live);
  modes.expectSaved(undefined);
  assert.deepStrictEqual(last(fake).look.layout, kept.trades.layout);
  // Freezing counts the columns as drawn: px is first.
  await fake.vscode.commands["q-lint.freezeResultColumns"]({ column: 1 });
  assert.strictEqual(last(fake).look.layout.frozen, 1);
  await fake.vscode.commands["q-lint.showHiddenResultColumns"]();
  assert.deepStrictEqual(last(fake).look.layout.hidden, []);
  await fake.vscode.commands["q-lint.unfreezeResultColumns"]();
  assert.strictEqual(last(fake).look.layout.frozen, 0);
  await fake.vscode.commands["q-lint.resetResultColumnLayout"]();
  assert.strictEqual(last(fake).look.layout, undefined);
  assert.deepStrictEqual(fake.state.get("q-lint.savedQueryLooks"), {});
  // A query not saved: its next run, in this window, starts from its look.
  modes.show(result("select from u"), live);
  await fake.vscode.commands["q-lint.hideResultColumn"]({ column: 0 });
  modes.show(result("select from u"), live);
  assert.deepStrictEqual(last(fake).look.layout.hidden, ["sym"]);
  assert.strictEqual(last(fake).saved, undefined);
  modes.show(result("select from w"), live);
  assert.deepStrictEqual(last(fake).look, {});
  // The last column is never hidden.
  modes.show(result("x", [["a", 7, ["1"], [1]]]), live);
  await fake.vscode.commands["q-lint.hideResultColumn"]({ column: 0 });
  assert.match(fake.said.at(-1), /shows one column/);
});

test("a chart is kept with its saved query, offered Save Query when it has none, drawn again, and forgotten (#1019)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result(), live);
  const page = fake.pages[0];
  await fake.vscode.commands["q-lint.saveResultChartWithQuery"]();
  assert.match(fake.said.at(-1), /draw the result's chart first/);
  const preset = { kind: "bar", series: ["px"], colours: { px: "#ff0000" } };
  page.receive({ type: "rendered", id: last(fake).id, rows: [0, 1, 2], rendered: { view: "chart", rows: 3, held: 3, total: 3, columns: [], first: [], preset } });
  fake.answers.infos.push("Save Query...");
  fake.answers.savedAs = "prices";
  await fake.vscode.commands["q-lint.saveResultChartWithQuery"]();
  assert.deepStrictEqual(fake.commandsRun.find((c) => c[0] === "q-lint.saveQuery"), ["q-lint.saveQuery", { code: "select from t" }]);
  assert.deepStrictEqual(fake.state.get("q-lint.savedQueryLooks"), { prices: { chart: preset } });
  // Its rules and layout are kept from then on too.
  await fake.vscode.commands["q-lint.toggleResultDataBar"]({ column: 1 });
  assert.deepStrictEqual(fake.state.get("q-lint.savedQueryLooks").prices, { cellCharts: { px: "bar" }, chart: preset });
  // The page's button keeps the chart it drew.
  page.receive({ type: "chartPreset", id: last(fake).id, preset: { ...preset, kind: "line" } });
  await tick();
  assert.strictEqual(fake.state.get("q-lint.savedQueryLooks").prices.chart.kind, "line");
  modes.expectSaved("prices", "select from t");
  modes.show(result(), live);
  modes.expectSaved(undefined);
  assert.strictEqual(last(fake).look.chart.kind, "line");
  await fake.vscode.commands["q-lint.forgetResultChartPreset"]();
  assert.deepStrictEqual(fake.state.get("q-lint.savedQueryLooks").prices, { cellCharts: { px: "bar" } });
  await fake.vscode.commands["q-lint.forgetResultChartPreset"]();
  assert.match(fake.said.at(-1), /no chart kept/);
});

test("Show Result Correlation Matrix asks the page for its view, once there are two numeric columns (#1020)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result("t", [["x", 9, ["1", "2"], [1, 2]], ["y", 9, ["2", "1"], [2, 1]]]), live);
  await fake.vscode.commands["q-lint.showResultCorrelation"]();
  assert.deepStrictEqual({ ...last(fake).control, key: undefined }, { key: undefined, action: "view", view: "corr" });
  modes.show(result(), live);
  await fake.vscode.commands["q-lint.showResultCorrelation"]();
  assert.match(fake.said.at(-1), /fewer than two numeric columns/);
});

test("Send Result to Notebook inserts a Markdown cell after the selected cell, the chart as a PNG (#1021)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result(), live);
  await fake.vscode.commands["q-lint.sendResultToNotebook"](false);
  assert.match(fake.said.at(-1), /open a q notebook/);
  const nb = fake.notebook("/w/a.qnb", 4);
  fake.vscode.window.visibleNotebookEditors.push({ notebook: nb, selections: [{ start: 1, end: 2 }] });
  const sending = fake.vscode.commands["q-lint.sendResultToNotebook"](true);
  await tick();
  const ask = last(fake).control;
  assert.deepStrictEqual([ask.action, ask.format], ["image", "png"]);
  fake.pages[0].receive({ type: "image", id: last(fake).id, format: "png", data: "data:image/png;base64,AAAA", key: ask.key });
  await sending;
  const [edit] = fake.edits;
  assert.strictEqual(edit.uri.path, "/w/a.qnb");
  assert.strictEqual(edit.list[0].index, 2);
  const cell = edit.list[0].cells[0];
  assert.deepStrictEqual([cell.kind, cell.languageId], [1, "markdown"]);
  assert.match(cell.value, /^\*\*Result\*\* from p at .*\n\n```q\nselect from t\n```\n\n\| sym \| px \| v \|\n/);
  assert.match(cell.value, /!\[chart\]\(data:image\/png;base64,AAAA\)\n$/);
  assert.match(fake.said.at(-1), /inserted 3 row\(s\) into a\.qnb as cell 3/);
  // The page's Send to... picks where.
  fake.answers.picks.push("q Notebook", "Table");
  fake.pages[0].receive({ type: "send", id: last(fake).id, rows: [2] });
  await tick();
  await tick();
  assert.strictEqual(fake.edits.length, 2);
  assert.match(fake.edits[1].list[0].cells[0].value, /\| c \| 9 \| ,5 \|\n$/);
});

test("Send to... keeps to the result it was asked from when another comes in during the picks (#1477)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result(), live);
  const nb = fake.notebook("/w/a.qnb", 1);
  fake.vscode.window.visibleNotebookEditors.push({ notebook: nb, selections: [] });
  // Result B, one row, arrives while the destination is picked: A's row 2 is still written.
  let arrived = false;
  const arrive = (code) => (i) => (arrived || ((arrived = true), modes.show(result(code, [["sym", 11, ["z"]], ["px", 9, ["7"], [7]]]), live)), i.label === "q Notebook");
  fake.answers.picks.push(arrive("select from u"), "Table");
  fake.pages[0].receive({ type: "send", id: last(fake).id, rows: [2] });
  await tick();
  await tick();
  const cell = fake.edits[0].list[0].cells[0].value;
  assert.match(cell, /select from t/);
  assert.match(cell, /\| c \| 9 \| ,5 \|\n$/);
  assert.ok(!/select from u|\| z \|/.test(cell), cell);
  // With the chart: the page now draws B's, so nothing is sent, and it says so.
  arrived = false;
  fake.answers.picks.push(arrive("select from w"), "Table and chart");
  fake.pages[0].receive({ type: "send", id: last(fake).id, rows: [0] });
  await tick();
  await tick();
  assert.strictEqual(fake.edits.length, 1);
  assert.match(fake.said.at(-1), /another result came in before its chart was drawn/);
  assert.notStrictEqual(last(fake).control?.action, "image");
});

test("Append Result to Markdown Report shows what it writes, appends after the text, and never writes over an image (#1021)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result(), live);
  const report = new fake.vscode.Uri("/w/daily.md");
  fake.files["/w/daily.md"] = "# Daily\nnotes";
  fake.files["/w/daily-images/old.svg"] = "<svg/>";
  // Declined: nothing written.
  fake.answers.warnings.push(undefined);
  await fake.vscode.commands["q-lint.appendResultToReport"](report, false);
  assert.strictEqual(fake.files["/w/daily.md"], "# Daily\nnotes");
  assert.ok(fake.said.some((m) => /Added after its last line; nothing in it is changed: 3 row\(s\) from p\.\n\n\*\*Result\*\* from p/.test(m)));
  fake.answers.warnings.push("Append");
  const sending = fake.vscode.commands["q-lint.appendResultToReport"](report, true);
  await tick();
  const ask = last(fake).control;
  assert.strictEqual(ask.format, "svg");
  fake.pages[0].receive({ type: "image", id: last(fake).id, format: "svg", data: "<svg>chart</svg>", key: ask.key });
  await sending;
  const text = fake.files["/w/daily.md"];
  assert.match(text, /^# Daily\nnotes\n\n\*\*Result\*\* from p/);
  const link = /!\[chart\]\((daily-images\/chart-\d{8}-\d{6}\.svg)\)/.exec(text);
  assert.ok(link, text);
  assert.strictEqual(fake.files[`/w/${link[1]}`], "<svg>chart</svg>");
  assert.strictEqual(fake.files["/w/daily-images/old.svg"], "<svg/>");
  // The next time, the last report is offered first; a new file is created, after asking.
  fake.answers.picks.push((i) => i.label === "Append to daily.md", "Table");
  fake.answers.warnings.push("Append");
  await fake.vscode.commands["q-lint.appendResultToReport"]();
  assert.strictEqual((fake.files["/w/daily.md"].match(/\*\*Result\*\*/g) || []).length, 2);
  fake.answers.picks.push("New Report File...");
  fake.answers.saveTo = new fake.vscode.Uri("/w/new.md");
  fake.answers.warnings.push("Create");
  await fake.vscode.commands["q-lint.appendResultToReport"](undefined, false);
  assert.match(fake.files["/w/new.md"], /^\*\*Result\*\* from p/);
  assert.ok(fake.said.includes("Create new.md with the result?"));
});

test("each feature turned off: its command refuses, the page gets none of its look, nothing is kept, written or sent (#1012-#1021)", async () => {
  const features = ["columnFormats", "conditionalFormats", "cellCharts", "columnLayout", "depthChart", "mapChart", "linkedCharts", "chartPresets", "correlation", "sendResult"];
  const config = Object.fromEntries(features.map((f) => [`results.${f}.enable`, false]));
  const fake = fakeVscode(config);
  const modes = loadModes(fake);
  // A saved query's look, kept while they were on.
  fake.state.set("q-lint.savedQueryLooks", { q: { rules: [{ column: "px", op: ">", value: 1, style: { bold: true } }], layout: { order: [], hidden: ["v"], widths: {}, frozen: 0 }, cellCharts: { px: "bar" }, chart: { kind: "bar", series: [], colours: {} } } });
  modes.expectSaved("q", "select from t");
  modes.show(result(), live);
  modes.expectSaved(undefined);
  const m = last(fake);
  assert.deepStrictEqual(m.look, {});
  for (const f of features) {
    assert.strictEqual(m.features[f], false, f);
  }
  const calls = [
    ["q-lint.addResultConditionalFormat", "conditionalFormats", [{ column: 1 }, { op: ">", value: 1, style: { bold: true } }]],
    ["q-lint.clearResultConditionalFormats", "conditionalFormats", [{ column: 1 }]],
    ["q-lint.toggleResultDataBar", "cellCharts", [{ column: 1 }]],
    ["q-lint.toggleResultSparkline", "cellCharts", [{ column: 2 }]],
    ["q-lint.hideResultColumn", "columnLayout", [{ column: 0 }]],
    ["q-lint.showHiddenResultColumns", "columnLayout", []],
    ["q-lint.freezeResultColumns", "columnLayout", [{ column: 0 }]],
    ["q-lint.unfreezeResultColumns", "columnLayout", []],
    ["q-lint.resetResultColumnLayout", "columnLayout", []],
    ["q-lint.saveResultChartWithQuery", "chartPresets", []],
    ["q-lint.forgetResultChartPreset", "chartPresets", []],
    ["q-lint.showResultCorrelation", "correlation", []],
    ["q-lint.sendResultToNotebook", "sendResult", [false]],
    ["q-lint.appendResultToReport", "sendResult", [new fake.vscode.Uri("/w/r.md"), false]],
  ];
  const posted = fake.pages[0].posted.length;
  for (const [id, feature, args] of calls) {
    fake.said.length = 0;
    await fake.vscode.commands[id](...args);
    assert.deepStrictEqual(fake.said, [OFF(feature)], id);
  }
  // What the page says is not acted on either.
  const page = fake.pages[0];
  page.receive({ type: "look", id: m.id, layout: { order: ["px"], hidden: [], widths: {}, frozen: 0 } });
  page.receive({ type: "chartPreset", id: m.id, preset: { kind: "bar", series: [], colours: {} } });
  page.receive({ type: "send", id: m.id, rows: [0] });
  await tick();
  assert.strictEqual(page.posted.length, posted, "nothing more was sent to the page");
  assert.deepStrictEqual(Object.keys(fake.files), []);
  assert.strictEqual(fake.edits.length, 0);
  // What the saved query keeps is left as it was while the features are off.
  assert.deepStrictEqual(Object.keys(fake.state.get("q-lint.savedQueryLooks").q).sort(), ["cellCharts", "chart", "layout", "rules"]);
  // Excel and HTML exports carry no rule while conditional formats are off.
  await fake.vscode.commands["q-lint.exportResultsAs"]("html", new fake.vscode.Uri("/w/x.html"));
  assert.ok(!/style="/.test(fake.files["/w/x.html"].replace(/<style>.*<\/style>/, "")));
  // On again, without a reload: the look is back with the next post.
  for (const f of features) fake.config[`results.${f}.enable`] = true;
  for (const f of fake.listeners.config) f({ affectsConfiguration: (s) => s === "q-lint.results" });
  assert.deepStrictEqual(Object.keys(last(fake).look).sort(), ["cellCharts", "chart", "layout", "rules"]);
});

test("package.json contributes each setting, command and menu, hidden while its feature is off (#1012-#1021)", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  const features = ["columnFormats", "conditionalFormats", "cellCharts", "columnLayout", "depthChart", "mapChart", "linkedCharts", "chartPresets", "correlation", "sendResult"];
  for (const f of features) {
    const s = props[`q-lint.results.${f}.enable`];
    assert.ok(s, f);
    assert.deepStrictEqual([s.type, s.default], ["boolean", true], f);
  }
  const titles = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
  const palette = new Map(pkg.contributes.menus.commandPalette.map((m) => [m.command, m.when]));
  const contextMenu = new Map(pkg.contributes.menus["webview/context"].map((m) => [m.command, m.when]));
  const own = {
    "q-lint.addResultConditionalFormat": "conditionalFormats",
    "q-lint.clearResultConditionalFormats": "conditionalFormats",
    "q-lint.toggleResultDataBar": "cellCharts",
    "q-lint.toggleResultSparkline": "cellCharts",
    "q-lint.hideResultColumn": "columnLayout",
    "q-lint.showHiddenResultColumns": "columnLayout",
    "q-lint.freezeResultColumns": "columnLayout",
    "q-lint.unfreezeResultColumns": "columnLayout",
    "q-lint.resetResultColumnLayout": "columnLayout",
    "q-lint.saveResultChartWithQuery": "chartPresets",
    "q-lint.forgetResultChartPreset": "chartPresets",
    "q-lint.showResultCorrelation": "correlation",
    "q-lint.sendResultToNotebook": "sendResult",
    "q-lint.appendResultToReport": "sendResult",
  };
  for (const [id, feature] of Object.entries(own)) {
    assert.strictEqual(titles.get(id)?.category, "q-lint", id);
    const when = palette.get(id);
    assert.ok(when === "false" || when.includes(`config.q-lint.results.${feature}.enable`), `${id}: ${when}`);
    if (contextMenu.has(id)) {
      assert.match(contextMenu.get(id), new RegExp(`webviewSection == 'column' .*config\\.q-lint\\.results\\.${feature}\\.enable`), id);
    }
  }
  assert.match(contextMenu.get("q-lint.toggleResultDataBar"), /columnKind == 'numeric'/);
  assert.match(contextMenu.get("q-lint.toggleResultSparkline"), /columnKind == 'list'/);
});

test("Copy as CSV and the exports write the columns drawn, in the order drawn, as their formats show the cells (#1639)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result("select from t", [...COLUMNS, ["ret_PCT", 9, ["0.0123", "0.5", "1"], [0.0123, 0.5, 1]]]), live);
  const id = last(fake).id;
  fake.pages[0].receive({ type: "look", id, layout: { order: ["px", "sym", "v"], hidden: ["v"], widths: {}, frozen: 0 } });
  await tick();
  await fake.vscode.commands["q-lint.exportResults"](new fake.vscode.Uri("/out.csv"));
  assert.strictEqual(fake.files["/out.csv"].toString(), "px,sym,ret_PCT\n1,a,1.23%\n5,b,50.00%\n9,c,100.00%\n");
  await fake.vscode.commands["q-lint.exportResultsAs"]("markdown", new fake.vscode.Uri("/out.md"));
  assert.match(fake.files["/out.md"].toString(), /^\| px \| sym \| ret\\_PCT \|\n.*\n\| 1 \| a \| 1\.23% \|/);
  // Typed formats keep the value, in the columns and order drawn.
  await fake.vscode.commands["q-lint.exportResultsAs"]("json", new fake.vscode.Uri("/out.json"));
  assert.match(fake.files["/out.json"].toString(), /^\[\n  \{"px": 1, "sym": "a", "ret_PCT": 0\.0123\}/);
});

test("Freeze Columns past the most frozen says so, rather than freezing what a resize then undoes (#1641)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  const info = [];
  fake.vscode.window.showInformationMessage = async (m) => info.push(m);
  const cols = Array.from({ length: 60 }, (_, i) => ["c" + i, 7, ["1"], [1]]);
  modes.show(result("wide", cols), live);
  await fake.vscode.commands["q-lint.freezeResultColumns"]({ column: 54 });
  assert.match(info.at(-1), /at most 50 columns are frozen; this column is number 55/);
  assert.strictEqual(last(fake).look.layout?.frozen ?? 0, 0);
  await fake.vscode.commands["q-lint.freezeResultColumns"]({ column: 49 });
  assert.strictEqual(last(fake).look.layout.frozen, 50);
  fake.pages[0].receive({ type: "look", id: last(fake).id, layout: { ...last(fake).look.layout, widths: { c0: 2400 } } });
  await tick();
  modes.show(result("wide", cols), live);
  assert.deepStrictEqual([last(fake).look.layout.frozen, last(fake).look.layout.widths], [50, { c0: 2000 }]);
});
