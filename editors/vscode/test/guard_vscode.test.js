// The read-only guard (#918) on each path that sends code to a process,
// through the stand-in `vscode` (vscode_stub.js) and a q process played by
// a socket server: a query, a notebook cell or a run with parameters (both
// through `runOnActive`), an agent's query (refused, never asked) and a
// connect script. Redefine on Process is in insightview.test.js, the agent
// tool's own path in agenttool.test.js, and Query a Tag, Compare, saved and
// watched queries in their own tests. No q and no editor needed.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");
const { Live } = require("../out/live.js");

/// A q process played by a socket server: every message is kept, decoded,
/// in `sent`, and answered as `RUN` answers.
async function fakeQ() {
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
        sent.push(deserialize(message));
        const out = serialize({ ok: true, type: -7, text: ["1"] });
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    /// The statements each query sent.
    queries: () => sent.filter((m) => Array.isArray(m) && Array.isArray(m[1])).map((m) => m[1].join("\n")),
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

async function setUp(t, tags, config = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const q = await fakeQ();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "127.0.0.1", port: q.port, tags }]);
  const live = new Live(context);
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  const editor = (text) => {
    vscode.window.activeTextEditor = {
      document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text }), getText: () => text },
      selection: { active: { line: 0 }, isEmpty: true },
    };
  };
  return { q, live, context, editor };
}

const asked = () => stub.messages.filter(([kind, text]) => kind === "warning" && /would change/.test(text)).map(([, text]) => text);

test("a query that would change a guarded process asks first; declined, nothing is sent", async (t) => {
  const { q, live, editor } = await setUp(t, ["prod"]);
  assert.strictEqual(await live.connectTo("rdb"), true);
  editor("trade:([] a:1 2)");
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.deepStrictEqual(asked(), ["This code would change rdb. Run it anyway?"]);
  assert.deepStrictEqual(q.queries(), []);
  assert.strictEqual(live.history().length, 0);
  // Confirmed, it runs.
  stub.picks.push("Run Anyway");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.deepStrictEqual(q.queries(), ["trade:([] a:1 2)"]);
  // Code that only reads is sent unasked.
  stub.messages = [];
  editor("select from trade");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.deepStrictEqual(asked(), []);
  assert.deepStrictEqual(q.queries().at(-1), "select from trade");
  // Rerun from the history goes through the same check.
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.rerunQuery")(live.history().find((e) => e.code.startsWith("trade:")));
  assert.strictEqual(q.queries().length, 2);
  assert.strictEqual(asked().length, 1);
});

test("a process with no guarded tag, the guard off, or the tag taken off the list is not asked about", async (t) => {
  const { q, live, editor } = await setUp(t, ["dev"]);
  await live.connectTo("rdb");
  editor("a:1");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.deepStrictEqual(asked(), []);
  assert.deepStrictEqual(q.queries(), ["a:1"]);
});

test("the guard's settings take effect without a reload", async (t) => {
  const { q, live, editor } = await setUp(t, ["live"], { "processes.readOnlyGuard.tags": ["live"] });
  await live.connectTo("rdb");
  editor("a:1");
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(asked().length, 1);
  assert.deepStrictEqual(q.queries(), []);
  stub.config.user["processes.readOnlyGuard.enable"] = false;
  stub.changeConfig("q-lint.processes.readOnlyGuard.enable");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(asked().length, 1);
  assert.deepStrictEqual(q.queries(), ["a:1"]);
});

test("a notebook cell, or a cell of a run with parameters, asks through runOnActive; declined, it throws why", async (t) => {
  const { q, live } = await setUp(t, ["prod"]);
  await live.connectTo("rdb");
  let ran = 0;
  const use = async (connection) => (ran++, connection.query(["a:1"], [10, 10]));
  stub.picks.push(undefined);
  await assert.rejects(live.runOnActive("a:1", use), /Not run: changing the read-only process rdb was not confirmed\./);
  assert.strictEqual(ran, 0);
  assert.deepStrictEqual(q.queries(), []);
  stub.picks.push("Run Anyway");
  assert.strictEqual((await live.runOnActive("a:1", use)).process, "rdb");
  assert.strictEqual(ran, 1);
  // Reading code is not asked about.
  stub.messages = [];
  await live.runOnActive("select from t", async () => 1);
  assert.deepStrictEqual(asked(), []);
});

test("a caller that cannot ask - an agent - is refused outright, and nothing is sent", async (t) => {
  const { q, live } = await setUp(t, ["prod"]);
  await live.connectTo("rdb");
  let ran = 0;
  await assert.rejects(
    live.runOnActive("`t upsert 1", async () => ran++, "refuse"),
    /^Error: Nothing was run: rdb is read-only guarded \(tagged prod; q-lint.processes.readOnlyGuard.tags\), and the query calls upsert\./,
  );
  assert.strictEqual(ran, 0);
  assert.deepStrictEqual(asked(), []);
  assert.deepStrictEqual(q.queries(), []);
  assert.match(live.guardRefuses("a:1", [{ label: "rdb", tags: ["prod"] }]), /^Nothing was run/);
  assert.strictEqual(live.guardRefuses("select from t", [{ label: "rdb", tags: ["prod"] }]), undefined);
});

test("a connect script that would change a guarded process asks at each connect; declined, it is skipped and the connection kept", async (t) => {
  const { q, live, context } = await setUp(t, ["prod"]);
  const [process] = context.globalState.get("q-lint.processes");
  await context.globalState.update("q-lint.processes", [{ ...process, init: "helper:{x+1}" }]);
  stub.picks.push(undefined);
  assert.strictEqual(await live.connectTo("rdb"), true);
  assert.deepStrictEqual(asked(), ["The connect script of rdb: This code would change rdb. Run it anyway?"]);
  assert.deepStrictEqual(q.queries(), []);
  assert.strictEqual(live.activeLabel(), "rdb");
  await stub.commands.get("q-lint.disconnectProcess")();
  stub.picks.push("Run Anyway");
  assert.strictEqual(await live.connectTo("rdb"), true);
  assert.deepStrictEqual(q.queries(), ["helper:{x+1}"]);
});
