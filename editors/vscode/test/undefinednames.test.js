// The undefined-name check against the process (#945): what the server's
// list and the process's answer become, and the check's life - registered
// only while q-lint.undefinedNames.enable is on (off by default), its
// command refusing and nothing sent when it is off, a production process
// asked only by the command and after a confirmation. The q side is
// undefinednames_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { readUnresolved, namesToAsk, readDefined, undefinedOnProcess, undefinedMessage } = require("../out/undefinednames.js");
const { registerUndefinedNames, CHECK_UNDEFINED, UNRESOLVED, SOURCE } = require("../out/undefinednamesview.js");
const pkg = require("../package.json");

const range = (line, a, b) => ({ start: { line, character: a }, end: { line, character: b } });
const FOUND = [
  { names: [".lib.missing"], written: ".lib.missing", range: range(0, 21, 33) },
  { names: ["other"], written: "other", range: range(0, 34, 39) },
  { names: ["trade"], written: "trade", range: range(1, 15, 20) },
  { names: [".a.f", "f"], written: "f", range: range(2, 0, 1) },
];

test("the server's list, the names asked once each, and what neither defines", () => {
  assert.deepStrictEqual(readUnresolved([...FOUND, { names: ["bad name"], written: "x", range: range(0, 0, 1) }, { names: [], written: "y" }, null]), FOUND);
  assert.deepStrictEqual(readUnresolved("junk"), []);
  const asked = namesToAsk([...FOUND, FOUND[1]]);
  assert.deepStrictEqual(asked, [".lib.missing", "other", "trade", ".a.f", "f"]);
  const defined = readDefined([false, false, true, false, true], asked);
  assert.deepStrictEqual(
    undefinedOnProcess(FOUND, defined).map((u) => u.written),
    [".lib.missing", "other"],
  );
  assert.strictEqual(undefinedMessage(FOUND[0], "dev"), ".lib.missing is defined neither in the workspace nor on dev");
  assert.strictEqual(undefinedMessage(FOUND[3], "dev"), "f is defined neither in the workspace nor on dev");
  // One name answers one boolean, which may come back as an atom.
  assert.deepStrictEqual([...readDefined(true, ["x"])], [["x", true]]);
  assert.throws(() => readDefined([true], ["x", "y"]), /which names it defines/);
});

test("the switch is declared off by default, and the command only where it can run", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.undefinedNames.enable"].default, false);
  const command = pkg.contributes.commands.find((c) => c.command === CHECK_UNDEFINED);
  assert.strictEqual(command.title, "Check Undefined Names on Process");
  const palette = pkg.contributes.menus.commandPalette.find((m) => m.command === CHECK_UNDEFINED);
  assert.match(palette.when, /config\.q-lint\.undefinedNames\.enable/);
});

/// Diagnostics and events, recorded.
function fakeEditor() {
  const collections = [];
  vscode.languages = {
    createDiagnosticCollection: (name) => {
      const c = {
        name,
        entries: new Map(),
        disposed: false,
        set(uri, list) {
          this.entries.set(String(uri), list);
        },
        delete(uri) {
          this.entries.delete(String(uri));
        },
        clear() {
          this.entries.clear();
        },
        dispose() {
          this.disposed = true;
        },
      };
      collections.push(c);
      return c;
    },
  };
  vscode.Diagnostic = class {
    constructor(range, message, severity) {
      Object.assign(this, { range, message, severity });
    }
  };
  vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
  vscode.Range = class {
    constructor(a, b, c, d) {
      Object.assign(this, { a, b, c, d });
    }
  };
  const listeners = {};
  const on = (name) => (l) => ((listeners[name] ??= []).push(l), { dispose: () => (listeners[name] = listeners[name].filter((x) => x !== l)) });
  vscode.workspace.onDidOpenTextDocument = on("open");
  vscode.workspace.onDidSaveTextDocument = on("save");
  vscode.workspace.onDidCloseTextDocument = on("close");
  vscode.window.onDidChangeActiveTextEditor = on("active");
  vscode.window.activeTextEditor = undefined;
  return { collections, listeners };
}

