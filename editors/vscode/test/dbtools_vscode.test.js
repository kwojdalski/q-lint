// The database commands' flows (#1022-#1031) through the stand-in `vscode`
// and a q process played by a socket server: off, each refuses, says how to
// turn it on and sends nothing; on, the reports open as new documents; the
// column manager is refused on a guarded process before anything is shown,
// and elsewhere runs only after Run; a dashboard's tiles run read-only
// queries, keep timers only when given an interval, and stop when the
// switch goes off; the tickerplant log's q is the extension's own, and goes
// when the switch does. Needs a q binary for the log's part, as
// dbtools_q.test.js does.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { serialize, deserialize } = require("node-q/lib/c.js");
const { Live } = require("../out/live.js");
const { registerDbTools, TABLES } = require("../out/dbtoolsview.js");
const { Dashboards, tileContent } = require("../out/dashboardview.js");
const { TickerplantLog } = require("../out/tplogview.js");
const { DB_COMMANDS, DB_SETTINGS } = require("../out/dbfeatures.js");
const { COLUMN_DIRS, RUN_SCRIPT } = require("../out/colmanager.js");
const { TABLE_INFO } = require("../out/tableinfo.js");
const { DOCUMENT } = require("../out/dbdoc.js");
const { SAVED_QUERIES_KEY } = require("../out/savedqueries.js");
const { DASHBOARDS_KEY } = require("../out/dashboard.js");

/// A q process played by a socket server; `answer(message)` answers each
/// message, decoded, and every message is kept.
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
        const m = deserialize(message);
        sent.push(m);
        const out = serialize(answer(m));
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

const INFO = { kind: "partitioned", rows: 18, bytes: null, partitions: 3, keys: [], ncols: 3, cols: ["date", "sym", "px"], types: ["d", "s", "f"], fkeys: ["", "", ""], attrs: ["", "", ""] };
const DOC = { pf: "date", parts: 3, tables: { name: "trade", kind: "partitioned", rows: 18, keys: [], cols: ["date", "sym"], types: ["d", "s"], fkeys: ["", ""], attrs: ["", ""] }, fnames: [], fparams: [] };

/// Answers a test puts in place of the usual ones, by lambda.
const answering = new Map();

function answers(m) {
  const lambda = Array.isArray(m) ? m[0] : m;
  if (answering.has(lambda)) return answering.get(lambda);
  if (lambda === TABLE_INFO) return INFO;
  if (lambda === DOCUMENT) return DOC;
  if (lambda === RUN_SCRIPT) return [true, "changed 3 of 3 directories"];
  return null;
}

/// workspaceState that keeps what is put in it.
function keepingState(context) {
  const state = new Map();
  context.workspaceState = { get: (k, d) => (state.has(k) ? structuredClone(state.get(k)) : d), update: async (k, v) => void state.set(k, structuredClone(v)), keys: () => [...state.keys()] };
}

function capture() {
  const opened = [];
  vscode.workspace.openTextDocument = async (options) => (opened.push(options), options);
  vscode.window.showTextDocument = async () => undefined;
  const panels = [];
  vscode.window.createWebviewPanel = (id, title) => {
    const panel = {
      id,
      title,
      disposed: false,
      posted: [],
      webview: { html: "", cspSource: "vscode-resource:", asWebviewUri: (u) => u, postMessage: async (m) => void panel.posted.push(m), onDidReceiveMessage: () => {} },
      disposeListeners: [],
      onDidDispose(l) {
        this.disposeListeners.push(l);
      },
      reveal() {},
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.disposeListeners.forEach((l) => l());
      },
    };
    panels.push(panel);
    return panel;
  };
  return { opened, panels };
}

async function setUp(t, tags = [], config = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const q = await fakeQ(answers);
  const context = stub.newContext();
  keepingState(context);
  await context.globalState.update("q-lint.processes", [{ label: "hdb", host: "127.0.0.1", port: q.port, tags }]);
  const live = new Live(context);
  const tools = registerDbTools(context, live);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  return { q, live, context, tools };
}

const off = Object.fromEntries(Object.values(DB_SETTINGS).map((s) => [s.key, false]));

test("off, every database command refuses, says how to turn it on, and sends nothing", async (t) => {
  const { opened } = capture();
  const { q, live, context } = await setUp(t, [], off);
  const dashboards = new Dashboards(context, live);
  const log = new TickerplantLog(context);
  await live.connectTo("hdb");
  const before = q.sent.length;
  const cases = [
    [DB_COMMANDS.manageColumn, ["trade", { op: "delete", column: "px" }], "hdbBrowser.columnManager.enable"],
    [DB_COMMANDS.document, ["markdown"], "databaseDocumenter.enable"],
    [DB_COMMANDS.checkPartitions, ["quick"], "hdbBrowser.partitionCheck.enable"],
    [DB_COMMANDS.inspectSym, [], "hdbBrowser.symInspector.enable"],
    [DB_COMMANDS.adviseAttributes, ["trade"], "processExplorer.attributeAdvisor.enable"],
    [DB_COMMANDS.migrateSchema, ["a", "b"], "schemaMigration.enable"],
    [DB_COMMANDS.testData, ["trade", { format: "q" }], "testDataGenerator.enable"],
    [DB_COMMANDS.openTpLog, ["/no/such.log"], "tickerplantLog.enable"],
    [DB_COMMANDS.openDashboard, ["d"], "dashboards.enable"],
    [DB_COMMANDS.addToDashboard, ["q", "d", "hdb"], "dashboards.enable"],
    [DB_COMMANDS.renderChart, ["/no/such.csv", "line", "/tmp/x.svg"], "charts.commandLine.enable"],
  ];
  for (const [command, args, key] of cases) {
    if (!stub.commands.has(command)) continue;
    const said = await stub.commands.get(command)(...args);
    assert.match(said, new RegExp(`turned off\\. Set q-lint\\.${key.replace(/\./g, "\\.")} to true`), command);
  }
  assert.strictEqual(q.sent.length, before);
  assert.strictEqual(opened.length, 0);
  assert.strictEqual(dashboards.timerCount(), 0);
  assert.strictEqual(log.port, undefined);
});

