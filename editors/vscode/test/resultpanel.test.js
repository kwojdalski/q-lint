// The result panel's extension side (src/resultpanel.ts): what it sends the
// page and what it does with the page's messages. Run after `tsc`, under a
// stand-in for the `vscode` module that records the webviews it makes, the
// messages posted to them and the clipboard.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

/// A stand-in `vscode`, fresh for each test: settings from `config`.
function fakeVscode(config = {}) {
  const pages = [];
  const listeners = { config: [] };
  const clipboard = { text: undefined };
  const written = {};
  const disposable = { dispose() {} };
  class Uri {
    constructor(path) {
      this.path = path;
      this.fsPath = path;
    }
    static joinPath(base, ...parts) {
      return new Uri([base.path, ...parts].join("/"));
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
  const vscode = {
    Uri,
    ViewColumn: { Beside: -2 },
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    commands: {
      registerCommand: (id, f) => {
        vscode.commands[id] = f;
        return disposable;
      },
      executeCommand: async () => {},
    },
    env: { clipboard: { writeText: async (t) => (clipboard.text = t) } },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerWebviewViewProvider: (id, provider) => {
        vscode.window.viewProvider = provider;
        return disposable;
      },
      createWebviewPanel: () => {
        const panel = { webview: makeWebview(), reveal() {}, dispose() {}, onDidDispose: () => disposable };
        pages.push(panel.webview);
        return panel;
      },
      showInformationMessage: async () => {},
      showWarningMessage: async () => {},
      showErrorMessage: async () => {},
      showSaveDialog: async () => undefined,
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
      fs: {
        writeFile: async (uri, bytes) => {
          written[uri.path] = Buffer.from(bytes).toString("utf8");
          written.bytes = { ...written.bytes, [uri.path]: Buffer.from(bytes) };
        },
      },
    },
  };
  return { vscode, pages, listeners, clipboard, config, written };
}

/// `src/resultpanel.ts`'s QueryModes, loaded against `fake`.
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
    return new QueryModes({ extensionUri: new fake.vscode.Uri("/ext"), subscriptions: [] });
  } finally {
    Module._load = load;
  }
}

/// A GRID payload of one long column `c` holding `values`.
const payload = (values, count = values.length) => ({
  count,
  keys: 0,
  names: ["c"],
  types: [7],
  cells: [values.map(String)],
  raw: [values],
  rank: [values.map((_, i) => i)],
});
const result = (values, count) => ({ process: "p", code: "t", millis: 1, answer: { ok: true, type: 98, text: [], grid: payload(values, count) } });
const live = (extra = {}) => ({ mode: "grid", resultsLocation: "editor", gridLimit: 10000, gridDecimals: -1, ...extra });

test("a result's id is new to the page after a reload, so the page does not keep an earlier session's sort and filters", () => {
  // A webview view keeps its page's state across a window reload, and the
  // page keeps its sort, filters and view for a result whose id it saw.
  const ids = [];
  for (let session = 0; session < 2; session++) {
    const fake = fakeVscode();
    const modes = loadModes(fake);
    assert.strictEqual(modes.show(result([1, 2]), live()), true);
    ids.push(fake.pages[0].posted.at(-1).id);
  }
  assert.notStrictEqual(ids[0], ids[1]);
});

test("a cut result says the limit it was cut at, after the setting changes", () => {
  const fake = fakeVscode({ "query.gridLimit": 100 });
  const modes = loadModes(fake);
  modes.show(result([1, 2, 3], 1000), live({ gridLimit: 100 }));
  assert.strictEqual(fake.pages[0].posted.at(-1).limit, 100);
  // The grid on show is re-sent when a query setting changes.
  fake.config["query.gridLimit"] = 5000;
  for (const f of fake.listeners.config) {
    f({ affectsConfiguration: () => true });
  }
  assert.strictEqual(fake.pages[0].posted.length, 2);
  assert.strictEqual(fake.pages[0].posted.at(-1).limit, 100);
});

