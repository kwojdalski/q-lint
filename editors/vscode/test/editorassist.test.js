// The editor's side of the reference count lens (#994), the process names
// in workspace symbol search (#996) and the argument slot highlight (#997):
// what the server's and the process's answers become, and each feature's
// life - registered only while its setting is on, and asking nothing of
// the server or the process when it is off. The q side of the process
// names is editorassist_q.test.js; the server's answers are tests/assist.rs.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const {
  ARGUMENT_SLOT,
  DEFINED_IN_WORKSPACE,
  NAMES_LIMIT,
  PROCESS_NAMES,
  lensTarget,
  matching,
  processSymbolDocument,
  readProcessNames,
  readSlot,
  slotHover,
  slotLabel,
} = require("../out/editorassist.js");
const { registerArgumentSlot, registerProcessSymbols } = require("../out/editorassistview.js");
const pkg = require("../package.json");

test("the switches are declared, the ones that ask a process off by default", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.argumentSlot.enable"].default, true);
  assert.strictEqual(props["q-lint.processSymbols.enable"].default, false);
  assert.strictEqual(props["q-lint.referenceLens.enable"].default, true);
  assert.strictEqual(props["q-lint.inferredTypes.enable"].default, true);
  assert.strictEqual(props["q-lint.autoLoad.enable"].default, false);
});

test("a process's names are read, and matched as a search matches them", () => {
  const names = readProcessNames({ name: ["f", ".ns.g", ["t"], "x"], kind: ["function", "function", "table", "nonsense"] });
  assert.deepStrictEqual(names, [
    { name: "f", kind: "function" },
    { name: ".ns.g", kind: "function" },
    { name: "t", kind: "table" },
  ]);
  assert.throws(() => readProcessNames(42), /something other than its names/);
  assert.throws(() => readProcessNames({ name: ["a"], kind: [] }), /something other than its names/);
  // In order, in either case; shortest first; at most the limit.
  const many = readProcessNames({ name: [".ns.getRate", "rate", "gr", "other"], kind: ["function", "variable", "function", "variable"] });
  assert.deepStrictEqual(matching(many, "gR").map((n) => n.name), ["gr", ".ns.getRate"]);
  assert.deepStrictEqual(matching(many, "").map((n) => n.name), ["gr", "rate", "other", ".ns.getRate"]);
  assert.strictEqual(matching(many, "", 2).length, 2);
});

test("a process-only name opens as a note on what it is", () => {
  assert.strictEqual(
    processSymbolDocument(".ns.g", "function", "dev"),
    "/ .ns.g: a function on dev, defined in no workspace file.\n/ q-lint: Open Function Source reads its text from the process.\n",
  );
  assert.match(processSymbolDocument("t", "table", "dev"), /^\/ t: a table on dev/);
});

test("a lens's arguments and a slot are read only when well formed", () => {
  assert.deepStrictEqual(lensTarget("file:///a.q", { line: 1, character: 2 }), { uri: "file:///a.q", position: { line: 1, character: 2 } });
  assert.strictEqual(lensTarget("", { line: 1, character: 2 }), undefined);
  assert.strictEqual(lensTarget("file:///a.q", { line: 1.5, character: 2 }), undefined);
  const range = { start: { line: 1, character: 14 }, end: { line: 1, character: 16 } };
  const slot = readSlot({ range, index: 1, callee: ".lib.add", parameter: "b", hinted: false });
  assert.deepStrictEqual(slot, { range, index: 1, callee: ".lib.add", parameter: "b", hinted: false });
  assert.strictEqual(slotLabel(slot), "b:");
  assert.strictEqual(slotHover(slot), "argument 2 of .lib.add: b");
  // An inlay hint draws the name already; none is known.
  assert.strictEqual(slotLabel({ ...slot, hinted: true }), undefined);
  const unnamed = readSlot({ range, index: 0, callee: "f", parameter: null, hinted: false });
  assert.strictEqual(slotLabel(unnamed), undefined);
  assert.strictEqual(slotHover(unnamed), "argument 1 of f");
  assert.strictEqual(readSlot(null), undefined);
  assert.strictEqual(readSlot({ index: 0 }), undefined);
});

