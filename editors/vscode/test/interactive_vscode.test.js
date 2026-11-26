// Running code interactively, through the stand-in `vscode` (vscode_stub.js)
// and a q process played by a socket server: cells and the Interactive
// Window (#956), Smart Send (#957), the cell lenses (#958), the q REPL pane
// (#959) and `.qlint.view` (#960) - each with its switch off, and each
// through the read-only guard (#918). No q and no editor needed; the same
// paths against a real q are interactive_q.test.js.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");
const { Live } = require("../out/live.js");
const { registerInteractive } = require("../out/interactiveview.js");
const { registerRepl } = require("../out/replview.js");
const { registerViewHelpers } = require("../out/viewhelpers.js");
const { INTERACTIVE_COMMANDS: C } = require("../out/interactiveconfig.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GRID = { count: 2, keys: 0, names: ["a"], types: [7], cells: [["1", "2"]], raw: [[1, 2]], rank: [[0, 1]], tree: [] };
const GATHERED = { rows: [{ ns: ".", name: "trades", kind: "table", type: 98, count: 1, cols: [], keys: [], params: [], partitioned: false }], spaces: [{ ns: ".", total: 1 }], more: 0 };

/// A q process played by a socket server. A query's statements are kept in
/// `queries`; one containing `boom` fails, and one calling `.qlint.view`
/// is preceded by the async message the real definition sends.
async function fakeQ() {
  const queries = [];
  let gathers = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    const send = (value, type) => {
      const out = serialize(value);
      out.writeUInt8(type, 1);
      socket.write(out);
    };
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        const m = deserialize(message);
        if (Array.isArray(m) && typeof m[0] === "string" && m[0].includes("`rows`spaces`more")) {
          gathers++;
          send(GATHERED, 2);
          continue;
        }
        const code = Array.isArray(m) && Array.isArray(m[1]) ? m[1].join("\n") : String(m);
        queries.push(code);
        if (code.includes(".qlint.view")) {
          send(["qlint", "view", { ok: true, type: 98, text: ["a", "-", "1", "2"], grid: GRID }], 0);
        }
        send(code.includes("boom") ? { ok: false, error: "boom", trace: "" } : { ok: true, type: -7, text: [`ran ${queries.length}`] }, 2);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    queries,
    gathers: () => gathers,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/// Record lens provider registrations, and give the classes the providers build.
function fakeLanguages() {
  const registered = [];
  vscode.languages = {
    registerCodeLensProvider: (selector, provider) => {
      const entry = { selector, provider, disposed: false, dispose() { this.disposed = true; } };
      registered.push(entry);
      return entry;
    },
  };
  vscode.CodeLens = class { constructor(range, command) { this.range = range; this.command = command; } };
  vscode.Range = class { constructor(a, b, c, d) { Object.assign(this, { start: { line: a, character: b }, end: { line: c, character: d } }); } };
  vscode.Selection = class { constructor(a, b, c, d) { this.active = { line: c, character: d }; this.isEmpty = true; } };
  vscode.TextEditorRevealType = { Default: 0 };
  return registered;
}

async function setUp(t, { tags = [], config = {} } = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const lenses = fakeLanguages();
  const q = await fakeQ();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "dev", host: "127.0.0.1", port: q.port, tags }]);
  const live = new Live(context);
  const repl = registerRepl(context, live);
  const interactive = registerInteractive(context, live, repl);
  const view = registerViewHelpers(context, live);
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    vscode.workspace.textDocuments = [];
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  /// A q editor on `text`, its cursor on `line`.
  const editor = (text, line = 0) => {
    const uri = vscode.Uri.file("/w/a.q");
    const document = { uri, languageId: "q", getText: (range) => (range ? text : text), lineAt: (l) => ({ text: text.split("\n")[l] ?? "" }) };
    const e = { document, selection: { active: { line }, isEmpty: true }, revealRange() {} };
    vscode.window.activeTextEditor = e;
    vscode.workspace.textDocuments = [document];
    return e;
  };
  return { q, live, context, interactive, repl, view, lenses, editor };
}

