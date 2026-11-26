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

// A network gone with no FIN or RST left the socket open: the heartbeat
// showed "no answer" for ever, and the automatic reconnect never began.
test("a heartbeat unanswered three beats on closes the connection of a host that takes none, and keeps a busy process's (#3031)", async (t) => {
  const a = await fakeQ((sent) => (sent === "::" ? undefined : 1));
  t.after(() => a.close());
  // The heartbeat's seconds are the fake clock's.
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => t.mock.timers.reset());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.heartbeat.enable": true, "connection.heartbeatInterval": 1 });
  await live.connectTo("a");
  await until(() => a.sent.includes("::"));
  const connect = net.connect;
  const asked = [];
  let gone = false;
  net.connect = (...args) => {
    // The network gone, its host is one no connection reaches.
    const socket = gone ? new net.Socket() : connect(...args);
    if (gone) {
      setImmediate(() => socket.destroy(new Error("connect EHOSTUNREACH")));
    }
    asked.push(new Promise((resolve) => socket.once("close", resolve)));
    return socket;
  };
  t.after(() => (net.connect = connect));
  stub.messages.length = 0;
  const beats = async (n) => {
    for (let i = 0; i < n; i++) {
      t.mock.timers.tick(1000);
      await sleep(5);
    }
  };
  // A busy process: its host takes a connection, and it keeps its own.
  await beats(2);
  assert.strictEqual(asked.length, 0, "its host was asked before the third beat");
  await beats(1);
  assert.strictEqual(asked.length, 1);
  await asked[0];
  await sleep(20);
  assert.strictEqual(live.activeLabel(), "a");
  assert.deepStrictEqual(stub.messages, []);
  assert.strictEqual(a.logins.length, 1, "asking the host logged in to the process");
  gone = true;
  await beats(3);
  assert.strictEqual(asked.length, 2);
  await until(() => live.activeLabel() === undefined);
  assert.deepStrictEqual(stub.messages, [["warning", "q-lint: the connection to a closed."]]);
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

// A query run with no connection connects first, and that connect was
// nobody's wait: no timeout ended it, the bar said "not connected", and
// Abort said no query was running while one waited to be sent.
test("the connect a query starts is its wait: shown waiting, stopped by Abort, ended at q-lint.query.timeout (#3019)", async (t) => {
  const a = await fakeQ(() => 1, 1500);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "query.timeout": 1 });
  stub.picks.push((options) => options.items[0]);
  let started = Date.now();
  const first = live.run("1+1");
  await until(() => a.logins.length === 1);
  assert.match(live.api().statusText(), /a waiting/);
  await stub.commands.get("q-lint.abortQuery")();
  await first;
  assert.ok(Date.now() - started < 900, `settled after ${Date.now() - started} ms`);
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: stopped the query waiting to be sent to a; it was not run."]]);
  assert.doesNotMatch(live.api().statusText(), /waiting/);
  // A file's bound process, connected to for its query, as well.
  stub.messages.length = 0;
  started = Date.now();
  await live.runOnProcess("2+2", "a", { what: "query" });
  assert.ok(Date.now() - started < 1400, `settled after ${Date.now() - started} ms`);
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: the query timed out after 1 s (q-lint.query.timeout) waiting to be sent to a; it was not run."]]);
  assert.strictEqual(live.activeLabel(), undefined, "the connect was stopped with the query");
  await sleep(50);
  assert.deepStrictEqual(live.history(), []);
});