/// Decorations and editors that record what is drawn.
function fakeEditor() {
  const drawn = new Map();
  const types = [];
  vscode.window.createTextEditorDecorationType = (options) => {
    const type = { options, disposed: false, dispose() { this.disposed = true; } };
    types.push(type);
    return type;
  };
  vscode.window.activeTextEditor = undefined;
  vscode.Range = class {
    constructor(a, b, c, d) {
      if (typeof a === "object") Object.assign(this, { start: a, end: b, isEmpty: a.line === b.line && a.character === b.character });
      else Object.assign(this, { start: { line: a, character: b }, end: { line: c, character: d }, isEmpty: a === c && b === d });
    }
  };
  const editor = {
    document: { languageId: "q", uri: { scheme: "file", toString: () => "file:///ws/a.q" } },
    selection: { isEmpty: true, active: { line: 1, character: 15 } },
    setDecorations: (type, ranges) => drawn.set(types.indexOf(type), ranges),
  };
  return { editor, drawn, types };
}

test("the argument slot is highlighted, its name drawn where no hint draws it, and nothing is asked when off", async () => {
  stub.reset();
  const { editor, drawn, types } = fakeEditor();
  const asked = [];
  let answer = { range: { start: { line: 1, character: 14 }, end: { line: 1, character: 16 } }, index: 1, callee: ".lib.add", parameter: "b", hinted: false };
  const server = { sendRequest: async (method, params) => (asked.push([method, params]), answer) };
  const slot = registerArgumentSlot(stub.newContext(), () => server);
  // On by default.
  assert.strictEqual(slot.registered(), true);
  await slot.update(editor);
  assert.deepStrictEqual(asked, [[ARGUMENT_SLOT, { textDocument: { uri: "file:///ws/a.q" }, position: { line: 1, character: 15 } }]]);
  assert.strictEqual(drawn.get(0).length, 1);
  assert.strictEqual(drawn.get(1)[0].renderOptions.before.contentText, "b:");
  assert.deepStrictEqual(slot.shown().label, "b:");
  // The hint draws `b:` already: only the slot.
  answer = { ...answer, hinted: true };
  await slot.update(editor);
  assert.deepStrictEqual(drawn.get(1), []);
  assert.strictEqual(drawn.get(0).length, 1);
  // Outside a call: cleared.
  answer = null;
  await slot.update(editor);
  assert.deepStrictEqual([drawn.get(0), drawn.get(1)], [[], []]);
  assert.strictEqual(slot.shown(), undefined);
  // A selection, or a document that is no saved q file: not asked.
  const before = asked.length;
  await slot.update({ ...editor, selection: { isEmpty: false, active: editor.selection.active } });
  await slot.update({ ...editor, document: { languageId: "python", uri: editor.document.uri } });
  assert.strictEqual(asked.length, before);

  stub.config.user["argumentSlot.enable"] = false;
  stub.changeConfig("q-lint.argumentSlot.enable");
  assert.strictEqual(slot.registered(), false);
  assert.ok(types.every((t) => t.disposed));
  await slot.update(editor);
  assert.strictEqual(asked.length, before);
});

