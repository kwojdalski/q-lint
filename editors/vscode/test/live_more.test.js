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
async function fakeQ(answer = () => null) {
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
    history: providers.get("q-lint.queryHistory"),
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
