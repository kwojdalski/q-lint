// The process-insight commands and views through the stand-in `vscode`
// (vscode_stub.js), against q processes played by socket servers: Open
// Function Source, Edit and Redefine and its confirmation (#929), a table's
// hover (#930), the HDB browser and Process Monitor views (#931, #932) and
// Find Callers (#935). No q and no editor needed.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");

// What the stub leaves as a no-op: documents, editors, hovers.
const contexts = new Map();
const documents = new Map();
let providers = {};
let untitled = 0;
class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Selection {
  constructor(anchor, active) {
    this.anchor = anchor;
    this.active = active;
    this.isEmpty = anchor.line === active.line && anchor.character === active.character;
  }
}
const uriOf = (scheme, path, query = "") => ({ scheme, path, query, toString: () => `${scheme}:${path}${query ? `?${query}` : ""}` });
function documentOf(uri, text, languageId = "q") {
  const lines = () => text.split("\n");
  return {
    uri,
    languageId,
    getText: (range) => (range === undefined ? text : text),
    lineAt: (line) => ({ text: lines()[line] }),
    positionAt: (offset) => {
      const before = text.slice(0, offset).split("\n");
      return new Position(before.length - 1, before.at(-1).length);
    },
    set text(v) {
      text = v;
    },
  };
}
vscode.Position = Position;
vscode.Selection = Selection;
vscode.Range = class {
  constructor(...at) {
    this.at = at;
  }
};
vscode.Hover = class {
  constructor(contents) {
    this.contents = contents;
  }
};
vscode.Uri.from = ({ scheme, path, query }) => uriOf(scheme, path, query);
vscode.Uri.parse = (s) => {
  const [, scheme, path, query] = /^([\w-]+):([^?]*)\??(.*)$/.exec(s);
  return uriOf(scheme, path, query);
};
vscode.workspace.registerTextDocumentContentProvider = (scheme, provider) => ((providers.content = provider), { dispose() {} });
vscode.languages.registerHoverProvider = (_selector, provider) => ((providers.hover = provider), { dispose() {} });
vscode.languages.registerCompletionItemProvider = () => ({ dispose() {} });
vscode.workspace.openTextDocument = async (arg) => {
  const document =
    arg.scheme !== undefined
      ? documentOf(arg, providers.content.provideTextDocumentContent(arg))
      : documentOf(uriOf("untitled", `Untitled-${++untitled}`), arg.content, arg.language);
  documents.set(document.uri.toString(), document);
  return document;
};
vscode.window.showTextDocument = async (document) => {
  const editor = { document, selection: new Selection(new Position(0, 0), new Position(0, 0)), revealRange() {} };
  vscode.window.activeTextEditor = editor;
  return editor;
};
vscode.window.onDidChangeActiveTextEditor = () => ({ dispose() {} });
vscode.workspace.onDidCloseTextDocument = () => ({ dispose() {} });
vscode.window.createTreeView = (id, options) => {
  const view = { id, options, message: undefined, description: undefined, visible: true, onDidChangeVisibility: () => ({ dispose() {} }), dispose() {} };
  stub.trees.push(view);
  return view;
};
const execute = vscode.commands.executeCommand;
vscode.commands.executeCommand = async (name, ...args) => (name === "setContext" ? void contexts.set(args[0], args[1]) : execute(name, ...args));