/// A workspace symbol API that records registrations.
function fakeSymbols() {
  const registered = [];
  vscode.languages = {
    registerWorkspaceSymbolProvider: (provider) => {
      const entry = { provider, disposed: false, dispose() { this.disposed = true; } };
      registered.push(entry);
      return entry;
    },
  };
  vscode.Uri.from = (parts) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}?${parts.query}` });
  vscode.Position = class {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  };
  vscode.Location = class {
    constructor(uri, position) {
      Object.assign(this, { uri, position });
    }
  };
  vscode.SymbolKind = { Function: 11, Variable: 12, Struct: 22 };
  vscode.SymbolInformation = class {
    constructor(name, kind, containerName, location) {
      Object.assign(this, { name, kind, containerName, location });
    }
  };
  return registered;
}

function fakeLive(process = { label: "dev", tags: [] }) {
  const sent = [];
  return {
    sent,
    activeProcess: () => process,
    activeLabel: () => process.label,
    borrow(use) {
      return use({ call: async (lambda, limit) => (sent.push({ lambda, limit }), { name: [".lib.add", "onproc", ".ns.tbl"], kind: ["function", "variable", "table"] }) }, process);
    },
  };
}

test("process names join a workspace search only while turned on, without the workspace's own", async () => {
  stub.reset();
  const registered = fakeSymbols();
  const asked = [];
  // The workspace defines .lib.add.
  const server = { sendRequest: async (method, params) => (asked.push([method, params]), params.names.map((n) => n === ".lib.add")) };
  const live = fakeLive();
  const symbols = registerProcessSymbols(stub.newContext(), live, () => server);
  // Off by default: no provider, nothing asked.
  assert.strictEqual(symbols.registered(), false);
  assert.strictEqual(registered.length, 0);
  assert.deepStrictEqual(await symbols.search(""), []);
  assert.deepStrictEqual(live.sent, []);
  assert.deepStrictEqual(asked, []);

  stub.config.user["processSymbols.enable"] = true;
  stub.changeConfig("q-lint.processSymbols.enable");
  assert.strictEqual(registered.length, 1);
  const found = await registered[0].provider.provideWorkspaceSymbols("o");
  assert.deepStrictEqual(
    found.map((s) => [s.name, s.kind, s.containerName]),
    [["onproc", 12, "dev (process)"]],
  );
  assert.strictEqual(found[0].location.uri.scheme, "q-lint-process-name");
  assert.strictEqual(live.sent.length, 1);
  assert.strictEqual(live.sent[0].limit, NAMES_LIMIT);
  assert.deepStrictEqual(asked, [[DEFINED_IN_WORKSPACE, { names: ["onproc"] }]]);
  // The next keystroke uses the names read a moment ago.
  const all = await symbols.search("");
  assert.deepStrictEqual(all.map((s) => s.name), ["onproc", ".ns.tbl"]);
  assert.strictEqual(all[1].kind, 22);
  assert.strictEqual(live.sent.length, 1);

  stub.config.user["processSymbols.enable"] = false;
  stub.changeConfig("q-lint.processSymbols.enable");
  assert.strictEqual(registered[0].disposed, true);
  assert.deepStrictEqual(await symbols.search(""), []);
  assert.strictEqual(live.sent.length, 1);
});

test("a process the read-only guard guards by a tag of its own is still read: the names are a fixed read-only call", async () => {
  stub.reset();
  const registered = fakeSymbols();
  stub.config.user["processSymbols.enable"] = true;
  stub.config.user["processes.readOnlyGuard.tags"] = ["ro"];
  const server = { sendRequest: async (method, params) => params.names.map(() => false) };
  const guarded = fakeLive({ label: "ro1", tags: ["ro"] });
  const found = await registerProcessSymbols(stub.newContext(), guarded, () => server).search("onproc");
  assert.deepStrictEqual(found.map((s) => s.name), ["onproc"]);
  assert.strictEqual(guarded.sent.length, 1);
  assert.strictEqual(guarded.sent[0].lambda, PROCESS_NAMES);
  assert.ok(!stub.messages.some(([kind]) => kind === "warning"), JSON.stringify(stub.messages));
  assert.strictEqual(registered.length, 1);
});

test("a production process, a busy one and no connection add nothing", async () => {
  stub.reset();
  fakeSymbols();
  stub.config.user["processSymbols.enable"] = true;
  const server = { sendRequest: async (method, params) => params.names.map(() => false) };
  const prod = fakeLive({ label: "live", tags: ["prod"] });
  assert.deepStrictEqual(await registerProcessSymbols(stub.newContext(), prod, () => server).search(""), []);
  assert.deepStrictEqual(prod.sent, []);
  const none = { activeProcess: () => undefined, activeLabel: () => undefined, borrow: () => undefined };
  assert.deepStrictEqual(await registerProcessSymbols(stub.newContext(), none, () => server).search(""), []);
  const busy = { activeProcess: () => ({ label: "dev", tags: [] }), activeLabel: () => undefined, borrow: () => undefined };
  assert.deepStrictEqual(await registerProcessSymbols(stub.newContext(), busy, () => server).search(""), []);
});
