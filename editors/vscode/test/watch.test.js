// Watch Query (#914): the settings and text (watch.ts), and the watch
// through the stand-in `vscode` (vscode_stub.js) against a q process played
// by a socket server. No q and no editor needed; queries_q.test.js watches
// a real q.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");
const { LONGEST_INTERVAL, intervalProblem, readWatch, watchText } = require("../out/watch.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("off by default, every 5 seconds; an interval is 1 second to a day", () => {
  const read = (values) => readWatch((k, f) => (k in values ? values[k] : f));
  assert.deepStrictEqual(read({}), { enabled: false, interval: 5 });
  assert.deepStrictEqual(read({ "query.watch.enable": true, "query.watch.interval": 2.5 }), { enabled: true, interval: 2.5 });
  assert.deepStrictEqual(read({ "query.watch.enable": "true", "query.watch.interval": 0 }), { enabled: false, interval: 5 });
  assert.strictEqual(read({ "query.watch.interval": LONGEST_INTERVAL + 1 }).interval, 5);
  assert.strictEqual(intervalProblem("10"), undefined);
  assert.strictEqual(intervalProblem("0.5"), "A number of seconds, 1 to 86400.");
  assert.strictEqual(intervalProblem(""), "A number of seconds, 1 to 86400.");
  assert.strictEqual(intervalProblem("x"), "A number of seconds, 1 to 86400.");
  assert.strictEqual(watchText("rdb", 5, 3), "$(eye) watching rdb every 5s (3)");
});