test("rows a page chose for an earlier result are not copied from the one now shown", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result([10, 20, 30]), live());
  const page = fake.pages[0];
  const first = page.posted.at(-1).id;
  // The page reports and copies by the result it drew; a new one arrives
  // before its message does.
  modes.show(result([40, 50, 60]), live());
  page.receive({ type: "copy", id: first, rows: [2] });
  page.receive({ type: "rendered", id: first, rows: [2], rendered: { view: "grid", rows: 1, held: 3, total: 3, columns: ["c"], first: ["30"] } });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fake.clipboard.text, undefined);
  assert.strictEqual(modes.lastRendered(), undefined);
  // For the result on show, they apply.
  page.receive({ type: "copy", id: page.posted.at(-1).id, rows: [2] });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fake.clipboard.text, "c\n60\n");
});

test("showing the q Results view gives the focus back to the editor as it was, every cursor kept", async () => {
  const fake = fakeVscode();
  const calls = [];
  const selections = [{ anchor: 1 }, { anchor: 9 }];
  const editor = { document: { uri: "file:///a.q" }, viewColumn: 1, selection: selections[0], selections };
  fake.vscode.window.activeTextEditor = editor;
  fake.vscode.window.showTextDocument = async (document, options) => {
    calls.push(options);
    // As VS Code does: a selection given replaces every cursor with it.
    if (options && options.selection) {
      editor.selections = [options.selection];
    }
    return editor;
  };
  const modes = loadModes(fake);
  modes.show(result([1, 2]), live({ resultsLocation: "panel" }));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].preserveFocus, false);
  assert.deepStrictEqual(editor.selections, selections);
});

test("a query setting other than the decimals does not redraw the result on show", () => {
  // Toggle Unwrapped Query, or the timeout, sent the result again, and
  // the page drew it afresh: the grid back at its first row.
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result([1, 2, 3]), live());
  const page = fake.pages[0];
  const sent = page.posted.length;
  const change = (key) => {
    for (const f of fake.listeners.config) {
      f({ affectsConfiguration: (k) => key === k || key.startsWith(`${k}.`) });
    }
  };
  for (const key of ["q-lint.query.unwrapped", "q-lint.query.timeout", "q-lint.query.mode", "q-lint.query.gridLimit"]) {
    change(key);
  }
  assert.strictEqual(page.posted.length, sent);
  change("q-lint.query.gridDecimals");
  assert.strictEqual(page.posted.length, sent + 1);
});

test("the q Results view's Export button writes the view's rows, though the editor's panel is open too", async () => {
  // resultsLocation is `editor`, and the view was opened before: both
  // pages show the result, each with its own filter and sort.
  const fake = fakeVscode({ "query.resultsLocation": "editor" });
  const modes = loadModes(fake);
  const view = { webview: fake.pages.length, show() {}, onDidDispose: () => ({ dispose() {} }) };
  modes.show(result([10, 20, 30]), live());
  const panel = fake.pages[0];
  const webview = { posted: [], options: {}, html: "", cspSource: "", asWebviewUri: (u) => u, postMessage: async () => true, onDidReceiveMessage(f) { webview.receive = f; return { dispose() {} }; } };
  view.webview = webview;
  fake.vscode.window.viewProvider.resolveWebviewView(view);
  const id = panel.posted.at(-1).id;
  const drawn = (rows) => ({ view: "grid", rows: rows.length, held: 3, total: 3, columns: ["c"], first: [] });
  panel.receive({ type: "rendered", id, rows: [2, 1, 0], rendered: drawn([2, 1, 0]) });
  webview.receive({ type: "rendered", id, rows: [0], rendered: drawn([0]) });
  const { RESULTS } = require("../out/liveconfig.js");
  await fake.vscode.commands[RESULTS.exportViewCsv](new fake.vscode.Uri("/view.csv"));
  await fake.vscode.commands[RESULTS.exportCsv](new fake.vscode.Uri("/editor.csv"));
  assert.strictEqual(fake.written["/view.csv"], "c\n10\n");
  assert.strictEqual(fake.written["/editor.csv"], "c\n30\n20\n10\n");
});

test("the q Results view's page is drawn on the panel's background, the editor's on the editor's", () => {
  // result.css painted every page with editor.background, so the view in
  // the bottom panel stood out as a block of the editor's colour where
  // the panel's differs (Dark Modern: #1f1f1f in #181818).
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show(result([1]), live());
  const view = { webview: { options: {}, html: "", cspSource: "", asWebviewUri: (u) => u, postMessage: async () => true, onDidReceiveMessage: () => ({ dispose() {} }) }, show() {}, onDidDispose: () => ({ dispose() {} }) };
  fake.vscode.window.viewProvider.resolveWebviewView(view);
  const bodyClass = (html) => /<body([^>]*)>/.exec(html)[1];
  assert.match(bodyClass(view.webview.html), /data-location="panel"/);
  assert.doesNotMatch(bodyClass(fake.pages[0].html), /panel/);
  const css = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "media", "result.css"), "utf8");
  assert.match(css, /body\[data-location="panel"\]\s*\{[^}]*background:\s*var\(--vscode-panel-background/);
});