// Each checks its switch again after every pick: turned off while one is
// open, it goes no further and sends nothing more (#2420).
test("a database command turned off while its pick is open sends nothing more", async (t) => {
  const { opened } = capture();
  const { q, live } = await setUp(t);
  answering.set(TABLES, [["trade"], ["partitioned"]]);
  t.after(() => answering.delete(TABLES));
  await live.connectTo("hdb");
  const cases = [
    [DB_COMMANDS.document, "databaseDocumenter.enable", "Markdown"],
    [DB_COMMANDS.checkPartitions, "hdbBrowser.partitionCheck.enable", "Quick check"],
    [DB_COMMANDS.adviseAttributes, "processExplorer.attributeAdvisor.enable", "trade"],
    [DB_COMMANDS.manageColumn, "hdbBrowser.columnManager.enable", "trade"],
    [DB_COMMANDS.migrateSchema, "schemaMigration.enable", "trade"],
    [DB_COMMANDS.testData, "testDataGenerator.enable", "trade"],
  ];
  for (const [command, key, answer] of cases) {
    stub.config.user[key] = true;
    stub.picks.push(() => ((stub.config.user[key] = false), answer));
    const before = q.sent.length;
    const said = await stub.commands.get(command)();
    assert.match(String(said), /turned off/, command);
    assert.deepStrictEqual(q.sent.slice(before).map((m) => (Array.isArray(m) ? m[0] : m)).filter((l) => l !== TABLES), [], command);
  }
  assert.strictEqual(opened.length, 0);
});

