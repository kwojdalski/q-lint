// The live half's queries and connections against a real q process: query
// placeholders (#911), the connect script (#916), and the heartbeat and
// auto-reconnect (#917), driven through the stand-in `vscode` module. Needs
// a q binary, so it runs only when QLINT_TEST_Q names one, as
// qclient.test.js does.
const { stub } = require("./vscode_stub.js");
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

/// Start a q process loading `body` on `port` (a free one by default);
/// resolves once it accepts.
async function startQ(body, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-liveq-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, body);
  port ??= await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (up) {
      return {
        port,
        dir,
        stop: () => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        },
      };
    }
    await sleep(100);
  }
  process.kill(-child.pid, "SIGKILL");
  throw new Error("q did not start listening");
}

/// A Live over a fresh context holding `processes`, its last history entry
/// as text, and a fake editor whose one line is `text`.
async function setUp(t, processes) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const vscode = require("vscode");
  const editor = (text) => {
    vscode.window.activeTextEditor = {
      document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text }), getText: () => text },
      selection: { active: { line: 0 }, isEmpty: true },
    };
  };
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  const last = () => {
    const h = live.history()[0];
    return h && `${h.outcome} ${h.code}${h.error ? ` '${h.error}` : ""}`;
  };
  return { context, live, editor, last };
}

const proc = (label, port, extra = {}) => ({ label, host: "127.0.0.1", port, tags: [], ...extra });

test("placeholders are filled in before a query reaches q (#911)", { skip }, async (t) => {
  const q = await startQ("t:([] sym:`a`b`a; n:1 2 3)\n");
  t.after(() => q.stop());
  const { live, editor, last } = await setUp(t, [proc("q", q.port)]);
  assert.strictEqual(await live.connectTo("q"), true);
  editor('(exec sum n from t where sym={{s}}, n>={{lo}}; "{{s}}")');
  stub.inputs.push("`a", "2");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(last(), 'ok (exec sum n from t where sym=`a, n>=2; "{{s}}")');
  assert.deepStrictEqual(live.history()[0].outcome, "ok");
  // The value is q's to read: a wrong one is q's error.
  stub.inputs.push("`a", "`oops");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.match(last(), /^error .* n>=`oops; .* 'type$/);
});
