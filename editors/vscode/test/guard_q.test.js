// The read-only guard (#918) on a production-tagged real q process, for the
// forms a bug hunt found it let through: each is declined and changes
// nothing, then let through and seen to change the process - a file in its
// directory, a global - so the guard is shown to hold back a real write.
// Needs a q binary, so it runs only when QLINT_TEST_Q names one, as
// queries_q.test.js does.
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

/// A q process loading `body`, run in a directory of its own, `dir`, with
/// `files` written there first.
async function startQ(t, body, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-guard-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  fs.writeFileSync(path.join(dir, "server.q"), body);
  const port = await freePort();
  const child = spawn(`${Q} server.q -p ${port}`, { shell: true, cwd: dir, stdio: ["ignore", "ignore", "pipe"], detached: true });
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
      return { port, dir };
    }
    await sleep(100);
  }
  stop();
  throw new Error("q did not start listening");
}

/// A Live connected to the q at `port` as the process `prod`, tagged `tags`,
/// with the settings `config`.
async function setUp(t, port, tags = ["prod"], config = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "prod", host: "127.0.0.1", port, tags }]);
  const live = new Live(context);
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  assert.strictEqual(await live.connectTo("prod"), true);
  /// Run `code` as the current line, the question answered `answer`.
  const send = async (code, answer) => {
    vscode.window.activeTextEditor = {
      document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text: code }), getText: () => code },
      selection: { active: { line: 0 }, isEmpty: true },
    };
    stub.messages = [];
    stub.picks.push(answer);
    await stub.commands.get("q-lint.queryCurrentLine")();
    stub.picks = [];
    return stub.messages.some(([kind, text]) => kind === "warning" && /would change/.test(text));
  };
  /// What the read `query` gives, as q shows it. A read the guard's
  /// backstop sends under reval and q refuses there, `system "cd"`, is let
  /// through when asked.
  const read = async (query) => {
    stub.picks.push("Run Anyway");
    try {
      return (await live.runOnActive(query, (c) => c.query([query], [10, 200]))).value.text.join("\n");
    } finally {
      stub.picks = [];
    }
  };
  return { live, send, read };
}

/// Declined, `code` is held and `changed` stays "0b"; let through, q runs
/// it and `changed` is "1b".
async function heldThenWrites(send, read, code, changed) {
  assert.strictEqual(await send(code, undefined), true, `asked about ${code}`);
  assert.strictEqual(await read(changed), "0b", `${code} was held`);
  assert.strictEqual(await send(code, "Run Anyway"), true, `asked again about ${code}`);
  assert.strictEqual(await read(changed), "1b", `${code} writes on q`);
}

test("1: to a file named by a plain symbol is held, and writes the file once let through (#2032)", { skip }, async (t) => {
  const q = await startQ(t, "\n");
  const { send, read } = await setUp(t, q.port);
  for (const [code, file] of [
    ["`a 1: 0x00", "a"],
    ["1:[`b1;0x00]", "b1"],
    [".[1:;(`b2;0x00)]", "b2"],
    ["(`b6) 1: 0x01", "b6"],
  ]) {
    await heldThenWrites(send, read, code, `\`${file} in key \`:.`);
    assert.ok(fs.existsSync(path.join(q.dir, file)), file);
  }
  // A parse format left of 1: reads, unasked.
  assert.strictEqual(await send('(1#"x";1) 1: `:a', undefined), false);
});

/// Declined, `send` is held - it throws, `changed` stays "0b"; let through
/// it runs and `changed` is "1b".
async function sentWhenConfirmed(read, send, changed, what) {
  stub.picks.push(undefined);
  await assert.rejects(send(), /Not run: changing the read-only process prod was not confirmed/, what);
  stub.picks = [];
  assert.strictEqual(await read(changed), "0b", `${what} was held`);
  stub.picks.push("Run Anyway");
  // What it gives back is beside the point: some fail after the write.
  await send().catch(() => undefined);
  stub.picks = [];
  assert.strictEqual(await read(changed), "1b", `${what} writes on q`);
}