const FILE = "/ %% setup\na:1\nb:2\n/ %% fail\nboom\n/ %% last\nc:3";
const asked = () => stub.messages.filter(([kind, text]) => kind === "warning" && /would change/.test(text));
const said = (re) => stub.messages.some(([, text]) => re.test(text));

test("Run Cell runs the cell at the cursor into the Interactive Window; Run Above and Run Below stop at the first failure", async (t) => {
  const { q, live, interactive, editor } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  editor(FILE, 2);
  await stub.commands.get(C.runCell)();
  assert.deepStrictEqual(q.queries, ["a:1\nb:2"], "the cell's statements, without its marker");
  assert.deepStrictEqual(
    interactive.entries().map(({ title, code, process, ok, lines }) => ({ title, code, process, ok, lines })),
    [{ title: "setup", code: "a:1\nb:2", process: "dev", ok: true, lines: ["ran 1"] }],
  );
  // Run Below from the first cell: setup, then fail, which stops it.
  await stub.commands.get(C.runBelow)("file:///w/a.q", 0);
  assert.deepStrictEqual(q.queries.slice(1), ["a:1\nb:2", "boom"]);
  assert.strictEqual(interactive.entries().at(-1).ok, false);
  assert.deepStrictEqual(interactive.entries().at(-1).lines, ["'boom"]);
  // Run Above the last cell: the two before it, stopping at fail again.
  await stub.commands.get(C.runAbove)("file:///w/a.q", 5);
  assert.deepStrictEqual(q.queries.slice(3), ["a:1\nb:2", "boom"]);
  // Run All Cells, and each run is in Query History.
  await stub.commands.get(C.clearInteractive)();
  assert.deepStrictEqual(interactive.entries(), []);
  assert.strictEqual(live.history()[0].code, "boom");
  assert.strictEqual(live.history()[0].outcome, "error");
  // A file without markers has no cells, and says so.
  editor("a:1\nb:2", 0);
  await stub.commands.get(C.runCell)();
  assert.ok(said(/has no cells/));
  assert.strictEqual(q.queries.length, 5);
});

test("the lenses: Run Cell, Run Above (not on the first cell) and Run Below on each marker", async (t) => {
  const { lenses, interactive, editor } = await setUp(t);
  const e = editor(FILE);
  assert.strictEqual(lenses.length, 1);
  assert.strictEqual(interactive.lensesRegistered(), true);
  const drawn = lenses[0].provider.provideCodeLenses(e.document);
  assert.deepStrictEqual(
    drawn.map((l) => `${l.range.start.line}:${l.command.title}`),
    ["0:Run Cell", "0:Run Below", "3:Run Cell", "3:Run Above", "3:Run Below", "5:Run Cell", "5:Run Above", "5:Run Below"],
  );
  assert.deepStrictEqual(drawn[2].command.arguments, ["file:///w/a.q", 3]);
});

