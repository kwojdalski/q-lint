// Asynchronous queries (#1037): the answer message read, the commands
// through the stand-in `vscode` module, on and off, and - when QLINT_TEST_Q
// names a q - a query sent async while the connection stays free, its
// table, value and error arriving, and a write to a guarded process held.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { serialize } = require("node-q/lib/c.js");
const pkg = require("../package.json");
const { Live } = require("../out/live.js");
const { ADMIN_COMMANDS, adminOff, readAdmin } = require("../out/admin.js");
const { ASYNC, ASYNC_TAG, readAsyncMessage, textPayload } = require("../out/asyncquery.js");
const { AsyncQueries } = require("../out/asyncqueryview.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the lambda sends its answer back tagged; only such a message is read", () => {
  assert.match(ASYNC, /^\{\[id;s;size;limit\] neg\[\.z\.w\]\(`qlintAsync;id;\{\[s;size;limit\]/);
  const ok = serialize([ASYNC_TAG, 7, { ok: true, type: -7, text: ["2"] }]);
  assert.deepStrictEqual(readAsyncMessage(ok), { id: 7, answer: { ok: true, type: -7, text: ["2"] } });
  assert.strictEqual(readAsyncMessage(serialize(["qlint", "view", {}])), undefined);
  assert.strictEqual(readAsyncMessage(serialize([ASYNC_TAG, "x", {}])), undefined);
  assert.strictEqual(readAsyncMessage(Buffer.from([1, 0, 0, 0, 9, 0, 0, 0, 99])), undefined);
  assert.deepStrictEqual(textPayload(["a", "b"]).cells, [["a", "b"]]);
});

test("the switch: on by default, contributed, commands hidden while off", () => {
  assert.strictEqual(readAdmin((_k, f) => f).asyncQuery, true);
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process admin");
  assert.strictEqual(section.properties["q-lint.query.async.enable"].default, true);
  for (const id of [ADMIN_COMMANDS.runAsync, ADMIN_COMMANDS.pendingAsync]) {
    assert.ok(pkg.contributes.commands.some((c) => c.command === id && c.category === "q-lint"));
    const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === id);
    assert.ok(menus.length > 0);
    for (const m of menus) assert.match(m.when, /config\.q-lint\.query\.async\.enable/);
  }
});

async function setUp(t, processes) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const shown = [];
  live.showGrid = (label, code, payload) => shown.push({ label, code, count: payload.count, cells: payload.cells });
  const queries = new AsyncQueries(context, live);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, queries, shown };
}

test("turned off, Run Query Asynchronously refuses and sends nothing; on again without a reload", async (t) => {
  const { live, queries } = await setUp(t, []);
  let asked = 0;
  live.runOnActive = async () => (asked++, undefined);
  stub.config.user["query.async.enable"] = false;
  stub.changeConfig("q-lint.query.async.enable");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.runAsync)("1+1"), undefined);
  await stub.commands.get(ADMIN_COMMANDS.pendingAsync)();
  assert.deepStrictEqual(stub.messages, [["info", adminOff("asyncQuery")], ["info", adminOff("asyncQuery")]]);
  assert.strictEqual(asked, 0);
  stub.config.user["query.async.enable"] = true;
  stub.changeConfig("q-lint.query.async.enable");
  await queries.run("1+1");
  assert.strictEqual(asked, 1);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-async-"));
  fs.writeFileSync(path.join(dir, "server.q"), "busy:{t:.z.p;while[.z.p<t+x*0D00:00:01;];([] a:til 3; b:`x`y`z)}\n");
  const child = spawn(`${Q} ${path.join(dir, "server.q")} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (up) return { stop };
    await sleep(100);
  }
  stop();
  throw new Error("q did not start listening");
}

const until = async (f) => {
  for (let i = 0; i < 100 && !f(); i++) await sleep(50);
};

test("a query sent async leaves the connection free; its table, value and error arrive (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const { live, queries, shown } = await setUp(t, [{ label: "a", host: "127.0.0.1", port, tags: [] }]);
  assert.strictEqual(await live.connectTo("a"), true);
  const sentAt = Date.now();
  assert.strictEqual(typeof (await queries.run("busy 1")), "number");
  assert.ok(Date.now() - sentAt < 500, "the command does not wait for the query");
  assert.strictEqual(live.isBusy(), false);
  assert.deepStrictEqual(queries.state().pending, [{ process: "a", code: "busy 1" }]);
  await until(() => queries.state().arrived.length === 1);
  assert.deepStrictEqual(queries.state().arrived, [{ process: "a", code: "busy 1", ok: true, rows: 3 }]);
  assert.deepStrictEqual(shown[0].cells[1], ["x", "y", "z"]);
  assert.deepStrictEqual(queries.state().pending, []);
  // A value that is not a table, and an error.
  await queries.run("1+1");
  await queries.run("'boom");
  await until(() => queries.state().arrived.length === 3);
  assert.deepStrictEqual(shown[1].cells, [["2"]]);
  assert.strictEqual(queries.state().arrived[2].ok, false);
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && text.endsWith("failed: 'boom")));
  assert.deepStrictEqual(live.history().map((e) => [e.code, e.outcome]), [["'boom", "error"], ["1+1", "ok"], ["busy 1", "ok"]]);
});

test("a write sent async to a guarded process is held for confirmation, and not sent when declined (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const { live, queries } = await setUp(t, [{ label: "p", host: "127.0.0.1", port, tags: ["prod"] }]);
  assert.strictEqual(await live.connectTo("p"), true);
  stub.picks.push(undefined);
  assert.strictEqual(await queries.run("x:1"), undefined);
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && /would change p/.test(text)), JSON.stringify(stub.messages));
  assert.deepStrictEqual(queries.state().pending, []);
  await sleep(200);
  const read = await live.runOnActive("@[value;`x;`none]", (c) => c.query(["@[value;`x;`none]"], [25, 80]));
  assert.deepStrictEqual(read.value.text, ["`none"]);
});
