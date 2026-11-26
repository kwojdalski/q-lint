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
/// nothing when it gives undefined. `sent` keeps what it was sent, `logins`
/// each handshake's `user:password`; `drop`
/// closes the connections it has.
async function fakeQ(answer = () => null, delay = 0) {
  const sockets = new Set();
  const sent = [];
  const logins = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        logins.push(chunk.subarray(0, chunk.length - 2).toString("utf8"));
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
        // A promise is answered when it settles: a query still running.
        const write = (v) => {
          if (v !== undefined && socket.writable) {
            const out = serialize(v);
            out.writeUInt8(2, 1);
            socket.write(out);
          }
        };
        if (value !== null && typeof value?.then === "function") {
          void value.then(write);
        } else {
          write(value);
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    sent,
    logins,
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

test("a query still running when its process is renamed lands under the new label (#2568)", async (t) => {
  let release;
  const a = await fakeQ((sent) => {
    const text = JSON.stringify(sent);
    if (!text.includes("slowq") && !text.includes("failq")) {
      return 1;
    }
    // Held until released; then the query lambda's answer, q's text of the
    // value, or one it cannot read.
    const held = new Promise((r) => (release = r));
    return held.then(() => (text.includes("slowq") ? { ok: true, type: -7, text: ["1"] } : 1));
  });
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)]);
  await live.connectTo("a");
  const shown = [];
  const show = live.modes.show.bind(live.modes);
  live.modes.show = (result, ...rest) => (shown.push(result.process), show(result, ...rest));
  for (const code of ["slowq", "failq"]) {
    const running = live.run(code);
    await until(() => live.isBusy());
    const to = code === "slowq" ? "a2" : "a3";
    await editProcess(live.activeLabel(), to, a.port, "");
    assert.strictEqual(live.activeLabel(), to);
    release();
    await running;
    assert.deepStrictEqual([live.history()[0].code, live.history()[0].process], [code, to]);
  }
  // The answer shown went to the result panel under the label of now.
  assert.deepStrictEqual(shown, ["a2"]);
  assert.strictEqual(live.history()[1].outcome, "ok");
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

test("Abort names the call it stopped: a heartbeat is not the explorer's read (#1709)", async (t) => {
  const a = await fakeQ((sent) => (sent === "::" ? undefined : 1));
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.heartbeat.enable": true, "connection.heartbeatInterval": 1 });
  await live.connectTo("a");
  await until(() => live.isBusy());
  await stub.commands.get("q-lint.abortQuery")();
  assert.match(stub.messages.at(-1)[1], /^q-lint: stopped the heartbeat of a, the only call running\./);
});

test("an unanswered heartbeat's warning stays through an edit of the process (#1710)", async (t) => {
  const a = await fakeQ((sent) => (sent === "::" ? undefined : 1));
  t.after(() => a.close());
  const { live, events } = await setUp(t, [proc("a", a.port)], { "connection.heartbeat.enable": true, "connection.heartbeatInterval": 1 });
  await live.connectTo("a");
  await until(() => /no answer/.test(live.api().statusText()), 8000);
  assert.match(live.api().statusText(), /no answer/);
  stub.inputs.push("uat");
  await stub.commands.get("q-lint.tagProcess")("a");
  assert.ok(events.includes("edited"));
  await sleep(1200);
  assert.match(live.api().statusText(), /no answer/);
});

test("a drill-down on the connected discovered prod process asks first, though a saved process has its label (#1711)", async (t) => {
  const a = await fakeQ(() => 1);
  const b = await fakeQ(() => 1);
  t.after(() => (a.close(), b.close()));
  const { live } = await setUp(t, [proc("srv/rdb", b.port)]);
  assert.strictEqual(await live.open({ label: "srv/rdb", server: "srv", host: "127.0.0.1", port: a.port, tags: ["prod"] }), true);
  let asked;
  stub.picks.push(({ message }) => ((asked = message), undefined));
  await live.runOnProcess("select from t", "srv/rdb", { what: "drill-down query" });
  assert.match(asked ?? "", /srv\/rdb is a production process/);
  assert.deepStrictEqual(a.sent, []);
});

// Edit moved the connected process and stored the new address's password
// under its label; the connection stayed where it was (#1443), and the
// reconnect after Abort dialled the old address with the new password (#2124).
test("the reconnect after Abort goes to the process as saved, never the old address with the new password (#2124)", async (t) => {
  const a = await fakeQ((sent) => (JSON.stringify(sent).includes("slow") ? undefined : 1));
  const b = await fakeQ(() => 1);
  t.after(() => (a.close(), b.close()));
  const { live, context } = await setUp(t, [proc("a", a.port, { user: "bob" })]);
  await context.secrets.store("q-lint.password.a", "pw-of-a");
  assert.strictEqual(await live.connectTo("a"), true);
  stub.inputs.push("a", "127.0.0.1", String(b.port), "bob", "pw-of-b", "");
  stub.picks.push("No");
  await stub.commands.get("q-lint.editProcess")("a");
  assert.strictEqual(live.activeProcess().port, a.port, "still connected where it was");
  const running = live.run("slow");
  await until(() => live.isBusy());
  await stub.commands.get("q-lint.abortQuery")();
  await running;
  await until(() => live.activeLabel() !== undefined);
  assert.strictEqual(live.activeProcess().port, b.port, JSON.stringify(stub.messages));
  assert.deepStrictEqual(a.logins, ["bob:pw-of-a"], "the old address never got the new password");
  assert.deepStrictEqual(b.logins, ["bob:pw-of-b"]);
});

test("a connection kept at its old address is given no password saved for the new one (#2124)", async (t) => {
  const a = await fakeQ(() => 1);
  const b = await fakeQ(() => 1);
  t.after(() => (a.close(), b.close()));
  const { live, context } = await setUp(t, [proc("a", a.port, { user: "bob" })]);
  await context.secrets.store("q-lint.password.a", "pw-of-a");
  assert.strictEqual(await live.connectTo("a"), true);
  stub.inputs.push("a", "127.0.0.1", String(b.port), "carol", "pw-of-carol", "");
  stub.picks.push("No");
  await stub.commands.get("q-lint.editProcess")("a");
  // What Abort or a timeout reconnects to, as the connection still is.
  assert.strictEqual(await live.open(live.activeProcess()), false);
  assert.deepStrictEqual(a.logins, ["bob:pw-of-a"]);
  assert.deepStrictEqual(b.logins, []);
  assert.match(stub.messages.at(-1)[1], /edited to 127\.0\.0\.1:\d+ and its user was changed to carol since it was connected/);
  assert.ok(!JSON.stringify(stub.messages).includes("pw-of"));
});

// A query behind an unanswered heartbeat, or behind the reconnect after an
// Abort, waited with no timeout, was not shown running, and Abort said no
// query was running (#2126).
test("a query waiting behind a heartbeat is shown running and ends at q-lint.query.timeout (#2126)", async (t) => {
  const a = await fakeQ((sent) => (sent === "::" ? undefined : 1));
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.heartbeat.enable": true, "connection.heartbeatInterval": 1, "query.timeout": 1 });
  await live.connectTo("a");
  await until(() => live.isBusy());
  const started = Date.now();
  const running = live.run("1+1");
  await sleep(200);
  assert.match(live.api().statusText(), /waiting/);
  await running;
  assert.ok(Date.now() - started < 2500, `settled after ${Date.now() - started} ms`);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: the query timed out after 1 s (q-lint.query.timeout) waiting to be sent to a; it was not run."]);
  assert.doesNotMatch(live.api().statusText(), /waiting/);
  assert.ok(!a.sent.some((m) => JSON.stringify(m).includes("1+1")));
});

// A notebook cell's Interrupt before it was sent stopped nothing: the cell
// waited on behind the background read until the process was free (#2560).
test("a call waiting behind a heartbeat stops at its own signal, and the heartbeat is left running (#2560)", async (t) => {
  const a = await fakeQ((sent) => (sent === "::" ? undefined : 1));
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.heartbeat.enable": true, "connection.heartbeatInterval": 1 });
  await live.connectTo("a");
  await until(() => live.isBusy());
  const stop = new AbortController();
  const started = Date.now();
  const running = live.runOnActive(["1+1"], (connection) => connection.query(["1+1"], [25, 80]), "ask", undefined, stop.signal);
  await sleep(200);
  assert.match(live.api().statusText(), /waiting/);
  stop.abort();
  assert.strictEqual(await running, undefined);
  assert.ok(Date.now() - started < 1500, `settled after ${Date.now() - started} ms`);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: stopped the query waiting to be sent to a; it was not run."]);
  assert.ok(!a.sent.some((m) => JSON.stringify(m).includes("1+1")));
  assert.strictEqual(live.isBusy(), true, "the heartbeat is still out");
  // A signal stopped before the call waits on nothing.
  assert.strictEqual(await live.runOnActive(["2+2"], async () => 4, "ask", undefined, stop.signal), undefined);
});

test("a query waiting for the reconnect after Abort is shown running, and Abort stops it (#2126)", async (t) => {
  let delay = 0;
  const a = await fakeQ((sent) => (JSON.stringify(sent).includes("slow") ? undefined : 1), () => delay);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)]);
  await live.connectTo("a");
  const slow = live.run("slow");
  await until(() => live.isBusy());
  delay = 3000;
  await stub.commands.get("q-lint.abortQuery")();
  await slow;
  const started = Date.now();
  const second = live.run("1+1");
  await sleep(200);
  assert.match(live.api().statusText(), /a waiting/);
  await stub.commands.get("q-lint.abortQuery")();
  await second;
  assert.ok(Date.now() - started < 1500, `settled after ${Date.now() - started} ms`);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: stopped the query waiting to be sent to a; it was not run."]);
  assert.ok(!stub.messages.some(([, m]) => m === "q-lint: no query is running."), JSON.stringify(stub.messages));
});