test("with cells off nothing is sent, the commands refuse and no lens is drawn; turned on again, they are back", async (t) => {
  const { q, live, lenses, interactive, editor } = await setUp(t, { config: { "cells.enable": false } });
  assert.ok(await live.connectTo("dev"));
  const e = editor(FILE, 1);
  assert.strictEqual(lenses.length, 0, "no provider registered");
  for (const command of [C.runCell, C.runAllCells, C.runAbove, C.runBelow, C.openInteractive]) {
    stub.messages = [];
    await stub.commands.get(command)("file:///w/a.q", 3);
    assert.ok(said(/q-lint\.cells\.enable/), command);
  }
  assert.deepStrictEqual(q.queries, []);
  assert.strictEqual(interactive.isOpen(), false);
  // On without a reload.
  stub.config.user["cells.enable"] = true;
  stub.changeConfig("q-lint.cells.enable");
  assert.strictEqual(lenses.length, 1);
  assert.strictEqual(lenses[0].provider.provideCodeLenses(e.document).length, 8);
  // Only the lenses off: the provider goes, Run Above and Below refuse, Run Cell still runs.
  stub.config.user["cells.codeLens.enable"] = false;
  stub.changeConfig("q-lint.cells.codeLens.enable");
  assert.strictEqual(lenses[0].disposed, true);
  assert.strictEqual(interactive.lensesRegistered(), false);
  assert.deepStrictEqual(interactive.lenses(e.document), []);
  stub.messages = [];
  await stub.commands.get(C.runAbove)("file:///w/a.q", 3);
  assert.ok(said(/q-lint\.cells\.codeLens\.enable/));
  assert.deepStrictEqual(q.queries, []);
  await stub.commands.get(C.runCell)();
  assert.deepStrictEqual(q.queries, ["a:1\nb:2"]);
});

test("a cell that would change a guarded process asks first; declined, nothing is sent", async (t) => {
  const { q, live, interactive, editor } = await setUp(t, { tags: ["prod"] });
  assert.ok(await live.connectTo("dev"));
  editor("/ %% write\nt:([] a:1 2)", 1);
  stub.picks = [undefined];
  await stub.commands.get(C.runCell)();
  assert.strictEqual(asked().length, 1);
  assert.deepStrictEqual(q.queries, []);
  assert.deepStrictEqual(interactive.entries(), [], "the run is taken back out");
  stub.picks = ["Run Anyway"];
  await stub.commands.get(C.runCell)();
  assert.deepStrictEqual(q.queries, ["t:([] a:1 2)"]);
});

test("Smart Send: off it refuses and sends nothing; on it sends the statement and moves the cursor to the next", async (t) => {
  const { q, live, interactive, repl, editor } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  const text = "a:1\nf:{\n  x+1}\n/ note\nb:2";
  let e = editor(text, 1);
  await stub.commands.get(C.smartSend)();
  assert.ok(said(/q-lint\.smartSend\.enable/));
  assert.deepStrictEqual(q.queries, []);
  assert.strictEqual(e.selection.active.line, 1, "nor moved");
  stub.config.user["smartSend.enable"] = true;
  await stub.commands.get(C.smartSend)();
  assert.deepStrictEqual(q.queries, ["f:{\n  x+1}"]);
  assert.strictEqual(e.selection.active.line, 4);
  // On a comment line, nothing is sent and the cursor moves on.
  e = editor(text, 3);
  await stub.commands.get(C.smartSend)();
  assert.strictEqual(q.queries.length, 1);
  assert.strictEqual(e.selection.active.line, 4);
  // To the Interactive Window, and to the REPL pane.
  stub.config.user["smartSend.target"] = "interactiveWindow";
  e = editor(text, 0);
  await stub.commands.get(C.smartSend)();
  assert.deepStrictEqual(interactive.entries().map((x) => x.code), ["a:1"]);
  stub.config.user["smartSend.target"] = "repl";
  editor(text, 4);
  await stub.commands.get(C.smartSend)();
  assert.deepStrictEqual(repl.entries().map((x) => x.code), ["b:2"]);
  assert.deepStrictEqual(q.queries.slice(1), ["a:1", "b:2"]);
  // To the q terminal, each statement as one line, as Send Current Block does.
  const typed = [];
  const original = vscode.window.createTerminal;
  vscode.window.createTerminal = () => ({ sendText: (line) => typed.push(line), show() {}, dispose() {} });
  t.after(() => (vscode.window.createTerminal = original));
  stub.config.user["smartSend.target"] = "terminal";
  editor(text, 1);
  await stub.commands.get(C.smartSend)();
  assert.strictEqual(typed.length, 2, "the line that starts q, then the statement");
  assert.match(typed[1], /^f:\{ *x\+1\}$/);
  assert.strictEqual(q.queries.length, 3, "nothing went to the process");
});

