// The live half's VS Code around queries: the query history, the status
// bar, a connection lost mid-query, and editing the connected process.
// Driven by node through a stand-in `vscode` module (vscode_stub.js) and q
// processes played by socket servers. No q and no editor needed.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize } = require("node-q/lib/c.js");

// What the stub leaves as a no-op, kept here to read: the status bar items
// and the tree data providers registered.
const statusItems = [];
const providers = new Map();
vscode.window.createStatusBarItem = (id) => {
  const item = { id, text: "", tooltip: undefined, show() {}, hide() {}, dispose() {} };
  statusItems.push(item);
  return item;
};
vscode.window.registerTreeDataProvider = (id, provider) => {
  providers.set(id, provider);
  return { dispose() {} };
};
const output = [];
vscode.window.createOutputChannel = () => ({
  appendLine: (line) => output.push(line),
  clear: () => (output.length = 0),
  show() {},
  dispose() {},
});

const { Live } = require("../out/live.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A q process played by a socket server: it answers the handshake, then
/// each message with what `answer` gives for it (a value, sent as a
/// response), nothing when it gives undefined, and closes the socket when
/// it gives `CLOSE`.
const CLOSE = Symbol("close");
async function fakeQ(answer = () => null, delay = () => 0) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        setTimeout(() => socket.writable && socket.write(Buffer.from([3])), delay());
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        const value = answer(message);
        if (value === CLOSE) {
          socket.destroy();
        } else if (value !== undefined) {
          const out = serialize(value);
          out.writeUInt8(2, 1);
          socket.write(out);
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    connections: () => sockets.size,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/// A query's answer as `RUN` gives it.
const OK = { ok: true, type: -7, text: ["42"] };

/// A Live over a fresh context holding `processes`.
async function setUp(t, processes) {
  stub.reset();
  statusItems.length = 0;
  providers.clear();
  output.length = 0;
  const context = stub.newContext();
  // A workspaceState in memory, as globalState is.
  const workspaceState = new Map();
  context.workspaceState = {
    get: (k, d) => (workspaceState.has(k) ? structuredClone(workspaceState.get(k)) : d),
    update: async (k, v) => void workspaceState.set(k, structuredClone(v)),
    keys: () => [...workspaceState.keys()],
  };
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return {
    context,
    live,
    status: statusItems.find((s) => s.id === "q-lint.connection"),
    history: providers.get("q-lint.queryHistory") ?? stub.trees.find((v) => v.id === "q-lint.queryHistory")?.options.treeDataProvider,
  };
}

const proc = (label, port, extra = {}) => ({ label, host: "127.0.0.1", port, tags: [], ...extra });

const entry = (extra = {}) => ({ process: "p", code: "x", at: new Date(0).toISOString(), millis: 3, outcome: "ok", ...extra });

// The process label and q's error went into the tooltip's Markdown raw: a
// label `*prod*_rdb` showed in italics without its underscore, an error
// `<cfg>` vanished as an HTML tag, and `'a_b_c` lost its underscores.
test("a history row's tooltip shows the process and q's error as written", async (t) => {
  const { history } = await setUp(t, []);
  const item = history.getTreeItem(entry({ process: "*prod*_rdb", outcome: "error", error: "<cfg> a_b_c [x](y)" }));
  const value = item.tooltip.value;
  assert.ok(value.includes("\\*prod\\*\\_rdb"), value);
  assert.ok(value.includes("'\\<cfg\\> a\\_b\\_c \\[x\\]\\(y\\)"), value);
});

// A row was labelled with the code's first line as it came: a selection
// starting on a blank line gave a row with no label, a CRLF file's left
// its CR, and a long line was cut inside a surrogate pair, showing a
// replacement character. Run Again's pick was labelled the same way.
test("a history row and Run Again's pick are labelled with the first line of code", async (t) => {
  const { live, history } = await setUp(t, []);
  const long = `${"a".repeat(78)}😀tail`;
  const codes = ["\r\n  \r\nx:1\r\ny:2", "f:{x}\r\nf 1", long];
  const labels = codes.map((code) => history.getTreeItem(entry({ code })).label);
  assert.deepStrictEqual(labels, ["x:1", "f:{x}", `${"a".repeat(78)}😀…`]);
  for (const code of codes.reverse()) await live.record(entry({ code }));
  let offered;
  stub.picks.push(({ items }) => ((offered = items.map((i) => i.label)), undefined));
  await stub.commands.get("q-lint.rerunQuery")();
  assert.deepStrictEqual(offered, labels);
});

// A query whose process closed the connection before answering - `exit 0`,
// `\\`, a crash - was recorded as aborted, and the output said "aborted",
// though nobody aborted it. Abort itself is still recorded as aborted.
test("a query whose connection closes is a failure, not an abort", async (t) => {
  let hold = false;
  const q = await fakeQ((message) => (message.includes("exit") ? CLOSE : hold ? undefined : OK));
  t.after(() => q.close());
  const { live } = await setUp(t, [proc("p", q.port)]);
  assert.strictEqual(await live.connectTo("p"), true);
  await live.run("exit 0");
  const [closed] = live.history();
  assert.deepStrictEqual([closed.outcome, closed.error], ["error", "the connection closed before the process answered"]);
  assert.ok(output.at(-1).includes("p - failed:"), output.at(-1));
  assert.strictEqual(await live.connectTo("p"), true);
  hold = true;
  const running = live.run("slow 1");
  await sleep(50);
  await live.abort();
  await running;
  assert.deepStrictEqual([live.history()[0].outcome, live.history()[0].error], ["aborted", "aborted"]);
});

test("a query stopped by Disconnect is recorded as aborted", async (t) => {
  const q = await fakeQ(() => undefined);
  t.after(() => q.close());
  const { live } = await setUp(t, [proc("p", q.port)]);
  assert.strictEqual(await live.connectTo("p"), true);
  const running = live.run("slow 1");
  await sleep(50);
  await stub.commands.get("q-lint.disconnectProcess")();
  await running;
  assert.deepStrictEqual([live.history()[0].outcome, live.history()[0].error], ["aborted", "aborted"]);
});

/// Edit Process's answers: label, host, port, TLS (no), user (none), tags.
const editAnswers = (label, host, port) => {
  stub.inputs.push(label, host, String(port));
  stub.picks.push(({ items }) => items.find((i) => i.label === "No"));
  stub.inputs.push("", "");
};

// Editing the connected process's host or port set it as the connection's
// process, so the status bar said "Connected to" the new address while
// the connection was still to the old one, and an agent's query was told
// the same.
test("editing the connected process's address leaves the connection's as it is", async (t) => {
  const q = await fakeQ(() => OK);
  t.after(() => q.close());
  const { live, status } = await setUp(t, [proc("p", q.port)]);
  assert.strictEqual(await live.connectTo("p"), true);
  editAnswers("p", "127.0.0.1", q.port + 1);
  await stub.commands.get("q-lint.editProcess")("p");
  assert.strictEqual(live.processes()[0].port, q.port + 1);
  assert.strictEqual(live.activeProcess().port, q.port);
  assert.ok(status.tooltip.includes(`127.0.0.1:${q.port}.`), status.tooltip);
  assert.ok(stub.messages.some(([, text]) => text.includes(`still connected to p at 127.0.0.1:${q.port}`)), JSON.stringify(stub.messages));
});

// Renaming the connected process changed the connection's label without a
// word to the Process Explorer, which keeps what it read under the label
// it read it for: it went empty, and live completion offered nothing, until
// something else refreshed it.
test("renaming the connected process keeps the Process Explorer", async (t) => {
  const { ProcessExplorer } = require("../out/explorerview.js");
  const gathered = { rows: [{ ns: ".", name: "x", kind: "variable", type: -7, count: 1, cols: [], keys: [], params: [], partitioned: false }], spaces: [{ ns: ".", total: 1 }], more: 0 };
  const q = await fakeQ((message) => (message.includes("`rows`spaces`more") ? gathered : OK));
  t.after(() => q.close());
  const { context, live } = await setUp(t, [proc("p", q.port)]);
  const explorer = new ProcessExplorer(context, live);
  assert.strictEqual(await live.connectTo("p"), true);
  for (let i = 0; i < 50 && explorer.rows().length === 0; i++) await sleep(10);
  assert.strictEqual(explorer.rows().length, 1);
  editAnswers("renamed", "127.0.0.1", q.port);
  await stub.commands.get("q-lint.editProcess")("p");
  for (let i = 0; i < 50 && explorer.rows().length === 0; i++) await sleep(10);
  assert.strictEqual(live.activeLabel(), "renamed");
  assert.strictEqual(explorer.rows().length, 1);
});

// Live completion inserted a name as it is listed. A name q cannot parse -
// one made with `set` from a symbol, `café` or `a b` - went in raw, which
// q reads as something else (`a b` is `a` applied to `b`) or refuses.
// Such a name goes in as Preview reads it, by its symbol.
test("live completion inserts a name q cannot parse by its symbol", async (t) => {
  let provider;
  vscode.languages.registerCompletionItemProvider = (_selector, p) => ((provider = p), { dispose: () => (provider = undefined) });
  vscode.CompletionItem = class {
    constructor(label, kind) {
      this.label = label;
      this.kind = kind;
    }
  };
  vscode.Range = class {
    constructor(...at) {
      this.at = at;
    }
  };
  const { ProcessExplorer } = require("../out/explorerview.js");
  const rows = ["café", "a b", "ok", "x.y"].map((name) => ({ ns: ".", name, kind: "variable", type: -7, count: 1, cols: [], keys: [], params: [], partitioned: false }));
  rows.push({ ns: ".ns", name: "é", kind: "variable", type: -7, count: 1, cols: [], keys: [], params: [], partitioned: false });
  const gathered = { rows, spaces: [{ ns: ".", total: 4 }, { ns: ".ns", total: 1 }], more: 0 };
  const q = await fakeQ((message) => (message.includes("`rows`spaces`more") ? gathered : OK));
  t.after(() => q.close());
  const { context, live } = await setUp(t, [proc("p", q.port)]);
  const explorer = new ProcessExplorer(context, live);
  assert.strictEqual(await live.connectTo("p"), true);
  for (let i = 0; i < 50 && explorer.rows().length === 0; i++) await sleep(10);
  // Off by default: a provider with items hides VS Code's word suggestions (#1779).
  assert.strictEqual(provider, undefined);
  stub.config.user["processExplorer.liveCompletion.enable"] = true;
  stub.changeConfig("q-lint.processExplorer.liveCompletion.enable");
  const document = { getText: () => "" };
  const items = provider.provideCompletionItems(document, { line: 0, character: 0 });
  const inserted = Object.fromEntries(items.map((i) => [i.label, i.insertText ?? i.label]));
  assert.deepStrictEqual(inserted, {
    "café": 'get`$"café"',
    "a b": 'get`$"a b"',
    ok: "ok",
    "x.y": "x.y",
    ".ns.é": 'get`$".ns.é"',
  });
  // After a drop written without spaces the name alone is replaced (#1992).
  const dropped = provider.provideCompletionItems({ getText: () => "r:-1_tra" }, { line: 0, character: 8 });
  assert.deepStrictEqual(dropped[0].range.at, [0, 5, 0, 8]);
  stub.config.user["processExplorer.liveCompletion.enable"] = false;
  stub.changeConfig("q-lint.processExplorer.liveCompletion.enable");
  assert.strictEqual(provider, undefined);
});

// From the command palette with no editor open (or the Output panel
// focused), the query, send and insert-label commands did nothing at all:
// no query, no message.
test("a query, send or Insert Label with no editor open says what it needs", async (t) => {
  const q = await fakeQ(() => OK);
  t.after(() => q.close());
  const { live } = await setUp(t, [proc("p", q.port)]);
  assert.strictEqual(await live.connectTo("p"), true);
  vscode.window.activeTextEditor = undefined;
  const commands = [
    "q-lint.queryCurrentLine",
    "q-lint.querySelection",
    "q-lint.queryBlock",
    "q-lint.queryEntireFile",
    "q-lint.sendCurrentLineToTerminal",
    "q-lint.sendSelectionToTerminal",
    "q-lint.sendBlockToTerminal",
    "q-lint.insertActiveConnectionLabel",
  ];
  for (const name of commands) {
    stub.messages = [];
    await stub.commands.get(name)();
    assert.deepStrictEqual(stub.messages, [["info", "q-lint: open a q file first: there is no active editor."]], name);
  }
});

// The status bar and a quick pick draw `$(name)` as an icon: a process
// labelled `$(zap)rdb` (or listed so by a discovery server) showed as an
// icon and `rdb` in the status bar and in Connect's pick.
test("a label holding $(...) is shown as written in the status bar and the pick", async (t) => {
  const q = await fakeQ(() => OK);
  t.after(() => q.close());
  const { live, status } = await setUp(t, [proc("$(zap)rdb", q.port)]);
  let offered;
  stub.picks.push(({ items }) => ((offered = items.map((i) => i.label)), items[0]));
  assert.strictEqual(await live.connectTo(), true);
  assert.deepStrictEqual(offered, ["\\$(zap)rdb"]);
  assert.strictEqual(status.text, "$(plug) q: \\$(zap)rdb");
  assert.strictEqual(live.activeLabel(), "$(zap)rdb");
  // q code holds `$(x)` often: a cast, `` `int$(x) ``.
  await live.record(entry({ code: "`int$(x)" }));
  stub.picks.push(({ items }) => ((offered = items.map((i) => [i.label, i.description])), undefined));
  await stub.commands.get("q-lint.rerunQuery")();
  assert.deepStrictEqual(offered[0], ["`int\\$(x)", "p"]);
});

// Deactivating closed the connection there was, but not one still being
// opened: the reconnect after an Abort, waiting for a busy process, opened
// its connection after the extension was gone, and nothing closed it - a
// login left on the process for as long as the extension host lived.
test("a reconnect still under way when the extension is deactivated is closed", async (t) => {
  let wait = 0;
  const q = await fakeQ(() => undefined, () => wait);
  t.after(() => q.close());
  const { context, live } = await setUp(t, [proc("p", q.port)]);
  assert.strictEqual(await live.connectTo("p"), true);
  const running = live.run("slow 1");
  await sleep(50);
  wait = 300;
  await live.abort();
  await running;
  for (const d of context.subscriptions) d.dispose?.();
  await sleep(600);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.strictEqual(q.connections(), 0);
});

// A query sent while the Process Explorer's read was out waited for it,
// showing nothing. Abort then stopped that read - the connection was busy
// with it - and the query, finding the connection gone, was dropped: not
// run, not in the history, and not a word said.
test("a query waiting for the explorer's read that is aborted says it was not run", async (t) => {
  const { ProcessExplorer } = require("../out/explorerview.js");
  const q = await fakeQ((message) => (message.includes("`rows`spaces`more") ? undefined : OK));
  t.after(() => q.close());
  const { context, live } = await setUp(t, [proc("p", q.port)]);
  new ProcessExplorer(context, live);
  assert.strictEqual(await live.connectTo("p"), true);
  await sleep(50);
  const waiting = live.run("1+1");
  await sleep(50);
  stub.messages = [];
  await live.abort();
  await waiting;
  assert.ok(stub.messages.some(([, text]) => text.includes("was not run")), JSON.stringify(stub.messages));
  // Abort said it stopped waiting for "the query", which was never sent.
  assert.ok(stub.messages.some(([, text]) => text.includes("stopped the Process Explorer's read of p")), JSON.stringify(stub.messages));
});

// A file bound to a process (Choose Connection for File) kept the label it
// was bound to. Renaming the process left every query from the file
// failing with "no q process is labelled", and so did deleting it, with
// the status bar still showing `file: <label>`.
test("renaming or deleting a process carries the files bound to it along", async (t) => {
  const q = await fakeQ(() => OK);
  t.after(() => q.close());
  const { context } = await setUp(t, [proc("p", q.port), proc("other", q.port)]);
  await context.workspaceState.update("q-lint.fileConnections", { "file:///a.q": "p", "file:///b.q": "other" });
  editAnswers("renamed", "127.0.0.1", q.port);
  await stub.commands.get("q-lint.editProcess")("p");
  assert.deepStrictEqual(context.workspaceState.get("q-lint.fileConnections"), { "file:///a.q": "renamed", "file:///b.q": "other" });
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteProcess")("renamed");
  assert.deepStrictEqual(context.workspaceState.get("q-lint.fileConnections"), { "file:///b.q": "other" });
});

test("renaming or deleting a process carries its dashboard tiles and scheduled exports along (#1617)", async (t) => {
  const q = await fakeQ(() => OK);
  t.after(() => q.close());
  const { context } = await setUp(t, [proc("rdb", q.port), proc("other", q.port)]);
  const tile = (id, process) => ({ id, query: "vwap", process, view: "table", refresh: 0 });
  const schedule = (id, process) => ({ id, query: "vwap", process, format: "csv", path: "/o.csv", every: 5, mode: "replace", since: 0 });
  await context.workspaceState.update("q-lint.dashboards", [{ name: "Desk", columns: 2, tiles: [tile("1", "rdb"), tile("2", "other")] }]);
  await context.workspaceState.update("q-lint.scheduledExports", [schedule("s1", "rdb"), schedule("s2", "other")]);
  editAnswers("rdb-ny", "127.0.0.1", q.port);
  await stub.commands.get("q-lint.editProcess")("rdb");
  assert.deepStrictEqual(context.workspaceState.get("q-lint.dashboards")[0].tiles.map((x) => x.process), ["rdb-ny", "other"]);
  assert.deepStrictEqual(context.workspaceState.get("q-lint.scheduledExports").map((x) => x.process), ["rdb-ny", "other"]);
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteProcess")("rdb-ny");
  assert.ok(stub.messages.some(([, m]) => /Its 1 dashboard tile\(s\) are removed with it\. Its 1 scheduled export\(s\) are deleted with it\./.test(m)), JSON.stringify(stub.messages));
  assert.deepStrictEqual(context.workspaceState.get("q-lint.dashboards")[0].tiles.map((x) => x.id), ["2"]);
  assert.deepStrictEqual(context.workspaceState.get("q-lint.scheduledExports").map((x) => x.id), ["s2"]);
});

test("a workspace not open when a process was renamed or deleted retargets its tiles and schedules when it opens (#1749)", async (t) => {
  const q = await fakeQ(() => OK);
  t.after(() => q.close());
  const { context } = await setUp(t, [proc("rdb", q.port), proc("hdb", q.port)]);
  editAnswers("rdb-ny", "127.0.0.1", q.port);
  await stub.commands.get("q-lint.editProcess")("rdb");
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteProcess")("hdb");
  // Another workspace: the same processes, its own tiles and schedules.
  const other = stub.newContext();
  other.globalState = context.globalState;
  const state = new Map([
    ["q-lint.dashboards", [{ name: "Desk", columns: 2, tiles: [{ id: "1", query: "v", process: "rdb", view: "table", refresh: 0 }, { id: "2", query: "v", process: "hdb", view: "table", refresh: 0 }]}]],
    ["q-lint.scheduledExports", [{ id: "s1", query: "v", process: "rdb", format: "csv", path: "/o.csv", every: 5, mode: "replace", since: 0 }]],
  ]);
  other.workspaceState = { get: (k, d) => (state.has(k) ? structuredClone(state.get(k)) : d), update: async (k, v) => void state.set(k, structuredClone(v)), keys: () => [...state.keys()] };
  new Live(other);
  t.after(() => { for (const d of other.subscriptions) d.dispose?.(); });
  for (let i = 0; i < 50 && state.get("q-lint.scheduledExports")[0].process === "rdb"; i++) await sleep(10);
  assert.deepStrictEqual(state.get("q-lint.dashboards")[0].tiles.map((x) => x.process), ["rdb-ny"]);
  assert.deepStrictEqual(state.get("q-lint.scheduledExports").map((x) => x.process), ["rdb-ny"]);
  // Applied once: a process named rdb again later keeps its own tiles.
  // Three in the log: the label rdb-ny taken (#1879), the rename, the deletion.
  assert.strictEqual(state.get("q-lint.processRelabelsApplied"), 3);
});

// Disconnect from the command palette with nothing connected did nothing
// and said nothing, where Abort, Reveal Process and Insert Label say there
// is no connection.
test("Disconnect with nothing connected says so", async (t) => {
  const q = await fakeQ(() => CLOSE);
  t.after(() => q.close());
  const { live } = await setUp(t, [proc("p", q.port)]);
  stub.messages = [];
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: not connected to a q process."]]);
  // Deleting a process once connected to, whose connection has closed,
  // has nothing to disconnect, and says nothing of it.
  assert.strictEqual(await live.connectTo("p"), true);
  await live.run("exit 0");
  stub.messages = [];
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteProcess")("p");
  assert.deepStrictEqual(live.processes(), []);
  assert.ok(!stub.messages.some(([, text]) => text.includes("not connected")), JSON.stringify(stub.messages));
});

// Deleting a discovery server forgot the passwords given for the processes
// it listed - those it listed at its last fetch, held in memory. After a
// window reload, before its first fetch (an interval of 0, a server that
// does not answer), it had listed none, so deleting it (or changing its URL
// or label) left every such password in secret storage, for a later server
// of the same label to be given.
test("deleting a discovery server after a reload forgets its processes' passwords", async (t) => {
  const q = await fakeQ(() => OK);
  t.after(() => q.close());
  const { context, live } = await setUp(t, []);
  stub.config.user["discovery.refreshInterval"] = 0;
  await context.globalState.update("q-lint.discoveryServers", [{ label: "desk", url: "http://127.0.0.1:9/" }]);
  stub.inputs.push("secret");
  const row = { kind: "discovered", server: "desk", process: { label: "rdb", host: "127.0.0.1", port: q.port, user: "u", tags: [] } };
  assert.strictEqual(await live.connectTo(row), true);
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.deepStrictEqual([...context.secrets.all.keys()].filter((k) => k.includes("rdb")), ["q-lint.discoveredPassword.desk/rdb"]);
  // A window reload: a new Live over what was kept, with nothing fetched.
  new Live(context);
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteDiscoveryServer")("desk");
  assert.deepStrictEqual([...context.secrets.all.keys()].filter((k) => k.includes("rdb")), []);
});

// Two queries started in one turn - a keybinding pressed twice, a command
// and a watch tick - both passed the check for a query still running, made
// before either was sent. The second was then refused by the connection and
// recorded as a failed query, and, both having started in one millisecond,
// took the first's place as the one running: Abort Current Query said it
// had stopped the Process Explorer's read, and recorded the first as failed.
test("of two queries started together one runs, and the other is told one is running (#1353)", async (t) => {
  const got = [];
  const q = await fakeQ((message) => void got.push(message));
  t.after(() => q.close());
  const { live } = await setUp(t, [proc("p", q.port)]);
  assert.strictEqual(await live.connectTo("p"), true);
  stub.messages = [];
  const first = live.run("1+1");
  await live.run("2+2");
  await sleep(50);
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: a query is still running on p. q-lint: Abort Current Query stops waiting for it."]]);
  assert.deepStrictEqual(live.history(), []);
  stub.messages = [];
  await live.abort();
  await first;
  assert.deepStrictEqual(live.history().map((e) => [e.code, e.outcome]), [["1+1", "aborted"]]);
  assert.ok(!stub.messages.some(([, text]) => text.includes("Process Explorer")), JSON.stringify(stub.messages));
});

test("of two cells started together one runs, and the other is not sent (#1353)", async (t) => {
  let n = 0;
  const q = await fakeQ(() => ((n += 1), OK));
  t.after(() => q.close());
  const { live } = await setUp(t, [proc("p", q.port)]);
  assert.strictEqual(await live.connectTo("p"), true);
  stub.messages = [];
  const cell = (code) => live.runOnActive(code, (connection) => connection.query([code], [10, 10]));
  const [one, two] = await Promise.all([cell("1+1"), cell("2+2")]);
  assert.deepStrictEqual([one?.process, two], ["p", undefined]);
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: a query is still running on p. q-lint: Abort Current Query stops waiting for it."]]);
});
