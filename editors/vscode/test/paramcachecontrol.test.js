// Toggle Parameter Cache's VS Code side (src/paramcachecontrol.ts): which
// documents it edits and when the status bar item shows. Run after `tsc`,
// under a stand-in for the `vscode` module.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

/// A stand-in `vscode` with one editor on `text` in `languageId`.
function fakeVscode(text, languageId) {
  const listeners = { active: [], change: [], open: [], config: [] };
  const settings = {};
  const messages = [];
  const item = { visible: false, text: "", show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const document = {
    text,
    languageId,
    getText() { return this.text; },
    offsetAt: (p) => p,
    positionAt: (o) => o,
  };
  const editor = {
    document,
    selection: { active: 0 },
    async edit(f) {
      const ops = [];
      f({ insert: (at, t) => ops.push([at, at, t]), delete: (r) => ops.push([r.start, r.end, ""]) });
      for (const [s, e, t] of ops) document.text = document.text.slice(0, s) + t + document.text.slice(e);
      return true;
    },
  };
  const disposable = { dispose() {} };
  const commands = {};
  const vscode = {
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    StatusBarAlignment: { Left: 1 },
    commands: { registerCommand: (id, f) => { commands[id] = f; return disposable; } },
    window: {
      activeTextEditor: editor,
      createStatusBarItem: () => item,
      onDidChangeActiveTextEditor: (f) => { listeners.active.push(f); return disposable; },
      showInformationMessage: async (m) => { messages.push(m); },
      showWarningMessage: async (m) => { messages.push(m); },
    },
    workspace: {
      onDidChangeTextDocument: (f) => { listeners.change.push(f); return disposable; },
      onDidOpenTextDocument: (f) => { listeners.open.push(f); return disposable; },
      onDidChangeConfiguration: (f) => { listeners.config.push(f); return disposable; },
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
    },
  };
  return { vscode, editor, document, item, listeners, messages, commands, settings };
}

function load(fake) {
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
    const { ParameterCache } = require("../out/paramcachecontrol.js");
    return new ParameterCache({ subscriptions: [] });
  } finally {
    Module._load = load;
  }
}

const CACHED = "f:{[a].qlint.cache.p1a2b3c:a;`a set .qlint.cache.p1a2b3c; a}\n";

test("Toggle Parameter Cache edits only a q document: a text file is left as it was", async () => {
  const fake = fakeVscode("f:{[a] a}\n", "plaintext");
  load(fake);
  fake.editor.selection.active = 4;
  await fake.commands["q-lint.toggleParameterCache"]();
  assert.strictEqual(fake.document.text, "f:{[a] a}\n");
  assert.match(fake.messages.join("\n"), /q file/);
  // A q document is still edited.
  const q = fakeVscode("f:{[a] a}\n", "q");
  load(q);
  q.editor.selection.active = 4;
  await q.commands["q-lint.toggleParameterCache"]();
  assert.match(q.document.text, /\.qlint\.cache\.p[0-9a-f]{6}:a/);
});

test("the status bar follows the active document's language when it is changed", () => {
  const fake = fakeVscode(CACHED, "q");
  const cache = load(fake);
  assert.strictEqual(cache.cached(), 1);
  assert.strictEqual(fake.item.visible, true);
  // Change Language Mode: VS Code closes and reopens the same document
  // with the new language, and the active editor does not change.
  fake.document.languageId = "plaintext";
  for (const f of fake.listeners.open) f(fake.document);
  assert.strictEqual(cache.cached(), 0);
  assert.strictEqual(fake.item.visible, false);
  fake.document.languageId = "q";
  for (const f of fake.listeners.open) f(fake.document);
  assert.strictEqual(cache.cached(), 1);
});

test("turned off, Toggle Parameter Cache refuses and its status bar item hides (#1624)", async () => {
  const fake = fakeVscode(CACHED, "q");
  const cache = load(fake);
  assert.strictEqual(fake.item.visible, true);
  fake.settings["editor.parameterCache.enable"] = false;
  for (const f of fake.listeners.config) f({ affectsConfiguration: (k) => k === "q-lint.editor.parameterCache" });
  assert.strictEqual(fake.item.visible, false);
  assert.strictEqual(cache.cached(), 0);
  await fake.commands["q-lint.toggleParameterCache"]();
  assert.strictEqual(fake.document.text, CACHED);
  assert.match(fake.messages.join("\n"), /Toggle Parameter Cache is turned off\. Set q-lint\.editor\.parameterCache\.enable to true/);
});
