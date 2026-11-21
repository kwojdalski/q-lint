// Queries on saved processes against real q processes, driven through the
// stand-in `vscode` module: the read-only guard (#918), Query a Tag (#906)
// and Compare Query (#907). Needs a q binary, so it runs only when
// QLINT_TEST_Q names one, as qclient.test.js does.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Live } = require("../out/live.js");
const { QueryAcross } = require("../out/queryacross.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// Start a q process loading `body`; resolves once it accepts.
async function startQ(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-queries-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, body);
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  t.after(stop);
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (up) {
      return { port, stop };
    }
    await sleep(100);
  }
  stop();
  throw new Error("q did not start listening");
}

/// A Live over a fresh context holding `processes`, and a fake editor
/// whose one line is `text`.
async function setUp(t, processes, config = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const across = new QueryAcross(context, live);
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  const editor = (text) => {
    vscode.window.activeTextEditor = {
      document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text }), getText: () => text },
      selection: { active: { line: 0 }, isEmpty: true },
    };
  };
  const last = () => {
    const h = live.history()[0];
    return h && `${h.process} ${h.outcome} ${h.code}`;
  };
  return { context, live, across, editor, last };
}

const proc = (label, port, tags = []) => ({ label, host: "127.0.0.1", port, tags });

test("the read-only guard keeps a declined change off a real q process (#918)", { skip }, async (t) => {
  const q = await startQ(t, "trade:([] sym:`a`b; px:1 2f)\n");
  const { live, editor, last } = await setUp(t, [proc("rdb", q.port, ["prod"])]);
  assert.strictEqual(await live.connectTo("rdb"), true);
  editor("delete from `trade where sym=`a");
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(live.history().length, 0);
  editor("count trade");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(last(), "rdb ok count trade");
  const count = async () => (await live.runOnActive("count trade", (c) => c.query(["count trade"], [10, 80]))).value.text[0];
  assert.strictEqual(await count(), "2");
  // Confirmed, it is sent and changes the table.
  editor("delete from `trade where sym=`a");
  stub.picks.push("Run Anyway");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(last(), "rdb ok delete from `trade where sym=`a");
  assert.strictEqual(await count(), "1");
});

test("Query a Tag merges the answers of real q processes, a failure as a row (#906)", { skip }, async (t) => {
  const a = await startQ(t, "trade:([] sym:`a`b; px:1 2f)\n");
  const b = await startQ(t, "trade:([] sym:enlist `c; px:enlist 3f; qty:enlist 7)\n");
  const c = await startQ(t, "trade:42\n");
  const dead = await freePort();
  const { live, across } = await setUp(t, [proc("a", a.port, ["eu"]), proc("b", b.port, ["eu"]), proc("c", c.port, ["eu"]), proc("gone", dead, ["eu"])]);
  await stub.commands.get("q-lint.queryTag")("eu", "trade");
  const { payload } = across.state().tag;
  assert.deepStrictEqual(payload.names, ["process", "sym", "px", "qty", "result", "error"]);
  assert.deepStrictEqual(payload.cells[0], ["a", "a", "b", "c", "gone"]);
  assert.deepStrictEqual(payload.cells[1], ["a", "b", "c", "", ""]);
  assert.deepStrictEqual(payload.raw[2], [1, 2, 3, null, null]);
  assert.deepStrictEqual(payload.cells[3], ["", "", "7", "", ""]);
  assert.deepStrictEqual(payload.cells[4], ["", "", "", "42", ""]);
  assert.notStrictEqual(payload.cells[5][4], "");
  assert.strictEqual(live.activeLabel(), undefined);
  assert.deepStrictEqual(live.history().map((h) => `${h.process} ${h.outcome}`).sort(), ["a ok", "b ok", "c ok", "gone error"]);
  // A q error is a row too.
  await stub.commands.get("q-lint.queryTag")("eu", "1+`x");
  assert.deepStrictEqual(across.state().tag.payload.cells.at(-1).slice(0, 3), ["'type", "'type", "'type"]);
});

test("Compare Query lines up two real q processes' keyed tables by key (#907)", { skip }, async (t) => {
  const a = await startQ(t, "pos:([sym:`a`b`c] qty:1 2 3; px:1.5 2.5 3.5)\n");
  const b = await startQ(t, "pos:([sym:`c`b`d] qty:3 9 4; px:3.5 2.5 4.5)\n");
  const { live, across } = await setUp(t, [proc("a", a.port), proc("b", b.port)]);
  await stub.commands.get("q-lint.compareQuery")("pos", "a", "b");
  const c = across.state().comparison;
  assert.strictEqual(c.matchedBy, "key");
  assert.deepStrictEqual(c.columns, ["sym", "qty", "px"]);
  assert.deepStrictEqual(
    c.rows.map((r) => [r.left?.join(" "), r.right?.join(" "), r.differs.map(Number).join("")]),
    [
      ["a 1 1.5", undefined, "111"],
      ["b 2 2.5", "b 9 2.5", "010"],
      ["c 3 3.5", "c 3 3.5", "000"],
      [undefined, "d 4 4.5", "111"],
    ],
  );
  assert.deepStrictEqual([c.differing, c.onlyLeft, c.onlyRight], [1, 1, 1]);
  assert.strictEqual(live.activeLabel(), undefined);
  // An atom on each side: compared as text.
  await stub.commands.get("q-lint.compareQuery")("sum exec qty from pos", "a", "b");
  assert.deepStrictEqual([across.state().comparison.left.text, across.state().comparison.right.text, across.state().comparison.same], ["6", "16", false]);
});
