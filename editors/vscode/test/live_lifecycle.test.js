// A connection's life through edits, drops, reconnects and aborts: the
// process it is to stays the one the list says, driven by node through the
// stand-in `vscode` module (vscode_stub.js) and q processes played by
// socket servers. No q and no editor needed.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");
const { Live } = require("../out/live.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A q process played by a socket server: it answers the handshake after
/// `delay` ms (or what `delay()` gives then), then each message with what
/// `answer` gives for what was sent (a value, sent as a response), or
/// nothing when it gives undefined. `sent` keeps what it was sent; `drop`
/// closes the connections it has.
async function fakeQ(answer = () => null, delay = 0) {
  const sockets = new Set();
  const sent = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        setTimeout(() => socket.writable && socket.write(Buffer.from([3])), typeof delay === "function" ? delay() : delay);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        let read;
        try {
          read = deserialize(message);
        } catch {
          read = "?";
        }
        sent.push(read);
        const value = answer(read);
        if (value !== undefined) {
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
    sent,
    drop: () => {
      for (const s of sockets) s.destroy();
    },
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/// A Live over a fresh context holding `processes`, with `config` set, and
/// the change events it fires.
async function setUp(t, processes, config = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const events = [];
  live.onDidChange((what) => events.push(what));
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { context, live, events };
}

const proc = (label, port, extra = {}) => ({ label, host: "127.0.0.1", port, tags: [], ...extra });

/// Edit Process on `label`, answering its boxes with `label2`, the address
/// and `tags`.
async function editProcess(label, label2, port, tags) {
  stub.inputs.push(label2, "127.0.0.1", String(port), "", tags);
  stub.picks.push("No");
  await stub.commands.get("q-lint.editProcess")(label);
}

/// Wait up to `ms` for `ready()`.
async function until(ready, ms = 5000) {
  for (const end = Date.now() + ms; !ready() && Date.now() < end; ) {
    await sleep(25);
  }
}

test("an auto-reconnect connects to the process as it is now, renamed and tagged since (#1699)", async (t) => {
  const a = await fakeQ();
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.autoReconnect.enable": true });
  assert.strictEqual(await live.connectTo("a"), true);
  stub.inputs.push("prod");
  await stub.commands.get("q-lint.tagProcess")("a");
  await editProcess("a", "a2", a.port, "prod");
  assert.strictEqual(live.activeLabel(), "a2");
  a.drop();
  await until(() => stub.messages.some(([, m]) => /reconnected/.test(m)));
  assert.strictEqual(live.activeLabel(), "a2");
  assert.deepStrictEqual(live.activeProcess().tags, ["prod"]);
  assert.notStrictEqual(live.guardRefuses("a::1", [live.activeProcess()]), undefined, "a write to the prod process is not asked about");
  assert.ok(stub.messages.some(([, m]) => m === "q-lint: the connection to a2 closed. Reconnecting."), JSON.stringify(stub.messages));
  assert.ok(stub.messages.some(([, m]) => m === "q-lint: reconnected to a2."));
});

test("Edit Process during a connect connects under the new label and tags (#1700)", async (t) => {
  const a = await fakeQ(() => null, 400);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)]);
  const connecting = live.connectTo("a");
  await sleep(50);
  await editProcess("a", "a2", a.port, "prod");
  assert.strictEqual(await connecting, true);
  assert.strictEqual(live.activeLabel(), "a2");
  assert.deepStrictEqual(live.activeProcess().tags, ["prod"]);
  assert.notStrictEqual(live.guardRefuses("a::1", [live.activeProcess()]), undefined);
});

test("Tag Process during a connect gives the connection its tags (#1700)", async (t) => {
  const a = await fakeQ(() => null, 400);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)]);
  const connecting = live.connectTo("a");
  await sleep(50);
  stub.inputs.push("prod");
  await stub.commands.get("q-lint.tagProcess")("a");
  assert.strictEqual(await connecting, true);
  assert.deepStrictEqual(live.activeProcess().tags, ["prod"]);
});

test("deleting a process while auto-reconnect waits between tries stops the reconnect (#1701)", async (t) => {
  const a = await fakeQ();
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.autoReconnect.enable": true });
  await live.connectTo("a");
  a.drop();
  await until(() => /reconnecting to a/.test(live.api().statusText()));
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteProcess")("a");
  assert.doesNotMatch(live.api().statusText(), /reconnecting/);
  await sleep(1500);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.ok(!stub.messages.some(([, m]) => /reconnected/.test(m)), JSON.stringify(stub.messages));
});

test("Abort says the connection went, though the reconnect after it fails (#1702)", async (t) => {
  const a = await fakeQ(() => undefined);
  t.after(() => a.close());
  const { live, events } = await setUp(t, [proc("a", a.port)]);
  await live.connectTo("a");
  events.length = 0;
  const running = live.run("hang[]");
  await sleep(100);
  a.close();
  await stub.commands.get("q-lint.abortQuery")();
  await running;
  await until(() => stub.messages.some(([, m]) => /could not connect/.test(m)));
  assert.strictEqual(live.activeLabel(), undefined);
  assert.ok(events.includes("disconnected"), JSON.stringify(events));
});

