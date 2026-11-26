// Queries across processes through the stand-in `vscode` (vscode_stub.js),
// against q processes played by socket servers: Query a Tag (#906) and
// Compare Query (#907). No q and no editor needed.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");
const { Live } = require("../out/live.js");
const { QueryAcross } = require("../out/queryacross.js");

/// A q process played by a socket server: each message, decoded, is kept
/// in `sent` and answered with `answer(message)`.
async function fakeQ(answer) {
  const sent = [];
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
        socket.write(Buffer.from([3]));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        const value = deserialize(message);
        sent.push(value);
        const out = serialize(answer(value));
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    sent,
    open: () => sockets.size,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/// A process answering every grid query with a one-column table of `values`.
const table = (values) => () => ({
  ok: true,
  type: 98,
  text: ["v", "-", ...values.map(String)],
  grid: { count: values.length, keys: 0, names: ["v"], types: [7], cells: [values.map(String)], raw: [values], rank: [values.map((_, i) => i)] },
});

async function deadPort() {
  const s = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function setUp(t, processes, config = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const across = new QueryAcross(context, live);
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, across };
}

const proc = (label, port, tags) => ({ label, host: "127.0.0.1", port, tags });
const queries = (q) => q.sent.filter((m) => Array.isArray(m) && Array.isArray(m[1])).map((m) => m[1].join("\n"));

test("Query a Tag runs the query on every process with the tag and shows one table (#906)", async (t) => {
  const a = await fakeQ(table([1, 2]));
  const b = await fakeQ(table([3]));
  const other = await fakeQ(table([9]));
  t.after(() => [a, b, other].forEach((q) => q.close()));
  const dead = await deadPort();
  const { live, across } = await setUp(t, [proc("a", a.port, ["eu"]), proc("b", b.port, ["EU"]), proc("c", other.port, ["us"]), proc("down", dead, ["eu"])]);
  await stub.commands.get("q-lint.queryTag")("eu", "select from t");
  const { tag, payload } = across.state().tag;
  assert.strictEqual(tag, "eu");
  assert.deepStrictEqual(payload.names, ["process", "v", "error"]);
  assert.deepStrictEqual(payload.cells[0], ["a", "a", "b", "down"]);
  assert.deepStrictEqual(payload.cells[1], ["1", "2", "3", ""]);
  assert.match(payload.cells[2][3], /ECONNREFUSED|closed|connect/);
  assert.deepStrictEqual([queries(a), queries(b), queries(other)], [["select from t"], ["select from t"], []]);
  // Each run is in the history under its process; the active connection
  // is left alone, and each connection of its own is closed.
  assert.deepStrictEqual(live.history().map((h) => `${h.process} ${h.outcome}`).sort(), ["a ok", "b ok", "down error"]);
  assert.strictEqual(live.activeLabel(), undefined);
  for (let i = 0; i < 50 && a.open() + b.open() > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(a.open() + b.open(), 0);
});

test("Query a Tag takes a tag row, or asks for a tag, and the code from the editor", async (t) => {
  const a = await fakeQ(table([1]));
  t.after(() => a.close());
  const { across } = await setUp(t, [proc("a", a.port, ["eu", "dev"])]);
  vscode.window.activeTextEditor = {
    document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text: "count t" }), getText: () => "count t" },
    selection: { active: { line: 0 }, isEmpty: true },
  };
  await stub.commands.get("q-lint.queryTag")({ kind: "tag", tag: "dev" });
  assert.deepStrictEqual(queries(a), ["count t"]);
  let offered;
  stub.picks.push((options) => ((offered = options.items.map((i) => `${i.label} ${i.description}`)), options.items[1]));
  await stub.commands.get("q-lint.queryTag")();
  assert.deepStrictEqual(offered, ["dev 1 process", "eu 1 process"]);
  assert.strictEqual(across.state().tag.tag, "eu");
  assert.strictEqual(queries(a).length, 2);
});

