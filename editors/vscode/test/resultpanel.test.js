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
      registerWebviewViewProvider: () => disposable,
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
      fs: { writeFile: async () => {} },
    },
  };
  return { vscode, pages, listeners, clipboard, config };
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
