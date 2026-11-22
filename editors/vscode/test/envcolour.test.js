// The environment colour (#1035): the colour a process's tags give, how
// it is drawn, and the status bar item and editor border through the
// stand-in `vscode` module - drawn on connect, gone on disconnect, and
// nothing at all while the switch is off (the default). No q process is
// involved: the feature sends nothing.
const { stub, vscode, EventEmitter } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const { readAdmin } = require("../out/admin.js");
const { DEFAULT_ENV_COLOURS, envColourOf, envPaint, readEnvColours } = require("../out/envcolour.js");
const { EnvironmentColour } = require("../out/envcolourview.js");

test("colours: the defaults, a setting's names and hex kept, junk dropped, the most cautious wins", () => {
  assert.deepStrictEqual(readEnvColours(undefined), DEFAULT_ENV_COLOURS);
  assert.deepStrictEqual(readEnvColours({ Prod: "RED", dev: "green", x: "pink", y: "#00ff00", z: 3, __proto__: "red" }), { prod: "red", dev: "green", y: "#00ff00" });
  const colours = readEnvColours(undefined);
  assert.deepStrictEqual(envColourOf(["fx", "uat", "prod"], colours), { tag: "prod", colour: "red" });
  assert.deepStrictEqual(envColourOf(["UAT"], colours), { tag: "UAT", colour: "amber" });
  assert.strictEqual(envColourOf(["dev"], colours), undefined);
  assert.strictEqual(envColourOf(["constructor"], colours), undefined);
  assert.deepStrictEqual(envColourOf(["a", "b"], { a: "#123456", b: "green" }), { tag: "b", colour: "green" });
  assert.deepStrictEqual(envPaint("red"), { background: "statusBarItem.errorBackground", theme: "charts.red" });
  assert.deepStrictEqual(envPaint("amber"), { background: "statusBarItem.warningBackground", theme: "charts.orange" });
  assert.deepStrictEqual(envPaint("blue"), { theme: "charts.blue" });
  assert.deepStrictEqual(envPaint("#abcdef"), { hex: "#abcdef" });
});

test("the switch: off by default, and the colours setting declared with the defaults", () => {
  assert.strictEqual(readAdmin((_k, f) => f).environmentColor, false);
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process admin");
  assert.strictEqual(section.properties["q-lint.processes.environmentColor.enable"].default, false);
  assert.deepStrictEqual(section.properties["q-lint.processes.environmentColor.colors"].default, DEFAULT_ENV_COLOURS);
});

function setUp(t) {
  stub.reset();
  const context = stub.newContext();
  const changed = new EventEmitter();
  let active;
  const live = { activeProcess: () => active, onDidChange: changed.event };
  const items = [];
  const types = [];
  const painted = [];
  vscode.window.createStatusBarItem = (id) => {
    const item = { id, shown: false, disposed: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() { this.disposed = true; } };
    items.push(item);
    return item;
  };
  vscode.window.createTextEditorDecorationType = (options) => {
    const type = { options, disposed: false, dispose() { this.disposed = true; } };
    types.push(type);
    return type;
  };
  const editor = (languageId) => ({ document: { languageId, lineCount: 3 }, setDecorations: (type, ranges) => painted.push({ languageId, type, ranges }) });
  vscode.window.visibleTextEditors = [editor("q"), editor("python")];
  vscode.window.onDidChangeVisibleTextEditors = () => ({ dispose() {} });
  vscode.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
  const env = new EnvironmentColour(context, live);
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
  });
  const connect = (process) => {
    active = process;
    changed.fire(process === undefined ? "disconnected" : "connected");
  };
  return { env, items, types, painted, connect, changed };
}

test("off (the default), nothing is drawn and nothing listens, whatever is connected", (t) => {
  const { env, items, types, connect, changed } = setUp(t);
  connect({ label: "p", host: "h", port: 1, tags: ["prod"] });
  assert.strictEqual(env.state(), undefined);
  assert.strictEqual(items.length + types.length, 0);
  assert.strictEqual(changed.listeners.length, 0);
});

test("on: a prod process gets a red item and a border on q editors; a disconnect takes them away", (t) => {
  const { env, items, types, painted, connect } = setUp(t);
  stub.config.user["processes.environmentColor.enable"] = true;
  stub.changeConfig("q-lint.processes.environmentColor.enable");
  connect({ label: "p1", host: "h", port: 1, tags: ["fx", "prod"] });
  assert.deepStrictEqual(env.state(), { label: "p1", tag: "prod", colour: "red", editors: 1 });
  const item = items[0];
  assert.strictEqual(item.shown, true);
  assert.strictEqual(item.text, "$(circle-large-filled) PROD");
  assert.strictEqual(item.backgroundColor.id, "statusBarItem.errorBackground");
  assert.strictEqual(types[0].options.borderColor.id, "charts.red");
  assert.deepStrictEqual(painted.map((p) => p.languageId), ["q"]);
  // A uat process: amber, a new decoration type.
  connect({ label: "u1", host: "h", port: 2, tags: ["uat"] });
  assert.deepStrictEqual(env.state(), { label: "u1", tag: "uat", colour: "amber", editors: 1 });
  assert.strictEqual(types[0].disposed, true);
  assert.strictEqual(item.backgroundColor.id, "statusBarItem.warningBackground");
  // An uncoloured process, then none: nothing drawn.
  connect({ label: "d", host: "h", port: 3, tags: ["dev"] });
  assert.strictEqual(env.state(), undefined);
  assert.strictEqual(item.shown, false);
  connect(undefined);
  assert.strictEqual(env.state(), undefined);
  // The colours setting applies at once: dev made blue (text, no background).
  stub.config.user["processes.environmentColor.colors"] = { dev: "blue" };
  connect({ label: "d", host: "h", port: 3, tags: ["dev"] });
  stub.changeConfig("q-lint.processes.environmentColor.colors");
  assert.deepStrictEqual(env.state(), { label: "d", tag: "dev", colour: "blue", editors: 1 });
  assert.strictEqual(item.backgroundColor, undefined);
  assert.strictEqual(item.color.id, "charts.blue");
});

test("turned off while drawn, the item and decoration are disposed and listening stops", (t) => {
  const s = setUp(t);
  stub.config.user["processes.environmentColor.enable"] = true;
  stub.changeConfig("q-lint.processes.environmentColor.enable");
  s.connect({ label: "p1", host: "h", port: 1, tags: ["prod"] });
  assert.ok(s.env.state());
  stub.config.user["processes.environmentColor.enable"] = false;
  stub.changeConfig("q-lint.processes.environmentColor.enable");
  assert.strictEqual(s.env.state(), undefined);
  assert.strictEqual(s.items[0].disposed, true);
  assert.strictEqual(s.types[0].disposed, true);
  assert.strictEqual(s.changed.listeners.length, 0);
});
