// The read-only guard's backstop in `Live`, through the stand-in `vscode`
// and a q process played by a socket server: what the guard reads as
// read-only goes to a guarded process under `reval` (the `_READ_ONLY`
// lambdas), so a write the guard misses is a q error; `reval` refusing it is
// asked about - "run anyway?" - and sent again as it is only when confirmed;
// a process without `reval` is said once and sent the plain lambda. Real q
// in guard_backstop_q.test.js.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");
const { Live } = require("../out/live.js");
const { NO_REVAL, RUN, RUN_READ_ONLY } = require("../out/query.js");
const { readEnforce, refusalQuestion } = require("../out/guard.js");

/// A q process played by a socket server. A lambda that evaluates under
/// `reval` is answered `refuse()`'s error when it gives one, and every
/// other message as `RUN` answers success.
async function fakeQ(refuse = () => undefined) {
  const sent = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
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
        sent.push(m);
        const error = Array.isArray(m) && typeof m[0] === "string" && m[0].includes("reval(value;x)") ? refuse(m) : undefined;
        // Asked apart whether it has reval: not when `refuse` says so.
        const out =
          m === "`reval in key`.q"
            ? serialize(refuse(m) !== NO_REVAL)
            : serialize(error === undefined ? { ok: true, type: -7, text: ["1"] } : { ok: false, error, trace: "" });
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    /// Each query's lambda and its statements.
    queries: () => sent.filter((m) => Array.isArray(m) && Array.isArray(m[1])).map((m) => [m[0] === RUN ? "RUN" : m[0] === RUN_READ_ONLY ? "RUN_READ_ONLY" : m[0], m[1].join("\n")]),
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

async function setUp(t, tags, refuse, config = {}, extra = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const q = await fakeQ(refuse);
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "127.0.0.1", port: q.port, tags, ...extra }]);
  const live = new Live(context);
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  const query = async (text) => {
    vscode.window.activeTextEditor = {
      document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text }), getText: () => text },
      selection: { active: { line: 0 }, isEmpty: true },
    };
    await stub.commands.get("q-lint.queryCurrentLine")();
  };
  return { q, live, query };
}

const warnings = () => stub.messages.filter(([kind]) => kind === "warning").map(([, text]) => text);

test("readEnforce is on by default, off with its setting or with the guard", () => {
  const read = (values) => readEnforce((key, fallback) => (key in values ? values[key] : fallback));
  assert.strictEqual(read({}), true);
  assert.strictEqual(read({ "processes.readOnlyGuard.enforce": false }), false);
  assert.strictEqual(read({ "processes.readOnlyGuard.enable": false }), false);
});

test("a read on a guarded process goes under reval; on an unguarded one, with enforce off, or confirmed as a write, it goes as it is", async (t) => {
  const { q, live, query } = await setUp(t, ["prod"]);
  assert.strictEqual(await live.connectTo("rdb"), true);
  await query("select from trade");
  stub.picks.push("Run Anyway");
  await query("a:1");
  stub.config.user["processes.readOnlyGuard.enforce"] = false;
  await query("count trade");
  assert.deepStrictEqual(q.queries(), [
    ["RUN_READ_ONLY", "select from trade"],
    ["RUN", "a:1"],
    ["RUN", "count trade"],
  ]);
});

test("an unguarded process is sent the plain lambda", async (t) => {
  const { q, live, query } = await setUp(t, ["dev"]);
  await live.connectTo("rdb");
  await query("select from trade");
  assert.deepStrictEqual(q.queries(), [["RUN", "select from trade"]]);
});

test("a TorQ gateway is sent its .gw.syncexec call as a plain string, without reval: it changes the gateway itself (#2584)", async (t) => {
  const { q, live, query } = await setUp(t, ["prod"], undefined, {}, { gateway: ["rdb"] });
  await live.connectTo("rdb");
  await query("select from trade");
  assert.deepStrictEqual(q.queries(), []);
  assert.strictEqual(live.history()[0].code, '.gw.syncexec["select from trade";enlist `rdb]');
});

// With the gateway feature off its code runs on the gateway as on any
// process, so the backstop holds there too (#2598).
test("with q-lint.connection.torqGateway.enable off, a guarded gateway's read goes under reval", async (t) => {
  const { q, live, query } = await setUp(t, ["prod"], undefined, { "connection.torqGateway.enable": false }, { gateway: ["rdb"] });
  await live.connectTo("rdb");
  await query("select from trade");
  assert.deepStrictEqual(q.queries(), [["RUN_READ_ONLY", "select from trade"]]);
});