test("the last q-lint.query.resultHistory results are kept, and a tab shows one again (#920)", async () => {
  const fake = fakeVscode({ "query.resultHistory": 2 });
  const modes = loadModes(fake);
  modes.show({ ...result([1]), code: "a" }, live());
  modes.show({ ...result([2]), code: "b" }, live());
  modes.show({ ...result([3]), code: "c\nmore" }, live());
  const page = fake.pages[0];
  const last = page.posted.at(-1);
  assert.deepStrictEqual(last.history.map((h) => h.code), ["b", "c..."]);
  page.receive({ type: "select", id: last.id, pick: last.history[0].id });
  assert.strictEqual(page.posted.at(-1).id, last.history[0].id);
  assert.deepStrictEqual(page.posted.at(-1).grid.cells, [["2"]]);
  // Copy now copies the result chosen.
  page.receive({ type: "copy", id: last.history[0].id });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fake.clipboard.text, "c\n2\n");
  // One no longer kept is not shown.
  const sent = page.posted.length;
  page.receive({ type: "select", pick: "gone" });
  assert.strictEqual(page.posted.length, sent);
  // Show Result from History takes an id too.
  const { RESULT_VIEW } = require("../out/liveconfig.js");
  await fake.vscode.commands[RESULT_VIEW.history](last.id);
  assert.strictEqual(page.posted.at(-1).id, last.id);
});

test("a query run again is sent with what changed since its previous run, in this window (#919)", () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show({ ...result([1, 2]), code: "q1" }, live());
  const page = fake.pages[0];
  assert.strictEqual(page.posted.at(-1).diff, undefined);
  modes.show({ ...result([5]), code: "other" }, live());
  modes.show({ ...result([1, 3, 4]), code: "q1", process: "p2" }, live());
  const { diff } = page.posted.at(-1);
  assert.strictEqual(diff.process, "p");
  assert.deepStrictEqual(diff.changes, [[0, 1, "2"]]);
  assert.deepStrictEqual(diff.addedRows, [2]);
});

test("the result commands ask the page for a view once, and say why when they cannot (#923, #928, #919)", async () => {
  const fake = fakeVscode();
  const info = [];
  fake.vscode.window.showInformationMessage = async (m) => info.push(m);
  const modes = loadModes(fake);
  const { RESULT_VIEW } = require("../out/liveconfig.js");
  await fake.vscode.commands[RESULT_VIEW.statistics]();
  assert.match(info.at(-1), /no result yet/);
  modes.show(result([1, 2]), live());
  const page = fake.pages[0];
  await fake.vscode.commands[RESULT_VIEW.statistics]();
  const first = page.posted.at(-1).control;
  assert.deepStrictEqual({ ...first, key: undefined }, { key: undefined, action: "view", view: "stats" });
  await fake.vscode.commands[RESULT_VIEW.statistics]();
  assert.notStrictEqual(page.posted.at(-1).control.key, first.key);
  await fake.vscode.commands[RESULT_VIEW.tree]();
  assert.match(info.at(-1), /has no tree/);
  await fake.vscode.commands[RESULT_VIEW.compare]();
  assert.match(info.at(-1), /nothing to compare/);
  // A dictionary's tree is sent with it.
  const tree = { key: "", text: "", type: 99, count: 0, children: [] };
  modes.show({ ...result([1]), answer: { ok: true, type: 99, text: [], grid: { ...payload([1]), tree } } }, live());
  assert.deepStrictEqual(page.posted.at(-1).tree, tree);
  await fake.vscode.commands[RESULT_VIEW.tree]();
  assert.strictEqual(page.posted.at(-1).control.view, "tree");
});

