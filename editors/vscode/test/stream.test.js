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
  // A char atom is its char, not its byte's number (#1490): (`a;"B";1.5).
  const chars = { kind: "list", attr: 0, v: [sym("a"), { kind: "atom", t: -10, v: 66 }, { kind: "atom", t: -9, v: 1.5 }] };
  assert.deepStrictEqual(readUpdate(upd("trade", chars), "trade", ["sym", "side", "px"]), [["a", "B", "1.5"]]);
  // Another table's update, or not an update: nothing.
  assert.strictEqual(readUpdate(upd("quote", data), "trade", ["sym", "px"]), undefined);
  assert.strictEqual(readUpdate(sym("x"), "trade", ["sym"]), undefined);
});

test("a one-row update of string columns is one row, not its characters as columns (#1582)", () => {
  const chars = (t) => ({ kind: "chars", attr: 0, v: Buffer.from(t) });
  const one = upd("t", { kind: "list", attr: 0, v: [chars("abc"), chars("de")] });
  assert.deepStrictEqual(readUpdate(one, "t", ["a", "b"]).length, 1);
  const even = upd("t", { kind: "list", attr: 0, v: [chars("ab"), chars("cd")] });
  assert.deepStrictEqual(readUpdate(even, "t", ["a", "b"], "  ").length, 1);
  assert.deepStrictEqual(readUpdate(even, "t", ["a", "b"], "CC").length, 1);
  // Char columns: two rows.
  assert.deepStrictEqual(readUpdate(even, "t", ["a", "b"], "cc"), [["a", "c"], ["b", "d"]]);
});

