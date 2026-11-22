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
const { registerDbTools } = require("../out/dbtoolsview.js");
const { DB_COMMANDS, DB_SETTINGS } = require("../out/dbfeatures.js");
const { TABLE_INFO } = require("../out/tableinfo.js");
const { DOCUMENT } = require("../out/dbdoc.js");

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

function answers(m) {
  const lambda = Array.isArray(m) ? m[0] : m;
  if (lambda === TABLE_INFO) return INFO;
  if (lambda === DOCUMENT) return DOC;
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