// Each reconnect that opened started a fresh run of tries at the first, so
// a process that drops every connection after the handshake was
// reconnected to for ever (#2129).
test("reconnectAttempts bounds the reconnects to a process that drops each connection after the handshake (#2129)", async (t) => {
  let a;
  a = await fakeQ(() => 1, () => (setTimeout(() => a.drop(), 150), 0));
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.autoReconnect.enable": true, "connection.reconnectAttempts": 2 });
  assert.strictEqual(await live.connectTo("a"), true);
  await until(() => stub.messages.some(([, m]) => /could not reconnect/.test(m)), 8000);
  assert.deepStrictEqual(stub.messages.at(-1), ["warning", "q-lint: could not reconnect to a after 2 tries."]);
  assert.strictEqual(a.logins.length, 3, "the connect and two reconnects");
  await sleep(1500);
  assert.strictEqual(a.logins.length, 3, JSON.stringify(stub.messages));
  assert.strictEqual(stub.messages.filter(([, m]) => m === "q-lint: reconnected to a.").length, 2);
});

// The bar was redrawn only when the next beat was due: with the default 30 s
// interval it showed the last round trip for 30 s, then a wait frozen until
// the beat after (#2131).
test("an unanswered heartbeat shows as no answer after 5 s, and its wait counts up (#2131)", async (t) => {
  const a = await fakeQ((sent) => (sent === "::" ? undefined : 1));
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.heartbeat.enable": true, "connection.heartbeatInterval": 30 });
  const started = Date.now();
  await live.connectTo("a");
  // A loaded runner reads the bar late (CI saw "no answer 8s" at the first
  // look), so this holds what #2131 promises - shown from 5 s, never before,
  // and counting up - rather than the exact second it is first read.
  await until(() => /no answer/.test(live.api().statusText()), 7000);
  assert.ok(Date.now() - started >= 4900, `shown after ${Date.now() - started} ms`);
  const seconds = () => Number(/no answer (\d+)/.exec(live.api().statusText())?.[1]);
  const first = seconds();
  assert.ok(first >= 5, live.api().statusText());
  await sleep(2100);
  assert.ok(seconds() >= first + 2, `${first} then ${live.api().statusText()}`);
});

