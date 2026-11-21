// Stream Tickerplant Table (#915): how an update is read and the last rows
// kept, the settings and their off state, and a stream from a real q
// tickerplant - one publishing as TorQ's and kdb+tick's do, `.u.sub` adding
// the handle and `.u.pub` sending `(`upd;t;x)` to it - when QLINT_TEST_Q
// names a q binary.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const pkg = require("../package.json");
const { RowWindow, STREAM_COMMANDS, readStream, readUpdate } = require("../out/stream.js");
const { QConnection } = require("../out/qclient.js");
const { Live } = require("../out/live.js");
const { TableStreams } = require("../out/streamview.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sym = (v) => ({ kind: "atom", t: -11, v });
const upd = (table, data) => ({ kind: "list", attr: 0, v: [sym("upd"), sym(table), data] });

test("an update's rows are read as q's text, in the subscribed columns' order", () => {
  const data = {
    kind: "table",
    attr: 0,
    cols: ["sym", "px"],
    data: [
      { kind: "vector", t: 11, attr: 0, v: ["a", "b"] },
      { kind: "vector", t: 9, attr: 0, v: [1.5, 2] },
    ],
  };
  assert.deepStrictEqual(readUpdate(upd("trade", data), "trade", ["sym", "px"]), [["a", "1.5"], ["b", "2"]]);
  // A list of columns, named by the subscription.
  assert.deepStrictEqual(readUpdate(upd("trade", { kind: "list", attr: 0, v: data.data }), "trade", ["sym", "px"]), [["a", "1.5"], ["b", "2"]]);
  // One row as a list of atoms.
  const row = { kind: "list", attr: 0, v: [sym("c"), { kind: "atom", t: -9, v: 3 }] };
  assert.deepStrictEqual(readUpdate(upd("trade", row), "trade", ["sym", "px"]), [["c", "3"]]);
  // Another table's update, or not an update: nothing.
  assert.strictEqual(readUpdate(upd("quote", data), "trade", ["sym", "px"]), undefined);
  assert.strictEqual(readUpdate(sym("x"), "trade", ["sym"]), undefined);
});

test("the grid keeps the newest rows, and counts them all", () => {
  const w = new RowWindow(3);
  w.push([["1"], ["2"]]);
  w.push([["3"], ["4"]]);
  assert.deepStrictEqual(w.rows(), [["2"], ["3"], ["4"]]);
  w.push([["5"], ["6"], ["7"], ["8"]]);
  assert.deepStrictEqual(w.rows(), [["6"], ["7"], ["8"]]);
  assert.strictEqual(w.total, 8);
});

test("streaming is off by default, keeps 1000 rows, and is hidden while off", () => {
  assert.deepStrictEqual(readStream((_k, f) => f), { enabled: false, rows: 1000 });
  const set = (values) => readStream((k, f) => (k in values ? values[k] : f));
  assert.strictEqual(set({ "tickerplant.stream.enable": "true" }).enabled, false);
  assert.strictEqual(set({ "tickerplant.stream.rows": 0 }).rows, 1000);
  assert.strictEqual(set({ "tickerplant.stream.rows": 1e6 }).rows, 10000);
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process connections");
  assert.strictEqual(section.properties["q-lint.tickerplant.stream.enable"].default, false);
  assert.strictEqual(section.properties["q-lint.tickerplant.stream.rows"].default, 1000);
  for (const m of Object.values(pkg.contributes.menus).flat().filter((m) => m.command === STREAM_COMMANDS.start)) {
    assert.match(m.when, /config\.q-lint\.tickerplant\.stream\.enable/);
  }
});

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// A tickerplant as kdb+tick's u.q and TorQ's are: `.u.t`, `.u.w`, `.u.sub`
/// answering (table; empty table), `.u.pub` sending `(`upd;t;x)` to each
/// subscriber, and `.z.pc` dropping a closed one.
const TICKERPLANT = [
  "trade:([] time:`timespan$(); sym:`symbol$(); px:`float$())",
  ".u.t:enlist `trade",
  ".u.w:.u.t!enlist ()",
  ".u.sub:{[t;s] if[not t in .u.t; 'string t]; .u.w[t],:enlist (.z.w;s); (t;value t)}",
  ".u.pub:{[t;x] {[t;x;w] neg[first w] (`upd;t;x)}[t;x] each .u.w t}",
  ".z.pc:{.u.w:{x where not y=first each x}[;x] each .u.w}",
  "batch:{[n] .u.pub[`trade;([] time:n#0D10:00:00.000000001; sym:n#`a`b`c; px:`float$til n)]}",
  "",
].join("\n");

async function startQ(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tp-"));
  fs.writeFileSync(path.join(dir, "tp.q"), body);
  const port = await freePort();
  const child = spawn(`${Q} ${path.join(dir, "tp.q")} -p ${port}`, { shell: true, stdio: "ignore", detached: true });
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (up) return port;
    await sleep(100);
  }
  throw new Error("q did not start");
}

