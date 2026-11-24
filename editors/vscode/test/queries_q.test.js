// Queries on saved processes against real q processes, driven through the
// stand-in `vscode` module: the read-only guard (#918), Query a Tag (#906),
// Compare Query (#907), saved queries (#912) and Watch Query (#914). Needs
// a q binary, so it runs only when QLINT_TEST_Q names one, as
// qclient.test.js does.
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
const { SavedQueries } = require("../out/savedqueriesview.js");

// What the stand-in leaves as a no-op: a saved query's document's URI.
vscode.Uri.from = ({ scheme, path }) => ({ scheme, path, toString: () => `${scheme}:${path}` });

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
  // The workspace's storage, in memory.
  const state = new Map();
  context.workspaceState = { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => void state.set(k, v), keys: () => [...state.keys()] };
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const across = new QueryAcross(context, live);
  const saved = new SavedQueries(context, live);
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
  return { context, live, across, saved, editor, last };
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

test("Compare Query compares two real q processes' values, not the digits they write, and their types (#1963)", { skip }, async (t) => {
  const fx = (px, n, far, more) => `fx:([] sym:\`eurusd\`gbpusd; px:${px} 1.5; n:${n}; l:(1 ${far};\`x))\n${more}`;
  const a = await startQ(t, fx("1.23456781", "1 2", "100.00000001", ""));
  const b = await startQ(t, fx("1.23456789", "1 2f", "100.00000002", ""));
  // As a, writing ten digits where a writes seven.
  const wide = await startQ(t, fx("1.23456781", "1 2", "100.00000001", "\\P 10\n"));
  const { across } = await setUp(t, [proc("a", a.port), proc("b", b.port), proc("wide", wide.port)]);
  const compare = async (code, left, right) => {
    await stub.commands.get("q-lint.compareQuery")(code, left, right);
    return across.state().comparison;
  };
  // Both write 1.234568: the cells differ, and are shown in full.
  const px = await compare("select sym, px from fx", "a", "b");
  assert.deepStrictEqual([px.same, px.differing], [false, 1]);
  assert.deepStrictEqual(px.rows.map((r) => [r.left.join(" "), r.right.join(" "), r.differs.map(Number).join("")]), [["eurusd 1.23456781f", "eurusd 1.23456789f", "01"], ["gbpusd 1.5", "gbpusd 1.5", "00"]]);
  // A long and a float of the same numbers.
  const n = await compare("select n from fx", "a", "b");
  assert.deepStrictEqual([n.same, n.differing, n.retyped], [false, 0, [{ column: "n", left: "long (j)", right: "float (f)" }]]);
  // A float inside a general list's item.
  const l = await compare("select l from fx", "a", "b");
  assert.deepStrictEqual([l.same, l.differing, l.rows[0].left, l.rows[0].right], [false, 1, ["1 100.00000001"], ["1 100.00000002"]]);
  // The same values written to different digits are the same.
  const same = await compare("fx", "a", "wide");
  assert.deepStrictEqual([same.rows[0].left[1], same.rows[0].right[1], same.same, same.differing], ["1.234568", "1.23456781", true, 0]);
  // An atom is its console text: the same to the digits written, and said so; in a list it is its value.
  const atom = await compare("first exec px from fx", "a", "b");
  assert.deepStrictEqual([atom.left.text, atom.right.text, atom.same, atom.digits], ["1.234568", "1.234568", true, true]);
  assert.strictEqual((await compare("enlist first exec px from fx", "a", "b")).same, false);
  assert.deepStrictEqual([(await compare("count fx", "a", "b")).same, across.state().comparison.digits], [true, false]);
});