test("Toggle Result Heatmap and the page's button switch q-lint.query.gridHeatmap, and the page is drawn again (#924)", async () => {
  const fake = fakeVscode();
  const updates = [];
  fake.vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => (key in fake.config ? fake.config[key] : fallback),
    inspect: () => ({}),
    update: async (key, value, target) => {
      updates.push([key, value, target]);
      fake.config[key] = value;
    },
  });
  const modes = loadModes(fake);
  modes.show(result([1, 2]), live());
  const page = fake.pages[0];
  assert.strictEqual(page.posted.at(-1).heatmap, false);
  const { RESULT_VIEW } = require("../out/liveconfig.js");
  await fake.vscode.commands[RESULT_VIEW.heatmap]();
  assert.deepStrictEqual(updates, [["query.gridHeatmap", true, 1]]);
  for (const f of fake.listeners.config) {
    f({ affectsConfiguration: (k) => "q-lint.query.gridHeatmap" === k || "q-lint.query.gridHeatmap".startsWith(`${k}.`) });
  }
  assert.strictEqual(page.posted.at(-1).heatmap, true);
  page.receive({ type: "heatmap", id: page.posted.at(-1).id });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(updates.at(-1), ["query.gridHeatmap", false, 1]);
});

test("each result feature turned off: its command refuses, the page is sent nothing for it, and the process is not asked for a tree", async () => {
  const off = {
    "results.history.enable": false,
    "results.diff.enable": false,
    "results.statistics.enable": false,
    "results.heatmap.enable": false,
    "results.tree.enable": false,
    "query.gridHeatmap": true,
  };
  const fake = fakeVscode({ ...off });
  const info = [];
  const updates = [];
  fake.vscode.window.showInformationMessage = async (m) => info.push(m);
  const base = fake.vscode.workspace.getConfiguration;
  fake.vscode.workspace.getConfiguration = () => ({ ...base(), update: async (...a) => updates.push(a) });
  const modes = loadModes(fake);
  assert.strictEqual(modes.wantsTree(), false);
  const tree = { key: "", text: "", type: 99, count: 0, children: [] };
  const dict = (code) => ({ ...result([1]), code, answer: { ok: true, type: 99, text: [], grid: { ...payload([1]), tree } } });
  modes.show(dict("q"), live());
  modes.show(dict("q"), live());
  const page = fake.pages[0];
  const m = page.posted.at(-1);
  assert.strictEqual(m.tree, undefined);
  assert.strictEqual(m.diff, undefined);
  assert.strictEqual(m.heatmap, false);
  assert.deepStrictEqual(m.features, { statistics: false, heatmap: false, export: true, pivot: true, charts: true, drilldown: true, wrangler: true, editCells: true, plots: true });
  assert.strictEqual(m.history.length, 1);
  const { RESULT_VIEW } = require("../out/liveconfig.js");
  const features = { statistics: "statistics", tree: "tree", compare: "diff", heatmap: "heatmap", history: "history" };
  for (const [command, feature] of Object.entries(features)) {
    const sent = page.posted.length;
    await fake.vscode.commands[RESULT_VIEW[command]]();
    assert.match(info.at(-1), new RegExp(`turned off\\. Turn it on with the setting q-lint\\.results\\.${feature}\\.enable`), command);
    assert.strictEqual(page.posted.length, sent, command);
  }
  page.receive({ type: "heatmap", id: m.id });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(updates, []);
  // Turned on again, without a reload: the page is sent them at once, and
  // the tree is asked for. The diff starts from the next run: none was kept.
  for (const key of Object.keys(off)) {
    if (key.startsWith("results.")) {
      delete fake.config[key];
    }
  }
  for (const f of fake.listeners.config) {
    f({ affectsConfiguration: (k) => k === "q-lint.results" || k === "q-lint" });
  }
  const on = page.posted.at(-1);
  assert.deepStrictEqual(on.tree, tree);
  assert.deepStrictEqual(on.features, { statistics: true, heatmap: true, export: true, pivot: true, charts: true, drilldown: true, wrangler: true, editCells: true, plots: true });
  assert.strictEqual(on.heatmap, true);
  assert.strictEqual(on.diff, undefined);
  assert.strictEqual(modes.wantsTree(), true);
  // History turned off while results are kept: only the one on show stays.
  modes.show(dict("r"), live());
  assert.strictEqual(page.posted.at(-1).history.length, 2);
  fake.config["results.history.enable"] = false;
  for (const f of fake.listeners.config) {
    f({ affectsConfiguration: (k) => k === "q-lint.results" || k === "q-lint" });
  }
  assert.deepStrictEqual(page.posted.at(-1).history.map((h) => h.code), ["r"]);
});