test("a read reval refuses is asked about; declined, it is not sent again; confirmed, it is sent as it is", async (t) => {
  const { q, live, query } = await setUp(t, ["prod"], () => "noupdate: `. `c");
  await live.connectTo("rdb");
  stub.picks.push(undefined);
  await query("cache 5");
  assert.deepStrictEqual(warnings(), [refusalQuestion("rdb", "noupdate: `. `c")]);
  assert.match(warnings()[0], /^Refused by the read-only evaluation of rdb: 'noupdate: `\. `c\. Run it anyway\?$/);
  assert.deepStrictEqual(q.queries(), [["RUN_READ_ONLY", "cache 5"]]);
  // The refusal is the result shown, as q's error.
  assert.strictEqual(live.history()[0].error, "noupdate: `. `c");
  stub.picks.push("Run Anyway");
  await query("cache 5");
  assert.deepStrictEqual(q.queries().slice(1), [
    ["RUN_READ_ONLY", "cache 5"],
    ["RUN", "cache 5"],
  ]);
  assert.strictEqual(live.history()[0].outcome, "ok");
});

test("an error that is not a refusal is shown, not asked about", async (t) => {
  const { q, live, query } = await setUp(t, ["prod"], () => "type");
  await live.connectTo("rdb");
  await query("1+`a");
  assert.deepStrictEqual(warnings(), []);
  assert.deepStrictEqual(q.queries(), [["RUN_READ_ONLY", "1+`a"]]);
});

test("a process without reval is said once, and sent the plain lambda from then on", async (t) => {
  const { q, live, query } = await setUp(t, ["prod"], () => NO_REVAL);
  await live.connectTo("rdb");
  await query("count trade");
  await query("count quote");
  assert.deepStrictEqual(q.queries(), [
    ["RUN_READ_ONLY", "count trade"],
    ["RUN", "count trade"],
    ["RUN", "count quote"],
  ]);
  const told = stub.messages.filter(([, text]) => /has no reval/.test(text));
  assert.strictEqual(told.length, 1);
  assert.match(told[0][1], /^q-lint: rdb has no reval, so code the read-only guard reads as read-only is sent to it as it is/);
  assert.deepStrictEqual(warnings(), []);
});

test("through runOnActive - a notebook cell, an agent - a refusal is asked about, or thrown to a caller that cannot ask", async (t) => {
  const { q, live } = await setUp(t, ["prod"], () => "sys");
  await live.connectTo("rdb");
  const use = (connection) => connection.query(["count t"], [25, 200]);
  stub.picks.push(undefined);
  const declined = await live.runOnActive("count t", use);
  assert.strictEqual(declined.value.error, "sys");
  stub.picks.push("Run Anyway");
  const confirmed = await live.runOnActive("count t", use);
  assert.strictEqual(confirmed.value.ok, true);
  await assert.rejects(live.runOnActive("count t", use, "refuse"), /^Error: Refused by the read-only evaluation of rdb: 'sys\. .*nothing was changed\.$/);
  assert.deepStrictEqual(
    q.queries().map(([lambda]) => lambda),
    ["RUN_READ_ONLY", "RUN_READ_ONLY", "RUN", "RUN_READ_ONLY"],
  );
});

test("the connection evaluates as before after a backstopped send, refused or not", async (t) => {
  const { live } = await setUp(t, ["prod"], () => "sys");
  await live.connectTo("rdb");
  let seen;
  stub.picks.push(undefined);
  await live.runOnActive("count t", async (connection) => {
    seen = connection;
    return connection.query(["count t"], [25, 200]);
  });
  assert.strictEqual(seen.readOnly, false);
  assert.strictEqual(seen.refused, undefined);
});

test("a .gw. or .dataaccess. name in code sent to a guarded process that is no gateway keeps reval (#2637)", async (t) => {
  const { q, live, query } = await setUp(t, ["prod"]);
  await live.connectTo("rdb");
  await query("count .gw.servers");
  await query("key .dataaccess.cfg");
  assert.deepStrictEqual(q.queries(), [
    ["RUN_READ_ONLY", "count .gw.servers"],
    ["RUN_READ_ONLY", "key .dataaccess.cfg"],
  ]);
  // A REPL, a notebook cell or an agent is not told to send it plain.
  assert.strictEqual(live.gatewayed(["count .gw.servers"]).plain, false);
});

test("on a process reval does not hold on, a gateway call still goes as a plain string (#2584, #2637)", async (t) => {
  const { q, live, query } = await setUp(t, ["dev"]);
  await live.connectTo("rdb");
  await query("count .gw.servers");
  assert.deepStrictEqual(q.queries(), []);
  assert.strictEqual(live.gatewayed(["count .gw.servers"]).plain, true);
});

test("a connect script the guard reads as read-only goes under reval on a guarded process (#2641)", async (t) => {
  const { q, live } = await setUp(t, ["prod"], undefined, {}, { init: "count t" });
  assert.strictEqual(await live.connectTo("rdb"), true);
  assert.deepStrictEqual(q.queries(), [["RUN_READ_ONLY", "count t"]]);
});

test("a connect script reval refuses is asked about; declined it is not sent again, confirmed it is sent as it is (#2641)", async (t) => {
  const { q, live } = await setUp(t, ["prod"], () => "restricted", {}, { init: "count t" });
  stub.picks.push(undefined);
  await live.connectTo("rdb");
  assert.deepStrictEqual(warnings(), [refusalQuestion("rdb", "restricted")]);
  assert.deepStrictEqual(q.queries(), [["RUN_READ_ONLY", "count t"]]);
  await stub.commands.get("q-lint.disconnectProcess")?.();
  stub.picks.push("Run Anyway");
  await live.connectTo("rdb");
  assert.deepStrictEqual(q.queries().slice(1), [
    ["RUN_READ_ONLY", "count t"],
    ["RUN", "count t"],
  ]);
});

test("an error whose text is NO_REVAL's, from a process that has reval, is a q error: reval stays on (#2638)", async (t) => {
  // This process answers the reval check true; the user's code raised the text.
  const { q, live, query } = await setUp(t, ["prod"], (m) => (Array.isArray(m) && m[1].join("\n").includes("no reval") ? NO_REVAL : undefined));
  await live.connectTo("rdb");
  await query(`'"${NO_REVAL}"`);
  await query("count trade");
  assert.deepStrictEqual(q.queries(), [
    ["RUN_READ_ONLY", `'"${NO_REVAL}"`],
    ["RUN_READ_ONLY", "count trade"],
  ]);
  assert.deepStrictEqual(stub.messages.filter(([, text]) => /has no reval/.test(text)), []);
});