const { Live } = require("../out/live.js");
const { FunctionSources } = require("../out/funcsourceview.js");
const { ProcessExplorer } = require("../out/explorerview.js");
const { registerInfoViews } = require("../out/infoview.js");
const { CALLERS, REDEFINE, SOURCE } = require("../out/funcsource.js");
const { TABLE_INFO } = require("../out/tableinfo.js");
const { MONITOR } = require("../out/monitor.js");
const { HDB } = require("../out/hdb.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A q process played by a socket server: each message, decoded, is
/// answered with what `answer` gives for it, and kept in `sent`.
async function fakeQ(answer) {
  const sent = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
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
        const value = deserialize(message);
        sent.push(value);
        const out = serialize(answer(Array.isArray(value) ? value : [value]));
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    sent,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

const GATHERED = {
  rows: [
    { ns: ".", name: "trade", kind: "table", type: 98, count: 3, cols: ["sym", "px"], keys: [], params: [], partitioned: false, ncols: 2 },
    { ns: ".ns", name: "h", kind: "function", type: 100, count: null, cols: [], keys: [], params: ["x"], partitioned: false, ncols: 0 },
    { ns: ".", name: "f", kind: "function", type: 100, count: null, cols: [], keys: [], params: ["a"], partitioned: false, ncols: 0 },
  ],
  spaces: [
    { ns: ".", total: 2 },
    { ns: ".ns", total: 1 },
  ],
  more: 0,
};

/// What the fake process answers each of the calls.
function answers([code, ...args]) {
  if (code === SOURCE) {
    return args[0] === ".ns.h" ? { type: 100, text: "{[x] x+lim}", ctx: "ns", params: ["x"] } : { type: 100, text: "{[a] .ns.h a}", ctx: "", params: ["a"] };
  }
  if (code === REDEFINE) {
    return args[0];
  }
  if (code === CALLERS) {
    return { rows: [{ name: "f", params: ["a"], how: "calls" }], scanned: 2, more: 0 };
  }
  if (code === TABLE_INFO) {
    return { kind: "table", rows: 3, bytes: 100, partitions: null, keys: [], ncols: 2, cols: ["sym", "px"], types: ["s", "f"], fkeys: ["", ""], attrs: ["g", ""] };
  }
  if (code === MONITOR) {
    return { memory: { key: ["used"], value: [1024] }, handles: { handle: [], queued: [], self: [] }, timer: "0i", ts: "", torq: [], settings: { key: ["p"], value: ["1i"] }, process: { key: ["pid"], value: ["1i"] } };
  }
  if (code === HDB) {
    return { hdb: false, root: "/tmp" };
  }
  if (typeof code === "string" && code.includes("`rows`spaces`more")) {
    return GATHERED;
  }
  return null;
}

async function setUp(t, tags = [], config = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  contexts.clear();
  documents.clear();
  providers = {};
  vscode.window.activeTextEditor = undefined;
  const q = await fakeQ(answers);
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [
    { label: "p", host: "127.0.0.1", port: q.port, tags },
    { label: "other", host: "127.0.0.1", port: q.port, tags: [] },
  ]);
  const live = new Live(context);
  const explorer = new ProcessExplorer(context, live);
  const sources = new FunctionSources(context, live);
  const views = registerInfoViews(context, live);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  assert.strictEqual(await live.connectTo("p"), true);
  for (let i = 0; i < 50 && explorer.rows().length === 0; i++) await sleep(10);
  return { q, live, explorer, sources, views };
}

const calls = (q, code) => q.sent.filter((m) => Array.isArray(m) && m[0] === code).map((m) => m.slice(1));

test("Open Function Source shows the process's text read-only; Edit and Redefine sends an edit back after asking", async (t) => {
  const { q, sources } = await setUp(t);
  // From an explorer row: its name.
  const node = { kind: "function", label: "h", name: ".ns.h" };
  const uri = await stub.commands.get("q-lint.openFunctionSource")(node);
  assert.strictEqual(uri.scheme, "q-lint-source");
  assert.strictEqual(uri.path, "/.ns.h.q");
  const shown = vscode.window.activeTextEditor.document;
  assert.strictEqual(shown.getText(), "/ .ns.h on p, defined in .ns\n{[x] x+lim}\n");
  const copy = await stub.commands.get("q-lint.editFunctionSource")(uri);
  assert.strictEqual(copy.uri.scheme, "untitled");
  assert.strictEqual(contexts.get("q-lint.redefinable"), true);
  copy.text = "/ .ns.h on p, defined in .ns\n{[x] x+lim*2}\n";
  // Escape on the confirmation: nothing is sent.
  stub.picks.push(undefined);
  assert.strictEqual(await stub.commands.get("q-lint.redefineFunction")(), false);
  assert.deepStrictEqual(calls(q, REDEFINE), []);
  stub.picks.push("Redefine");
  assert.strictEqual(await stub.commands.get("q-lint.redefineFunction")(), true);
  assert.deepStrictEqual(calls(q, REDEFINE), [[".ns.h", "{[x] x+lim}", "{[x] x+lim*2}"]]);
  assert.ok(stub.messages.some(([, text]) => text === "Redefine .ns.h on p?"));
  assert.ok(stub.messages.some(([, text]) => text === "q-lint: redefined .ns.h on p."));
  // The read-only document shows the new text, and the next Redefine
  // checks the process has that one.
  assert.strictEqual(providers.content.provideTextDocumentContent(uri), "/ .ns.h on p, defined in .ns\n{[x] x+lim*2}\n");
  stub.picks.push("Redefine");
  await stub.commands.get("q-lint.redefineFunction")();
  assert.strictEqual(calls(q, REDEFINE)[1][1], "{[x] x+lim*2}");
  assert.strictEqual(sources.state().copies.length, 1);
});

test("Redefine goes only to the process the function came from", async (t) => {
  const { q, live } = await setUp(t);
  const uri = await stub.commands.get("q-lint.openFunctionSource")(".ns.h");
  await stub.commands.get("q-lint.editFunctionSource")(uri);
  assert.strictEqual(await live.connectTo("other"), true);
  stub.messages = [];
  assert.strictEqual(await stub.commands.get("q-lint.redefineFunction")(), false);
  assert.match(stub.messages[0][1], /copied from p; connect to it to redefine it there \(connected to other\)/);
  assert.deepStrictEqual(calls(q, REDEFINE), []);
});

test("Redefine on a process tagged prod says so in its confirmation", async (t) => {
  await setUp(t, ["prod"]);
  let asked;
  const warn = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async (text, options) => ((asked = { text, options }), undefined);
  t.after(() => (vscode.window.showWarningMessage = warn));
  const uri = await stub.commands.get("q-lint.openFunctionSource")(".ns.h");
  await stub.commands.get("q-lint.editFunctionSource")(uri);
  await stub.commands.get("q-lint.redefineFunction")();
  assert.strictEqual(asked.options.modal, true);
  // The read-only guard (#918) guards prod by default: Redefine assigns.
  assert.strictEqual(asked.text, "Redefine .ns.h on the read-only process p?");
  assert.match(asked.options.detail, /^p is tagged prod, which q-lint.processes.readOnlyGuard.tags guards: Redefine assigns .ns.h there\./);
  // Declined, nothing is sent; with the guard off, the production warning.
  stub.config.user["processes.readOnlyGuard.enable"] = false;
  await stub.commands.get("q-lint.redefineFunction")();
  assert.match(asked.options.detail, /^p is a production process \(tagged prod\)/);
});

test("Redefine on a read-only process is not sent when its confirmation is declined (#918)", async (t) => {
  const { q } = await setUp(t, ["live"], { "processes.readOnlyGuard.tags": ["live"] });
  const uri = await stub.commands.get("q-lint.openFunctionSource")(".ns.h");
  await stub.commands.get("q-lint.editFunctionSource")(uri);
  stub.picks.push(undefined);
  assert.strictEqual(await stub.commands.get("q-lint.redefineFunction")(), false);
  assert.ok(stub.messages.some(([, text]) => text === "Redefine .ns.h on the read-only process p?"));
  assert.deepStrictEqual(calls(q, REDEFINE), []);
});

test("Open Function Source and Find Callers read the name under the cursor in a q editor", async (t) => {
  const { q } = await setUp(t);
  const editor = await vscode.window.showTextDocument(documentOf(uriOf("file", "/a.q"), "r:.ns.h 1"));
  editor.selection = new Selection(new Position(0, 4), new Position(0, 4));
  let offered;
  stub.picks.push(({ items, title }) => ((offered = { items, title }), items[0]));
  await stub.commands.get("q-lint.findCallers")();
  assert.deepStrictEqual(calls(q, CALLERS)[0].slice(1), [".ns.h", 1000]);
  assert.strictEqual(offered.title, "Callers of .ns.h on p: 1 of 2 functions");
  assert.deepStrictEqual([offered.items[0].label, offered.items[0].description, offered.items[0].detail], ["f", "[a]", "calls .ns.h"]);
  // The pick opens the caller at the call.
  const opened = vscode.window.activeTextEditor;
  assert.strictEqual(opened.document.uri.path, "/f.q");
  const text = opened.document.getText();
  assert.deepStrictEqual(opened.selection.active, opened.document.positionAt(text.indexOf(".ns.h a")));
});

test("a table's hover: in the explorer when first shown, and on its name in a q editor", async (t) => {
  const { q, explorer } = await setUp(t, [], { "processExplorer.editorTableHover.enable": true });
  const table = explorer.rows()[0].children[0].children[0];
  assert.strictEqual(table.name, "trade");
  const item = await explorer.resolveTreeItem({ tooltip: "plain" }, table);
  assert.match(item.tooltip.value, /^\*\*trade\*\* on p: table, 3 rows, 2 columns, 100 B in memory/);
  const hover = await providers.hover.provideHover(documentOf(uriOf("file", "/a.q"), "select from trade"), new Position(0, 14));
  assert.match(hover.contents.value, /\| sym \| `s` \| `g` grouped \|/);
  // Asked for once until the next refresh.
  assert.strictEqual(calls(q, TABLE_INFO).length, 1);
  assert.strictEqual(await providers.hover.provideHover(documentOf(uriOf("file", "/a.q"), "select from nosuch"), new Position(0, 14)), undefined);
  await stub.commands.get("q-lint.refreshProcessExplorer")();
  await providers.hover.provideHover(documentOf(uriOf("file", "/a.q"), "trade"), new Position(0, 1));
  assert.strictEqual(calls(q, TABLE_INFO).length, 2);
});

test("the Process Monitor and HDB browser read the process on Refresh, and empty on disconnect", async (t) => {
  const { views } = await setUp(t);
  await stub.commands.get("q-lint.refreshProcessMonitor")();
  assert.deepStrictEqual(views.monitor().map((n) => n.label), ["Process", "Memory", "Handles", "Timers", "Settings"]);
  await stub.commands.get("q-lint.refreshHdbBrowser")();
  assert.deepStrictEqual(views.hdb().map((n) => n.label), ["p has no partitioned database loaded"]);
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.deepStrictEqual([views.monitor(), views.hdb()], [[], []]);
});

const OFF = {
  "processExplorer.functionSource.enable": false,
  "processExplorer.findCallers.enable": false,
  "processExplorer.tableHover.enable": false,
  "processMonitor.enable": false,
  "hdbBrowser.enable": false,
};

test("a feature turned off refuses its commands, registers no provider or view, and sends nothing", async (t) => {
  const { q, explorer, views } = await setUp(t, [], OFF);
  const before = q.sent.length;
  stub.messages = [];
  assert.strictEqual(await stub.commands.get("q-lint.openFunctionSource")(".ns.h"), undefined);
  assert.strictEqual(await stub.commands.get("q-lint.editFunctionSource")(), undefined);
  assert.strictEqual(await stub.commands.get("q-lint.redefineFunction")(), false);
  await stub.commands.get("q-lint.findCallers")(".ns.h");
  await stub.commands.get("q-lint.refreshProcessMonitor")();
  await stub.commands.get("q-lint.refreshHdbBrowser")();
  assert.deepStrictEqual(
    stub.messages.map(([, text]) => text.replace(/ is turned off.*\. Set (q-lint\.[\w.]+) to true.*/, " off: $1")),
    [
      "q-lint: Function source and Redefine off: q-lint.processExplorer.functionSource.enable",
      "q-lint: Function source and Redefine off: q-lint.processExplorer.functionSource.enable",
      "q-lint: Function source and Redefine off: q-lint.processExplorer.functionSource.enable",
      "q-lint: Find Callers in Process off: q-lint.processExplorer.findCallers.enable",
      "q-lint: The Process Monitor off: q-lint.processMonitor.enable",
      "q-lint: The HDB Browser off: q-lint.hdbBrowser.enable",
    ],
  );
  // The editor's hover is off by default: no provider at all.
  assert.strictEqual(providers.hover, undefined);
  const table = explorer.rows()[0].children[0].children[0];
  const item = await explorer.resolveTreeItem({ tooltip: "plain" }, table);
  assert.strictEqual(item.tooltip, "plain");
  assert.deepStrictEqual([views.monitor(), views.hdb()], [[], []]);
  assert.ok(!stub.trees.some((v) => v.id === "q-lint.processMonitor" || v.id === "q-lint.hdbBrowser"));
  assert.strictEqual(q.sent.length, before);
});

test("turning a feature on or off takes effect without a reload", async (t) => {
  const { views } = await setUp(t, [], OFF);
  stub.config.user["processMonitor.enable"] = true;
  stub.config.user["processExplorer.editorTableHover.enable"] = true;
  stub.changeConfig("q-lint.processMonitor.enable");
  stub.changeConfig("q-lint.processExplorer.editorTableHover.enable");
  await stub.commands.get("q-lint.refreshProcessMonitor")();
  assert.strictEqual(views.monitor().length, 5);
  assert.notStrictEqual(providers.hover, undefined);
  stub.config.user["processMonitor.enable"] = false;
  stub.changeConfig("q-lint.processMonitor.enable");
  assert.deepStrictEqual(views.monitor(), []);
});