test("a watched query's next run replaces its result in place: the same id, no new tab, the previous run kept to compare (#914)", () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  modes.show({ ...result([1]), code: "w" }, live());
  const page = fake.pages[0];
  const first = page.posted.at(-1);
  modes.show({ ...result([2]), code: "w" }, live(), true);
  const next = page.posted.at(-1);
  assert.strictEqual(next.id, first.id);
  assert.deepStrictEqual(next.grid.cells, [["2"]]);
  assert.strictEqual(next.history.length, 1);
  assert.deepStrictEqual(next.diff.changes, [[0, 0, "1"]]);
  // Another query on show is not replaced: a run of `w` then is a new result.
  modes.show({ ...result([3]), code: "other" }, live());
  modes.show({ ...result([4]), code: "w" }, live(), true);
  assert.notStrictEqual(page.posted.at(-1).id, first.id);
  assert.strictEqual(page.posted.at(-1).history.length, 3);
  assert.strictEqual(fake.pages.length, 1);
});

// --- wave two: export formats (#921), paging (#922), pivot (#925), charts
// (#926) and drill-down (#927)

test("Export Results As writes the format named to the file given, and Copy Results As puts text on the clipboard (#921)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  const { RESULT_VIEW } = require("../out/liveconfig.js");
  modes.show(result([1, 2]), live());
  await fake.vscode.commands[RESULT_VIEW.exportAs]("json", new fake.vscode.Uri("/r.json"));
  assert.deepStrictEqual(JSON.parse(fake.written["/r.json"]), [{ c: 1 }, { c: 2 }]);
  await fake.vscode.commands[RESULT_VIEW.exportAs]("xlsx", new fake.vscode.Uri("/r.xlsx"));
  assert.strictEqual(fake.written.bytes["/r.xlsx"].toString("latin1", 0, 2), "PK");
  await fake.vscode.commands[RESULT_VIEW.exportAs]("parquet", new fake.vscode.Uri("/r.parquet"));
  assert.strictEqual(fake.written.bytes["/r.parquet"].toString("latin1", 0, 4), "PAR1");
  // The rows the page shows, in its order.
  const page = fake.pages[0];
  page.receive({ type: "rendered", id: page.posted.at(-1).id, rows: [1], rendered: { view: "grid", rows: 1, held: 2, total: 2, columns: ["c"], first: ["2"] } });
  await fake.vscode.commands[RESULT_VIEW.copyAs]("q");
  assert.strictEqual(fake.clipboard.text, "([] c:enlist 2)\n");
  await fake.vscode.commands[RESULT_VIEW.copyAs]("markdown");
  assert.strictEqual(fake.clipboard.text, "| c |\n| ---: |\n| 2 |\n");
  // A format picked: the page's button sends no format.
  fake.vscode.window.showQuickPick = async (items) => items.find((i) => i.format === "json");
  page.receive({ type: "copyAs", id: page.posted.at(-1).id, rows: [0, 1] });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(fake.clipboard.text, '[\n  {"c": 1},\n  {"c": 2}\n]\n');
  assert.strictEqual(page.posted.at(-1).features.export, true);
});

test("paging is off by default; on, a cut result the process holds is fetched page by page as the page asks (#922)", async () => {
  const fake = fakeVscode({ "results.paging.enable": true });
  const modes = loadModes(fake);
  const calls = [];
  modes.setPager(async (process, offset, count) => {
    calls.push([process, offset, count]);
    return { count: 5, names: ["c"], types: [7], cells: [["3", "4", "5"]], raw: [[3, 4, 5]], rank: [[0, 1, 2]] };
  });
  assert.strictEqual(modes.wantsHold(false), true);
  // Never on a production process.
  assert.strictEqual(modes.wantsHold(true), false);
  modes.show({ ...result([1, 2], 5), held: true }, live({ gridLimit: 2 }));
  const page = fake.pages[0];
  assert.strictEqual(page.posted.at(-1).more, true);
  page.receive({ type: "more", id: page.posted.at(-1).id });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(calls, [["p", 2, 2]]);
  const after = page.posted.at(-1);
  assert.deepStrictEqual(after.grid.cells, [["1", "2", "3", "4", "5"]]);
  assert.strictEqual(after.more, false);
  // A result not asked for with wantsHold is not paged.
  modes.show(result([1, 2], 5), live({ gridLimit: 2 }));
  assert.strictEqual(page.posted.at(-1).more, false);
  // An error from the process: said, and paging stops for that result.
  const warned = [];
  fake.vscode.window.showWarningMessage = async (m) => warned.push(m);
  modes.setPager(async () => "held");
  modes.show({ ...result([1, 2], 5), held: true }, live({ gridLimit: 2 }));
  page.receive({ type: "more", id: page.posted.at(-1).id });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.match(warned.at(-1), /could not fetch more rows from p: held/);
  assert.strictEqual(page.posted.at(-1).more, false);
  // Off by default.
  const plain = loadModes(fakeVscode());
  assert.strictEqual(plain.wantsHold(false), false);
});

