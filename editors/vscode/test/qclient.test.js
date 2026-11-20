// A real q process, driven over IPC the way a query from the editor drives
// it (#853). Needs a q binary, so it runs only when QLINT_TEST_Q names one
// (a command line, run by the shell: `QLINT_TEST_Q="QHOME=~/.kx/q ~/.kx/bin/q"`)
// and is skipped otherwise - CI has no q.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 80];

const SERVER = `
t:([] sym:\`a\`b\`c; px:1.5 2.5 3.5)
slow:{system "sleep ",string x; x}
.z.pw:{[u;p] not u~\`locked}
`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// Start a q process listening on a free port; resolves once it accepts.
async function startQ() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-qclient-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, SERVER);
  const port = await freePort();
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
        // The process may have exited already: one test makes it.
        stop: () => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        },
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.kill(-child.pid, "SIGKILL");
  throw new Error("q did not start listening");
}

test("queries, blocks, errors, abort and close against a real q process", { skip }, async (t) => {
  const q = await startQ();
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });

  await t.test("a line", async () => {
    assert.deepStrictEqual(await connection.query(["1+1"], SIZE), { ok: true, type: -7, text: ["2"] });
  });

  await t.test("a table, formatted by the process", async () => {
    const answer = await connection.query(["t"], SIZE);
    assert.strictEqual(answer.type, 98);
    assert.deepStrictEqual(answer.text.map((l) => l.trimEnd()), ["sym px", "-------", "a   1.5", "b   2.5", "c   3.5"]);
  });

  await t.test("a block runs as a script would, and keeps its globals", async () => {
    const code = "a:1\nf:{[x]\n  x+a}\n/ a comment\nf 10";
    assert.deepStrictEqual(await connection.query(statements(code), SIZE), { ok: true, type: -7, text: ["11"] });
    assert.deepStrictEqual((await connection.query(["a"], SIZE)).text, ["1"]);
  });

  await t.test("an error comes back with its message, and a trace of the user's code only", async () => {
    const answer = await connection.query(["g:{x+`a}", "g 1"], SIZE);
    assert.strictEqual(answer.ok, false);
    assert.strictEqual(answer.error, "type");
    assert.match(answer.trace, /\{x\+`a\}/);
    assert.doesNotMatch(answer.trace, /\.Q\.trp|value each/);
  });

  await t.test("statements after an error do not run", async () => {
    const answer = await connection.query(["b:1", "1+`a", "b:2"], SIZE);
    assert.strictEqual(answer.ok, false);
    assert.deepStrictEqual((await connection.query(["b"], SIZE)).text, ["1"]);
  });

  await t.test("a system command, and the context it sets stays", async () => {
    await connection.query(statements("\\d .ns\nzz:42\n\\d ."), SIZE);
    assert.deepStrictEqual((await connection.query([".ns.zz"], SIZE)).text, ["42"]);
  });

  await t.test("a result larger than the console is cut by the process", async () => {
    const answer = await connection.query(["til 100000"], SIZE);
    assert.strictEqual(answer.text.length, 1);
    assert.ok(answer.text[0].length <= SIZE[1], answer.text[0]);
    assert.ok(answer.text[0].endsWith(".."));
  });

  await t.test("an assignment ending in ; answers ::", async () => {
    const answer = await connection.query(["c:5;"], SIZE);
    assert.strictEqual(answer.type, 101);
    // kdb+ formats it as "::", PeachQ as nothing.
    assert.ok(["::", ""].includes(answer.text.join("")), JSON.stringify(answer.text));
  });

  await t.test("a second query while one runs is refused", async () => {
    const running = connection.query(["slow 1"], SIZE);
    await assert.rejects(connection.query(["1"], SIZE), /already running/);
    assert.deepStrictEqual((await running).text, ["1"]);
  });

  await t.test("abort stops waiting at once, and the connection is closed", async () => {
    const started = Date.now();
    const running = connection.query(["slow 5"], SIZE);
    setTimeout(() => connection.abort(), 200);
    await assert.rejects(running, /closed before the process answered/);
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
    assert.strictEqual(connection.isOpen, false);
    await assert.rejects(connection.query(["1"], SIZE), /closed/);
  });

  await t.test("a new connection works after an abort, once the process is free", async () => {
    // q runs one message at a time: the aborted query still runs, and a new
    // connection's handshake waits for it to finish.
    const again = await QConnection.open({ host: "127.0.0.1", port: q.port });
    assert.deepStrictEqual((await again.query(["1+2"], SIZE)).text, ["3"]);
    await again.close();
    assert.strictEqual(again.isOpen, false);
  });

  await t.test("a refused user is told so", async () => {
    await assert.rejects(QConnection.open({ host: "127.0.0.1", port: q.port, user: "locked", password: "x" }), /refused/);
  });

  await t.test("the process exiting closes the connection, and whoever waits hears it", async () => {
    const other = await QConnection.open({ host: "127.0.0.1", port: q.port });
    const heard = new Promise((resolve) => other.whenClosed(resolve));
    await assert.rejects(other.query(["exit 0"], SIZE), /closed/);
    await heard;
    assert.strictEqual(other.isOpen, false);
  });
});

test("connecting to a port nobody listens on fails with why", { skip }, async () => {
  const port = await freePort();
  await assert.rejects(QConnection.open({ host: "127.0.0.1", port }), /ECONNREFUSED/);
});

test("a connect that gets no answer gives up", { skip }, async () => {
  // A socket that accepts and never answers the handshake.
  const silent = net.createServer(() => {}).listen(0, "127.0.0.1");
  await new Promise((r) => silent.once("listening", r));
  const started = Date.now();
  await assert.rejects(QConnection.open({ host: "127.0.0.1", port: silent.address().port }, 300), /no answer/);
  assert.ok(Date.now() - started < 1500);
  silent.close();
});