// A query that waited for a connect went on, when the connect ended with
// no connection, to ask "Connect to which q process?": of a user who had
// pressed Disconnect, or had just been told the connect failed.
test("a query that waited for a connect that was disconnected, or failed, is not run and asks for no process (#3015)", async (t) => {
  const a = await fakeQ(() => 1, 1500);
  t.after(() => a.close());
  // A process that closes every connection before the handshake.
  const refusing = net.createServer((socket) => socket.on("data", () => setTimeout(() => socket.destroy(), 100)).on("error", () => {}));
  await new Promise((r) => refusing.listen(0, "127.0.0.1", r));
  t.after(() => refusing.close());
  const { live } = await setUp(t, [proc("a", a.port), proc("b", refusing.address().port)]);
  const asked = [];
  const pick = vscode.window.showQuickPick;
  vscode.window.showQuickPick = async (_items, options) => void asked.push(options?.title);
  t.after(() => (vscode.window.showQuickPick = pick));
  const connect = live.connectTo("a");
  await until(() => a.logins.length === 1);
  const first = live.run("1+1");
  await sleep(50);
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.strictEqual(await connect, false);
  await first;
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: the connect to a did not complete; the query was not run."]]);
  stub.messages.length = 0;
  const refused = live.connectTo("b");
  await sleep(30);
  const second = live.run("2+2");
  assert.strictEqual(await refused, false);
  await second;
  assert.deepStrictEqual(stub.messages.map(([, m]) => m.replace(/\(.*$/, "")), ["q-lint: could not connect to b ", "q-lint: the connect to b did not complete; the query was not run."]);
  assert.deepStrictEqual(asked, []);
  assert.deepStrictEqual(live.history(), []);
});

// The line a Run Line runs from was kept in one field until `run` took it,
// after the connect a bound file's first query makes: a second Run Line
// during that connect put its line there, and the first query's result was
// drawn beside the second line.
test("two Run Lines during a bound file's connect each draw their result at their own line (#3022)", async (t) => {
  const a = await fakeQ((sent) => ({ ok: true, type: -7, text: [JSON.stringify(sent).includes("10*10") ? "100" : "2"] }), 300);
  t.after(() => a.close());
  const { context, live } = await setUp(t, [proc("a", a.port)]);
  const lines = ["1+1", "10*10"];
  const uri = vscode.Uri.file("/w/bound.q");
  context.workspaceState.get = (key, fallback) => (key === "q-lint.fileConnections" ? { [uri.toString()]: "a" } : fallback);
  const editor = {
    document: { uri, version: 1, languageId: "q", lineAt: (line) => ({ text: lines[line] }), getText: () => lines.join("\n") },
    selection: { active: { line: 0 }, isEmpty: true },
  };
  vscode.window.activeTextEditor = editor;
  t.after(() => (vscode.window.activeTextEditor = undefined));
  const answers = [];
  live.onDidAnswer((answered) => answers.push([answered.line, answered.answer.text]));
  const first = stub.commands.get("q-lint.queryCurrentLine")();
  await until(() => a.logins.length === 1);
  editor.selection = { active: { line: 1 }, isEmpty: true };
  const second = stub.commands.get("q-lint.queryCurrentLine")();
  await Promise.all([first, second]);
  assert.deepStrictEqual(answers[0], [0, ["2"]], JSON.stringify(answers));
  assert.ok(answers.every(([line, text]) => (line === 0) === (text[0] === "2")), JSON.stringify(answers));
});

// During a connect, and during Abort's reconnect - which waits, perhaps for
// minutes, until the process is free - the bar said "not connected" and the
// process's environment colour went, while a query sent then is sent there.
test("the status bar says a connect and Abort's reconnect are under way, and the environment colour stays through the reconnect (#3018)", async (t) => {
  const { EnvironmentColour } = require("../out/envcolourview.js");
  let delay = 300;
  const a = await fakeQ((sent) => (JSON.stringify(sent).includes("slow") ? undefined : 1), () => delay);
  t.after(() => a.close());
  const { context, live } = await setUp(t, [proc("a", a.port, { tags: ["prod"] })], { "processes.environmentColor.enable": true });
  const items = [];
  const create = vscode.window.createStatusBarItem;
  vscode.window.createStatusBarItem = (id, ...rest) => {
    const item = { ...create(id, ...rest), id, shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
    items.push(item);
    return item;
  };
  t.after(() => (vscode.window.createStatusBarItem = create));
  new EnvironmentColour(context, live);
  const colour = () => items.find((item) => item.id === "q-lint.environment");
  const connect = live.connectTo("a");
  await until(() => a.logins.length === 1);
  assert.strictEqual(live.api().statusText(), "$(sync~spin) q: connecting to a");
  assert.strictEqual(await connect, true);
  assert.strictEqual(live.api().statusText(), "$(plug) q: a");
  assert.strictEqual(colour().shown, true);
  const slow = live.run("slow");
  await until(() => live.isBusy());
  delay = 400;
  await stub.commands.get("q-lint.abortQuery")();
  await slow;
  assert.strictEqual(live.api().statusText(), "$(sync~spin) q: reconnecting to a");
  assert.strictEqual(colour().shown, true, "the colour of the process the next query goes to");
  assert.match(colour().tooltip, /^Reconnecting to a, tagged prod/);
  await until(() => live.activeLabel() === "a");
  assert.strictEqual(live.api().statusText(), "$(plug) q: a");
  assert.match(colour().tooltip, /^Connected to a, tagged prod/);
  // Stopped by Disconnect, neither stays.
  const again = live.run("slow");
  await until(() => live.isBusy());
  await stub.commands.get("q-lint.abortQuery")();
  await again;
  assert.strictEqual(colour().shown, true);
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.strictEqual(colour().shown, false);
  await until(() => live.api().statusText() === "$(debug-disconnect) q: not connected", 1000);
  assert.strictEqual(live.api().statusText(), "$(debug-disconnect) q: not connected");
});

// After Disconnect the process last connected to was still taken for the one
// a waiting query goes to, and for the one a connect under way is to: the
// wait was timed by its timeout and said its name, and Stop Process on it
// stopped the connect to another.
test("a connect after Disconnect has nothing of the process disconnected from: not its timeout, its name, or its Stop Process (#3038)", async (t) => {
  const dev = await fakeQ(() => 1);
  const hdb = await fakeQ(() => ({ ok: true, type: -7, text: ["4"] }), 1300);
  t.after(() => (dev.close(), hdb.close()));
  const { live } = await setUp(t, [proc("dev", dev.port, { timeout: 1 }), proc("hdb", hdb.port)]);
  assert.strictEqual(await live.connectTo("dev"), true);
  await stub.commands.get("q-lint.disconnectProcess")();
  stub.messages.length = 0;
  const connect = live.connectTo("hdb");
  await until(() => hdb.logins.length === 1);
  const stopped = live.run("1+1");
  await sleep(50);
  await stub.commands.get("q-lint.abortQuery")();
  await stopped;
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: stopped the query waiting to be sent to hdb; it was not run."]]);
  stub.messages.length = 0;
  // Longer than dev's timeout, and the query is sent to hdb all the same.
  const run = live.run("2+2");
  await live.stopping("dev", dev.port);
  assert.strictEqual(await connect, true, "Stop Process on dev left the connect to hdb");
  await run;
  assert.deepStrictEqual(stub.messages, []);
  assert.deepStrictEqual(live.history().map((e) => [e.process, e.code, e.outcome]), [["hdb", "2+2", "ok"]]);
});

// The status bar's item runs Connect ("Click to switch"): picking the
// process already connected there closed the connection and opened it
// again, and the query running on it was recorded as aborted.
test("picking the connected process from Connect's list keeps the connection and the query running on it (#3030)", async (t) => {
  let answer;
  const a = await fakeQ((sent) => (JSON.stringify(sent).includes("slow") ? new Promise((resolve) => (answer = resolve)) : 1));
  t.after(() => a.close());
  const { live, events } = await setUp(t, [proc("a", a.port), proc("b", a.port)]);
  assert.strictEqual(await live.connectTo("a"), true);
  const slow = live.run("slow");
  await until(() => answer !== undefined);
  stub.picks.push((options) => options.items.find((item) => item.label === "a"));
  await stub.commands.get(live.status.command)();
  assert.strictEqual(a.logins.length, 1, "connected once");
  answer({ ok: true, type: -7, text: ["42"] });
  await slow;
  assert.deepStrictEqual(live.history().map((e) => [e.code, e.outcome]), [["slow", "ok"]]);
  assert.deepStrictEqual(events, ["connected", "queried"]);
  assert.deepStrictEqual(stub.messages, [["info", "q-lint: already connected to a."]]);
});

// Connect stopped an automatic reconnect as soon as a process was chosen,
// before a discovered process's password was asked for: Escape there
// connected nowhere and left the dropped process disconnected for good.
test("Escape at a discovered process's password box leaves the automatic reconnect under way (#3028)", async (t) => {
  const a = await fakeQ(() => 1);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)], { "connection.autoReconnect.enable": true });
  live.discovery.discovered = () => [{ server: { label: "disc", url: "http://x" }, state: { processes: [proc("rdb", a.port, { user: "u" })], problems: [], loading: false } }];
  assert.strictEqual(await live.connectTo("a"), true);
  a.drop();
  await until(() => /reconnecting to a/.test(live.api().statusText()));
  stub.inputs.push(undefined);
  assert.strictEqual(await live.connectTo("disc/rdb"), false);
  assert.match(live.api().statusText(), /reconnecting to a/);
  await until(() => live.activeLabel() === "a", 3000);
  assert.strictEqual(live.activeLabel(), "a");
});