// Between an auto-reconnect's tries nothing was connecting, so a query
// asked which process to connect to, and the pick ended the reconnect (#2132).
test("a query run between an auto-reconnect's tries waits for it, and runs on the process reconnected to (#2132)", async (t) => {
  const a = await fakeQ(() => 2);
  const b = await fakeQ(() => 3);
  t.after(() => (a.close(), b.close()));
  const { live } = await setUp(t, [proc("a", a.port), proc("b", b.port)], { "connection.autoReconnect.enable": true });
  await live.connectTo("a");
  a.drop();
  await until(() => /reconnecting to a/.test(live.api().statusText()));
  let asked;
  const pick = vscode.window.showQuickPick;
  vscode.window.showQuickPick = async (_items, options) => ((asked = options?.title ?? "a pick"), undefined);
  t.after(() => (vscode.window.showQuickPick = pick));
  await live.run("1+1");
  assert.strictEqual(asked, undefined, "it asked which process to connect to");
  assert.strictEqual(live.activeLabel(), "a");
  assert.strictEqual(live.history()[0].process, "a");
  assert.strictEqual(live.history()[0].code, "1+1");
  assert.deepStrictEqual(b.logins, []);
});

// The reconnect after a drop (or after Abort) asked the read-only guard's
// modal question about the connect script from a timer, with nobody there,
// and every query waited behind it (#2133).
test("an automatic reconnect asks nothing about a connect script the guard holds: it connects without it and says so (#2133)", async (t) => {
  const a = await fakeQ(() => null);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("p", a.port, { tags: ["prod"], init: "marker:1" })], { "connection.autoReconnect.enable": true });
  stub.picks.push("Run Anyway");
  assert.strictEqual(await live.connectTo("p"), true);
  const ran = () => a.sent.filter((m) => JSON.stringify(m).includes("marker:1")).length;
  assert.strictEqual(ran(), 1);
  const asked = stub.messages.length;
  a.drop();
  await until(() => stub.messages.some(([, m]) => m === "q-lint: reconnected to p."));
  const after = stub.messages.slice(asked);
  assert.ok(!after.some(([, m]) => /Run it anyway/.test(m)), JSON.stringify(after));
  assert.ok(after.some(([kind, m]) => kind === "warning" && m === "q-lint: the connect script of p failed: it would change p, and a reconnect asks nobody: it was not run. Connect to p to be asked."), JSON.stringify(after));
  assert.strictEqual(ran(), 1);
  assert.strictEqual(live.activeLabel(), "p");
});