test("a one-row update of atoms of one type, which q sends as a simple list, is one row (#1921)", () => {
  // (`upd;`px;(1.5;2.5)), (`a;`b), ("B";"x") and enlist 1.5.
  const vector = (t, v) => ({ kind: "vector", t, attr: 0, v });
  assert.deepStrictEqual(readUpdate(upd("px", vector(9, [1.5, 2.5])), "px", ["bid", "ask"]), [["1.5", "2.5"]]);
  assert.deepStrictEqual(readUpdate(upd("px", vector(11, ["a", "b"])), "px", ["sym", "src"], "ss"), [["a", "b"]]);
  assert.deepStrictEqual(readUpdate(upd("px", { kind: "chars", attr: 0, v: Buffer.from("Bx") }), "px", ["side", "flag"], "cc"), [["B", "x"]]);
  assert.deepStrictEqual(readUpdate(upd("px", vector(9, [1.5])), "px", ["bid"]), [["1.5"]]);
  // Not a row of the table: q's own insert refuses it, 'length.
  assert.strictEqual(readUpdate(upd("px", vector(9, [1.5, 2.5, 3.5])), "px", ["bid", "ask"]), undefined);
  assert.strictEqual(readUpdate(upd("px", { kind: "chars", attr: 0, v: Buffer.from("abc") }), "px", ["side"]), undefined);
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

test("a tickerplant the read-only guard guards asks before .u.sub; declined, nothing is connected to or sent (#918)", async (t) => {
  // A port nothing listens on: a connect would be an error message.
  const { streams, panels } = await setUp(t, [{ label: "tp", host: "127.0.0.1", port: 1, tags: ["live"] }]);
  stub.config.user["tickerplant.stream.enable"] = true;
  stub.config.user["processes.readOnlyGuard.tags"] = ["live"];
  stub.picks.push(undefined);
  await stub.commands.get(STREAM_COMMANDS.start)("tp", "trade");
  assert.strictEqual(stub.messages.length, 1);
  assert.match(stub.messages[0][1], /^tp is read-only guarded \(tagged live\)\. Subscribing adds q-lint/);
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
  stub.picks.push((o) => (assert.deepStrictEqual(o.items, [{ label: "trade", table: "trade" }]), o.items[0]));
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

test("streaming turned off while Stream Table asks for the table subscribes to nothing and opens no grid (#1419)", async (t) => {
  const { fakeQ, heads } = require("./fakeq.js");
  const { SUBSCRIBE } = require("../out/stream.js");
  const q = await fakeQ((m) => (Array.isArray(m) && m[0] === SUBSCRIBE ? ["trade", ["time", "sym", "px"]] : null));
  t.after(() => q.close());
  const { panels, streams } = await setUp(t, [{ label: "tp", host: "127.0.0.1", port: q.port, tags: [] }]);
  stub.config.user["tickerplant.stream.enable"] = true;
  stub.inputs.push(() => {
    stub.config.user["tickerplant.stream.enable"] = false;
    stub.changeConfig("q-lint.tickerplant.stream.enable");
    return "trade";
  });
  await stub.commands.get(STREAM_COMMANDS.start)("tp");
  await sleep(50);
  assert.ok(!heads(q.sent).includes(SUBSCRIBE));
  assert.deepStrictEqual(panels, []);
  assert.deepStrictEqual(streams.state(), []);
});

test("closing the grid touches its webview no more: the connection's close draws nothing (#1272)", async (t) => {
  const { fakeQ } = require("./fakeq.js");
  const { SUBSCRIBE } = require("../out/stream.js");
  const q = await fakeQ((m) => (Array.isArray(m) && m[0] === SUBSCRIBE ? ["trade", ["time", "sym", "px"]] : null));
  t.after(() => q.close());
  const { panels } = await setUp(t, [{ label: "tp", host: "127.0.0.1", port: q.port, tags: [] }]);
  const vscode = require("vscode");
  const made = vscode.window.createWebviewPanel;
  // As VS Code's panel: its webview cannot be reached once disposed.
  vscode.window.createWebviewPanel = (...args) => {
    const panel = made(...args);
    const webview = panel.webview;
    let disposed = false;
    const dispose = panel.dispose;
    Object.defineProperty(panel, "webview", { get: () => (disposed ? (() => { throw new Error("Webview is disposed"); })() : webview) });
    panel.dispose = () => ((disposed = true), dispose());
    return panel;
  };
  const thrown = [];
  const catcher = (error) => thrown.push(error.message);
  process.on("uncaughtException", catcher);
  t.after(() => process.off("uncaughtException", catcher));
  stub.config.user["tickerplant.stream.enable"] = true;
  await stub.commands.get(STREAM_COMMANDS.start)("tp", "trade");
  assert.strictEqual(panels.length, 1);
  panels[0].dispose();
  await sleep(400);
  assert.deepStrictEqual(thrown, []);
});

// Paused, the grid is sent no rows - and was sent nothing when its
// connection closed either, so it went on reading as a stream merely held
// back until Resume was pressed.
test("a paused grid is told at once that its connection closed, and sent no rows with it (#1932)", async (t) => {
  const { fakeQ } = require("./fakeq.js");
  const { SUBSCRIBE } = require("../out/stream.js");
  const q = await fakeQ((m) => (Array.isArray(m) && m[0] === SUBSCRIBE ? ["trade", ["time", "sym", "px"]] : null));
  t.after(() => q.close());
  const { panels, streams } = await setUp(t, [{ label: "tp", host: "127.0.0.1", port: q.port, tags: [] }]);
  stub.config.user["tickerplant.stream.enable"] = true;
  await stub.commands.get(STREAM_COMMANDS.start)("tp", "trade");
  panels[0].send({ type: "pause", paused: true });
  const sent = panels[0].posted.length;
  q.close();
  for (let i = 0; i < 50 && streams.state()[0].closed === undefined; i++) await sleep(20);
  await sleep(400);
  assert.deepStrictEqual(panels[0].posted.slice(sent), [{ type: "closed", closed: "the connection to tp closed" }]);
  // Resumed, the rows' message says it too, as it did.
  panels[0].send({ type: "pause", paused: false });
  assert.strictEqual(panels[0].posted.at(-1).type, "rows");
  assert.strictEqual(panels[0].posted.at(-1).closed, "the connection to tp closed");
  // The page writes it beside the Resume button, its rows and status as they were.
  const page = streamPage();
  page.listener({ data: { type: "rows", process: "tp", table: "trade", columns: ["sym"], limit: 10, reset: true, rows: [["a"]], kept: 1, total: 1, at: "now" } });
  const [, status, , closed] = page.body.children[0].children;
  assert.strictEqual(closed.textContent, "");
  page.listener({ data: { type: "closed", closed: "the connection to tp closed" } });
  assert.strictEqual(closed.textContent, "Stopped: the connection to tp closed.");
  assert.strictEqual(status.textContent, "1 of 1 rows received (last 10 kept), updated now");
  assert.strictEqual(page.body.children[1].children[0].children[1].children.length, 1);
  panels[0].dispose();
});

// The grid listened for updates only once .u.sub had answered: an update
// a tickerplant published at once, in the same packet as the answer, was
// dispatched to no listener and lost.
test("an update in the same packet as .u.sub's answer reaches the grid", async (t) => {
  const { serialize, deserialize } = require("node-q/lib/c.js");
  const { SUBSCRIBE } = require("../out/stream.js");
  const server = net.createServer((socket) => {
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
        const answer = serialize(Array.isArray(m) && m[0] === SUBSCRIBE ? ["trade", ["sym", "px"]] : null);
        answer.writeUInt8(2, 1);
        // The answer and the first update, in one write.
        socket.write(Array.isArray(m) && m[0] === SUBSCRIBE ? Buffer.concat([answer, serialize(["`upd", "`trade", ["`a", 1.5]])]) : answer);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { panels } = await setUp(t, [{ label: "tp", host: "127.0.0.1", port: server.address().port, tags: [] }]);
  stub.config.user["tickerplant.stream.enable"] = true;
  await stub.commands.get(STREAM_COMMANDS.start)("tp", "trade");
  assert.strictEqual(panels.length, 1);
  await sleep(400);
  assert.deepStrictEqual(panels[0].posted.at(-1).rows, [["a", "1.5"]]);
  panels[0].dispose();
});

test("the grid is sent only the rows since it last drew, and all of them when none it has is kept (#1861)", () => {
  const w = new RowWindow(3);
  assert.deepStrictEqual(w.since(-1), { reset: true, rows: [] });
  w.push([["1"], ["2"]]);
  assert.deepStrictEqual(w.since(-1), { reset: true, rows: [["1"], ["2"]] });
  w.push([["3"]]);
  assert.deepStrictEqual(w.since(2), { reset: false, rows: [["3"]] });
  assert.deepStrictEqual(w.since(3), { reset: false, rows: [] });
  w.push([["4"], ["5"]]);
  assert.deepStrictEqual(w.since(3), { reset: false, rows: [["4"], ["5"]] });
  w.push([["6"], ["7"], ["8"]]);
  assert.deepStrictEqual(w.since(5), { reset: true, rows: [["6"], ["7"], ["8"]] });
  // Many small updates keep only the newest, without copying them all each time.
  const big = new RowWindow(10_000);
  const t = process.hrtime.bigint();
  for (let i = 0; i < 100_000; i++) {
    big.push([[String(i)]]);
  }
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 1000);
  assert.strictEqual(big.rows().length, 10_000);
  assert.deepStrictEqual(big.rows()[0], ["90000"]);
  assert.deepStrictEqual(big.rows().at(-1), ["99999"]);
});

/// media/stream.js run over a document of plain nodes: its body, what the
/// page listens to messages with, and how many nodes were made (`made`,
/// which a test may set).
function streamPage() {
  const page = { made: 0 };
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.textContent = "";
      page.made++;
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n.tagName === "#fragment") {
          this.append(...n.children);
        } else {
          n.parent = this;
          this.children.push(n);
        }
      }
    }
    insertBefore(node, before) {
      const at = before === null || before === undefined ? this.children.length : this.children.indexOf(before);
      const nodes = node.tagName === "#fragment" ? node.children : [node];
      nodes.forEach((n) => (n.parent = this));
      this.children.splice(at, 0, ...nodes);
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    remove() {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
    }
    addEventListener() {}
    get firstChild() {
      return this.children[0] ?? null;
    }
    get lastElementChild() {
      return this.children.at(-1) ?? null;
    }
    get childElementCount() {
      return this.children.length;
    }
  }
  page.body = new Node("body");
  const context = {
    acquireVsCodeApi: () => ({ postMessage() {} }),
    document: { body: page.body, createElement: (t) => new Node(t), createDocumentFragment: () => new Node("#fragment") },
    window: { addEventListener: (_t, f) => (page.listener = f) },
  };
  require("node:vm").runInNewContext(fs.readFileSync(path.join(__dirname, "..", "media", "stream.js"), "utf8"), context);
  return page;
}

test("the stream page adds the rows that came above its own and drops the oldest, not every row again (#1861)", () => {
  const page = streamPage();
  const { body, listener } = page;
  const w = new RowWindow(10_000);
  let seen = -1;
  const send = () => {
    const { reset, rows } = w.since(seen);
    seen = w.total;
    listener({ data: { type: "rows", process: "tp", table: "trade", columns: ["sym", "px"], limit: 10_000, reset, rows, kept: w.rows().length, total: w.total, at: "now" } });
  };
  const tbody = () => body.children[1].children[0].children[1];
  const shown = () => tbody().children.map((tr) => tr.children.map((td) => td.textContent));
  w.push(Array.from({ length: 10_000 }, (_, i) => ["a", String(i)]));
  send();
  assert.strictEqual(tbody().children.length, 10_000);
  // A batch of five makes five rows' nodes, not ten thousand.
  page.made = 0;
  w.push(Array.from({ length: 5 }, (_, i) => ["b", String(10_000 + i)]));
  send();
  assert.ok(page.made <= 5 * 3 + 1, String(page.made));
  assert.strictEqual(tbody().children.length, 10_000);
  // Newest first, the oldest dropped: as a full redraw would show them.
  assert.deepStrictEqual(shown(), w.rows().slice().reverse());
});