// A reconnect to a process from a discovery server dialed the address it
// had at the first connect: one restarted on another port, which its server
// now lists, was never reconnected to.
test("a reconnect to a discovered process dials the address its server lists now (#3021)", async (t) => {
  let answer;
  const old = await fakeQ(() => 1);
  const moved = await fakeQ((sent) => (JSON.stringify(sent).includes("slow") ? new Promise((resolve) => (answer = resolve)) : 1));
  const again = await fakeQ(() => 1);
  t.after(() => (old.close(), moved.close(), again.close()));
  const { live } = await setUp(t, [], { "connection.autoReconnect.enable": true });
  let listed = [proc("rdb", old.port)];
  live.discovery.discovered = () => [{ server: { label: "disc", url: "http://x" }, state: { processes: listed, problems: [], loading: false } }];
  assert.strictEqual(await live.connectTo("disc/rdb"), true);
  listed = [proc("rdb", moved.port)];
  old.drop();
  await until(() => live.activeLabel() === undefined);
  await until(() => live.activeLabel() === "disc/rdb", 3000);
  assert.deepStrictEqual([live.activeProcess()?.port, moved.logins.length], [moved.port, 1]);
  // Abort's reconnect too.
  const slow = live.run("slow");
  await until(() => answer !== undefined);
  listed = [proc("rdb", again.port)];
  await stub.commands.get("q-lint.abortQuery")();
  await slow;
  await until(() => live.activeLabel() === "disc/rdb");
  assert.deepStrictEqual([live.activeProcess()?.port, again.logins.length], [again.port, 1]);
});