test("on, the documenter reads the process once and opens its document", async (t) => {
  const { opened } = capture();
  const { q, live } = await setUp(t);
  await live.connectTo("hdb");
  const before = q.sent.length;
  const text = await stub.commands.get(DB_COMMANDS.document)("markdown");
  assert.match(text, /### trade\n\npartitioned, 18 rows\./);
  assert.deepStrictEqual(q.sent.slice(before).map((m) => m[0]), [DOCUMENT]);
  assert.strictEqual(opened.at(-1).language, "markdown");
  // Not connected: it says so and sends nothing.
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.strictEqual(await stub.commands.get(DB_COMMANDS.document)("html"), "not read");
});

test("the column manager is refused on a guarded process before its script is shown or sent", async (t) => {
  const { opened } = capture();
  const { q, live, tools } = await setUp(t, ["prod"]);
  await live.connectTo("hdb");
  const said = await stub.commands.get(DB_COMMANDS.manageColumn)("trade", { op: "delete", column: "px" });
  assert.match(said, /does not change hdb, which the read-only guard guards/);
  assert.ok(!q.sent.some((m) => m[0] === RUN_SCRIPT));
  assert.strictEqual(opened.length, 0);
  assert.strictEqual(tools.state.lastScript, undefined);
});

test("elsewhere the column manager shows its script and runs it only after Run", async (t) => {
  const { opened } = capture();
  const { q, live, tools } = await setUp(t);
  await live.connectTo("hdb");
  stub.picks.push(undefined);
  assert.strictEqual(await stub.commands.get(DB_COMMANDS.manageColumn)("trade", { op: "rename", column: "px", to: "price" }), "not run");
  assert.ok(!q.sent.some((m) => m[0] === RUN_SCRIPT));
  assert.strictEqual(opened.at(-1).language, "q");
  assert.match(opened.at(-1).content, /rename column px to price in trade on hdb/);
  stub.picks.push("Run");
  assert.match(await stub.commands.get(DB_COMMANDS.manageColumn)("trade", { op: "rename", column: "px", to: "price" }), /changed 3 of 3 directories/);
  const run = q.sent.find((m) => m[0] === RUN_SCRIPT);
  assert.ok(run[1].some((s) => s.includes(".qlint.cm.ren[`px;`price]")));
  assert.strictEqual(tools.state.lastRun, "changed 3 of 3 directories");
  // A column the table lacks is refused before anything is shown.
  const n = q.sent.length;
  assert.match(await stub.commands.get(DB_COMMANDS.manageColumn)("trade", { op: "delete", column: "nope" }), /no column nope/);
  assert.ok(q.sent.slice(n).every((m) => m[0] === TABLE_INFO || m[0] === COLUMN_DIRS));
});

// meta is the newest partition's: the column manager asks every directory's
// .d, and adds to the older ones a column only the newest have (#2138).
test("the column manager adds a column the newest partitions have and the older lack (#2138)", async (t) => {
  capture();
  answering.set(TABLE_INFO, { ...INFO, ncols: 4, cols: [...INFO.cols, "ex"], types: [...INFO.types, "s"], fkeys: [...INFO.fkeys, ""], attrs: [...INFO.attrs, ""] });
  answering.set(COLUMN_DIRS, [["sym", "px"], ["sym", "px"], ["sym", "px", "ex"]]);
  t.after(() => answering.clear());
  const { q, live } = await setUp(t);
  await live.connectTo("hdb");
  stub.picks.push("Run");
  assert.match(await stub.commands.get(DB_COMMANDS.manageColumn)("trade", { op: "add", column: "ex", value: "`" }), /changed 3 of 3 directories/);
  assert.ok(q.sent.find((m) => m[0] === RUN_SCRIPT)[1].some((s) => s.includes(".qlint.cm.add[`ex;`]")));
  assert.deepStrictEqual(q.sent.find((m) => m[0] === COLUMN_DIRS).slice(1), ["trade"]);
});

test("the column manager runs nothing when the active process changed while Run was asked (#1081)", async (t) => {
  capture();
  const { q, live, context } = await setUp(t);
  const other = await fakeQ(answers);
  t.after(() => other.close());
  await context.globalState.update("q-lint.processes", [
    { label: "hdb", host: "127.0.0.1", port: q.port, tags: [] },
    { label: "other", host: "127.0.0.1", port: other.port, tags: [] },
  ]);
  live.refreshProcesses();
  await live.connectTo("hdb");
  stub.picks.push(async () => (await live.connectTo("other"), "Run"));
  const said = await stub.commands.get(DB_COMMANDS.manageColumn)("trade", { op: "delete", column: "px" });
  assert.match(said, /hdb is no longer the active process/);
  assert.ok(!q.sent.some((m) => m[0] === RUN_SCRIPT));
  assert.ok(!other.sent.some((m) => m[0] === RUN_SCRIPT));
});

// Named, then Escape at the process pick: the empty dashboard was kept (#2404).
test("Add to Dashboard cancelled at the process pick keeps no new dashboard (#2404)", async (t) => {
  const { live, context } = await setUp(t);
  await context.workspaceState.update(SAVED_QUERIES_KEY, [{ name: "px", code: "select from trade" }]);
  new Dashboards(context, live);
  stub.inputs.push("Desk");
  stub.picks.push("$(add) New dashboard...", undefined);
  assert.strictEqual(await stub.commands.get(DB_COMMANDS.addToDashboard)("px"), "cancelled");
  assert.deepStrictEqual(context.workspaceState.get(DASHBOARDS_KEY) ?? [], []);
  // Picked, it is saved with its tile.
  stub.inputs.push("Desk");
  stub.picks.push("$(add) New dashboard...");
  const id = await stub.commands.get(DB_COMMANDS.addToDashboard)("px", undefined, "hdb");
  assert.deepStrictEqual(context.workspaceState.get(DASHBOARDS_KEY).map((d) => [d.name, d.tiles.map((x) => x.id)]), [["Desk", [id]]]);
});

test("a dashboard runs its tiles' read-only queries, keeps a timer only with an interval, and stops when turned off", async (t) => {
  const { panels } = capture();
  const { live, context } = await setUp(t);
  await context.workspaceState.update(SAVED_QUERIES_KEY, [{ name: "px", code: "select from trade" }, { name: "bad", code: "t:1" }]);
  let runs = 0;
  live.runApart = async () => (runs++, { ok: true, type: 98, text: [], grid: { count: 2, keys: 0, names: ["a", "b"], types: [7, 9], cells: [["1", "2"], ["3", "4"]], raw: [[1, 2], [3, 4]], rank: [[0, 1], [0, 1]] } });
  const dashboards = new Dashboards(context, live);
  assert.match(await stub.commands.get(DB_COMMANDS.addToDashboard)("bad", undefined, "hdb"), /cannot be a tile: a dashboard runs read-only queries only/);
  stub.inputs.push("Desk");
  stub.picks.push("$(add) New dashboard...");
  const id = await stub.commands.get(DB_COMMANDS.addToDashboard)("px", undefined, "hdb");
  assert.strictEqual(typeof id, "string");
  assert.strictEqual(context.workspaceState.get(DASHBOARDS_KEY)[0].name, "Desk");
  await stub.commands.get(DB_COMMANDS.openDashboard)("Desk");
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(runs, 1);
  assert.strictEqual(dashboards.contents.get(id).kind, "table");
  assert.strictEqual(dashboards.timerCount(), 0);
  await dashboards.receive({ type: "refresh-interval", id, seconds: 5 });
  assert.strictEqual(dashboards.timerCount(), 1);
  await dashboards.receive({ type: "view", id, view: "line" });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(dashboards.contents.get(id).kind, "chart");
  // The last answer is shaped again: the query is not run again (#1630).
  assert.strictEqual(runs, 1);
  assert.ok(panels[0].posted.some((m) => m.type === "layout" && m.tiles[0].refresh === 5));
  assert.match(panels[0].webview.html, /Content-Security-Policy/);
  stub.config.user["dashboards.enable"] = false;
  stub.changeConfig("q-lint.dashboards.enable");
  assert.strictEqual(panels[0].disposed, true);
  assert.strictEqual(dashboards.timerCount(), 0);
  const before = runs;
  await dashboards.runTile({ id, query: "px", process: "hdb", view: "table", refresh: 0 });
  assert.strictEqual(runs, before);
  assert.deepStrictEqual(tileContent({ ok: false, error: "type", trace: "" }, "table"), { kind: "error", text: "type" });
  // A chart of the rows fetched says how many of the answer's it draws (#1792).
  const cut = tileContent({ ok: true, type: 98, text: [], grid: { count: 1000000, keys: 0, names: ["a", "b"], types: [7, 9], cells: [["1", "2"], ["3", "4"]], raw: [[1, 2], [3, 4]], rank: [[0, 1], [0, 1]] } }, "line");
  assert.deepStrictEqual([cut.kind, cut.total, cut.drawn], ["chart", 1000000, 2]);
});

test("Open Dashboard with a name no dashboard has makes one of that name, asking nothing (#1268)", async (t) => {
  capture();
  const { live, context } = await setUp(t);
  new Dashboards(context, live);
  assert.strictEqual(await stub.commands.get(DB_COMMANDS.openDashboard)("Trading"), "Trading");
  assert.deepStrictEqual(context.workspaceState.get(DASHBOARDS_KEY).map((d) => d.name), ["Trading"]);
  assert.strictEqual(stub.inputs.length, 0);
  // A name that cannot be one - taken, once trimmed - is offered in the box to change.
  let value;
  stub.inputs.push((o) => ((value = o.value), "Desk"));
  assert.strictEqual(await stub.commands.get(DB_COMMANDS.openDashboard)("Trading "), "Desk");
  assert.strictEqual(value, "Trading ");
});

// Names went to the picks as plain strings beside "$(add) New dashboard...",
// and the pick was told from it by its text: a name with $(trash) drew an
// icon, and a dashboard named as that item could never be opened.
test("a dashboard's and a saved query's $(name) are text in the picks, and any name can be picked (#1929)", async (t) => {
  capture();
  const { live, context } = await setUp(t);
  const fresh = "$(add) New dashboard...";
  await context.workspaceState.update(SAVED_QUERIES_KEY, [{ name: "px $(zap)", code: "select from trade" }]);
  await context.workspaceState.update(DASHBOARDS_KEY, [
    { name: "$(trash) x", columns: 2, tiles: [] },
    { name: fresh, columns: 2, tiles: [] },
  ]);
  live.runApart = async () => ({ ok: true, type: -7, text: ["1"] });
  const dashboards = new Dashboards(context, live);
  const labels = (o) => o.items.map((i) => (typeof i === "string" ? i : i.label));
  let offered;
  stub.picks.push((o) => ((offered = labels(o)), o.items[1]));
  assert.strictEqual(await stub.commands.get(DB_COMMANDS.openDashboard)(), fresh);
  assert.deepStrictEqual(offered, ["\\$(trash) x", "\\$(add) New dashboard...", fresh]);
  assert.strictEqual(stub.inputs.length, 0);
  assert.strictEqual(context.workspaceState.get(DASHBOARDS_KEY).length, 2);
  // Add to Dashboard: the saved query by its own name, onto the dashboard picked.
  const seen = [];
  stub.picks.push((o) => (seen.push(labels(o)), o.items[0]), (o) => (seen.push(labels(o)), o.items[1]));
  const id = await stub.commands.get(DB_COMMANDS.addToDashboard)(undefined, undefined, "hdb");
  assert.deepStrictEqual(seen, [["px \\$(zap)"], ["\\$(trash) x", "\\$(add) New dashboard...", fresh]]);
  const saved = context.workspaceState.get(DASHBOARDS_KEY);
  assert.deepStrictEqual(saved.map((d) => d.tiles.map((x) => x.query)), [[], ["px $(zap)"]]);
  assert.strictEqual(saved[1].tiles[0].id, id);
  dashboards.close();
});

// With no saved query, Add to Dashboard offered an empty pick (#2262).
test("Add to Dashboard with no saved query says to save one first, and asks nothing", async (t) => {
  capture();
  const { live, context } = await setUp(t);
  const dashboards = new Dashboards(context, live);
  let asked;
  stub.picks.push((o) => ((asked = o.title), undefined));
  const said = await stub.commands.get(DB_COMMANDS.addToDashboard)();
  assert.strictEqual(asked, undefined);
  stub.picks.length = 0;
  assert.strictEqual(said, "q-lint: there is no saved query to add yet; save one with q-lint: Save Query.");
  assert.deepStrictEqual(stub.messages.at(-1), ["info", said]);
  assert.deepStrictEqual(context.workspaceState.get(DASHBOARDS_KEY, []), []);
  dashboards.close();
});

// A timer was set only when a tile had none: 5 s -> 300 s went on
// querying every 5 s until the panel closed.
test("changing a tile's refresh interval sets its timer again (#1123)", async (t) => {
  capture();
  const { live, context } = await setUp(t);
  await context.workspaceState.update(SAVED_QUERIES_KEY, [{ name: "px", code: "select from trade" }]);
  live.runApart = async () => ({ ok: true, type: -7, text: ["1"] });
  const dashboards = new Dashboards(context, live);
  stub.inputs.push("Desk");
  stub.picks.push("$(add) New dashboard...");
  const id = await stub.commands.get(DB_COMMANDS.addToDashboard)("px", undefined, "hdb");
  await stub.commands.get(DB_COMMANDS.openDashboard)("Desk");
  await dashboards.receive({ type: "refresh-interval", id, seconds: 5 });
  assert.deepStrictEqual(dashboards.timerSeconds(), [5]);
  await dashboards.receive({ type: "refresh-interval", id, seconds: 300 });
  assert.deepStrictEqual(dashboards.timerSeconds(), [300]);
  await dashboards.receive({ type: "view", id, view: "line" });
  assert.deepStrictEqual(dashboards.timerSeconds(), [300]);
  dashboards.close();
});

// The run kept the view it started with, and the rerun the change asked
// for was skipped as "already running": a table under a select saying line.
test("a tile whose view changes while its run is out is shown in the view chosen (#1339)", async (t) => {
  const { panels } = capture();
  const { live, context } = await setUp(t);
  await context.workspaceState.update(SAVED_QUERIES_KEY, [{ name: "px", code: "select from trade" }]);
  const answer = { ok: true, type: 98, text: [], grid: { count: 2, keys: 0, names: ["a", "b"], types: [7, 9], cells: [["1", "2"], ["3", "4"]], raw: [[1, 2], [3, 4]], rank: [[0, 1], [0, 1]] } };
  let release;
  live.runApart = () => new Promise((r) => (release = () => r(answer)));
  const dashboards = new Dashboards(context, live);
  stub.inputs.push("Desk");
  stub.picks.push("$(add) New dashboard...");
  const id = await stub.commands.get(DB_COMMANDS.addToDashboard)("px", undefined, "hdb");
  await stub.commands.get(DB_COMMANDS.openDashboard)("Desk");
  await new Promise((r) => setTimeout(r, 20));
  await dashboards.receive({ type: "view", id, view: "line" });
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(context.workspaceState.get(DASHBOARDS_KEY)[0].tiles[0].view, "line");
  assert.strictEqual(dashboards.contents.get(id).kind, "chart");
  assert.strictEqual(panels[0].posted.filter((m) => m.type === "tile").at(-1).content.kind, "chart");
  dashboards.close();
});

// The answer of the run before the failed one was still held, so a view
// change drew it over the error, under the failed run's time.
test("a tile whose refresh failed still shows the failure after its view changes (#1925)", async (t) => {
  const { panels } = capture();
  const { live, context } = await setUp(t);
  await context.workspaceState.update(SAVED_QUERIES_KEY, [{ name: "px", code: "select from trade" }]);
  let fails = false;
  let runs = 0;
  live.runApart = async () => {
    runs++;
    if (fails) throw new Error("connect ECONNREFUSED 127.0.0.1:5010");
    return { ok: true, type: 98, text: [], grid: { count: 2, keys: 0, names: ["a", "b"], types: [7, 9], cells: [["1", "2"], ["3", "4"]], raw: [[1, 2], [3, 4]], rank: [[0, 1], [0, 1]] } };
  };
  const dashboards = new Dashboards(context, live);
  stub.inputs.push("Desk");
  stub.picks.push("$(add) New dashboard...");
  const id = await stub.commands.get(DB_COMMANDS.addToDashboard)("px", undefined, "hdb");
  await stub.commands.get(DB_COMMANDS.openDashboard)("Desk");
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(dashboards.contents.get(id).kind, "table");
  fails = true;
  await dashboards.receive({ type: "refresh", id });
  const failure = { kind: "error", text: "connect ECONNREFUSED 127.0.0.1:5010" };
  assert.deepStrictEqual(dashboards.contents.get(id), failure);
  await dashboards.receive({ type: "view", id, view: "line" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(dashboards.contents.get(id), failure);
  assert.deepStrictEqual(panels[0].posted.filter((m) => m.type === "tile").at(-1).content, failure);
  assert.strictEqual(runs, 2);
  // The saved query gone is a failure of the same kind: nothing older is drawn.
  fails = false;
  await dashboards.receive({ type: "refresh", id });
  assert.strictEqual(dashboards.contents.get(id).kind, "chart");
  await context.workspaceState.update(SAVED_QUERIES_KEY, []);
  await dashboards.receive({ type: "refresh", id });
  await dashboards.receive({ type: "view", id, view: "table" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(dashboards.contents.get(id), { kind: "error", text: "There is no saved query px any more." });
  dashboards.close();
});

// A layout change draws every tile again from what it last showed, and
// sent that without its time: every "at 09:30:00" went blank.
test("a tile drawn again after a layout change keeps the time it ran at (#1341)", async (t) => {
  const { panels } = capture();
  const { live, context } = await setUp(t);
  await context.workspaceState.update(SAVED_QUERIES_KEY, [{ name: "px", code: "select from trade" }]);
  let runs = 0;
  live.runApart = async () => (runs++, { ok: true, type: -7, text: ["1"] });
  const dashboards = new Dashboards(context, live);
  stub.inputs.push("Desk");
  stub.picks.push("$(add) New dashboard...");
  await stub.commands.get(DB_COMMANDS.addToDashboard)("px", undefined, "hdb");
  await stub.commands.get(DB_COMMANDS.openDashboard)("Desk");
  await new Promise((r) => setTimeout(r, 20));
  const ran = panels[0].posted.filter((m) => m.type === "tile").at(-1);
  assert.match(ran.at, /\d/);
  await dashboards.receive({ type: "columns", columns: 3 });
  const again = panels[0].posted.filter((m) => m.type === "tile").at(-1);
  assert.notStrictEqual(again, ran, "posted again");
  assert.strictEqual(runs, 1, "not run again");
  assert.strictEqual(again.at, ran.at);
  dashboards.close();
});

// Adding a tile drew the dashboard with "run every tile": a tile set to
// refresh only when asked ran again because another was added.
test("adding a tile to an open dashboard runs the new tile only (#1789)", async (t) => {
  capture();
  const { live, context } = await setUp(t);
  await context.workspaceState.update(SAVED_QUERIES_KEY, [{ name: "px", code: "select from trade" }, { name: "py", code: "select from quote" }]);
  const ran = [];
  live.runApart = async (_p, code) => (ran.push(code), { ok: true, type: -7, text: ["1"] });
  const dashboards = new Dashboards(context, live);
  stub.inputs.push("Desk");
  stub.picks.push("$(add) New dashboard...");
  await stub.commands.get(DB_COMMANDS.addToDashboard)("px", undefined, "hdb");
  await stub.commands.get(DB_COMMANDS.openDashboard)("Desk");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(ran, ["select from trade"]);
  await stub.commands.get(DB_COMMANDS.addToDashboard)("py", "Desk", "hdb");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(ran, ["select from trade", "select from quote"]);
  dashboards.close();
});

// Deleting a process left its tiles drawn on an open dashboard, their
// timers running and their Refresh doing nothing (#2550).
test("an open dashboard draws its tiles again when a tile's process is deleted", async (t) => {
  const { panels } = capture();
  const { live, context } = await setUp(t);
  await context.globalState.update("q-lint.processes", [...live.processes(), { label: "b", host: "127.0.0.1", port: 1, tags: [] }]);
  await context.workspaceState.update(SAVED_QUERIES_KEY, [{ name: "px", code: "select from trade" }]);
  live.runApart = async () => ({ ok: true, type: -7, text: ["1"] });
  const dashboards = new Dashboards(context, live);
  stub.inputs.push("Desk");
  stub.picks.push("$(add) New dashboard...");
  const a = await stub.commands.get(DB_COMMANDS.addToDashboard)("px", undefined, "hdb");
  const b = await stub.commands.get(DB_COMMANDS.addToDashboard)("px", "Desk", "b");
  await stub.commands.get(DB_COMMANDS.openDashboard)("Desk");
  await dashboards.receive({ type: "refresh-interval", id: a, seconds: 5 });
  assert.strictEqual(dashboards.timerCount(), 1);
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteProcess")("hdb");
  const layout = panels[0].posted.filter((m) => m.type === "layout").at(-1);
  assert.deepStrictEqual(layout.tiles.map((x) => x.id), [b]);
  assert.strictEqual(dashboards.timerCount(), 0);
  dashboards.close();
});

// Add to Dashboard offers discovered and shared processes, but a tile ran
// only on a saved one: "There is no saved process desk/rdb", every time.
test("a tile on a discovered process runs on it (#1122)", async (t) => {
  capture();
  const { live, context } = await setUp(t);
  await context.workspaceState.update(SAVED_QUERIES_KEY, [{ name: "px", code: "select from trade" }]);
  live.discovery.discovered = () => [{ server: { label: "desk", url: "http://x/" }, state: { processes: [{ label: "rdb", host: "h", port: 1, tags: [] }], problems: [], loading: false } }];
  const ran = [];
  live.runApart = async (process) => (ran.push([process.label, process.server, process.host]), { ok: true, type: -7, text: ["1"] });
  const dashboards = new Dashboards(context, live);
  await dashboards.runTile({ id: "t", query: "px", process: "desk/rdb", view: "table", refresh: 0 });
  assert.deepStrictEqual(ran, [["desk/rdb", "desk", "h"]]);
  await dashboards.runTile({ id: "u", query: "px", process: "gone/rdb", view: "table", refresh: 0 });
  assert.deepStrictEqual(dashboards.contents.get("u"), { kind: "error", text: "There is no q process gone/rdb." });
});

test("a chart is rendered from a file to the path given", async (t) => {
  capture();
  const { context, live } = await setUp(t);
  void context;
  void live;
  vscode.workspace.fs = {
    readFile: async (u) => fs.readFileSync(u.fsPath),
    writeFile: async (u, data) => fs.writeFileSync(u.fsPath, data),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-chartcmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "d.csv"), "x,y\n1,2\n2,3\n");
  const svg = await stub.commands.get(DB_COMMANDS.renderChart)(path.join(dir, "d.csv"), "scatter", path.join(dir, "d.svg"));
  assert.ok(svg.startsWith("<svg"));
  assert.strictEqual(fs.readFileSync(path.join(dir, "d.svg"), "utf8"), svg);
});

const Q = process.env.QLINT_TEST_Q;

test("the tickerplant log is read in a q of the extension's own, replayed there after asking, and goes when turned off", { skip: Q ? false : "QLINT_TEST_Q names no q binary" }, async (t) => {
  const { panels } = capture();
  stub.reset();
  stub.config.user["terminal.qBinary"] = Q;
  const context = stub.newContext();
  const log = new TickerplantLog(context);
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tplog-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A log written by a q of the test's own.
  const make = path.join(dir, "make.q");
  fs.writeFileSync(make, ['f:hsym`$"' + path.join(dir, "tp.log") + '";', ".[f;();:;()];", "h:hopen f;", "h enlist(`upd;`t;([]time:enlist 2026.01.05D09:00:00;x:enlist 1));", "h enlist(`upd;`t;([]time:enlist 2026.01.05D10:00:00;x:enlist 2));", "hclose h;", "exit 0;", ""].join("\n"));
  require("node:child_process").execSync(`${Q} ${make}`, { stdio: "ignore", timeout: 15000 });
  assert.strictEqual(await log.open(path.join(dir, "tp.log")), "2 messages");
  const port = log.port;
  assert.ok(port > 0);
  await log.receive({ type: "ready" });
  const page = log.posted.find((m) => m.type === "page");
  assert.deepStrictEqual(page.rows.map((r) => r.table), ["t", "t"]);
  await log.receive({ type: "page", table: "t", from: "09:30", to: "", offset: 0 });
  assert.deepStrictEqual(log.posted.at(-1).rows.map((r) => r.index), [1]);
  stub.picks.push(undefined);
  assert.strictEqual(await log.replay(0, 1), "not replayed");
  stub.picks.push("Replay");
  assert.match(await log.replay(0, 1), /Replayed 2 messages\. The local q on port \d+ now holds t 2 rows/);
  stub.config.user["tickerplantLog.enable"] = false;
  stub.changeConfig("q-lint.tickerplantLog.enable");
  assert.strictEqual(panels[0].disposed, true);
  assert.strictEqual(log.port, undefined);
  await new Promise((r) => setTimeout(r, 300));
  const up = await new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });
  assert.strictEqual(up, false);
});

/// A tickerplant log of two messages, written by a q of the test's own, in a
/// directory removed after.
function tpLogFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tplog-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = path.join(dir, "make.q");
  fs.writeFileSync(make, ['f:hsym`$"' + path.join(dir, "tp.log") + '";', ".[f;();:;()];", "h:hopen f;", "h enlist(`upd;`t;([]time:enlist 2026.01.05D09:00:00;x:enlist 1));", "h enlist(`upd;`t;([]time:enlist 2026.01.05D10:00:00;x:enlist 2));", "hclose h;", "exit 0;", ""].join("\n"));
  require("node:child_process").execSync(`${Q} ${make}`, { stdio: "ignore", timeout: 15000 });
  return path.join(dir, "tp.log");
}

// The local q runs code: only the extension, with its one-time password,
// may connect to it, not another local user (#1574).
test("the tickerplant log's local q refuses a connection without its password", { skip: Q ? false : "QLINT_TEST_Q names no q binary" }, async (t) => {
  capture();
  stub.reset();
  stub.config.user["terminal.qBinary"] = Q;
  const context = stub.newContext();
  const log = new TickerplantLog(context);
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  assert.strictEqual(await log.open(tpLogFile(t)), "2 messages");
  const { QConnection } = require("../out/qclient.js");
  for (const target of [{}, { user: "qlint", password: "guess" }, { user: process.env.USER ?? "u", password: "" }]) {
    await assert.rejects(
      QConnection.open({ host: "127.0.0.1", port: log.port, ...target }, 2000).then((c) => c.call("{system\"echo hi\"}", 0)),
      /refused|closed/,
      JSON.stringify(target),
    );
  }
  // The extension's own connection still works.
  await log.receive({ type: "ready" });
  assert.deepStrictEqual(log.posted.find((m) => m.type === "page").rows.map((r) => r.table), ["t", "t"]);
});

test("a log opened while another is starting stops the first one's q (#1074)", { skip: Q ? false : "QLINT_TEST_Q names no q binary" }, async (t) => {
  capture();
  stub.reset();
  stub.config.user["terminal.qBinary"] = Q;
  const context = stub.newContext();
  const log = new TickerplantLog(context);
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  const file = tpLogFile(t);
  const cp = require("node:child_process");
  const spawn = cp.spawn;
  const children = [];
  cp.spawn = (...args) => {
    const child = spawn(...args);
    // The q's, not its lifeline's watchdog, which starts in no directory.
    if (args[2]?.cwd !== undefined) children.push({ child, dir: args[2].cwd });
    return child;
  };
  t.after(() => (cp.spawn = spawn));
  const [first, second] = await Promise.all([log.open(file), log.open(file)]);
  cp.spawn = spawn;
  assert.strictEqual(first, "superseded");
  assert.strictEqual(second, "2 messages");
  assert.strictEqual(children.length, 2);
  await new Promise((r) => setTimeout(r, 300));
  assert.notStrictEqual(children[0].child.exitCode ?? children[0].child.signalCode, null);
  assert.strictEqual(fs.existsSync(children[0].dir), false);
  assert.strictEqual(children[1].child.exitCode, null);
  log.close();
});

test("the tickerplant log's page asks one thing at a time: a click during a page load waits (#1112)", { skip: Q ? false : "QLINT_TEST_Q names no q binary" }, async (t) => {
  capture();
  stub.reset();
  stub.config.user["terminal.qBinary"] = Q;
  const context = stub.newContext();
  const log = new TickerplantLog(context);
  t.after(() => log.close());
  assert.strictEqual(await log.open(tpLogFile(t)), "2 messages");
  await Promise.all([
    log.receive({ type: "page", table: "", from: "", to: "", offset: 0 }),
    log.receive({ type: "show", index: 1 }),
    log.receive({ type: "page", table: "t", from: "09:30", to: "", offset: 0 }),
  ]);
  assert.deepStrictEqual(log.posted.filter((m) => m.failed), []);
  assert.deepStrictEqual(log.posted.map((m) => m.type), ["page", "message", "page"]);
  assert.deepStrictEqual(log.posted.at(-1).rows.map((r) => r.index), [1]);
});

test("Load Schema loads a q file whose path has a space, and the local q keeps its own directory (#1257)", { skip: Q ? false : "QLINT_TEST_Q names no q binary" }, async (t) => {
  capture();
  stub.reset();
  stub.config.user["terminal.qBinary"] = Q;
  const context = stub.newContext();
  const log = new TickerplantLog(context);
  t.after(() => log.close());
  const file = tpLogFile(t);
  assert.strictEqual(await log.open(file), "2 messages");
  const spaced = path.join(path.dirname(file), "sch ema");
  fs.mkdirSync(spaced);
  fs.writeFileSync(path.join(spaced, "part.q"), "u:([]time:`timestamp$();x:`long$())\n");
  fs.writeFileSync(path.join(spaced, "schema.q"), "\\l part.q\nt:u\n");
  fs.writeFileSync(path.join(spaced, "my schema.q"), "t:([]time:`timestamp$();x:`long$();y:`float$())\n");
  const dialog = vscode.window.showOpenDialog;
  t.after(() => (vscode.window.showOpenDialog = dialog));
  // A schema that loads another file by a path relative to its own.
  vscode.window.showOpenDialog = async () => [vscode.Uri.file(path.join(spaced, "schema.q"))];
  await log.receive({ type: "schema" });
  assert.deepStrictEqual(log.posted.at(-1), { type: "status", text: "Loaded schema.q into the local q." });
  stub.picks.push("Replay");
  assert.match(await log.replay(0, 1), /Replayed 2 messages\. .* holds t 2 rows, u 0 rows/);
  // A file name with a space in it.
  vscode.window.showOpenDialog = async () => [vscode.Uri.file(path.join(spaced, "my schema.q"))];
  await log.receive({ type: "schema" });
  assert.deepStrictEqual(log.posted.at(-1), { type: "status", text: "Loaded my schema.q into the local q." });
  // The local q still reads a cut log in its own directory.
  const b = fs.readFileSync(file);
  fs.writeFileSync(path.join(path.dirname(file), "cut.log"), b.subarray(0, b.length - 4));
  assert.strictEqual(await log.open(path.join(path.dirname(file), "cut.log")), "1 messages");
});

test("opening a second log lists its messages, not the first one's (#1258)", { skip: Q ? false : "QLINT_TEST_Q names no q binary" }, async (t) => {
  capture();
  stub.reset();
  stub.config.user["terminal.qBinary"] = Q;
  const context = stub.newContext();
  const log = new TickerplantLog(context);
  t.after(() => log.close());
  const file = tpLogFile(t);
  assert.strictEqual(await log.open(file), "2 messages");
  await log.receive({ type: "ready" });
  const b = fs.readFileSync(file);
  const cut = path.join(path.dirname(file), "cut.log");
  fs.writeFileSync(cut, b.subarray(0, b.length - 4));
  log.posted.length = 0;
  assert.strictEqual(await log.open(cut), "1 messages");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(log.posted.map((m) => m.type), ["log", "page"]);
  assert.deepStrictEqual(log.posted[1].rows.map((r) => r.index), [0]);
});

// A file that was not a log stopped the open log's q first, and every
// click on its panel did nothing after (#2552).
test("opening a file that is not a log leaves the open log working", { skip: Q ? false : "QLINT_TEST_Q names no q binary" }, async (t) => {
  capture();
  stub.reset();
  stub.config.user["terminal.qBinary"] = Q;
  const context = stub.newContext();
  const log = new TickerplantLog(context);
  t.after(() => log.close());
  const file = tpLogFile(t);
  assert.strictEqual(await log.open(file), "2 messages");
  const port = log.port;
  const bad = path.join(path.dirname(file), "bad.log");
  fs.writeFileSync(bad, "not a log\n");
  assert.match(await log.open(bad), /could not read .*bad\.log/);
  assert.strictEqual(log.port, port);
  log.posted.length = 0;
  await log.receive({ type: "page", table: "", from: "", to: "", offset: 0 });
  assert.deepStrictEqual(log.posted.map((m) => [m.type, m.total]), [["page", 2]]);
});

test("the local q's directory is removed once the q has exited, where it cannot be before (#1287)", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "a read-only directory stands in for a running q on POSIX, as a non-root user" : false }, async () => {
  const { once } = require("node:events");
  const { spawn } = require("node:child_process");
  const { stopLocalQ } = require("../out/tplogview.js");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tplog-test-"));
  const dir = path.join(parent, "q");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "qlint_tplog.q"), "");
  // A child of its own group, as the local q is: stopLocalQ signals that
  // group, so the pid has to be one this test owns (#1874).
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  await once(child, "spawn");
  // As on Windows, where a running q's directory cannot be removed.
  fs.chmodSync(parent, 0o555);
  try {
    stopLocalQ({ child, dir, port: 0, connection: undefined, output: "" });
    assert.strictEqual(fs.existsSync(dir), true);
    fs.chmodSync(parent, 0o755);
    await once(child, "exit");
    assert.strictEqual(fs.existsSync(dir), false);
  } finally {
    child.kill("SIGKILL");
    fs.chmodSync(parent, 0o755);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("stopping the local q ends a wrapper script's q too, not the wrapper alone (#1874)", { skip: process.platform === "win32" ? "no process groups" : false }, async () => {
  const { once } = require("node:events");
  const { spawn } = require("node:child_process");
  const { stopLocalQ } = require("../out/tplogview.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tplog-test-"));
  // As startLocalQ spawns it, in a group of its own; the "q" is a wrapper
  // whose q runs as its child (rlwrap-style, no exec), and says its pid.
  const child = spawn("/bin/sh", ["-c", "sleep 300 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const [said] = await once(child.stdout, "data");
  const inner = Number(String(said).trim());
  assert.ok(inner > 1 && inner !== child.pid, String(said));
  const alive = () => {
    try {
      process.kill(inner, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    assert.strictEqual(alive(), true);
    stopLocalQ({ child, dir, port: 0, connection: undefined, output: "" });
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(alive(), false, "the wrapper's q is still running");
    assert.strictEqual(fs.existsSync(dir), false);
  } finally {
    if (alive()) process.kill(inner, "SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: the log's local q runs a q.cmd wrapper by cmd.exe, as the launcher does (#1815)", async (t) => {
  const { EventEmitter } = require("node:events");
  const { startLocalQ } = require("../out/tplogview.js");
  const cp = require("node:child_process");
  const { spawn } = cp;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const spawned = [];
  // A q that has exited at once, with no pid: nothing is signalled.
  cp.spawn = (command, args, options) => {
    spawned.push({ command, args, verbatim: options.windowsVerbatimArguments });
    return Object.assign(new EventEmitter(), { pid: undefined, exitCode: 1, signalCode: null, kill: () => true });
  };
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => {
    cp.spawn = spawn;
    Object.defineProperty(process, "platform", platform);
  });
  await assert.rejects(startLocalQ("C:\\q\\q.cmd", {}, 1000), /did not start/);
  assert.strictEqual(spawned.length, 1);
  assert.match(spawned[0].command, /cmd\.exe$/i);
  assert.deepStrictEqual(spawned[0].args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(spawned[0].args[3], /^"C:\\q\\q\.cmd .*qlint_tplog\.q -p 127\.0\.0\.1:\d+"$/);
  assert.strictEqual(spawned[0].verbatim, true);
});

test("Open Tickerplant Log starts the q of the log file's own workspace folder (#1842)", { skip: process.platform === "win32" && "POSIX paths" }, async (t) => {
  capture();
  stub.reset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tplog-folder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const A = path.join(root, "A");
  const B = path.join(root, "B");
  fs.mkdirSync(path.join(A, "bin"), { recursive: true });
  fs.mkdirSync(path.join(B, "bin"), { recursive: true });
  fs.mkdirSync(path.join(B, "logs"));
  // Each folder's ./bin/q leaves its mark; neither is a q.
  for (const dir of [A, B]) fs.writeFileSync(path.join(dir, "bin", "q"), `#!/bin/sh\ntouch '${path.join(dir, "ran")}'\n`, { mode: 0o755 });
  stub.config.user["terminal.qBinary"] = "./bin/q";
  const folders = [A, B].map((d, index) => ({ uri: vscode.Uri.file(d), name: path.basename(d), index }));
  const plain = { folders: vscode.workspace.workspaceFolders, get: vscode.workspace.getWorkspaceFolder };
  vscode.workspace.workspaceFolders = folders;
  vscode.workspace.getWorkspaceFolder = (uri) => folders.find((f) => uri.fsPath.startsWith(f.uri.fsPath + path.sep));
  t.after(() => void Object.assign(vscode.workspace, { workspaceFolders: plain.folders, getWorkspaceFolder: plain.get }));
  const context = stub.newContext();
  const log = new TickerplantLog(context);
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  await log.open(path.join(B, "logs", "tp2026.11.24"));
  assert.strictEqual(fs.existsSync(path.join(B, "ran")), true, "B's q was started");
  assert.strictEqual(fs.existsSync(path.join(A, "ran")), false, "A's was not");
});