test("Load more while direct evaluation is on is later, not the end of the result: nothing is sent (#2566)", async (t) => {
  const a = await fakeQ(() => 1);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "query.unwrapped": true });
  await live.connectTo("a");
  const sent = a.sent.length;
  const page = await live.pageHeld("a", 100, 100, "token");
  assert.match(page.later, /evaluated directly now/);
  assert.strictEqual(a.sent.length, sent);
});

// Disconnect waited for the running query, then showed its answer and
// recorded it as run (#2556). q answers what it was sent after the client
// half-closes, so this one does too.
test("Disconnect while a query runs stops it at once: nothing shown, recorded as aborted", async (t) => {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => {});
    let shook = false;
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      const read = deserialize(chunk);
      setTimeout(() => {
        if (!socket.writable) return;
        const out = serialize(JSON.stringify(read).includes("slowone") ? { ok: true, type: -7, text: ["1"] } : null);
        out.writeUInt8(2, 1);
        socket.write(out);
        socket.end();
      }, JSON.stringify(read).includes("slowone") ? 800 : 0);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { live } = await setUp(t, [proc("a", server.address().port)]);
  assert.strictEqual(await live.connectTo("a"), true);
  const running = live.run("slowone");
  await until(() => live.isBusy());
  const started = Date.now();
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.ok(Date.now() - started < 500, `Disconnect took ${Date.now() - started} ms`);
  await running;
  assert.strictEqual(live.activeLabel(), undefined);
  assert.strictEqual(live.history()[0].code, "slowone");
  assert.strictEqual(live.history()[0].outcome, "aborted");
});

