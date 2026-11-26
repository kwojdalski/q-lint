// Logpoints (#984) with the vscode stub: Add Logpoint sends the wrapper for
// the function at the cursor through the guard, the editor marks it, Remove
// Logpoint and Show Logpoint Hits read the process's own list; turned off,
// every command refuses and nothing is sent.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { LOGPOINT_COMMANDS, LOG_ADD, LOG_REMOVE, LOG_LIST, addLogpoint, readLogpoints, hitLines } = require("../out/logpoint.js");
const { registerLogpoints } = require("../out/logpointview.js");
const { DRIFT } = require("../out/definitions.js");

test("the process's list and hits are read whatever shape q gives them", () => {
  assert.deepStrictEqual(readLogpoints({ names: "sq", hits: [] }), { names: ["sq"], hits: [] });
  assert.deepStrictEqual(readLogpoints({ names: [], hits: [["2026.01.01D00:00:00", "sq", ",3"], "junk"] }), {
    names: [],
    hits: [{ time: "2026.01.01D00:00:00", name: "sq", args: ",3" }],
  });
  assert.throws(() => readLogpoints(1), /something other than its logpoints/);
  assert.deepStrictEqual(hitLines("dev", []), ["# dev: no logpoint has been hit"]);
});

// A run's text in the function goes when the run ends: a logpoint written
// into it would go too, so none is sent meanwhile.
test("a function a coverage run holds takes no logpoint until the run is over", async () => {
  const sent = [];
  const call = async (q, ...args) => (sent.push(q), q === DRIFT ? { name: args, state: ["lambda"], text: ["{x*x}"], via: ["cov"] } : "sq");
  await assert.rejects(addLogpoint(call, "sq"), /a coverage run holds it just now; add the logpoint when that is over/);
  assert.deepStrictEqual(sent, [DRIFT]);
});

function setup(text = "/ lib\nsq:{x*x}\n\\d .fx\nmid:{[b;a] (b+a)%2}\n", file = "/w/lib.q") {
  stub.reset();
  const lines = text.split("\n");
  const decorated = [];
  vscode.window.createTextEditorDecorationType = () => ({ disposed: false, dispose() { this.disposed = true; } });
  vscode.window.activeTextEditor = {
    document: { uri: vscode.Uri.file(file), languageId: "q", getText: () => text, lineAt: (i) => ({ range: { line: i }, text: lines[i] }) },
    selection: { active: { line: 3 } },
    setDecorations: (_d, ranges) => decorated.push(ranges.map((r) => r.range.line)),
  };
  const sent = [];
  const held = new Set();
  const connection = {
    call: async (lambda, name) => {
      // Add Logpoint reads the function's text first, and sends it back with the logging in it.
      if (lambda === DRIFT) return { name: [name], state: ["lambda"], text: ["{x}"] };
      sent.push([lambda, name]);
      if (lambda === LOG_ADD) return held.add(name), name;
      if (lambda === LOG_REMOVE) return held.delete(name), true;
      if (lambda === LOG_LIST) return { names: [...held], hits: [["t", "sq", ",3"]] };
      throw new Error("unexpected");
    },
  };
  const process = { label: "dev", tags: [] };
  const live = {
    guarded: [],
    activeLabel: () => "dev",
    activeProcess: () => process,
    borrow: (use) => use(connection, process),
    onDidChange(listener) {
      this.changed = listener;
      return { dispose() {} };
    },
    async runOnActive(code, query) {
      this.guarded.push(code);
      return { process: "dev", value: await query(connection) };
    },
  };
  const lines2 = [];
  vscode.window.createOutputChannel = () => ({ clear() {}, appendLine: (l) => lines2.push(l), show() {}, dispose() {} });
  const api = registerLogpoints(stub.newContext(), live);
  return { sent, live, api, decorated, output: lines2, held };
}

// A function redefined by a query lost its wrapper, yet the editor kept
// marking it from the window's list (#2558).
test("after a query, a process marked with logpoints is read again: a redefined function is no longer marked", async () => {
  const s = setup();
  await stub.commands.get(LOGPOINT_COMMANDS.add)("sq");
  assert.deepStrictEqual(s.api.marked(), [1]);
  // The user's file run again redefines sq: the process lists it no more.
  s.held.delete("sq");
  s.live.changed("queried");
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(s.sent.at(-1), [LOG_LIST, undefined]);
  assert.deepStrictEqual(s.api.logged(), { dev: [] });
  assert.deepStrictEqual(s.api.marked(), []);
  // With nothing marked, a query sends nothing more.
  const before = s.sent.length;
  s.live.changed("queried");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(s.sent.length, before);
});

test("Add Logpoint wraps the function at the cursor through the guard and marks it; Remove puts it back", async () => {
  const s = setup();
  await stub.commands.get(LOGPOINT_COMMANDS.add)();
  assert.deepStrictEqual(s.sent, [[LOG_ADD, ".fx.mid"]]);
  assert.deepStrictEqual(s.live.guarded, [LOG_ADD]);
  assert.deepStrictEqual(s.api.logged(), { dev: [".fx.mid"] });
  assert.deepStrictEqual(s.api.marked(), [3]);
  await stub.commands.get(LOGPOINT_COMMANDS.add)("sq");
  assert.deepStrictEqual(s.api.marked(), [1, 3]);
  await stub.commands.get(LOGPOINT_COMMANDS.hits)();
  assert.deepStrictEqual(s.output, ["# dev: the last 1 logpoint hit, oldest first", "t sq ,3"]);
  // Remove: the one at the cursor, read from the process's own list first.
  await stub.commands.get(LOGPOINT_COMMANDS.remove)();
  assert.deepStrictEqual(s.sent.slice(-2), [[LOG_LIST, undefined], [LOG_REMOVE, ".fx.mid"]]);
  assert.deepStrictEqual(s.api.marked(), [1]);
  await stub.commands.get(LOGPOINT_COMMANDS.removeAll)();
  assert.deepStrictEqual(s.sent.slice(-1), [[LOG_REMOVE, "sq"]]);
  assert.deepStrictEqual(s.api.marked(), []);
  assert.deepStrictEqual(s.live.guarded, [LOG_ADD, LOG_ADD, LOG_REMOVE, LOG_REMOVE]);
});