test("text a feature values whole is held when a / line in it hides a write from a script's reading (#2033)", { skip }, async (t) => {
  const { guardedText, liveValues } = require("../out/qnbrun.js");
  const { EXPLAIN_AJ, explainGuardCode, findAj } = require("../out/ajexplain.js");
  const { TABLE_SHAPE, shapeGuardCode } = require("../out/joinassist.js");
  const { TEST_RUN, testRunGuardCode } = require("../out/testing.js");
  const { asCode } = require("../out/processtools.js");
  const q = await startQ(t, "t:([] sym:`a`b; time:1 2; px:1 2f)\n");
  const { live, read } = await setUp(t, q.port);
  // A live value in a notebook's Markdown, sent with its cell as notebook.ts sends it.
  const markdown = ["Count: {{q: (1;\n/\nd6:9)}} rows"];
  await sentWhenConfirmed(read, () => live.runOnActive(guardedText("1+1", markdown), (c) => liveValues(c, markdown)), "`d6 in key `.", "a live value");
  // The aj explainer's right table.
  const call = findAj("aj[`sym`time;t;(1;\n/\nj1:9;t)]");
  await sentWhenConfirmed(read, () => live.runOnActive(explainGuardCode(call), (c) => c.call(EXPLAIN_AJ, asCode(call.columns), asCode(call.left), asCode(call.right), 0)), "`j1 in key `.", "an aj explanation");
  // The join assistant's table.
  const tables = ["(1;\n/\nj2:9;t)", "t"];
  await sentWhenConfirmed(read, () => live.runOnActive(shapeGuardCode(tables), (c) => c.call(TABLE_SHAPE, asCode(tables[0]))), "`j2 in key `.", "a table's shape");
  // A k4unit row's code, run by the Test Explorer.
  const rows = ["(1;\n/\nkk:9)"];
  await sentWhenConfirmed(read, () => live.runOnActive(testRunGuardCode(rows), (c) => c.call(TEST_RUN, rows, "run")), "`kk in key `.", "a k4unit row");
});

test("a system command or k's . after a language prefix is held, and runs once let through (#2034)", { skip }, async (t) => {
  const q = await startQ(t, "\n", { "ld.q": "loaded:42\n" });
  fs.mkdirSync(path.join(q.dir, "sub"));
  const { send, read } = await setUp(t, q.port);
  await heldThenWrites(send, read, "k)\\l ld.q", "`loaded in key `.");
  await heldThenWrites(send, read, 'q)k)."i5:1"', "`i5 in key `.");
  await heldThenWrites(send, read, "q)q)\\cd sub", '"sub"~last "/" vs system "cd"');
});

test("a lambda applied inline that writes through its parameter is held, and writes once let through (#2035)", { skip }, async (t) => {
  const q = await startQ(t, "t:([] a:1 2; b:3 4)\n");
  const { send, read } = await setUp(t, q.port);
  await heldThenWrites(send, read, '{value x}"s1:1"', "`s1 in key `.");
  await heldThenWrites(send, read, "{.[x;();:;1]}`u1", "`u1 in key `.");
  await heldThenWrites(send, read, "{update a:9 from x}`t", "9 9~t`a");
  await heldThenWrites(send, read, "{x 1: 0x00}`:u5", "`u5 in key `:.");
  await heldThenWrites(send, read, "{hclose hopen x}`:u4", "`u4 in key `:.");
  await heldThenWrites(send, read, "{.[x;();:;1]} each `v2`v3", "all `v2`v3 in key `.");
});

test("? passed as a value is held, and extends the enumeration once let through (#2036)", { skip }, async (t) => {
  const q = await startQ(t, "sym:`a`b\n");
  const { send, read } = await setUp(t, q.port);
  await heldThenWrites(send, read, "(?)[`sym;`x1]", "`x1 in sym");
  await heldThenWrites(send, read, ".[?;(`sym;`x2)]", "`x2 in sym");
  await heldThenWrites(send, read, "?/[`sym;`x3]", "`x3 in sym");
});

test("a writer named by a cast symbol is held, and writes once let through (#2037)", { skip }, async (t) => {
  const q = await startQ(t, "\n");
  const { send, read } = await setUp(t, q.port);
  await heldThenWrites(send, read, '(`$".q.set") . (`zz1;1)', "`zz1 in key `.");
  await heldThenWrites(send, read, '(`$".q.value") "p8:1"', "`p8 in key `.");
});

