// Connection health (#917): the settings, the backoff and latency text, and
// the heartbeat and automatic reconnect through the stand-in `vscode` module
// against q processes played by socket servers.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const pkg = require("../package.json");
const { serialize } = require("node-q/lib/c.js");
const { HEARTBEAT, UNANSWERED_MS, backoffDelay, latencyText, readHealth } = require("../out/health.js");
const { Live } = require("../out/live.js");
const { readConnectScript } = require("../out/connectscript.js");
const { needsRestart } = require("../out/settings.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("every connection setting is read, off by default, and none restarts the server", () => {
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: connections");
  const read = new Map();
  const settings = readHealth((key, fallback) => (read.set(key, fallback), fallback));
  assert.deepStrictEqual(readConnectScript((key, fallback) => (read.set(key, fallback), fallback)), { enabled: true });
  for (const [key, spec] of Object.entries(section.properties)) {
    const short = key.replace(/^q-lint\./, "");
    assert.ok(read.has(short), `${key} is declared but never read`);
    assert.deepStrictEqual(read.get(short), spec.default, key);
    assert.strictEqual(needsRestart((s) => key === s || key.startsWith(`${s}.`)), false, key);
  }
  assert.strictEqual(read.size, Object.keys(section.properties).length);
  assert.deepStrictEqual(settings, { heartbeat: 0, autoReconnect: false, reconnectAttempts: 5 });
  const set = (values) => readHealth((key, fallback) => (key in values ? values[key] : fallback));
  const beat = (interval) => set({ "connection.heartbeat.enable": true, "connection.heartbeatInterval": interval }).heartbeat;
  assert.strictEqual(set({ "connection.heartbeat.enable": true }).heartbeat, 30);
  assert.strictEqual(set({ "connection.heartbeatInterval": 10 }).heartbeat, 0, "an interval alone sends nothing");
  assert.strictEqual(beat(0.2), 1);
  assert.strictEqual(beat(5), 5);
  assert.strictEqual(beat("30"), 0);
  assert.strictEqual(beat(1e9), 86_400);
  assert.strictEqual(set({ "connection.autoReconnect.enable": "true" }).autoReconnect, false);
  assert.strictEqual(set({ "connection.autoReconnect.enable": true }).autoReconnect, true);
  assert.strictEqual(set({ "connection.reconnectAttempts": 0 }).reconnectAttempts, 5);
  assert.strictEqual(set({ "connection.reconnectAttempts": 2.5 }).reconnectAttempts, 5);
  assert.strictEqual(set({ "connection.reconnectAttempts": 1000 }).reconnectAttempts, 100);
});

test("a reconnect waits 1 s, then twice as long, at most 30 s; latency is ms, then seconds", () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.strictEqual(backoffDelay(0), 1000);
  assert.deepStrictEqual([0, 3.4, 999, 1000, 12345].map(latencyText), ["0 ms", "3 ms", "999 ms", "1.0 s", "12.3 s"]);
  assert.deepStrictEqual([999.4, 999.5, 999.9].map(latencyText), ["999 ms", "1.0 s", "1.0 s"]);
  assert.strictEqual(HEARTBEAT, "::");
  assert.strictEqual(UNANSWERED_MS, 5000);
});

/// A q process played by a socket server on `port` (a free one by default):
/// it answers each message after `delay()` ms with `::`, and `drop()` closes
/// every connection from its side.
async function fakeQ({ port = 0, delay = () => 0 } = {}) {
  const sockets = new Set();
  const seen = [];
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
        seen.push(message.readInt8(8) === 10 ? message.subarray(14).toString() : `type ${message.readInt8(8)}`);
        setTimeout(() => {
          const out = serialize(null);
          out.writeUInt8(2, 1);
          if (socket.writable) socket.write(out);
        }, delay());
      }
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    port: server.address().port,
    seen,
    connections: () => sockets.size,
    drop: () => {
      for (const s of sockets) s.destroy();
    },
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(r);
    }),
  };
}

async function setUp(t, port) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "p", host: "127.0.0.1", port, tags: [] }]);
  const live = new Live(context);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return live;
}

test("the heartbeat shows the round trip in the status bar, and a late answer as none", async (t) => {
  let late = 0;
  const q = await fakeQ({ delay: () => late });
  t.after(() => q.close());
  const live = await setUp(t, q.port);
  stub.config.user["connection.heartbeat.enable"] = true;
  stub.config.user["connection.heartbeatInterval"] = 1;
  assert.strictEqual(await live.connectTo("p"), true);
  for (let i = 0; i < 50 && live.latency === undefined; i++) await sleep(20);
  assert.match(live.status.text, /^\$\(plug\) q: p \$\(pulse\) \d+ ms$/);
  assert.match(live.status.tooltip, /Heartbeat round trip \d+ ms/);
  assert.deepStrictEqual(q.seen, ["::"]);
  // An answer that does not come in UNANSWERED_MS is shown waiting.
  late = 60_000;
  live.beatSent = Date.now() - UNANSWERED_MS;
  live.showStatus();
  assert.match(live.status.text, /^\$\(plug\) q: p \$\(warning\) no answer 5s$/);
  live.beatSent = undefined;
  late = 0;
  // Turned off, it stops and the latency goes.
  stub.config.user["connection.heartbeat.enable"] = false;
  stub.changeConfig("q-lint.connection.heartbeat.enable");
  assert.strictEqual(live.status.text, "$(plug) q: p");
  assert.strictEqual(live.heartbeat, undefined);
  const sent = q.seen.length;
  await sleep(1200);
  assert.strictEqual(q.seen.length, sent);
});

