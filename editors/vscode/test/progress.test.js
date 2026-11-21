// A long query's progress (#910): the running time the status bar counts,
// and the notification when one ends while the window is not focused.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize } = require("node-q/lib/c.js");
const { elapsedText, finishedText, readProgress, shouldNotify } = require("../out/progress.js");
const { Live } = require("../out/live.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the running time is whole seconds, then minutes, then hours", () => {
  assert.strictEqual(elapsedText(0), "0s");
  assert.strictEqual(elapsedText(999), "0s");
  assert.strictEqual(elapsedText(59_999), "59s");
  assert.strictEqual(elapsedText(65_000), "1m 05s");
  assert.strictEqual(elapsedText(3_599_000), "59m 59s");
  assert.strictEqual(elapsedText(3_600_000 + 3 * 60_000 + 59_000), "1h 03m");
  assert.strictEqual(elapsedText(-5), "0s");
});

test("notifyAfter is read as a positive number of seconds, else never", () => {
  const read = (v) => readProgress((key, fallback) => (key === "query.notifyAfter" && v !== undefined ? v : fallback));
  assert.deepStrictEqual(read(undefined), { notifyAfter: 10 });
  assert.deepStrictEqual(read(2.5), { notifyAfter: 2.5 });
  for (const off of [0, -1, "10", null, NaN, Infinity]) assert.deepStrictEqual(read(off), { notifyAfter: 0 }, String(off));
  assert.deepStrictEqual(read(1e9), { notifyAfter: 86_400 });
});

test("only a long query that ends unseen is notified, and never an aborted one", () => {
  const on = { notifyAfter: 10 };
  assert.strictEqual(shouldNotify(10_000, false, "ok", on), true);
  assert.strictEqual(shouldNotify(9_999, false, "ok", on), false);
  assert.strictEqual(shouldNotify(60_000, true, "ok", on), false);
  assert.strictEqual(shouldNotify(60_000, false, "error", on), true);
  assert.strictEqual(shouldNotify(60_000, false, "timeout", on), true);
  assert.strictEqual(shouldNotify(60_000, false, "aborted", on), false);
  assert.strictEqual(shouldNotify(60_000, false, "ok", { notifyAfter: 0 }), false);
});

test("the notification names the process, the time and q's error, cut when long", () => {
  assert.strictEqual(finishedText("rdb", 12_000, "ok"), "q-lint: the query on rdb finished after 12s.");
  assert.strictEqual(finishedText("rdb", 75_000, "error", "type"), "q-lint: the query on rdb failed after 1m 15s: 'type.");
  assert.strictEqual(finishedText("rdb", 5_000, "timeout", "timed out after 5 s"), "q-lint: the query on rdb timed out after 5 s.");
  const long = finishedText("rdb", 1000, "error", "x".repeat(500));
  assert.ok(long.length < 260 && long.endsWith("….") , long);
});

/// A q process played by a socket server that answers each query after `ms`.
async function slowQ(ms) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    socket.on("data", () => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      setTimeout(() => {
        const out = serialize({ ok: true, type: -7, text: ["42"] });
        out.writeUInt8(2, 1);
        if (socket.writable) socket.write(out);
      }, ms);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}

test("the status bar counts a running query's time, and its end is notified when the window is not focused", async (t) => {
  const q = await slowQ(1300);
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "slow", host: "127.0.0.1", port: q.port, tags: [] }]);
  const vscode = require("vscode");
  const focused = vscode.window.state;
  vscode.window.state = { focused: false };
  const live = new Live(context);
  t.after(async () => {
    vscode.window.state = focused;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  stub.config.user["query.notifyAfter"] = 1;
  assert.strictEqual(await live.connectTo("slow"), true);
  const running = live.run("slow 1");
  await sleep(150);
  assert.match(live.status.text, /^\$\(sync~spin\) q: slow 0s$/);
  await sleep(1100);
  assert.match(live.status.text, /^\$\(sync~spin\) q: slow 1s$/);
  await running;
  assert.strictEqual(live.status.text, "$(plug) q: slow");
  assert.strictEqual(live.ticker, undefined, "the ticker stops with the query");
  assert.deepStrictEqual(stub.messages.filter(([, m]) => m.includes("finished after")), [["info", "q-lint: the query on slow finished after 1s."]]);
  // Focused, nothing is said.
  vscode.window.state = { focused: true };
  await live.run("slow 1");
  assert.strictEqual(stub.messages.filter(([, m]) => m.includes("finished after")).length, 1);
});
