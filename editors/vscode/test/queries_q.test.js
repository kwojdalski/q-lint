// Queries on saved processes against real q processes, driven through the
// stand-in `vscode` module: the read-only guard (#918). Needs a q binary,
// so it runs only when QLINT_TEST_Q names one, as qclient.test.js does.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Live } = require("../out/live.js");

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
  return { context, live, editor, last };
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