test("a heartbeat is skipped while a query runs, and a query waits for one out", async (t) => {
  const q = await fakeQ({ delay: () => 300 });
  t.after(() => q.close());
  const live = await setUp(t, q.port);
  assert.strictEqual(await live.connectTo("p"), true);
  const running = live.run("1");
  await sleep(20);
  await live.beat();
  assert.strictEqual(live.beatSent, undefined);
  await running;
  assert.strictEqual(q.seen.length, 1);
  const beat = live.beat();
  await live.run("2");
  await beat;
  // The query was sent after the heartbeat's answer, not refused as busy.
  assert.deepStrictEqual([q.seen.length, q.seen[1], q.seen[2].startsWith("type"), live.history().length], [3, "::", true, 2]);
  assert.ok(!stub.messages.some(([, m]) => m.includes("still running")));
});

test("a dropped connection is reconnected when autoReconnect is on, and never otherwise", async (t) => {
  const q = await fakeQ();
  t.after(() => q.close());
  const live = await setUp(t, q.port);
  assert.strictEqual(await live.connectTo("p"), true);
  q.drop();
  for (let i = 0; i < 50 && live.activeLabel() !== undefined; i++) await sleep(10);
  await sleep(1300);
  assert.strictEqual(live.activeLabel(), undefined, "reconnected with autoReconnect off");
  assert.deepStrictEqual(stub.messages.at(-1), ["warning", "q-lint: the connection to p closed."]);
  stub.config.user["connection.autoReconnect.enable"] = true;
  assert.strictEqual(await live.connectTo("p"), true);
  q.drop();
  for (let i = 0; i < 50 && live.activeLabel() !== undefined; i++) await sleep(10);
  assert.match(live.status.text, /^\$\(sync~spin\) q: reconnecting to p \(1 of 5\)$/);
  assert.ok(stub.messages.some(([, m]) => m === "q-lint: the connection to p closed. Reconnecting."));
  for (let i = 0; i < 100 && live.activeLabel() === undefined; i++) await sleep(20);
  assert.strictEqual(live.activeLabel(), "p");
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: reconnected to p."]);
});

// Read once per reconnect, a lowered count went on trying the old one: at
// 100 tries of 30 s, 50 minutes.
test("connection.reconnectAttempts lowered during a reconnect stops it at the new count (#1850)", async (t) => {
  const q = await fakeQ();
  const live = await setUp(t, q.port);
  stub.config.user["connection.autoReconnect.enable"] = true;
  stub.config.user["connection.reconnectAttempts"] = 4;
  assert.strictEqual(await live.connectTo("p"), true);
  await q.close();
  for (let i = 0; i < 100 && !live.status.text.includes("reconnecting"); i++) await sleep(10);
  assert.match(live.status.text, /\(1 of 4\)/);
  stub.config.user["connection.reconnectAttempts"] = 1;
  stub.changeConfig("q-lint.connection.reconnectAttempts");
  const t0 = Date.now();
  for (let i = 0; i < 200 && !stub.messages.some(([, m]) => m.includes("could not reconnect")); i++) await sleep(25);
  assert.ok(Date.now() - t0 < 2500, `gave up after ${Date.now() - t0} ms`);
  assert.deepStrictEqual(stub.messages.at(-1), ["warning", "q-lint: could not reconnect to p after 1 try."]);
});

test("a reconnect backs off and gives up after its tries, and Disconnect stops one", async (t) => {
  const q = await fakeQ();
  const port = q.port;
  const live = await setUp(t, port);
  stub.config.user["connection.autoReconnect.enable"] = true;
  stub.config.user["connection.reconnectAttempts"] = 2;
  assert.strictEqual(await live.connectTo("p"), true);
  await q.close();
  // Tries at 1 s and 1 + 2 s, then gives up, saying nothing of each failure.
  const t0 = Date.now();
  for (let i = 0; i < 200 && !stub.messages.some(([, m]) => m.includes("could not reconnect")); i++) await sleep(25);
  assert.ok(Date.now() - t0 >= 2900, `gave up after ${Date.now() - t0} ms`);
  assert.deepStrictEqual(stub.messages.at(-1), ["warning", "q-lint: could not reconnect to p after 2 tries."]);
  assert.ok(!stub.messages.some(([k]) => k === "error"), JSON.stringify(stub.messages));
  assert.strictEqual(live.status.text, "$(debug-disconnect) q: not connected");
  // Disconnect while it waits: it stops, and the process coming back is not connected to.
  const back = await fakeQ({ port });
  t.after(() => back.close());
  assert.strictEqual(await live.connectTo("p"), true);
  back.drop();
  for (let i = 0; i < 50 && live.activeLabel() !== undefined; i++) await sleep(10);
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.strictEqual(live.status.text, "$(debug-disconnect) q: not connected");
  await sleep(1300);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.strictEqual(back.connections(), 0);
});

test("by default no heartbeat is sent, and turning autoReconnect off stops a reconnect under way", async (t) => {
  const q = await fakeQ();
  const port = q.port;
  const live = await setUp(t, port);
  assert.strictEqual(await live.connectTo("p"), true);
  await sleep(1200);
  assert.deepStrictEqual([q.seen, live.heartbeat, live.status.text], [[], undefined, "$(plug) q: p"]);
  stub.config.user["connection.autoReconnect.enable"] = true;
  await q.close();
  for (let i = 0; i < 50 && live.reconnecting === undefined; i++) await sleep(10);
  assert.ok(live.reconnecting);
  stub.config.user["connection.autoReconnect.enable"] = false;
  stub.changeConfig("q-lint.connection.autoReconnect.enable");
  assert.deepStrictEqual([live.reconnecting, live.status.text], [undefined, "$(debug-disconnect) q: not connected"]);
  const back = await fakeQ({ port });
  t.after(() => back.close());
  await sleep(1300);
  assert.deepStrictEqual([live.activeLabel(), back.connections()], [undefined, 0]);
});
