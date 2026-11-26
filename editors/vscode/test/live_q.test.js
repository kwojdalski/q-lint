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

test("a process's connect script runs on every connect, before any query (#916)", { skip }, async (t) => {
  const q = await startQ("connects:0\nslow:{system \"sleep \",string x; x}\n");
  t.after(() => q.stop());
  const script = path.join(q.dir, "init.q");
  fs.writeFileSync(script, "/ a comment\nfromFile:`yes\nf:{[a]\n  a*2}\n");
  const vscode = require("vscode");
  const workspaceFs = vscode.workspace.fs;
  vscode.workspace.fs = { readFile: async (uri) => fs.promises.readFile(uri.fsPath) };
  t.after(() => (vscode.workspace.fs = workspaceFs));
  const { live, editor, last } = await setUp(t, [
    proc("code", q.port, { init: "connects+:1; .lib.v:42" }),
    proc("file", q.port, { initFile: script }),
    proc("bad", q.port, { init: "1+`a" }),
    proc("missing", q.port, { initFile: path.join(q.dir, "nope.q") }),
  ]);
  const query = async (code) => {
    editor(code);
    await stub.commands.get("q-lint.queryCurrentLine")();
    return last();
  };
  assert.strictEqual(await live.connectTo("code"), true);
  assert.strictEqual(await query("(connects;.lib.v)"), "ok (connects;.lib.v)");
  assert.strictEqual(await query("if[not connects=1;'wrong]"), "ok if[not connects=1;'wrong]");
  // Again on reconnecting: the abort's reconnect runs it too.
  editor("slow 1");
  const running = stub.commands.get("q-lint.queryCurrentLine")();
  await sleep(200);
  await stub.commands.get("q-lint.abortQuery")();
  await running;
  for (let i = 0; i < 50 && live.activeLabel() === undefined; i++) await sleep(100);
  assert.strictEqual(live.activeLabel(), "code");
  assert.strictEqual(await query("if[not connects=2;'wrong]"), "ok if[not connects=2;'wrong]");
  // A file, read at connect.
  assert.strictEqual(await live.connectTo("file"), true);
  assert.strictEqual(await query("(fromFile;f 21)~(`yes;42)"), "ok (fromFile;f 21)~(`yes;42)");
  // A script that fails is said, and the connection kept.
  stub.messages = [];
  assert.strictEqual(await live.connectTo("bad"), true);
  assert.deepStrictEqual(stub.messages.filter(([k]) => k === "warning").map(([, m]) => m), ["q-lint: the connect script of bad failed: 'type"]);
  assert.strictEqual(live.activeLabel(), "bad");
  stub.messages = [];
  assert.strictEqual(await live.connectTo("missing"), true);
  assert.match(stub.messages.find(([k]) => k === "warning")[1], /^q-lint: the connect script of missing failed: could not read .*nope\.q/);
});

test("the heartbeat times a real process, and a process that restarts is reconnected to (#917)", { skip }, async (t) => {
  const body = "started:.z.p\n";
  let q = await startQ(body);
  const port = q.port;
  t.after(() => q.stop());
  const { live, editor, last } = await setUp(t, [proc("q", port, { init: "inited:1b" })]);
  stub.config.user["connection.heartbeat.enable"] = true;
  stub.config.user["connection.heartbeatInterval"] = 1;
  stub.config.user["connection.autoReconnect.enable"] = true;
  assert.strictEqual(await live.connectTo("q"), true);
  for (let i = 0; i < 100 && live.latency === undefined; i++) await sleep(20);
  assert.match(live.status.text, /^\$\(plug\) q: q \$\(pulse\) \d+ ms$/);
  // The heartbeat defines nothing on the process.
  editor("key[`.] except `started`inited");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(last(), "ok key[`.] except `started`inited");
  q.stop();
  for (let i = 0; i < 100 && live.activeLabel() !== undefined; i++) await sleep(20);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.match(live.status.text, /reconnecting to q \(\d of 5\)/);
  q = await startQ(body, port);
  for (let i = 0; i < 200 && live.activeLabel() === undefined; i++) await sleep(50);
  assert.strictEqual(live.activeLabel(), "q");
  // The connect script ran again on the new process.
  editor("if[not inited;'no]");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(last(), "ok if[not inited;'no]");
  for (let i = 0; i < 100 && live.latency === undefined; i++) await sleep(20);
  assert.ok(live.latency !== undefined, "the heartbeat restarted");
});

test("Run Current Statement, Line and Selection run in the context the file's \\d left above them (#2911)", { skip }, async (t) => {
  const q = await startQ(".ns.v:42\n");
  t.after(() => q.stop());
  const { live, last } = await setUp(t, [proc("q", q.port), proc("prod", q.port, { tags: ["prod"] })]);
  const vscode = require("vscode");
  const lines = ["\\d .ns", "f:{x+1}", "g:{", "  x+2}", "h:3", "v", "\\d .", "k:4", "(1_key `.ns;`f`g`h`k inter key `.)"];
  const answers = [];
  live.onDidAnswer((a) => answers.push(a.answer.ok ? a.answer.text.join(" ") : `'${a.answer.error}`));
  /// The cursor on `line`, or lines `line` to `to` selected.
  const at = (line, to) => {
    const selection = to === undefined ? { active: { line }, isEmpty: true } : { active: { line: to }, isEmpty: false, start: { line, character: 0 }, end: { line: to, character: lines[to].length } };
    vscode.window.activeTextEditor = {
      document: { uri: vscode.Uri.file("/w/a.q"), version: 1, lineAt: (n) => ({ text: lines[n] }), getText: (sel) => (sel ? lines.slice(sel.start.line, sel.end.line + 1).join("\n") : lines.join("\n")) },
      selection,
    };
  };
  assert.strictEqual(await live.connectTo("q"), true);
  at(1);
  await stub.commands.get("q-lint.queryCurrentLine")();
  // Kept with its \d, so Run Query Again runs it there too.
  assert.strictEqual(last(), "ok \\d .ns\nf:{x+1}");
  // The statement starts a line above the cursor: read from there.
  at(3);
  await stub.commands.get("q-lint.queryBlock")();
  at(4, 4);
  await stub.commands.get("q-lint.querySelection")();
  // Below the \d . the file is in the root again.
  at(7);
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(last(), "ok k:4");
  at(8);
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(answers.at(-1), "`v`f`g`h ,`k");
  // The guard reads the code, not the \d put before it: a read is not asked about.
  assert.strictEqual(await live.connectTo("prod"), true);
  stub.messages = [];
  at(5);
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(answers.at(-1), "42");
  assert.deepStrictEqual(stub.messages.filter(([kind]) => kind === "warning"), []);
});