// The workspace's shared list (.qlint/processes.json) is in the pool: its
// tags are offered and its processes queried, named `.qlint/label` (#2359).
test("Query a Tag offers and queries the processes of the workspace's shared list", async (t) => {
  const rdb = await fakeQ(table([7]));
  t.after(() => rdb.close());
  const { live, across } = await setUp(t, []);
  live.sharedList = () => [{ server: { label: ".qlint", url: "file:///w/.qlint/processes.json" }, state: { processes: [proc("rdb", rdb.port, ["prod"])], problems: [], loading: false, fetchedAt: 1 } }];
  let offered;
  stub.picks.push((options) => ((offered = options.items.map((i) => `${i.label} ${i.description}`)), options.items[0]));
  await stub.commands.get("q-lint.queryTag")(undefined, "count t");
  assert.deepStrictEqual(offered, ["prod 1 process"]);
  assert.deepStrictEqual(queries(rdb), ["count t"]);
  assert.deepStrictEqual(across.state().tag.payload.cells[0], [".qlint/rdb"]);
});

// A gateway in the tag, or compared, gets the code on the server types the
// file names, as Run Query sends it (#2363).
test("Query a Tag and Compare Query send a gateway the editor's code on the file's server types", async (t) => {
  const gw = await fakeQ(table([1]));
  const a = await fakeQ(table([2]));
  t.after(() => [gw, a].forEach((q) => q.close()));
  await setUp(t, [{ ...proc("gw", gw.port, ["desk"]), gateway: ["rdb"] }, proc("a", a.port, ["desk"])]);
  const text = "count t\n/ @servertypes hdb";
  vscode.window.activeTextEditor = {
    document: { uri: vscode.Uri.file("/w/a.q"), lineAt: (n) => ({ text: text.split("\n")[n] }), lineCount: 2, getText: () => text },
    selection: { active: { line: 0 }, isEmpty: true },
  };
  await stub.commands.get("q-lint.queryTag")("desk");
  await stub.commands.get("q-lint.compareQuery")(undefined, "gw", "a");
  const sent = gw.sent.filter((m) => typeof m === "string");
  assert.deepStrictEqual(sent, ['.gw.syncexec["count t";enlist `hdb]', '.gw.syncexec["count t";enlist `hdb]']);
});

test("Query a Tag on guarded processes asks the read-only guard once; declined, nothing is sent", async (t) => {
  const a = await fakeQ(table([1]));
  const b = await fakeQ(table([2]));
  t.after(() => [a, b].forEach((q) => q.close()));
  await setUp(t, [proc("a", a.port, ["prod"]), proc("b", b.port, ["prod"])]);
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.queryTag")("prod", "a:1");
  assert.deepStrictEqual(stub.messages.filter(([k]) => k === "warning").map(([, m]) => m), ["This code would change 2 read-only processes. Run it anyway?"]);
  assert.deepStrictEqual([queries(a), queries(b)], [[], []]);
  await stub.commands.get("q-lint.queryTag")("prod", "count t");
  assert.deepStrictEqual([queries(a), queries(b)], [["count t"], ["count t"]]);
});

test("turned off, Query a Tag refuses, says how to turn it on, and sends nothing", async (t) => {
  const a = await fakeQ(table([1]));
  t.after(() => a.close());
  const { across } = await setUp(t, [proc("a", a.port, ["eu"])], { "query.tagQuery.enable": false });
  await stub.commands.get("q-lint.queryTag")("eu", "count t");
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: Query a Tag is turned off. Set q-lint.query.tagQuery.enable to true to turn it on."]]);
  assert.deepStrictEqual(a.sent, []);
  assert.deepStrictEqual(across.state(), {});
  // On again, without a reload.
  stub.config.user["query.tagQuery.enable"] = true;
  stub.changeConfig("q-lint.query.tagQuery.enable");
  await stub.commands.get("q-lint.queryTag")("eu", "count t");
  assert.deepStrictEqual(queries(a), ["count t"]);
});

