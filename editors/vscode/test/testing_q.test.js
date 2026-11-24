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

test("a match row and a qUnit assertion carry both sides of a failure (#980)", { skip }, async (t) => {
  const qunit = [
    "\\d .qunit",
    "ar:()",
    "assertThat:{[actual;relation;expected;msg] p:.[relation;(actual;expected);0b]; ar::`actual`expected`msg!(actual;expected;msg); if[not p;'`assertThatFAIL]; actual}",
    "assertEquals:{[actual;expected;msg] assertThat[actual;~;expected;msg]}",
    "\\d .",
    "",
  ].join("\n");
  const c = await connect(t, qunit);
  const { splitMatch } = require("../out/testing.js");
  const sides = splitMatch("(1 2 3*2)~2 4 7");
  const failed = await run(c, [`(${sides.left};${sides.right})`], "match");
  assert.strictEqual(failed.passed, false);
  assert.deepStrictEqual(failed.diff, { expected: "2 4 7\n", actual: "2 4 6\n" });
  assert.strictEqual(failureText(failed, "match"), "the two sides of ~ differ");
  const passed = await run(c, ["(til 3;0 1 2)"], "match");
  assert.deepStrictEqual(passed, { passed: true, text: "1b", errored: false });
  // A side that signals is an error, as the row would be.
  assert.strictEqual((await run(c, ["(1+`a;2)"], "match")).errored, true);
  const q = await run(c, ["testEq:{[] .qunit.assertEquals[`a`b!1 2;`a`b!1 3;\"dict\"]}", "testEq[]"]);
  assert.strictEqual(q.passed, false);
  assert.strictEqual(q.text, "assertThatFAIL");
  assert.deepStrictEqual(q.diff, { expected: "a| 1\nb| 3\n", actual: "a| 1\nb| 2\n" });
  // A passing assertion leaves no diff on a later failure of another kind.
  const other = await run(c, ["testOk:{[] .qunit.assertEquals[1;1;\"one\"]; '`boom}", "testOk[]"]);
  assert.deepStrictEqual(other, { passed: false, text: "boom", errored: true });
});

// qUnit's own flag, as qunit.q has it: `doCheck` keeps `failFlag` set once
// an assertion fails, and an assertion returns the value it checked.
const QUNIT_FLAG = [
  "\\d .qunit",
  "EMPTYAR:`actual`expected`msg!```; ar:EMPTYAR; failFlag:0b; ignoreAllExceptions:0b;",
  "doCheck:{[checkPassed;failMsg] failFlag::failFlag or not checkPassed; if[failFlag and not .qunit.ignoreAllExceptions; 'failMsg];};",
  "assertThat:{[actual;relation;expected;msg] p:.[relation;(actual;expected);0b]; ar::`actual`expected`msg!(actual;expected;msg); doCheck[p;\"assertThatFAIL\"]; actual};",
  "assertTrue:{[actual;msg] assertThat[actual;=;1b;msg]};",
  "assertFalse:{[actual;msg] assertThat[actual;=;0b;msg]};",
  "\\d .",
  "",
].join("\n");

test("a qUnit failure does not fail the next test, and a failure ignoreAllExceptions hides still fails (#1588)", { skip }, async (t) => {
  const c = await connect(t, QUNIT_FLAG);
  const failed = await run(c, ["testA:{[] .qunit.assertThat[1;=;2;\"a\"]}", "testA[]"]);
  assert.strictEqual(failed.passed, false);
  // The flag the failure left is cleared before the next test.
  assert.deepStrictEqual(await run(c, ["testB:{[] .qunit.assertTrue[1b;\"b\"]}", "testB[]"]), { passed: true, text: "1b", errored: false });
  // With ignoreAllExceptions nothing signals, and the flag still fails it.
  await c.evaluate(".qunit.ignoreAllExceptions:1b");
  const quiet = await run(c, ["testC:{[] .qunit.assertThat[1;=;2;\"c\"]}", "testC[]"]);
  assert.strictEqual(quiet.passed, false);
  assert.deepStrictEqual(quiet.diff, { expected: "2\n", actual: "1\n" });
});
