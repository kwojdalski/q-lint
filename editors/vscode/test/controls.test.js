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
  fakeVscode.on.close({ uri: first });
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