test("Compare Query runs one query on two processes and lines up the answers (#907)", async (t) => {
  const a = await fakeQ(table([1, 2]));
  const b = await fakeQ(table([1, 3, 4]));
  t.after(() => [a, b].forEach((q) => q.close()));
  const { live, across } = await setUp(t, [proc("a", a.port, []), proc("b", b.port, [])]);
  await stub.commands.get("q-lint.compareQuery")("select from t", "a", "b");
  const { comparison } = across.state();
  assert.deepStrictEqual([comparison.left.process, comparison.right.process], ["a", "b"]);
  assert.deepStrictEqual([comparison.differing, comparison.onlyLeft, comparison.onlyRight, comparison.same], [1, 0, 1, false]);
  assert.deepStrictEqual([queries(a), queries(b)], [["select from t"], ["select from t"]]);
  assert.deepStrictEqual(live.history().map((h) => h.process).sort(), ["a", "b"]);
  assert.strictEqual(live.activeLabel(), undefined);
  // Picked when not given; the second pick says which is first.
  let titles = [];
  stub.picks.push((o) => (titles.push(o.title), o.items.find((i) => i.label === "b")));
  stub.picks.push((o) => (titles.push(o.title), o.items.find((i) => i.label === "a")));
  await stub.commands.get("q-lint.compareQuery")("count t");
  assert.deepStrictEqual(titles, ["Compare Query (1 of 2): run it on which process?", "Compare Query (2 of 2): and compare b with which process?"]);
  assert.strictEqual(across.state().comparison.left.process, "b");
  // The same process twice is not a comparison.
  stub.messages = [];
  await stub.commands.get("q-lint.compareQuery")("count t", "a", "a");
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: Compare Query compares two processes; a was chosen twice."]]);
  assert.strictEqual(queries(a).length, 2);
});