test("the REPL's input is cleared for a line it sent, not for a run from the editor (#1922)", async (t) => {
  const { live, repl } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  const posted = [];
  const original = vscode.window.createWebviewPanel;
  vscode.window.createWebviewPanel = (...given) => {
    const panel = original(...given);
    return new Proxy(panel, { get: (p, key) => (key === "webview" ? new Proxy(p.webview, { get: (w, k) => (k === "postMessage" ? async (m) => void posted.push(m) : w[k]) }) : p[key]), set: (p, key, value) => ((p[key] = value), true) });
  };
  t.after(() => (vscode.window.createWebviewPanel = original));
  const kinds = () => posted.filter((m) => m.type === "accepted" || m.type === "history");
  await repl.runFromEditor("a:1", vscode.Uri.file("/w/a.q"));
  assert.deepStrictEqual(kinds(), [{ type: "history", history: ["a:1"] }]);
  assert.strictEqual(await repl.enter("b:2"), "ran");
  assert.deepStrictEqual(kinds().slice(1), [{ type: "accepted", history: ["b:2", "a:1"], code: "b:2" }]);
});

test("the REPL: Enter inside a bracket starts a new line; a complete input runs, is kept, and lands in Query History", async (t) => {
  const { q, live, repl, context } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  await stub.commands.get(C.openRepl)();
  assert.strictEqual(repl.isOpen(), true);
  assert.strictEqual(await repl.enter("f:{x+"), "newline");
  assert.deepStrictEqual(q.queries, []);
  assert.strictEqual(await repl.enter("f:{x+\ny}\nf[1;2]"), "ran");
  assert.deepStrictEqual(q.queries, ["f:{x+\n y}\nf[1;2]"], "the line inside the bracket is a continuation");
  assert.deepStrictEqual(repl.entries()[0].lines, ["ran 1"]);
  assert.deepStrictEqual(repl.history(), ["f:{x+\ny}\nf[1;2]"]);
  assert.deepStrictEqual(context.globalState.get("q-lint.replHistory"), ["f:{x+\ny}\nf[1;2]"]);
  assert.strictEqual(live.history()[0].code, "f:{x+\n y}\nf[1;2]");
  // Another window's run, written to the shared history meanwhile, is kept (#1694).
  await context.globalState.update("q-lint.replHistory", ["x:1", ...context.globalState.get("q-lint.replHistory")]);
  await repl.enter("count trades");
  assert.deepStrictEqual(context.globalState.get("q-lint.replHistory"), ["count trades", "x:1", "f:{x+\ny}\nf[1;2]"]);
  assert.deepStrictEqual(repl.search("f[", 0), { index: 2, code: "f:{x+\ny}\nf[1;2]" });
  assert.deepStrictEqual(repl.search("zzz", 0), { index: -1, code: "" });
  // A stored history that is no list of strings: a run and a search do not throw (#1888).
  await context.globalState.update("q-lint.replHistory", [null, "x:1", 3]);
  assert.deepStrictEqual(repl.search("x", 0), { index: 0, code: "x:1" });
  await context.globalState.update("q-lint.replHistory", { not: "a list" });
  assert.deepStrictEqual(repl.search("x", 0), { index: -1, code: "" });
  assert.strictEqual(await repl.enter("1+1"), "ran");
  assert.deepStrictEqual(context.globalState.get("q-lint.replHistory"), ["1+1"]);
});