/// A context whose workspace state is kept, as a window's is.
function keeping(context) {
  const kept = new Map();
  context.workspaceState = { get: (k, d) => (kept.has(k) ? kept.get(k) : d), update: async (k, v) => void kept.set(k, v), keys: () => [...kept.keys()] };
  return context;
}

/// What another window's rename of the saved process `from` to `to`, or its
/// deletion (`to` undefined), leaves in the state every window shares.
async function elsewhere(context, from, to) {
  const saved = context.globalState.get("q-lint.processes");
  await context.globalState.update("q-lint.processes", to === undefined ? saved.filter((p) => p.label !== from) : saved.map((p) => (p.label === from ? { ...p, label: to } : p)));
  const log = context.globalState.get("q-lint.processRelabels", []);
  await context.globalState.update("q-lint.processRelabels", [...log, { n: log.length + 1, from, to: to ?? null }]);
}

// The process was renamed in another window: the reconnect after a drop
// found no saved process of the old label and ended without a word, the
// status bar going to "not connected" after "Reconnecting.".
test("an automatic reconnect follows a rename made in another window, and says why it stops when the process was deleted there (#3036)", async (t) => {
  const a = await fakeQ(() => ({ ok: true, type: -7, text: ["2"] }));
  t.after(() => a.close());
  const { context, live } = await setUp(t, [proc("rdb", a.port)], { "connection.autoReconnect.enable": true });
  keeping(context);
  assert.strictEqual(await live.connectTo("rdb"), true);
  await elsewhere(context, "rdb", "rdb-eu");
  a.drop();
  await until(() => live.activeLabel() === undefined);
  await until(() => live.activeLabel() !== undefined, 3000);
  assert.strictEqual(live.activeLabel(), "rdb-eu");
  assert.deepStrictEqual(stub.messages.map((m) => m[1]), ["q-lint: the connection to rdb closed. Reconnecting.", "q-lint: reconnected to rdb-eu."]);
  // Answered, the connection held: the next reconnect's tries start again.
  await live.run("1+1");
  stub.messages.length = 0;
  await elsewhere(context, "rdb-eu", undefined);
  a.drop();
  await until(() => stub.messages.length === 2, 3000);
  assert.deepStrictEqual(stub.messages, [
    ["warning", "q-lint: the connection to rdb-eu closed. Reconnecting."],
    ["warning", "q-lint: stopped reconnecting to rdb-eu: it is no longer in the process list."],
  ]);
  assert.strictEqual(live.api().statusText(), "$(debug-disconnect) q: not connected");
});