test("Compare Query asks the read-only guard first; declined, neither process is sent anything", async (t) => {
  const a = await fakeQ(table([1]));
  const b = await fakeQ(table([1]));
  t.after(() => [a, b].forEach((q) => q.close()));
  const { across } = await setUp(t, [proc("a", a.port, ["dev"]), proc("b", b.port, ["prd"])]);
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.compareQuery")("`t upsert 1", "a", "b");
  assert.deepStrictEqual(stub.messages.filter(([k]) => k === "warning").map(([, m]) => m), ["This code would change b. Run it anyway?"]);
  assert.deepStrictEqual([queries(a), queries(b), across.state().comparison], [[], [], undefined]);
});

test("turned off, Compare Query refuses, says how to turn it on, and sends nothing", async (t) => {
  const a = await fakeQ(table([1]));
  t.after(() => a.close());
  await setUp(t, [proc("a", a.port, []), proc("b", a.port, [])], { "query.compare.enable": false });
  await stub.commands.get("q-lint.compareQuery")("count t", "a", "b");
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: Compare Query is turned off. Set q-lint.query.compare.enable to true to turn it on."]]);
  assert.deepStrictEqual(a.sent, []);
  stub.config.user["query.compare.enable"] = true;
  stub.changeConfig("q-lint.query.compare.enable");
  await stub.commands.get("q-lint.compareQuery")("count t", "a", "b");
  assert.strictEqual(queries(a).length, 2);
});

test("turned off, the Compare Query panel closes, and a compare still running opens none (#1458)", async (t) => {
  const panels = [];
  const create = vscode.window.createWebviewPanel;
  vscode.window.createWebviewPanel = () => {
    const panel = {
      disposed: false,
      webview: { html: "", cspSource: "csp", asWebviewUri: (u) => u, onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async () => true },
      onDidDispose: () => ({ dispose() {} }),
      reveal() {},
      dispose() { this.disposed = true; },
    };
    panels.push(panel);
    return panel;
  };
  t.after(() => (vscode.window.createWebviewPanel = create));
  const a = await fakeQ(table([1]));
  const b = await fakeQ(table([2]));
  t.after(() => [a, b].forEach((q) => q.close()));
  await setUp(t, [proc("a", a.port, []), proc("b", b.port, [])]);
  await stub.commands.get("q-lint.compareQuery")("count t", "a", "b");
  assert.strictEqual(panels.length, 1);
  stub.config.user["query.compare.enable"] = false;
  stub.changeConfig("q-lint.query.compare.enable");
  assert.strictEqual(panels[0].disposed, true);
  // On again, and turned off while a compare runs: no panel after.
  stub.config.user["query.compare.enable"] = true;
  stub.changeConfig("q-lint.query.compare.enable");
  const running = stub.commands.get("q-lint.compareQuery")("count t", "a", "b");
  stub.config.user["query.compare.enable"] = false;
  stub.changeConfig("q-lint.query.compare.enable");
  await running;
  assert.strictEqual(panels.length, 1);
});

// Cancelled after the first runs, every process not yet started was still
// recorded in Query History as run and aborted (#1629).
test("cancelling Query a Tag records only the runs that were sent", async (t) => {
  const procs = Array.from({ length: 12 }, (_, i) => proc(`p${i}`, 1, ["eu"]));
  const { live } = await setUp(t, procs);
  const listeners = [];
  const token = { isCancellationRequested: false, onCancellationRequested: (f) => (listeners.push(f), { dispose() {} }) };
  const withProgress = vscode.window.withProgress;
  vscode.window.withProgress = async (_o, task) => task({ report() {} }, token);
  t.after(() => (vscode.window.withProgress = withProgress));
  let sent = 0;
  live.runApart = async () => {
    sent++;
    await new Promise((r) => setTimeout(r, 10));
    token.isCancellationRequested = true;
    listeners.forEach((f) => f());
    return table([1])();
  };
  await stub.commands.get("q-lint.queryTag")("eu", "select from t");
  assert.ok(sent > 0 && sent < 12, String(sent));
  assert.strictEqual(live.history().length, sent);
});

// One still connecting when the cancel came - its handshake not answered -
// was recorded as an 'error' run, though nothing had been sent to it (#1926).
test("cancelling Query a Tag while a process connects records no run for it", async (t) => {
  const a = await fakeQ(table([1]));
  const held = new Set();
  const silent = net.createServer((socket) => void held.add(socket.on("error", () => {})));
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  t.after(() => {
    a.close();
    for (const s of held) s.destroy();
    silent.close();
  });
  const { live, across } = await setUp(t, [proc("a", a.port, ["eu"]), proc("slow", silent.address().port, ["eu"])]);
  const listeners = [];
  const token = { isCancellationRequested: false, onCancellationRequested: (f) => (listeners.push(f), { dispose() {} }) };
  const withProgress = vscode.window.withProgress;
  vscode.window.withProgress = async (_o, task) => task({ report() {} }, token);
  t.after(() => (vscode.window.withProgress = withProgress));
  const running = stub.commands.get("q-lint.queryTag")("eu", "select from t");
  for (let i = 0; i < 100 && (live.history().length < 1 || held.size < 1); i++) await new Promise((r) => setTimeout(r, 20));
  token.isCancellationRequested = true;
  listeners.forEach((f) => f());
  await running;
  assert.deepStrictEqual(live.history().map((h) => `${h.process} ${h.outcome}`), ["a ok"]);
  // It is listed as the ones never started are: cancelled.
  const { payload } = across.state().tag;
  assert.deepStrictEqual(payload.cells[0], ["a", "slow"]);
  assert.strictEqual(payload.cells[payload.names.indexOf("error")][1], "cancelled");
});

// One still in its connect script when the cancel came: the closed
// connection was said as the script failing, and a run recorded as aborted
// for a query that was never sent.
test("cancelling Query a Tag while a process runs its connect script warns of no failed script and records no run (#3016)", async (t) => {
  const { fakeQ: scripted, SILENT } = require("./fakeq.js");
  const a = await fakeQ(table([1]));
  // The connect script is never answered.
  const slow = await scripted((m) => (JSON.stringify(m).includes("blocks") ? SILENT : table([2])()));
  t.after(() => (a.close(), slow.close()));
  const { live, across } = await setUp(t, [proc("a", a.port, ["eu"]), { ...proc("slow", slow.port, ["eu"]), init: "blocks[]" }]);
  const listeners = [];
  const token = { isCancellationRequested: false, onCancellationRequested: (f) => (listeners.push(f), { dispose() {} }) };
  const withProgress = vscode.window.withProgress;
  vscode.window.withProgress = async (options, task) => (options.cancellable ? task({ report() {} }, token) : withProgress(options, task));
  t.after(() => (vscode.window.withProgress = withProgress));
  const running = stub.commands.get("q-lint.queryTag")("eu", "select from t");
  for (let i = 0; i < 100 && (live.history().length < 1 || slow.sent.length < 1); i++) await new Promise((r) => setTimeout(r, 20));
  token.isCancellationRequested = true;
  listeners.forEach((f) => f());
  await running;
  assert.deepStrictEqual(stub.messages.filter(([kind]) => kind !== "info"), []);
  assert.deepStrictEqual(live.history().map((h) => `${h.process} ${h.outcome}`), ["a ok"]);
  assert.strictEqual(slow.sent.length, 1, "only the connect script was sent");
  const { payload } = across.state().tag;
  assert.strictEqual(payload.cells[payload.names.indexOf("error")][1], "cancelled");
});

// Each read its switch on entry only: turned off while a pick or the
// guard's question was open, the query was still sent (#2005).
test("turned off at a pick or the guard's question, Query a Tag and Compare Query send nothing (#2005)", async (t) => {
  const a = await fakeQ(table([1]));
  const b = await fakeQ(table([2]));
  t.after(() => [a, b].forEach((q) => q.close()));
  await setUp(t, [proc("a", a.port, ["prod"]), proc("b", b.port, ["prod"])]);
  const turn = (key, on) => {
    stub.config.user[key] = on;
    stub.changeConfig(`q-lint.${key}`);
  };
  const offThen = (key, answer) => (options) => (turn(key, false), answer(options));
  const first = (o) => o.items[0];
  const yes = () => "Run Anyway";
  const named = (label) => (o) => o.items.find((i) => i.label === label);
  const says = (text) => stub.messages.filter(([k]) => k === "info").map(([, m]) => m).includes(text);
  for (const [key, off, run, picks] of [
    // The tag pick.
    ["query.tagQuery.enable", "q-lint: Query a Tag is turned off. Set q-lint.query.tagQuery.enable to true to turn it on.", () => stub.commands.get("q-lint.queryTag")(undefined, "count t"), (k) => [offThen(k, first)]],
    // The guard's question, answered yes.
    ["query.tagQuery.enable", "q-lint: Query a Tag is turned off. Set q-lint.query.tagQuery.enable to true to turn it on.", () => stub.commands.get("q-lint.queryTag")("prod", "t:1"), (k) => [offThen(k, yes)]],
    ["query.compare.enable", "q-lint: Compare Query is turned off. Set q-lint.query.compare.enable to true to turn it on.", () => stub.commands.get("q-lint.compareQuery")("count t"), (k) => [offThen(k, named("a")), named("b")]],
    ["query.compare.enable", "q-lint: Compare Query is turned off. Set q-lint.query.compare.enable to true to turn it on.", () => stub.commands.get("q-lint.compareQuery")("count t"), (k) => [named("a"), offThen(k, named("b"))]],
    ["query.compare.enable", "q-lint: Compare Query is turned off. Set q-lint.query.compare.enable to true to turn it on.", () => stub.commands.get("q-lint.compareQuery")("t:1", "a", "b"), (k) => [offThen(k, yes)]],
  ]) {
    turn(key, true);
    stub.messages = [];
    stub.picks.push(...picks(key));
    await run();
    assert.strictEqual(stub.picks.length, 0, key);
    assert.deepStrictEqual([a.sent, b.sent], [[], []], key);
    assert.ok(says(off), JSON.stringify(stub.messages));
  }
});
