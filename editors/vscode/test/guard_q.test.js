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

/// A Live connected to the q at `port` as the process `prod`, tagged prod.
async function setUp(t, port) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", [{ label: "prod", host: "127.0.0.1", port, tags: ["prod"] }]);
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
  /// What the read `query` gives, as q shows it.
  const read = async (query) => (await live.runOnActive(query, (c) => c.query([query], [10, 200]))).value.text.join("\n");
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