// The log of renames (#1749) was read only when a workspace opened: a file
// bound to a process another window then renamed stayed bound to the old
// label, and every Run Line in it failed until a reload.
test("a file bound to a process renamed in another window runs on it under its new label, without a reload (#3035)", async (t) => {
  const a = await fakeQ(() => ({ ok: true, type: -7, text: ["2"] }));
  t.after(() => a.close());
  stub.reset();
  let focus;
  vscode.window.onDidChangeWindowState = (listener) => ((focus = listener), new vscode.Disposable(() => {}));
  t.after(() => delete vscode.window.onDidChangeWindowState);
  const context = keeping(stub.newContext());
  await context.globalState.update("q-lint.processes", [proc("rdb", a.port), proc("hdb", a.port)]);
  const report = vscode.Uri.file("/w/report.q");
  const eod = vscode.Uri.file("/w/eod.q");
  await context.workspaceState.update("q-lint.fileConnections", { [report.toString()]: "rdb", [eod.toString()]: "hdb" });
  const live = new Live(context);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  await sleep(10);
  await elsewhere(context, "rdb", "rdb-eu");
  vscode.window.activeTextEditor = {
    document: { uri: report, version: 1, languageId: "q", lineAt: () => ({ text: "1+1" }), getText: () => "1+1" },
    selection: { active: { line: 0 }, isEmpty: true },
  };
  t.after(() => (vscode.window.activeTextEditor = undefined));
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.deepStrictEqual(stub.messages, []);
  assert.deepStrictEqual([live.fileBinding(report), live.activeLabel()], ["rdb-eu", "rdb-eu"]);
  assert.deepStrictEqual(live.history().map((e) => [e.process, e.code, e.outcome]), [["rdb-eu", "1+1", "ok"]]);
  // And when the window is come back to, before anything is run in it.
  await elsewhere(context, "hdb", "hdb-eu");
  focus({ focused: true });
  await sleep(10);
  assert.strictEqual(live.fileBinding(eod), "hdb-eu");
});