test("Tag Process and Import Processes retagging the connected process say so (#1703)", async (t) => {
  const a = await fakeQ();
  t.after(() => a.close());
  const { live, events } = await setUp(t, [proc("a", a.port)]);
  await live.connectTo("a");
  events.length = 0;
  stub.inputs.push("prod");
  await stub.commands.get("q-lint.tagProcess")("a");
  assert.deepStrictEqual(events, ["edited"]);
  // Tagged as it was: nothing to redraw.
  stub.inputs.push("prod");
  await stub.commands.get("q-lint.tagProcess")("a");
  assert.deepStrictEqual(events, ["edited"]);
  events.length = 0;
  const fs = vscode.workspace.fs;
  t.after(() => (vscode.workspace.fs = fs));
  vscode.workspace.fs = { readFile: async () => Buffer.from(JSON.stringify({ processes: [proc("a", a.port, { tags: ["prod", "uat"] })] })) };
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/x.json"));
  assert.deepStrictEqual(live.activeProcess().tags, ["prod", "uat"]);
  assert.deepStrictEqual(events, ["edited"]);
});

test("Disconnect during a slow connect cuts it short: the next connect does not wait for it (#1704)", async (t) => {
  const a = await fakeQ(() => null, 3000);
  const b = await fakeQ();
  t.after(() => (a.close(), b.close()));
  const { live } = await setUp(t, [proc("a", a.port), proc("b", b.port)]);
  const toA = live.connectTo("a");
  await sleep(100);
  await stub.commands.get("q-lint.disconnectProcess")();
  const started = Date.now();
  assert.strictEqual(await live.connectTo("b"), true);
  assert.ok(Date.now() - started < 1500, `waited ${Date.now() - started} ms`);
  assert.strictEqual(await toA, false);
  assert.strictEqual(live.activeLabel(), "b");
});

test("a connect elsewhere stops the one under way: its connect script never runs (#1704)", async (t) => {
  const a = await fakeQ(() => [], 800);
  const b = await fakeQ();
  t.after(() => (a.close(), b.close()));
  const { live, events } = await setUp(t, [proc("a", a.port, { init: "setupA[]" }), proc("b", b.port)]);
  const toA = live.connectTo("a");
  await sleep(50);
  const started = Date.now();
  assert.strictEqual(await live.connectTo("b"), true);
  assert.ok(Date.now() - started < 700, `waited ${Date.now() - started} ms`);
  assert.strictEqual(await toA, false);
  assert.deepStrictEqual(a.sent, []);
  assert.deepStrictEqual(events, ["connected"]);
  assert.strictEqual(live.activeLabel(), "b");
});

test("turning auto-reconnect off while a try is dialing stops that try (#1705)", async (t) => {
  let shakes = 0;
  const a = await fakeQ(() => null, () => (shakes++ === 0 ? 0 : 1500));
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.autoReconnect.enable": true });
  await live.connectTo("a");
  a.drop();
  // The first try dials after a second, and its handshake is held 1.5 s.
  await until(() => shakes === 2);
  stub.config.user["connection.autoReconnect.enable"] = false;
  stub.changeConfig("q-lint.connection.autoReconnect.enable");
  await sleep(2000);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.ok(!stub.messages.some(([, m]) => /reconnected/.test(m)));
});

test("connecting to the process a try is dialing connects, though the try is stopped (#1705)", async (t) => {
  let shakes = 0;
  const a = await fakeQ(() => null, () => (shakes++ === 0 ? 0 : 500));
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.autoReconnect.enable": true });
  await live.connectTo("a");
  a.drop();
  await until(() => shakes === 2);
  assert.strictEqual(await live.connectTo("a"), true);
  assert.strictEqual(live.activeLabel(), "a");
});

test("renaming the connected process keeps its results its own: paging and drill-down reach it (#1706)", async (t) => {
  const a = await fakeQ(() => 1);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)]);
  await live.connectTo("a");
  const grid = { count: 2, keys: 0, names: ["c"], types: [7], cells: [["1", "2"]], raw: [[1, 2]], rank: [[0, 1]] };
  live.modes.show({ process: "a", code: "t", millis: 1, answer: { ok: true, type: 98, text: [], grid } }, { mode: "grid", resultsLocation: "editor", gridLimit: 10000, gridDecimals: -1 });
  await editProcess("a", "a2", a.port, "");
  const shown = live.resultOnShow();
  assert.strictEqual(shown.process, "a2");
  // Asked of the process (whose answer is no page), not refused as another's.
  assert.strictEqual((await live.pageHeld(shown.process, 0, 10)).later, undefined);
  stub.messages.length = 0;
  const sent = a.sent.length;
  await live.runOnProcess("1+1", shown.process, { what: "drill-down query" });
  assert.deepStrictEqual(stub.messages.filter(([kind]) => kind === "error"), []);
  assert.ok(a.sent.length > sent);
});

test("renaming the connected process keeps its Watch Query running (#1707)", async (t) => {
  const a = await fakeQ(() => 1);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "query.watch.enable": true });
  await live.connectTo("a");
  await stub.commands.get("q-lint.watchQuery")("1+1", 1);
  await editProcess("a", "a2", a.port, "");
  await sleep(1300);
  assert.strictEqual(live.api().watching()?.label, "a2");
  assert.ok(live.api().watching().runs >= 2);
  assert.ok(!stub.messages.some(([, m]) => /stopped watching/.test(m)), JSON.stringify(stub.messages));
});

test("starting a Watch Query says nothing of there being none to stop (#1708)", async (t) => {
  const a = await fakeQ(() => 1);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "query.watch.enable": true });
  await live.connectTo("a");
  await stub.commands.get("q-lint.watchQuery")("1+1", 1);
  assert.ok(live.api().watching() !== undefined);
  assert.ok(!stub.messages.some(([, m]) => m === "q-lint: no query is watched."), JSON.stringify(stub.messages));
  // Stop Watching Query with none watched still says so.
  await stub.commands.get("q-lint.stopWatchingQuery")();
  await stub.commands.get("q-lint.stopWatchingQuery")();
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: no query is watched."]);
});