/// A Live and TableStreams over a fresh context, webview panels faked to
/// keep what was posted to them.
async function setUp(t, processes) {
  stub.reset();
  const vscode = require("vscode");
  const panels = [];
  const make = vscode.window.createWebviewPanel;
  vscode.window.createWebviewPanel = (_id, title) => {
    const disposers = [];
    const receivers = [];
    const panel = {
      title,
      posted: [],
      webview: { html: "", cspSource: "csp", asWebviewUri: (u) => u, postMessage: async (m) => void panel.posted.push(m), onDidReceiveMessage: (f) => receivers.push(f) },
      onDidDispose: (f) => disposers.push(f),
      dispose: () => disposers.forEach((f) => f()),
      send: (m) => receivers.forEach((f) => f(m)),
    };
    panels.push(panel);
    return panel;
  };
  t.after(() => (vscode.window.createWebviewPanel = make));
  const context = stub.newContext();
  context.extensionUri = vscode.Uri.file("/ext");
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const streams = new TableStreams(context, live);
  t.after(async () => {
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, streams, panels };
}

test("with q-lint.tickerplant.stream.enable off, Stream Tickerplant Table refuses and connects to nothing", async (t) => {
  // A port nothing listens on: a connect would be an error message.
  const { streams, panels } = await setUp(t, [{ label: "tp", host: "127.0.0.1", port: 1, tags: [] }]);
  await stub.commands.get(STREAM_COMMANDS.start)("tp", "trade");
  assert.deepStrictEqual(stub.messages, [
    ["info", "q-lint: Streaming a tickerplant table is turned off. Set q-lint.tickerplant.stream.enable to true to turn it on."],
  ]);
  assert.deepStrictEqual(panels, []);
  assert.deepStrictEqual(streams.state(), []);
});

test("a tickerplant table streams into the grid, keeping its newest rows, and closing unsubscribes", { skip }, async (t) => {
  const port = await startQ(t, TICKERPLANT);
  const { streams, panels } = await setUp(t, [
    { label: "tp", host: "127.0.0.1", port, tags: [] },
    { label: "prodtp", host: "127.0.0.1", port, tags: ["prod"] },
  ]);
  stub.config.user["tickerplant.stream.enable"] = true;
  stub.config.user["tickerplant.stream.rows"] = 4;
  // The table is picked from what .u.t lists.
  stub.picks.push((o) => (assert.deepStrictEqual(o.items, ["trade"]), "trade"));
  await stub.commands.get(STREAM_COMMANDS.start)("tp");
  assert.strictEqual(panels.length, 1);
  assert.strictEqual(panels[0].title, "q: trade on tp");
  assert.match(panels[0].webview.html, /script-src 'nonce-[^']+'/);
  const publisher = await QConnection.open({ host: "127.0.0.1", port });
  t.after(() => publisher.close());
  assert.deepStrictEqual(await publisher.call('"i"$count .u.w`trade'), 1);
  await publisher.call("batch 3");
  await publisher.call("batch 3");
  for (let i = 0; i < 50 && streams.state()[0].total < 6; i++) await sleep(20);
  const [s] = streams.state();
  assert.deepStrictEqual(s.columns, ["time", "sym", "px"]);
  assert.strictEqual(s.total, 6);
  assert.deepStrictEqual(s.rows, [
    ["0D10:00:00.000000001", "c", "2"],
    ["0D10:00:00.000000001", "a", "0"],
    ["0D10:00:00.000000001", "b", "1"],
    ["0D10:00:00.000000001", "c", "2"],
  ]);
  // The page is sent the rows, at most every 200 ms; paused, it is sent none.
  for (let i = 0; i < 50 && panels[0].posted.at(-1)?.total !== 6; i++) await sleep(20);
  assert.deepStrictEqual(panels[0].posted.at(-1).rows, s.rows);
  panels[0].send({ type: "pause", paused: true });
  const sent = panels[0].posted.length;
  await publisher.call("batch 1");
  await sleep(400);
  assert.strictEqual(panels[0].posted.length, sent);
  assert.strictEqual(streams.state()[0].total, 7);
  // Closing the grid closes its connection, which the tickerplant drops.
  panels[0].dispose();
  for (let i = 0; i < 50 && (await publisher.call('"i"$count .u.w`trade')) !== 0; i++) await sleep(20);
  assert.strictEqual(await publisher.call('"i"$count .u.w`trade'), 0);
  assert.deepStrictEqual(streams.state(), []);
  // A production tickerplant asks first; Escape subscribes nothing.
  await stub.commands.get(STREAM_COMMANDS.start)("prodtp", "trade");
  assert.match(stub.messages.at(-1)[1], /prodtp is a production process/);
  assert.strictEqual(panels.length, 1);
  // A table the tickerplant does not publish is its error.
  await stub.commands.get(STREAM_COMMANDS.start)("tp", "quote");
  assert.match(stub.messages.at(-1)[1], /could not subscribe to quote on tp: quote/);
  // Turned off, every stream closes.
  await stub.commands.get(STREAM_COMMANDS.start)("tp", "trade");
  assert.strictEqual(streams.state().length, 1);
  stub.config.user["tickerplant.stream.enable"] = false;
  stub.changeConfig("q-lint.tickerplant.stream.enable");
  assert.deepStrictEqual(streams.state(), []);
  for (let i = 0; i < 50 && (await publisher.call('"i"$count .u.w`trade')) !== 0; i++) await sleep(20);
  assert.strictEqual(await publisher.call('"i"$count .u.w`trade'), 0);
});