// A host that takes no connection was read as a process busy with the
// query it was left with: Abort's reconnect dialed it again every 10 s
// without end, and without a word.
test("Abort's reconnect gives up, saying why, on a host that takes no connection (#3032)", async (t) => {
  const a = await fakeQ((sent) => (JSON.stringify(sent).includes("slow") ? undefined : 1));
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)]);
  assert.strictEqual(await live.connectTo("a"), true);
  const slow = live.run("slow");
  await until(() => a.sent.some((sent) => JSON.stringify(sent).includes("slow")));
  // The network goes: a SYN nothing answers is a socket that never connects.
  const connect = net.connect;
  let dials = 0;
  net.connect = () => (dials++, new net.Socket());
  t.after(() => (net.connect = connect));
  const turn = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  await stub.commands.get("q-lint.abortQuery")();
  await slow;
  stub.messages.length = 0;
  for (let i = 0; i < 3; i++) {
    await turn();
    t.mock.timers.tick(10_000);
  }
  await turn();
  t.mock.timers.reset();
  assert.strictEqual(dials, 1);
  assert.deepStrictEqual(stub.messages, [["error", `q-lint: could not connect to a (127.0.0.1:${a.port}): 127.0.0.1:${a.port} could not be reached in 10 s`]]);
  assert.strictEqual(live.api().statusText(), "$(debug-disconnect) q: not connected");
});

// Abort's reconnect gave its login up after 10 s and made another, for as
// long as the process was busy: once free, the process answered every one
// in turn - the password checked and `.z.po` run for each, a one-time
// credential spent on a connection long closed.
test("Abort's reconnect leaves one login with a busy process, and is connected by it once the process is free (#3024)", async (t) => {
  let busy = 0;
  const a = await fakeQ((sent) => (JSON.stringify(sent).includes("slow") ? undefined : 1), () => busy);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port, { user: "me" })]);
  assert.strictEqual(await live.connectTo("a"), true);
  const slow = live.run("slow");
  await until(() => a.sent.some((sent) => JSON.stringify(sent).includes("slow")));
  // The process is 25 s from the end of its query, by a clock the test turns.
  busy = 25_000;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const turn = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await stub.commands.get("q-lint.abortQuery")();
  await slow;
  for (let i = 0; i < 20 && a.logins.length < 2; i++) {
    await turn();
  }
  for (const seconds of [10, 10, 4]) {
    t.mock.timers.tick(seconds * 1000);
    await turn();
  }
  assert.deepStrictEqual([a.logins, live.activeLabel()], [["me:", "me:"], undefined]);
  t.mock.timers.tick(1000);
  for (let i = 0; i < 20 && live.activeLabel() === undefined; i++) {
    await turn();
  }
  t.mock.timers.reset();
  assert.deepStrictEqual([a.logins, live.activeLabel()], [["me:", "me:"], "a"]);
});

// Disconnect and Abort close the connections apart still in their connect
// script (#2567) - and closed a tile's refresh and a scheduled export on
// other processes with them, which failed with nothing said.
test("Disconnect, and Abort with nothing running, leave a background run on another process in its connect script (#3026)", async (t) => {
  const ok = { ok: true, type: -7, text: ["2"] };
  const dev = await fakeQ(() => ok);
  const hdb = await fakeQ((sent) => (JSON.stringify(sent).includes("prepare") ? sleep(200).then(() => ok) : ok));
  t.after(() => (dev.close(), hdb.close()));
  const { live } = await setUp(t, [proc("dev", dev.port), proc("hdb", hdb.port, { init: "prepare[]" })]);
  assert.strictEqual(await live.connectTo("dev"), true);
  for (const [command, said] of [
    ["q-lint.abortQuery", [["info", "q-lint: no query is running."]]],
    ["q-lint.disconnectProcess", []],
  ]) {
    hdb.sent.length = 0;
    stub.messages.length = 0;
    const background = live.runApart(live.processes()[1], "til 3", undefined, { unattended: true });
    await until(() => hdb.sent.length === 1);
    await stub.commands.get(command)();
    assert.deepStrictEqual((await background).text, ["2"], command);
    assert.deepStrictEqual(stub.messages, said, command);
  }
});