test("the REPL's Tab offers q's words, the language server's symbols and the process's names", async (t) => {
  const { q, live, repl } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  stub.commands.set("vscode.executeWorkspaceSymbolProvider", async (query) => (query === "tr" ? [{ name: "trim2" }, { name: "trades" }] : []));
  const got = await repl.complete("x:tr", 4);
  assert.strictEqual(got.start, 2);
  assert.deepStrictEqual(
    got.items.map((i) => `${i.label}/${i.detail}`),
    ["trim/q", "trim2/workspace", "trades/dev"],
  );
  assert.strictEqual(q.gathers(), 1);
  await repl.complete("x:tr", 4);
  assert.strictEqual(q.gathers(), 1, "the names are read once, until the next run");
  assert.deepStrictEqual((await repl.complete("x: 1", 4)).items, []);
});

test("with the REPL off its command refuses, Enter sends nothing, and an open pane closes", async (t) => {
  const { q, live, repl } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  await stub.commands.get(C.openRepl)();
  stub.config.user["repl.enable"] = false;
  stub.changeConfig("q-lint.repl.enable");
  assert.strictEqual(repl.isOpen(), false);
  await stub.commands.get(C.openRepl)();
  assert.ok(said(/q-lint\.repl\.enable/));
  assert.strictEqual(await repl.enter("1+1"), "refused");
  assert.deepStrictEqual((await repl.complete("x:tr", 4)).items, []);
  assert.deepStrictEqual(q.queries, []);
  assert.strictEqual(q.gathers(), 0);
});

test("a write typed in the REPL on a guarded process asks first; declined, nothing is sent", async (t) => {
  const { q, live, repl } = await setUp(t, { tags: ["prod"] });
  assert.ok(await live.connectTo("dev"));
  stub.picks = [undefined];
  await repl.enter("delete from `trades");
  assert.strictEqual(asked().length, 1);
  assert.deepStrictEqual(q.queries, []);
  assert.strictEqual(repl.entries()[0].ok, false);
});

test(".qlint.view: a call opens its value in the grid while the switch is on; off, nothing listens", async (t) => {
  const { live, view } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  assert.strictEqual(view.listening(), true);
  await live.run(".qlint.view t");
  // Until it is shown, not a fixed 20 ms a loaded machine can outrun.
  for (const end = Date.now() + 10_000; view.shown().length === 0 && Date.now() < end; ) await sleep(10);
  assert.deepStrictEqual(view.shown(), [{ kind: "view", process: "dev", rows: 2 }]);
  stub.config.user["view.enable"] = false;
  stub.changeConfig("q-lint.view.enable");
  assert.strictEqual(view.listening(), false);
  await live.run(".qlint.view t");
  await sleep(20);
  assert.strictEqual(view.shown().length, 1);
});

