// The query controls' VS Code half (src/controls.ts): a file's own
// connection as the status bar and the live half see it. Run after `tsc`,
// under a stand-in for the `vscode` module.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

/// A stand-in `vscode` whose workspaceState is `state`, kept across loads
/// as a workspace keeps it across window reloads.
function fakeVscode(state, editor) {
  const disposable = { dispose() {} };
  const item = () => ({ show() {}, hide() {}, dispose() {} });
  return {
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    commands: {
      registerCommand: (id, f) => {
        fakeVscode.commands[id] = f;
        return disposable;
      },
      executeCommand: async () => {},
    },
    window: {
      activeTextEditor: editor,
      createStatusBarItem: item,
      onDidChangeActiveTextEditor: () => disposable,
      showInformationMessage: async () => {},
    },
    workspace: {
      getConfiguration: () => ({ get: (_k, fallback) => fallback, inspect: () => ({}), update: async () => {} }),
      onDidChangeConfiguration: () => disposable,
      onDidCloseTextDocument: (f) => {
        fakeVscode.on.close = f;
        return disposable;
      },
      onDidRenameFiles: (f) => {
        fakeVscode.on.rename = f;
        return disposable;
      },
      onDidOpenTextDocument: (f) => {
        fakeVscode.on.open = f;
        return disposable;
      },
      onDidSaveTextDocument: (f) => {
        fakeVscode.on.save = f;
        return disposable;
      },
      textDocuments: [],
    },
    state,
  };
}
fakeVscode.commands = {};
fakeVscode.on = {};

function loadControls(vscode) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "vscode" ? vscode : load.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (/[\\/]out[\\/]/.test(key)) {
        delete require.cache[key];
      }
    }
    const { QueryControls } = require("../out/controls.js");
    const workspaceState = {
      get: (k) => vscode.state[k],
      update: async (k, v) => {
        vscode.state[k] = v;
      },
    };
    return new QueryControls({ subscriptions: [], workspaceState, extension: { id: "x.q-lint" } }, { activeLabel: () => undefined, pick: async () => undefined });
  } finally {
    Module._load = load;
  }
}

const uri = (scheme, path) => ({ scheme, path, toString: () => `${scheme}:${path}` });

test("an untitled editor's process is not kept for the next untitled editor of that name", async () => {
  // Untitled-1 is bound to prod, then closed unsaved; after a reload, the
  // next new editor is Untitled-1 too, and its queries must not go to prod.
  const state = {};
  const first = uri("untitled", "Untitled-1");
  const vscode = fakeVscode(state, { document: { uri: first } });
  const controls = loadControls(vscode);
  await fakeVscode.commands["q-lint.chooseConnectionForFile"]("prod");
  assert.strictEqual(controls.binding(first), "prod");
  const reloaded = loadControls(fakeVscode(state, undefined));
  assert.strictEqual(reloaded.binding(uri("untitled", "Untitled-1")), undefined);
  // A file's is kept, as before.
  const file = uri("file", "/w/a.q");
  const filed = loadControls(fakeVscode(state, { document: { uri: file } }));
  await fakeVscode.commands["q-lint.chooseConnectionForFile"]("dev");
  assert.strictEqual(loadControls(fakeVscode(state, undefined)).binding(file), "dev");
  assert.strictEqual(filed.binding(file), "dev");
});

test("an untitled editor closed unsaved does not hand its process to the next new editor in this window", async () => {
  // VS Code names the next new editor Untitled-1 again once the first is
  // closed, in the same window.
  const first = uri("untitled", "Untitled-1");
  const controls = loadControls(fakeVscode({}, { document: { uri: first } }));
  await fakeVscode.commands["q-lint.chooseConnectionForFile"]("prod");
  fakeVscode.on.close({ uri: first, getText: () => "" });
  assert.strictEqual(controls.binding(uri("untitled", "Untitled-1")), undefined);
});