test("a double-clicked cell offers its drill-down templates, filled in, and runs the one picked on its process (#927)", async () => {
  const fake = fakeVscode({ "results.drilldownTemplates": [{ label: "next", query: "select from t where c>{{value}}" }, { query: "x", columns: ["other"] }] });
  const modes = loadModes(fake);
  const ran = [];
  modes.setRunner(async (code, process) => ran.push([code, process]));
  let offered;
  fake.vscode.window.showQuickPick = async (items) => {
    offered = items;
    return items[0];
  };
  modes.show(result([10, 20]), live());
  const page = fake.pages[0];
  page.receive({ type: "drill", id: page.posted.at(-1).id, column: 0, row: 1 });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(offered.map((i) => [i.label, i.detail]), [["next", "select from t where c>20"]]);
  assert.deepStrictEqual(ran, [["select from t where c>20", "p"]]);
  // From the editor's context menu, with the cell's data-vscode-context.
  const { RESULT_VIEW } = require("../out/liveconfig.js");
  await fake.vscode.commands[RESULT_VIEW.drillDown]({ webviewSection: "cell", column: 0, row: 0 });
  assert.deepStrictEqual(ran.at(-1), ["select from t where c>10", "p"]);
  // No template: it says where to add one.
  const none = fakeVscode();
  const info = [];
  none.vscode.window.showInformationMessage = async (m) => info.push(m);
  const bare = loadModes(none);
  bare.setRunner(async (code) => ran.push([code]));
  bare.show(result([1]), live());
  await none.vscode.commands[RESULT_VIEW.drillDown]({ column: 0, row: 0 });
  assert.match(info.at(-1), /no drill-down query for column c\. Add one to q-lint\.results\.drilldownTemplates/);
  assert.strictEqual(ran.length, 2);
});