test("an amend projection in parentheses applied to its target is held, and amends once let through (#2038)", { skip }, async (t) => {
  const q = await startQ(t, "\n");
  const { send, read } = await setUp(t, q.port);
  await heldThenWrites(send, read, "(.[;();:;1]) `q8", "`q8 in key `.");
  await heldThenWrites(send, read, "(@[;();:;1]) `u8", "`u8 in key `.");
  await heldThenWrites(send, read, "(.[;();:;1]) each `v2`v3", "all `v2`v3 in key `.");
});

test("a gateway query that is a list, projected or built is held, and runs once let through (#2039)", { skip }, async (t) => {
  // A stand-in for TorQ's gateway: it evaluates the query, as its servers do.
  const q = await startQ(t, ".gw.syncexec:{[query;servers] value query}\n");
  const { send, read } = await setUp(t, q.port);
  await heldThenWrites(send, read, ".gw.syncexec[(@;`.;`y2;:;1);`rdb]", "`y2 in key `.");
  await heldThenWrites(send, read, '.gw.syncexec[;`rdb] "y4:1"', "`y4 in key `.");
  await heldThenWrites(send, read, '(.gw.syncexec)["y5:1";`rdb]', "`y5 in key `.");
  await heldThenWrites(send, read, '.gw.syncexec["y6",":1";`rdb]', "`y6 in key `.");
});

test("a process imported as Live Desk is guarded by the guard tag live desk, and written once let through (#2040)", { skip }, async (t) => {
  const { readKxServers } = require("../out/importother.js");
  const { readGuard } = require("../out/guard.js");
  const config = { "processes.readOnlyGuard.tags": ["live desk"] };
  const guard = readGuard((key, fallback) => (key in config ? config[key] : fallback));
  const q = await startQ(t, "\n");
  const kx = readKxServers({ a: { serverAlias: "a", serverName: "127.0.0.1", serverPort: String(q.port) } }, [{ labelName: "Live Desk", connections: ["a"] }], guard.tags);
  const { send, read } = await setUp(t, q.port, kx.processes[0].tags, config);
  await heldThenWrites(send, read, "a1:1", "`a1 in key `.");
});

test("! passed as a value with -11 or -19 is held, and replays or compresses once let through (#2041)", { skip }, async (t) => {
  // A two-message log, and an upd that counts the messages replayed.
  const q = await startQ(t, "n:0; upd:{[t;x] n+::1}; `:lg set (); h:hopen `:lg; h enlist (`upd;`t;1); h enlist (`upd;`t;2); hclose h;\n");
  const { send, read } = await setUp(t, q.port);
  await heldThenWrites(send, read, "(!)[-11;`:lg]", "n=2");
  await heldThenWrites(send, read, ".[!;(-11;`:lg)]", "n=4");
  await heldThenWrites(send, read, "!/[-11;`:lg]", "n=6");
  await heldThenWrites(send, read, ".[!;(-19;(`:lg;`:lgz;17;2;6))]", "`lgz in key `:.");
});

test("a computed handle 0, a lambda a .Q function applies, and a lambda made of a string and applied are held, and write once let through (#2624, #2628, #2635)", { skip }, async (t) => {
  const q = await startQ(t, "\n");
  const { send, read } = await setUp(t, q.port);
  // A handle computed of numbers (#2624).
  await heldThenWrites(send, read, '(1-1)"h1:1"', "`h1 in key `.");
  await heldThenWrites(send, read, 'abs[0]"h2:1"', "`h2 in key `.");
  await heldThenWrites(send, read, '(0 1)[0]"h3:1"', "`h3 in key `.");
  // A lambda .Q.trp, .Q.ts or .Q.sp applies to the data it is given (#2628).
  await heldThenWrites(send, read, '.Q.trp[{value x};"k3:1";::]', "`k3 in key `.");
  await heldThenWrites(send, read, '.Q.ts[{get x};enlist"k10:1"]', "`k10 in key `.");
  await heldThenWrites(send, read, '.Q.sp[{value x};enlist"k4:1"]', "`k4 in key `.");
  // A lambda in a string, made and applied (#2635).
  await heldThenWrites(send, read, '(get"{.[x;();:;1]}")`z3', "`z3 in key `.");
  await heldThenWrites(send, read, '(eval parse"{.[x;();:;1]}")`z4', "`z4 in key `.");
});
