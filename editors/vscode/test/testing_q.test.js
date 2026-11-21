// The Test Explorer's runner against a real q process (#939): a test sent
// under its \d, judged, and the process's own \d put back. Needs a q binary,
// so it runs only when QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { TEST_RUN, testStatements, readTestResult, failureText, parseK4unit, isK4Test, k4Mode, k4Statement } = require("../out/testing.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-testing-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source.replaceAll("$DIR", dir));
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true, cwd: dir });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
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
  throw new Error(`q did not start listening: ${stderr}`);
}

async function connect(t, source) {
  const q = await startQ(source);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  return connection;
}

const run = async (c, statements, mode = "test") => readTestResult(await c.call(TEST_RUN, statements, mode));

test("a function test runs under its \\d, passes or fails, and leaves the process at the root", { skip }, async (t) => {
  const c = await connect(t, "\\d .qt.m\nhelper:{x+1}\n\\d .\n");
  const good = { code: "\\d .qt.m\ntest_add:{[]\n  2~helper 1}\n\\d .", call: ".qt.m.test_add[]" };
  assert.deepStrictEqual(await run(c, testStatements(good)), { passed: true, text: "1b", errored: false });
  // Defined where the file defines it, and callable again by its name.
  assert.deepStrictEqual(await run(c, [".qt.m.test_add[]"]), { passed: true, text: "1b", errored: false });
  const signals = await run(c, testStatements({ code: "\\d .qt.m\ntest_bad:{[] '\"boom\"}\n\\d .", call: ".qt.m.test_bad[]" }));
  assert.deepStrictEqual(signals, { passed: false, text: "boom", errored: true });
  assert.strictEqual(failureText(signals, "test"), "'boom");
  // Left in .qt.m by the failed test's `\\d`, it is put back at the root.
  assert.strictEqual((await c.evaluate("system \"d\"")).value, ".");
  // False, or a boolean list with a false in it, fails; other answers pass.
  assert.strictEqual((await run(c, ["test_f:{[] 0b}", "test_f[]"])).passed, false);
  assert.strictEqual((await run(c, ["test_l:{[] 110b}", "test_l[]"])).passed, false);
  assert.strictEqual((await run(c, ["test_t:{[] `done}", "test_t[]"])).passed, true);
  // A one-statement test, with a one-character statement.
  assert.strictEqual((await run(c, ["1"])).passed, true);
});

test("a k4unit suite's rows are judged by their action", { skip }, async (t) => {
  const c = await connect(t, "");
  const rows = parseK4unit(
    [
      "action,ms,bytes,lang,code,repeat,minver,comment",
      "before,0,0,q,t:([] a:1 2 3),1,,",
      'true,0,0,q,"3=count t",1,,',
      'true,0,0,q,"2=count t",1,,',
      'fail,0,0,q,"1+`a",1,,',
      'fail,0,0,q,"1+1",1,,',
      'run,0,0,q,"x:sum t`a",1,,',
      "",
    ].join("\n"),
  );
  assert.strictEqual((await run(c, [k4Statement(rows[0])], "run")).passed, true);
  const results = [];
  for (const row of rows.filter(isK4Test)) {
    results.push((await run(c, [k4Statement(row)], k4Mode(row))).passed);
  }
  assert.deepStrictEqual(results, [true, false, true, false, true]);
  assert.strictEqual(String((await c.evaluate("x")).value), "6");
});