// A file bound to another process could not send its code while the Process
// Explorer's read - or any background read - was out on the connection: "a
// query is still running", of a read Abort does not call one. Only a query
// holds the connection where it is (#3039).
test("a file bound elsewhere connects there while a background read is out, and is refused only by a query (#3039)", async (t) => {
  const dev = await fakeQ(() => undefined);
  const hdb = await fakeQ(() => undefined);
  t.after(() => (dev.close(), hdb.close()));
  const { live, context } = await setUp(t, [proc("dev", dev.port), proc("hdb", hdb.port)]);
  const bindings = { "file:///hdb.q": "hdb", "file:///dev.q": "dev" };
  context.workspaceState.get = (key, fallback) => (key === "q-lint.fileConnections" ? bindings : fallback);
  assert.strictEqual(await live.connectTo("dev"), true);
  const read = live.borrow((connection) => connection.evaluate("tables[]"), "the Process Explorer's read");
  read.catch(() => {});
  assert.strictEqual(live.isBusy(), true);
  assert.strictEqual(live.queryRunning(), false);
  stub.messages = [];
  assert.strictEqual(await live.toFileBinding(vscode.Uri.file("/hdb.q")), true);
  assert.strictEqual(live.activeLabel(), "hdb");
  assert.deepStrictEqual(stub.messages, []);
  // A query is the user's to wait for: the connection stays.
  const running = live.run("slowone");
  await until(() => live.isBusy());
  assert.strictEqual(live.queryRunning(), true);
  assert.strictEqual(await live.toFileBinding(vscode.Uri.file("/dev.q")), false);
  assert.strictEqual(live.activeLabel(), "hdb");
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: a query is still running on hdb; this file's code goes to dev. q-lint: Abort Current Query stops waiting for it."]]);
  await stub.commands.get("q-lint.disconnectProcess")();
  await running;
});

// Load more sent its page straight on the connection: a query run while it
// was out was refused ("a query is still running", of none), and a page asked
// for during the Process Explorer's read was put off as if a query ran. It is
// a background read like theirs, taking its turn (#3017).
test("Load more takes its turn with background reads, and a query sent meanwhile waits for it (#3017)", async (t) => {
  const page = { count: 5, names: ["c"], types: [7], cells: [["3", "4"]], raw: [[3, 4]], rank: [[0, 1]] };
  let answerRead;
  const a = await fakeQ((message) => {
    const text = JSON.stringify(message);
    if (text.includes("slowread")) {
      return new Promise((resolve) => (answerRead = () => resolve(1)));
    }
    if (text.includes("token")) {
      return new Promise((resolve) => setTimeout(() => resolve(page), 150));
    }
    return { ok: true, type: -7, text: ["2"] };
  });
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)]);
  await live.connectTo("a");
  // Asked for while another read is out: it waits, not "a query is running".
  const read = live.borrow((connection) => connection.evaluate("slowread"), "the Process Explorer's read");
  const more = live.pageHeld("a", 100, 2, "token");
  await sleep(50);
  answerRead();
  await read;
  // A query sent while the page is out waits for it, and runs.
  stub.messages = [];
  await sleep(20);
  assert.strictEqual(live.isBusy(), true, "the page is out");
  await live.run("1+1");
  assert.deepStrictEqual((await more).cells, [["3", "4"]]);
  assert.deepStrictEqual(stub.messages, []);
  assert.deepStrictEqual(live.history().map((e) => [e.code, e.outcome]), [["1+1", "ok"]]);
});

// A watched query's run was a query like any other: a cell, a test or a
// query from the editor sent while one was out was refused with "a query is
// still running", of a query the user never ran - a Run All stopped midway
// through, every interval. It waits for the run, as for a background read.
test("a query sent while a watched query's run is out waits for that run (#3029)", async (t) => {
  const answer = { ok: true, type: -7, text: ["2"] };
  let answerWatch;
  const a = await fakeQ((message) => (JSON.stringify(message).includes("watchme") ? new Promise((resolve) => (answerWatch = () => resolve(answer))) : answer));
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "query.watch.enable": true });
  await live.connectTo("a");
  const watching = stub.commands.get("q-lint.watchQuery")("watchme", 1);
  await until(() => answerWatch !== undefined);
  stub.messages = [];
  const cell = live.runOnActive("1+1", (connection) => connection.query(["1+1"], [25, 80]));
  await sleep(50);
  assert.ok(!a.sent.some((message) => JSON.stringify(message).includes("1+1")), "the cell is not sent while the run is out");
  answerWatch();
  assert.strictEqual((await cell)?.process, "a");
  assert.deepStrictEqual(stub.messages, []);
  await watching;
  await stub.commands.get("q-lint.stopWatchingQuery")();
});