test("Define .qlint.view sends the definition through the guard; off it refuses and sends nothing", async (t) => {
  const { q, live, view } = await setUp(t, { tags: ["prod"] });
  assert.ok(await live.connectTo("dev"));
  stub.picks = [undefined];
  assert.strictEqual(await stub.commands.get(C.defineView)(), false);
  assert.strictEqual(asked().length, 1);
  assert.deepStrictEqual(q.queries, []);
  stub.picks = ["Run Anyway"];
  assert.strictEqual(await view.define(), true);
  assert.match(q.queries[0], /^\.qlint\.grid:\{\[s;size;limit\]/);
  assert.match(q.queries[0], /\n\.qlint\.plot:\.qlint\.show`plot$/);
  stub.config.user["view.enable"] = false;
  stub.messages = [];
  assert.strictEqual(await stub.commands.get(C.defineView)(), false);
  assert.ok(said(/q-lint\.view\.enable/));
  assert.strictEqual(q.queries.length, 1);
});

test("defined on connect only while q-lint.view.defineOnConnect is on, and never on a guarded process", async (t) => {
  const { q, live } = await setUp(t, { tags: ["prod"], config: { "view.defineOnConnect": true } });
  assert.ok(await live.connectTo("dev"));
  await sleep(50);
  assert.deepStrictEqual(q.queries, [], "refused, not asked");
  assert.strictEqual(asked().length, 0);
  assert.ok(said(/were not defined/));
});

test("defined on connect to a process the guard lets through", async (t) => {
  const { q, live } = await setUp(t, { config: { "view.defineOnConnect": true } });
  assert.ok(await live.connectTo("dev"));
  // Until it is sent, with a deadline a loaded machine cannot outrun (it was 0.5 s).
  for (const end = Date.now() + 10_000; q.queries.length === 0 && Date.now() < end; ) await sleep(10);
  assert.strictEqual(q.queries.length, 1);
  assert.match(q.queries[0], /^\.qlint\.grid:/);
});

test("not defined on connect while the setting is off, its default", async (t) => {
  const { q, live } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  await sleep(50);
  assert.deepStrictEqual(q.queries, []);
});

test("cells turned off while Run All Cells is queued: the cells not yet run are not sent (#1277)", async (t) => {
  const { q, live, editor } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  editor("/ %% one\na:1\n/ %% two\nb:2\n/ %% three\nc:3", 0);
  const run = stub.commands.get(C.runAllCells)();
  stub.config.user["cells.enable"] = false;
  stub.changeConfig("q-lint.cells.enable");
  await run;
  assert.deepStrictEqual(q.queries, []);
});

test("Run Cell, Run Above and Run Below title an untitled cell by its number, as Run All does (#1937)", async (t) => {
  const { interactive, live, editor } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  editor("/ %%\na:1\n/ %%\nb:2\n/ %%\nc:3", 3);
  const titles = () => interactive.entries().map((e) => e.title);
  await stub.commands.get(C.runCell)();
  assert.deepStrictEqual(titles(), ["Cell 2"]);
  await stub.commands.get(C.runAbove)("file:///w/a.q", 4);
  assert.deepStrictEqual(titles().slice(1), ["Cell 1", "Cell 2"]);
  await stub.commands.get(C.runBelow)("file:///w/a.q", 2);
  assert.deepStrictEqual(titles().slice(3), ["Cell 2", "Cell 3"]);
});

test("Run Cell above the first cell says where the cursor is, not that the file has no cells (#1938)", async (t) => {
  const { q, live, editor } = await setUp(t);
  assert.ok(await live.connectTo("dev"));
  for (const line of [0, 1]) {
    stub.messages.length = 0;
    editor("/ header\n\n/ %% a\na:1", line);
    await stub.commands.get(C.runCell)();
    assert.ok(said(/the cursor is above the file's first cell/), JSON.stringify(stub.messages));
    assert.ok(!said(/has no cells/));
    await stub.commands.get(C.runBelow)();
    assert.strictEqual(stub.messages.filter(([, text]) => /above the file's first cell/.test(text)).length, 2);
  }
  assert.deepStrictEqual(q.queries, []);
  // In the cell it runs, as before.
  editor("/ header\n\n/ %% a\na:1", 2);
  await stub.commands.get(C.runCell)();
  assert.deepStrictEqual(q.queries, ["a:1"]);
});

test("Ctrl+Enter's context is on only for a file that has a cell: a marker inside a block comment is none (#1938)", async (t) => {
  const { editor } = await setUp(t);
  const contexts = [];
  const executeCommand = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (name, ...args) => (name === "setContext" ? void contexts.push(args) : executeCommand(name, ...args));
  t.after(() => (vscode.commands.executeCommand = executeCommand));
  const { HAS_CELLS } = require("../out/interactiveconfig.js");
  // A change to the cells' settings reads the active editor again.
  const read = () => stub.changeConfig("q-lint.cells.codeLens.enable");
  editor("/\n/ %% not a cell\n\\\na:1");
  read();
  assert.deepStrictEqual(contexts, []);
  editor("/ %% a cell\na:1");
  read();
  assert.deepStrictEqual(contexts, [[HAS_CELLS, true]]);
  editor("/\n/ %% not a cell\n\\\na:1");
  read();
  assert.deepStrictEqual(contexts.at(-1), [HAS_CELLS, false]);
});