// The process holds a module's `f` as `.m.mymod.f`: a logpoint on `f` was
// one on a name it does not have.
test("Add Logpoint names a KDB-X module's function in the module's context (#2917)", async (t) => {
  const s = setup("/ a module\nhlp:{x+1}\nexport:([hlp])\n\n", "/w/mymod/init.q");
  vscode.workspace.asRelativePath = (uri) => uri.fsPath.replace(/^\/w\//, "");
  t.after(() => delete vscode.workspace.asRelativePath);
  vscode.window.activeTextEditor.selection = { active: { line: 1 } };
  await stub.commands.get(LOGPOINT_COMMANDS.add)();
  assert.deepStrictEqual(s.sent, [[LOG_ADD, ".m.mymod.hlp"]]);
  assert.deepStrictEqual(s.api.marked(), [1]);
});

test("Add Logpoint takes a function named as a symbol, `.fx.mid, as the name .fx.mid (#2649)", async () => {
  const s = setup();
  await stub.commands.get(LOGPOINT_COMMANDS.add)("`.fx.mid");
  assert.deepStrictEqual(s.sent, [[LOG_ADD, ".fx.mid"]]);
  assert.deepStrictEqual(s.api.logged(), { dev: [".fx.mid"] });
});

test("off, every command refuses, nothing is sent, and the marks go", async () => {
  const s = setup();
  await stub.commands.get(LOGPOINT_COMMANDS.add)();
  stub.config.user["logpoints.enable"] = false;
  stub.changeConfig("q-lint.logpoints.enable");
  assert.deepStrictEqual(s.api.marked(), []);
  const before = s.sent.length;
  for (const command of Object.values(LOGPOINT_COMMANDS)) {
    await stub.commands.get(command)();
    assert.match(stub.messages.at(-1)[1], /q-lint\.logpoints\.enable to true/);
  }
  assert.strictEqual(s.sent.length, before);
});

test("Remove Logpoint removes only on the process it listed, not one connected while it asked (#1294)", async (t) => {
  const { setUp, fakeQ, heads } = require("./fakeq.js");
  vscode.window.createTextEditorDecorationType = () => ({ dispose() {} });
  vscode.window.activeTextEditor = undefined;
  const answer = (m) => ((Array.isArray(m) ? m[0] : m) === LOG_LIST ? { names: ["f", "g"], hits: [] } : true);
  const { q, live, context } = await setUp(t, { answer, register: registerLogpoints });
  const other = await fakeQ(answer);
  t.after(() => other.close());
  await context.globalState.update("q-lint.processes", [
    { label: "a", host: "127.0.0.1", port: q.port, tags: [] },
    { label: "b", host: "127.0.0.1", port: other.port, tags: [] },
  ]);
  live.refreshProcesses();
  await live.connectTo("a");
  stub.picks.push(async () => (await live.connectTo("b"), "g"));
  await stub.commands.get(LOGPOINT_COMMANDS.remove)();
  assert.ok(!heads(q.sent).includes(LOG_REMOVE) && !heads(other.sent).includes(LOG_REMOVE));
  assert.ok(stub.messages.some(([, m]) => /the logpoint on g was not removed: a is no longer the active process/.test(m)), JSON.stringify(stub.messages));
});

test("turned off while Add Logpoint asks for the name, nothing is wrapped (#1453)", async () => {
  const s = setup();
  vscode.window.activeTextEditor = undefined;
  stub.inputs.push(() => {
    stub.config.user["logpoints.enable"] = false;
    stub.changeConfig("q-lint.logpoints.enable");
    return ".ns.f";
  });
  await stub.commands.get(LOGPOINT_COMMANDS.add)();
  assert.deepStrictEqual(s.sent, []);
  assert.deepStrictEqual(s.api.logged(), {});
  assert.match(stub.messages.at(-1)[1], /q-lint\.logpoints\.enable to true/);
});

test("turned off, the logpoints output channel goes too (#1461)", async () => {
  const s = setup();
  const channels = [];
  vscode.window.createOutputChannel = () => {
    const channel = { disposed: false, clear() {}, appendLine() {}, show() {}, dispose() { this.disposed = true; } };
    channels.push(channel);
    return channel;
  };
  await stub.commands.get(LOGPOINT_COMMANDS.hits)();
  assert.strictEqual(channels.length, 1);
  stub.config.user["logpoints.enable"] = false;
  stub.changeConfig("q-lint.logpoints.enable");
  assert.strictEqual(channels[0].disposed, true);
  // On again, Show Logpoint Hits makes a new one.
  stub.config.user["logpoints.enable"] = true;
  stub.changeConfig("q-lint.logpoints.enable");
  await stub.commands.get(LOGPOINT_COMMANDS.hits)();
  assert.strictEqual(channels.length, 2);
  assert.ok(s.sent.length > 0);
});