test("Save Result Chart asks the page for the chart and writes the image it sends to the file given (#926)", async () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  const { RESULT_VIEW } = require("../out/liveconfig.js");
  modes.show(result([1, 2]), live({ mode: "chart" }));
  const page = fake.pages[0];
  const saving = fake.vscode.commands[RESULT_VIEW.saveChart]("svg", new fake.vscode.Uri("/c.svg"));
  const asked = page.posted.at(-1).control;
  assert.strictEqual(asked.action, "image");
  assert.strictEqual(asked.format, "svg");
  page.receive({ type: "image", id: page.posted.at(-1).id, format: "svg", data: "<svg></svg>", key: asked.key });
  await saving;
  assert.strictEqual(fake.written["/c.svg"], "<svg></svg>");
  // A PNG arrives as a data URL; anything else is not written.
  const png = fake.vscode.commands[RESULT_VIEW.saveChart]("png", new fake.vscode.Uri("/c.png"));
  const key = page.posted.at(-1).control.key;
  page.receive({ type: "image", id: page.posted.at(-1).id, format: "png", data: "data:image/png;base64,iVBORw0KGgo=", key });
  await png;
  assert.deepStrictEqual([...fake.written.bytes["/c.png"].subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const bad = fake.vscode.commands[RESULT_VIEW.saveChart]("svg", new fake.vscode.Uri("/x.svg"));
  page.receive({ type: "image", id: page.posted.at(-1).id, format: "svg", data: "<script>", key: page.posted.at(-1).control.key });
  await bad;
  assert.strictEqual(fake.written["/x.svg"], undefined);
});

test("export, paging, pivot, charts and drill-down turned off: each command refuses, the page is offered none, and nothing is sent", async () => {
  const off = {
    "results.export.enable": false,
    "results.pivot.enable": false,
    "results.charts.enable": false,
    "results.drilldown.enable": false,
    "results.drilldownTemplates": [{ query: "x {{value}}" }],
  };
  const fake = fakeVscode({ ...off });
  const info = [];
  fake.vscode.window.showInformationMessage = async (m) => info.push(m);
  fake.vscode.window.showQuickPick = async (items) => items[0];
  const modes = loadModes(fake);
  const pages = [];
  const ran = [];
  modes.setPager(async () => {
    pages.push(1);
    return "held";
  });
  modes.setRunner(async (code) => ran.push(code));
  assert.strictEqual(modes.wantsHold(false), false);
  modes.show({ ...result([1, 2], 5), held: true }, live());
  const page = fake.pages[0];
  const m = page.posted.at(-1);
  assert.deepStrictEqual(m.features, { statistics: true, heatmap: true, export: false, pivot: false, charts: false, drilldown: false, wrangler: true, editCells: true, plots: true });
  assert.strictEqual(m.more, false);
  const { RESULT_VIEW } = require("../out/liveconfig.js");
  const features = { exportAs: "export", copyAs: "export", loadMore: "paging", pivot: "pivot", saveChart: "charts", drillDown: "drilldown" };
  for (const [command, feature] of Object.entries(features)) {
    const sent = page.posted.length;
    await fake.vscode.commands[RESULT_VIEW[command]]("json", new fake.vscode.Uri("/off"));
    assert.match(info.at(-1), new RegExp(`turned off\\. Turn it on with the setting q-lint\\.results\\.${feature}\\.enable`), command);
    assert.strictEqual(page.posted.length, sent, command);
  }
  // What the page sends for them is refused too.
  for (const type of ["exportAs", "copyAs", "drill", "more", "image"]) {
    page.receive({ type, id: m.id, format: "svg", data: "<svg/>", column: 0, row: 0, rows: [0] });
  }
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(Object.keys(fake.written), []);
  assert.deepStrictEqual(pages, []);
  assert.deepStrictEqual(ran, []);
  assert.strictEqual(fake.clipboard.text, undefined);
  // Turned on again, without a reload.
  for (const key of Object.keys(off)) {
    if (key.endsWith(".enable")) {
      delete fake.config[key];
    }
  }
  for (const f of fake.listeners.config) {
    f({ affectsConfiguration: (k) => k === "q-lint.results" || k === "q-lint" });
  }
  assert.deepStrictEqual(page.posted.at(-1).features, { statistics: true, heatmap: true, export: true, pivot: true, charts: true, drilldown: true, wrangler: true, editCells: true, plots: true });
});

test("each chart the page draws is kept for the q Plots view; off, none is (#970)", () => {
  const fake = fakeVscode();
  const modes = loadModes(fake);
  const { PLOTS } = require("../out/plots.js");
  modes.show(result([1, 2]), live({ mode: "chart" }));
  const page = fake.pages[0];
  const m = page.posted.at(-1);
  assert.strictEqual(m.features.plots, true);
  const svg = (label) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><text>${label}</text></svg>`;
  page.receive({ type: "plotted", id: m.id, format: "line", data: svg("a") });
  page.receive({ type: "plotted", id: m.id, format: "bar", data: svg("b") });
  // The same result and kind drawn again replaces its plot.
  page.receive({ type: "plotted", id: m.id, format: "line", data: svg("c") });
  assert.deepStrictEqual(PLOTS.list().map((p) => [p.kind, p.process, p.code, p.svg.includes("<text>c") || p.svg.includes("<text>b")]), [["line", "p", "t", true], ["bar", "p", "t", true]]);
  // Anything but a plain SVG, or a plot of a result no longer on show, is not kept.
  page.receive({ type: "plotted", id: m.id, format: "area", data: '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>' });
  page.receive({ type: "plotted", id: "old", format: "area", data: svg("d") });
  assert.strictEqual(PLOTS.list().length, 2);
  // Off: the page is told, and a plot it sends anyway is not kept.
  fake.config["results.plots.enable"] = false;
  for (const f of fake.listeners.config) {
    f({ affectsConfiguration: (k) => k === "q-lint.results" || k === "q-lint" });
  }
  assert.strictEqual(page.posted.at(-1).features.plots, false);
  page.receive({ type: "plotted", id: m.id, format: "step", data: svg("e") });
  assert.strictEqual(PLOTS.list().length, 2);
  PLOTS.clear();
});
