// A run from the q REPL or the Interactive Window that does not come back
// (#1872): the process dies, Abort stops waiting, or the process's own
// timeout does. Driven by node through the stand-in `vscode` module
// (vscode_stub.js) and a q process played by a socket server. No q and no
// editor needed.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");
const { Live } = require("../out/live.js");
const { runText } = require("../out/consolerun.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A q process played by a socket server: a query with `die` in it closes
/// the connection, one with `slow` is never answered, any other is.
async function fakeQ() {
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
        const sent = JSON.stringify(deserialize(message));
        if (sent.includes("die")) {
          socket.destroy();
        } else if (!sent.includes("slow")) {
          const out = serialize({ ok: true, type: -7, text: ["1"] });
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

async function setUp(t, extra = {}) {
  const q = await fakeQ();
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "127.0.0.1", port: q.port, tags: [], ...extra }]);
  const live = new Live(context);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  await live.connectTo("rdb");
  assert.strictEqual(live.activeLabel(), "rdb");
  return live;
}

const kept = (live) => live.history().map((h) => [h.process, h.outcome, h.error, h.code]);

test("a run that answers is kept under its process", async (t) => {
  const live = await setUp(t);
  const ran = await runText(live, "1+1");
  assert.strictEqual(ran.process, "rdb");
  assert.strictEqual(ran.answer.ok, true);
  assert.deepStrictEqual(kept(live), [["rdb", "ok", undefined, "1+1"]]);
});

test("a process that dies mid-query fails under its own label, not 'the process' (#1872)", async (t) => {
  const live = await setUp(t);
  const ran = await runText(live, "die[]");
  assert.strictEqual(live.activeLabel(), undefined);
  assert.strictEqual(ran.process, "rdb");
  assert.deepStrictEqual(ran.answer, { ok: false, error: "the connection closed before the process answered", trace: "" });
  assert.deepStrictEqual(kept(live), [["rdb", "error", "the connection closed before the process answered", "die[]"]]);
});

test("Abort Current Query is kept as aborted, under the process's label (#1872)", async (t) => {
  const live = await setUp(t);
  const running = runText(live, "slow[]");
  await sleep(100);
  await live.abort();
  const ran = await running;
  assert.strictEqual(ran.process, "rdb");
  assert.deepStrictEqual(ran.answer, { ok: false, error: "aborted", trace: "" });
  assert.deepStrictEqual(kept(live), [["rdb", "aborted", "aborted", "slow[]"]]);
});

test("Disconnect while a run waits is kept as aborted too (#1872)", async (t) => {
  const live = await setUp(t);
  const running = runText(live, "slow[]");
  await sleep(100);
  await stub.commands.get("q-lint.disconnectProcess")();
  const ran = await running;
  assert.deepStrictEqual([ran.process, ran.answer.error], ["rdb", "aborted"]);
  assert.deepStrictEqual(kept(live), [["rdb", "aborted", "aborted", "slow[]"]]);
});

test("the process's own timeout is kept as a timeout, under its label (#1872)", async (t) => {
  const live = await setUp(t, { timeout: 1 });
  const ran = await runText(live, "slow[]");
  assert.strictEqual(ran.process, "rdb");
  assert.strictEqual(ran.answer.ok, false);
  assert.match(ran.answer.error, /^timed out after 1 s/);
  const [[process, outcome, error]] = kept(live);
  assert.deepStrictEqual([process, outcome], ["rdb", "timeout"]);
  assert.match(error, /^timed out after 1 s/);
});