/// A q process played by a socket server answering every query as `RUN`
/// does; `queries()` are the statements each sent.
async function fakeQ() {
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
        sent.push(deserialize(message));
        const out = serialize({ ok: true, type: -7, text: [String(sent.length)] });
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    queries: () => sent.filter((m) => Array.isArray(m) && Array.isArray(m[1])).map((m) => m[1].join("\n")),
    drop: () => sockets.forEach((s) => s.destroy()),
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

const { Live } = require("../out/live.js");

async function setUp(t, config = { "query.watch.enable": true }, tags = []) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const q = await fakeQ();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "127.0.0.1", port: q.port, tags }]);
  // The status bar items made, to see the watch's come and go.
  const items = [];
  const create = vscode.window.createStatusBarItem;
  vscode.window.createStatusBarItem = (id) => {
    const item = { id, text: "", shown: false, disposed: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() { this.disposed = true; } };
    items.push(item);
    return item;
  };
  const live = new Live(context);
  t.after(async () => {
    vscode.window.createStatusBarItem = create;
    await stub.commands.get("q-lint.stopWatchingQuery")?.();
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  const watchItem = () => items.filter((i) => i.id === "q-lint.watch").at(-1);
  return { q, live, items, watchItem, api: live.api() };
}

test("Watch Query runs now and again every interval, refreshing in place, until stopped", async (t) => {
  const { q, live, api, watchItem } = await setUp(t);
  assert.strictEqual(await live.connectTo("rdb"), true);
  await stub.commands.get("q-lint.watchQuery")("count t", 1);
  assert.deepStrictEqual(q.queries(), ["count t"]);
  assert.deepStrictEqual(api.watching(), { code: "count t", label: "rdb", every: 1, runs: 1 });
  assert.strictEqual(watchItem().text, "$(eye) watching rdb every 1s (1)");
  assert.strictEqual(watchItem().shown, true);
  await sleep(2300);
  assert.ok(q.queries().length >= 3, `ran ${q.queries().length} times`);
  // Only the first run is in the history.
  assert.strictEqual(live.history().length, 1);
  await stub.commands.get("q-lint.stopWatchingQuery")();
  const runs = q.queries().length;
  assert.strictEqual(api.watching(), undefined);
  assert.strictEqual(watchItem().disposed, true);
  await sleep(1200);
  assert.strictEqual(q.queries().length, runs);
});

test("a watch stops on disconnect, and on a dropped connection, and says so", async (t) => {
  const { q, live, api } = await setUp(t);
  await live.connectTo("rdb");
  await stub.commands.get("q-lint.watchQuery")("count t", 1);
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.strictEqual(api.watching(), undefined);
  assert.ok(stub.messages.some(([, m]) => m === "q-lint: stopped watching the query: the connection to rdb closed."));
  await live.connectTo("rdb");
  await stub.commands.get("q-lint.watchQuery")("count t", 1);
  q.drop();
  for (let i = 0; i < 50 && api.watching() !== undefined; i++) await sleep(20);
  assert.strictEqual(api.watching(), undefined);
});

test("Watch Query asks for the interval when not given; Escape watches nothing", async (t) => {
  const { q, live, api } = await setUp(t, { "query.watch.enable": true, "query.watch.interval": 7 });
  await live.connectTo("rdb");
  let box;
  stub.inputs.push((o) => ((box = o), undefined));
  await stub.commands.get("q-lint.watchQuery")("count t");
  assert.strictEqual(box.value, "7");
  assert.strictEqual(box.validateInput("0"), "A number of seconds, 1 to 86400.");
  assert.deepStrictEqual([api.watching(), q.queries()], [undefined, []]);
  stub.inputs.push("30");
  await stub.commands.get("q-lint.watchQuery")("count t");
  assert.strictEqual(api.watching().every, 30);
});

test("on a guarded or production process a watch asks first; code that would change it, the guard asks too", async (t) => {
  const { q, live, api } = await setUp(t, { "query.watch.enable": true }, ["prod"]);
  await live.connectTo("rdb");
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.watchQuery")("count t", 1);
  assert.deepStrictEqual(stub.messages.filter(([k]) => k === "warning").map(([, m]) => m), ["Watch the query on rdb?"]);
  assert.deepStrictEqual([api.watching(), q.queries()], [undefined, []]);
  stub.messages = [];
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.watchQuery")("n+:1", 1);
  assert.deepStrictEqual(stub.messages.filter(([k]) => k === "warning").map(([, m]) => m), ["This code would change rdb. Run it anyway?"]);
  assert.deepStrictEqual(q.queries(), []);
  stub.picks.push("Watch");
  await stub.commands.get("q-lint.watchQuery")("count t", 1);
  assert.deepStrictEqual(q.queries(), ["count t"]);
});

test("off (the default), Watch Query refuses, makes no status item and sends nothing; turned off, a watch stops", async (t) => {
  const { q, live, api, watchItem } = await setUp(t, {});
  await live.connectTo("rdb");
  await stub.commands.get("q-lint.watchQuery")("count t", 1);
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: Watch Query is turned off. Set q-lint.query.watch.enable to true to turn it on."]]);
  assert.deepStrictEqual([api.watching(), watchItem(), q.queries()], [undefined, undefined, []]);
  stub.config.user["query.watch.enable"] = true;
  stub.changeConfig("q-lint.query.watch.enable");
  await stub.commands.get("q-lint.watchQuery")("count t", 1);
  assert.strictEqual(api.watching().runs, 1);
  stub.config.user["query.watch.enable"] = false;
  stub.changeConfig("q-lint.query.watch.enable");
  assert.strictEqual(api.watching(), undefined);
  assert.strictEqual(watchItem().disposed, true);
  await sleep(1200);
  assert.deepStrictEqual(q.queries(), ["count t"]);
});

test("turned off while the interval box is open, nothing is watched or sent (#1451)", async (t) => {
  const { q, live, api, watchItem } = await setUp(t);
  assert.strictEqual(await live.connectTo("rdb"), true);
  stub.inputs.push(() => {
    stub.config.user["query.watch.enable"] = false;
    stub.changeConfig("q-lint.query.watch.enable");
    return "1";
  });
  await stub.commands.get("q-lint.watchQuery")("count t");
  await sleep(1200);
  assert.strictEqual(api.watching(), undefined);
  assert.strictEqual(watchItem(), undefined);
  assert.deepStrictEqual(q.queries(), []);
});