test("Compare Query does not call a keyed and an unkeyed table of two real q processes the same (#2008)", { skip }, async (t) => {
  const a = await startQ(t, "one:([k:1 2] v:10 20)\ntwo:([k:`a`b;j:1 2] v:10 20)\nd:`a`b!1 2\n");
  const b = await startQ(t, "one:([] k:1 2; v:10 20)\ntwo:([k:`a`b] j:1 2;v:10 20)\nd:flip `key`value!(`a`b;1 2)\n");
  const { across } = await setUp(t, [proc("a", a.port), proc("b", b.port)]);
  const compare = async (code) => {
    await stub.commands.get("q-lint.compareQuery")(code, "a", "b");
    const c = across.state().comparison;
    return [c.same, c.differing, c.rekeyed];
  };
  assert.deepStrictEqual(await compare("one"), [false, 0, { left: ["k"], right: [] }]);
  assert.deepStrictEqual(await compare("two"), [false, 0, { left: ["k", "j"], right: ["k"] }]);
  // A dictionary, which the grid draws keyed by `key`, and a table of those columns.
  assert.deepStrictEqual(await compare("d"), [false, 0, { left: ["key"], right: [] }]);
  // Keyed alike on both, or on neither.
  assert.deepStrictEqual([await compare("0!one"), await compare("1!0!one"), await compare("2!0!two")], [[true, 0, undefined], [true, 0, undefined], [true, 0, undefined]]);
});

test("Compare Query compares each of two columns of one name on two real q processes (#1964)", { skip }, async (t) => {
  const a = await startQ(t, "d:3 4\n");
  const b = await startQ(t, "d:9 9\n");
  const { across } = await setUp(t, [proc("a", a.port), proc("b", b.port)]);
  await stub.commands.get("q-lint.compareQuery")("flip `a`a!(1 2;d)", "a", "b");
  const c = across.state().comparison;
  assert.deepStrictEqual([c.columns, c.same, c.differing], [["a", "a"], false, 2]);
  assert.deepStrictEqual(c.rows.map((r) => [r.left.join(" "), r.right.join(" "), r.differs.map(Number).join("")]), [["1 3", "1 9", "01"], ["2 4", "2 9", "01"]]);
  await stub.commands.get("q-lint.compareQuery")("flip `a`a!(1 2;1+1 2)", "a", "b");
  assert.strictEqual(across.state().comparison.same, true);
});

test("a saved query runs on a real q process, its placeholder asked for (#912)", { skip }, async (t) => {
  const q = await startQ(t, "trade:([] sym:`a`b`a; px:1 2 3f)\n");
  const { live, saved, editor, last } = await setUp(t, [proc("rdb", q.port)]);
  editor("exec sum px from trade where sym={{s}}");
  stub.inputs.push("by sym");
  await stub.commands.get("q-lint.saveQuery")();
  assert.deepStrictEqual(saved.queries(), [{ name: "by sym", code: "exec sum px from trade where sym={{s}}" }]);
  assert.strictEqual(await live.connectTo("rdb"), true);
  stub.inputs.push("`a");
  await stub.commands.get("q-lint.runSavedQuery")("by sym");
  assert.strictEqual(last(), "rdb ok exec sum px from trade where sym=`a");
  const value = await live.runOnActive("x", (c) => c.query(["exec sum px from trade where sym=`a"], [10, 80]));
  assert.strictEqual(value.value.text[0], "4f");
});

test("Watch Query re-runs a query on a real q process until it is disconnected (#914)", { skip }, async (t) => {
  const q = await startQ(t, "n:0\n.z.ts:{n+:1}\n\\t 100\n");
  const { live } = await setUp(t, [proc("rdb", q.port)], { "query.watch.enable": true });
  assert.strictEqual(await live.connectTo("rdb"), true);
  await stub.commands.get("q-lint.watchQuery")("n", 1);
  await sleep(2400);
  const watching = live.api().watching();
  assert.ok(watching.runs >= 3, `ran ${watching.runs} times`);
  assert.deepStrictEqual(live.history().map((h) => `${h.outcome} ${h.code}`), ["ok n"]);
  // The process goes away: the watch stops.
  q.stop();
  for (let i = 0; i < 100 && live.api().watching() !== undefined; i++) await sleep(50);
  assert.strictEqual(live.api().watching(), undefined);
});