test("a file renamed or moved keeps its process", async () => {
  const state = {};
  const file = uri("file", "/w/a.q");
  const inFolder = uri("file", "/w/d/b.q");
  const controls = loadControls(fakeVscode(state, { document: { uri: file } }));
  await fakeVscode.commands["q-lint.chooseConnectionForFile"]("prod");
  const other = loadControls(fakeVscode(state, { document: { uri: inFolder } }));
  await fakeVscode.commands["q-lint.chooseConnectionForFile"]("dev");
  await fakeVscode.on.rename({
    files: [
      { oldUri: file, newUri: uri("file", "/w/a 2.q") },
      { oldUri: uri("file", "/w/d"), newUri: uri("file", "/w/e") },
    ],
  });
  assert.strictEqual(other.binding(uri("file", "/w/a 2.q")), "prod");
  assert.strictEqual(other.binding(file), undefined);
  assert.strictEqual(other.binding(uri("file", "/w/e/b.q")), "dev");
  assert.strictEqual(controls.binding(inFolder), undefined);
});

// Saving a bound untitled editor closes it and opens the file: the file
// lost its process, and its queries went to the active one (#1529).
test("an untitled editor saved to a file hands the file its process", async () => {
  const first = uri("untitled", "Untitled-1");
  const vscode = fakeVscode({}, { document: { uri: first } });
  const controls = loadControls(vscode);
  await fakeVscode.commands["q-lint.chooseConnectionForFile"]("prod");
  // Closed first, then saved: the file opened has its text.
  fakeVscode.on.close({ uri: first, getText: () => "select from t" });
  const saved = uri("file", "/w/q1.q");
  await fakeVscode.on.save({ uri: saved, getText: () => "select from t" });
  assert.strictEqual(controls.binding(saved), "prod");
  // Saved while still open, as VS Code may order it.
  const second = uri("untitled", "Untitled-2");
  vscode.window.activeTextEditor = { document: { uri: second } };
  await fakeVscode.commands["q-lint.chooseConnectionForFile"]("dev");
  vscode.workspace.textDocuments = [{ uri: second, getText: () => "count t" }];
  const other = uri("file", "/w/q2.q");
  await fakeVscode.on.save({ uri: other, getText: () => "count t" });
  assert.strictEqual(controls.binding(other), "dev");
  // Another file saved meanwhile, with other text, takes none.
  const unrelated = uri("file", "/w/b.q");
  await fakeVscode.on.save({ uri: unrelated, getText: () => "1+1" });
  assert.strictEqual(controls.binding(unrelated), undefined);
  // A file opened long before, saved with an open bound editor's text, is
  // not the one it was saved as (#1723).
  const old = uri("file", "/w/old.q");
  fakeVscode.on.open({ uri: old });
  const at = Date.now;
  Date.now = () => at() + 60_000;
  try {
    await fakeVscode.on.save({ uri: old, getText: () => "count t" });
  } finally {
    Date.now = at;
  }
  assert.strictEqual(controls.binding(old), undefined);
  // One just opened by the save, as Save As opens it, still takes it.
  const fresh = uri("file", "/w/q3.q");
  fakeVscode.on.open({ uri: fresh });
  await fakeVscode.on.save({ uri: fresh, getText: () => "count t" });
  assert.strictEqual(controls.binding(fresh), "dev");
});

// Two New Query opens in a row: the first one's bind landed on the second
// editor, active by then, and left the first unbound (#1530).
test("the editor named is bound, not whichever is active by then", async () => {
  const first = uri("untitled", "Untitled-1");
  const second = uri("untitled", "Untitled-2");
  const controls = loadControls(fakeVscode({}, { document: { uri: second } }));
  await fakeVscode.commands["q-lint.chooseConnectionForFile"]("prodA", first);
  await fakeVscode.commands["q-lint.chooseConnectionForFile"]("devB", second);
  assert.strictEqual(controls.binding(first), "prodA");
  assert.strictEqual(controls.binding(second), "devB");
});