function fakeLive(process = { label: "dev", tags: [] }) {
  const sent = [];
  const changes = [];
  return {
    sent,
    process,
    activeProcess() {
      return this.process;
    },
    activeLabel() {
      return this.process?.label;
    },
    onDidChange: (l) => (changes.push(l), { dispose() {} }),
    fire: (what) => changes.forEach((l) => l(what)),
    borrow(use) {
      return use({ call: async (lambda, names) => (sent.push(names), names.split(" ").map((n) => n === "trade" || n === "f")) }, this.process);
    },
  };
}

const doc = { languageId: "q", uri: { scheme: "file", fsPath: "/ws/main.q", toString: () => "file:///ws/main.q" } };

test("off, nothing is registered or sent and the command refuses; on, a saved file is warned on what neither defines", async () => {
  stub.reset();
  const { collections, listeners } = fakeEditor();
  const asked = [];
  const server = { sendRequest: async (method, params) => (asked.push([method, params]), FOUND) };
  const live = fakeLive();
  const check = registerUndefinedNames(stub.newContext(), live, () => server);
  assert.strictEqual(check.registered(), false);
  assert.strictEqual(collections.length, 0);
  vscode.window.activeTextEditor = { document: doc };
  assert.strictEqual(await stub.commands.get(CHECK_UNDEFINED)(), undefined);
  assert.match(stub.messages.at(-1)[1], /The undefined-name check against the process is turned off\. Set q-lint\.undefinedNames\.enable to true/);
  assert.match(await check.check(doc, true), /turned off/);
  assert.deepStrictEqual(asked, []);
  assert.deepStrictEqual(live.sent, []);

  stub.config.user["undefinedNames.enable"] = true;
  stub.changeConfig("q-lint.undefinedNames.enable");
  assert.strictEqual(collections.length, 1);
  // Turned on with a q file at the front: it is checked at once.
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(asked[0], [UNRESOLVED, { textDocument: { uri: "file:///ws/main.q" } }]);
  assert.deepStrictEqual(live.sent, [".lib.missing other trade .a.f f"]);
  const shown = collections[0].entries.get("file:///ws/main.q");
  assert.deepStrictEqual(
    shown.map((d) => [d.message, d.severity, d.source]),
    [
      [".lib.missing is defined neither in the workspace nor on dev", 1, SOURCE],
      ["other is defined neither in the workspace nor on dev", 1, SOURCE],
    ],
  );
  // A save checks again; a disconnect clears; a close forgets the file.
  listeners.save.forEach((l) => l(doc));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(live.sent.length, 2);
  live.fire("disconnected");
  assert.strictEqual(collections[0].entries.size, 0);
  // The command, on.
  assert.strictEqual(await stub.commands.get(CHECK_UNDEFINED)(), undefined);
  assert.strictEqual(collections[0].entries.get("file:///ws/main.q").length, 2);
  listeners.close.forEach((l) => l(doc));
  assert.strictEqual(collections[0].entries.size, 0);

  // Off: cleared and disposed, and nothing more is sent.
  const before = live.sent.length;
  stub.config.user["undefinedNames.enable"] = false;
  stub.changeConfig("q-lint.undefinedNames.enable");
  assert.strictEqual(collections[0].disposed, true);
  assert.strictEqual(listeners.save.length, 0);
  assert.strictEqual(live.sent.length, before);
});

test("a production process is asked only by the command, after a confirmation", async () => {
  stub.reset();
  fakeEditor();
  stub.config.user["undefinedNames.enable"] = true;
  const server = { sendRequest: async () => FOUND };
  const live = fakeLive({ label: "live", tags: ["prd"] });
  const check = registerUndefinedNames(stub.newContext(), live, () => server);
  assert.match(await check.check(doc, false), /production process, checked only when asked/);
  assert.deepStrictEqual(live.sent, []);
  stub.picks.push(undefined);
  assert.strictEqual(await check.check(doc, true), "not checked.");
  assert.deepStrictEqual(live.sent, []);
  stub.picks.push("Check");
  assert.strictEqual(await check.check(doc, true), undefined);
  assert.strictEqual(live.sent.length, 1);
  // With no connection, nothing is asked and the warnings go.
  live.process = undefined;
  assert.match(await check.check(doc, true), /connect to a q process first/);
  assert.strictEqual(check.collection().entries.size, 0);
});
