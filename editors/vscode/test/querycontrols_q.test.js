// Unlimited and unwrapped queries and the query timeout (#887) against a
// real q process. Needs a q binary, so it runs only when QLINT_TEST_Q names
// one (a command line, run by the shell, as for qclient.test.js) and is
// skipped otherwise - CI has no q.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection, QError } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");
const { UNLIMITED, UNLIMITED_ROWS, UNLIMITED_SIZE, armTimeout, readUnlimited, runUnwrapped } = require("../out/querycontrols.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 80];

const SERVER = `
t:([] sym:\`a\`b\`c; px:1.5 2.5 3.5)
big:([] i:til 20000; s:20000#\`x\`y)
kt:([k:\`b\`a] v:2 1)
slow:{system "sleep ",string x; x}
dom:\`a\`b\`c,\`$"s",/:string til 100
ids:1 2 3
`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-controls-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source);
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

test("unlimited, unwrapped and timed-out queries against a real q process", { skip }, async (t) => {
  const q = await startQ(SERVER);
  t.after(() => q.stop());
  let connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());

  await t.test("unlimited: a long list is written whole, where a query cuts it", async () => {
    const cut = await connection.query(["til 100000"], SIZE);
    assert.ok(cut.text[0].endsWith(".."));
    const whole = readUnlimited(await connection.call(UNLIMITED, ["til 100000"], UNLIMITED_SIZE));
    assert.strictEqual(whole.ok, true);
    assert.strictEqual(whole.type, 7);
    assert.strictEqual(whole.text.length, 1);
    assert.ok(whole.text[0].startsWith("0 1 2 3"));
    assert.ok(whole.text[0].endsWith("99998 99999"), whole.text[0].slice(-40));
    // Symbols and a single item, as q writes them. (Not "`a`b": the codec
    // sends a string that starts with a backtick as a symbol.)
    assert.deepStrictEqual(readUnlimited(await connection.call(UNLIMITED, ["(`a;`b)"], UNLIMITED_SIZE)).text, ["`a`b"]);
    assert.deepStrictEqual(readUnlimited(await connection.call(UNLIMITED, ["enlist 3i"], UNLIMITED_SIZE)).text, [",3i"]);
  });

  await t.test("unlimited: a temporal list reads as the process writes it, nanoseconds and all (#894)", async () => {
    for (const list of [
      "(2026.11.20D10:11:12.123456789;0Np;0Wp;-0Wp)",
      "(1999.12m;2000.01m;0Nm;0Wm)",
      "(-0Wd;1999.12.31;0Nd;0Wd)",
      "(1999.12.31T23:59:59.999;0Nz;0wz)",
      "(-0D01:02:03.000000001;0Nn;0Wn)",
      "(10:11;0Nu;0Wu)",
      "(10:11:12;0Nv;-0Wv)",
      "(10:11:12.123;0Nt;0Wt)",
    ]) {
      const own = await connection.query([list], SIZE);
      const whole = readUnlimited(await connection.call(UNLIMITED, [list], UNLIMITED_SIZE));
      assert.strictEqual(own.ok, true, list);
      assert.deepStrictEqual(whole.text, own.text, list);
    }
  });

  await t.test("unlimited: a list keeps the attribute q writes before it", async () => {
    for (const list of ["asc 3 1 2", "`u#`a`b", "`p#1 1 2", "`g#1 2", "`s#2026.01.01 2026.01.02", "`s#enlist 1", "`s#\"abc\""]) {
      const own = await connection.query([list], SIZE);
      const whole = readUnlimited(await connection.call(UNLIMITED, [list], UNLIMITED_SIZE));
      assert.deepStrictEqual(whole.text, own.text, list);
    }
  });

  await t.test("unlimited: a string is written as q writes it, UTF-8 and control bytes escaped", async () => {
    for (const s of ['"caf\\303\\251"', 'enlist "\\303\\251"', '"a\\001b\\"\\\\"', 'enlist "x"', '""', '`s#"abc"']) {
      const own = await connection.query([s], SIZE);
      const whole = readUnlimited(await connection.call(UNLIMITED, [s], UNLIMITED_SIZE));
      assert.deepStrictEqual(whole.text, own.text, s);
    }
    // And whole, where a query cuts it at \c.
    const long = readUnlimited(await connection.call(UNLIMITED, ["300#\"ab\""], UNLIMITED_SIZE));
    assert.deepStrictEqual(long.text, [`"${"ab".repeat(150)}"`]);
  });

  await t.test("unlimited: an enumerated list is written whole, as q writes it", async () => {
    // exec sym from an HDB table is enumerated: .Q.S wrote it with -3!,
    // which KDB-X cuts at \\c, unlimited or not.
    const syms = Array.from({ length: 100 }, (_, i) => `\`s${i}`).join("");
    const whole = readUnlimited(await connection.call(UNLIMITED, ["`dom$`$\"s\",/:string til 100"], UNLIMITED_SIZE));
    assert.deepStrictEqual(whole.text, [`\`dom$${syms}`]);
    assert.strictEqual(whole.type, 20);
    for (const list of ["`dom$`a`b", "`dom$enlist`b", "`dom$0#`", "`s#`dom$`a`b", "`ids$1 3"]) {
      const own = await connection.query([list], SIZE);
      const one = readUnlimited(await connection.call(UNLIMITED, [list], UNLIMITED_SIZE));
      assert.deepStrictEqual(one.text, own.text, list);
    }
  });

  await t.test("unlimited: a table is every row, formatted by the process", async () => {
    const cut = await connection.query(["big"], SIZE);
    assert.ok(cut.text.length <= SIZE[0]);
    const whole = readUnlimited(await connection.call(UNLIMITED, ["big"], UNLIMITED_SIZE));
    assert.strictEqual(whole.text.length, 20002);
    assert.strictEqual(whole.text.at(-1).trimEnd(), "19999 y");
  });

  await t.test("unlimited: a grid is sent every row", async () => {
    const answer = await connection.queryGrid(["big"], UNLIMITED_SIZE, UNLIMITED_ROWS);
    assert.strictEqual(answer.grid.count, 20000);
    assert.strictEqual(answer.grid.cells[0].length, 20000);
    const limited = await connection.queryGrid(["big"], SIZE, 100);
    assert.strictEqual(limited.grid.cells[0].length, 100);
  });

  await t.test("unlimited: an error still reads as an error", async () => {
    const answer = readUnlimited(await connection.call(UNLIMITED, ["1+`a"], UNLIMITED_SIZE));
    assert.strictEqual(answer.ok, false);
    assert.strictEqual(answer.error, "type");
  });

  const options = { size: SIZE, limit: 100, unlimited: false, grid: false };

  await t.test("unwrapped: a string is evaluated, and its value and type come back", async () => {
    const r = await connection.evaluate("1+1");
    assert.strictEqual(r.type, -7);
    assert.strictEqual(String(r.value), "2");
    // A string starting with a backtick is code, not a symbol.
    const s = await connection.evaluate("`a`b");
    assert.strictEqual(s.type, 11);
    assert.deepStrictEqual(s.value, ["a", "b"]);
  });

  await t.test("unwrapped: statements run in order and the last value is formatted here", async () => {
    const code = "uw:10\nf:{[x]\n  x+uw}\nf 5";
    assert.deepStrictEqual(await runUnwrapped(connection, statements(code), options), { ok: true, type: -7, text: ["15"] });
    // A table reads as the process would format it.
    const own = await connection.query(["t"], SIZE);
    const here = await runUnwrapped(connection, ["t"], options);
    assert.deepStrictEqual(here.text, own.text.map((l) => l.trimEnd()));
    const keyed = await runUnwrapped(connection, ["kt"], options);
    assert.deepStrictEqual(keyed.text, ["k| v", "-| -", "b| 2", "a| 1"]);
    const dict = await runUnwrapped(connection, ["`a`b!1 2"], options);
    assert.deepStrictEqual(dict.text, ["a| 1", "b| 2"]);
    const atoms = await runUnwrapped(connection, ["(1.5;2026.11.20;`s)"], options);
    // A symbol inside a general list is shown as a symbol.
    assert.deepStrictEqual(atoms.text, ["1.5", "2026.11.20", "`s"]);
    assert.deepStrictEqual((await runUnwrapped(connection, ["2026.11.20D10:11:12.5"], options)).text, ["2026.11.20D10:11:12.500000000"]);
    assert.deepStrictEqual((await runUnwrapped(connection, ['"abc"'], options)).text, ['"abc"']);
    assert.deepStrictEqual((await runUnwrapped(connection, ["a:1;"], options)).type, 101);
  });

  await t.test("unwrapped: a system command runs, but a \\d lasts only for its own message", async () => {
    // q evaluates each string a client sends in the root context, so the
    // statement after a \d is back there: zz lands in the root.
    await runUnwrapped(connection, statements("\\d .uw\nzz:42\n\\d ."), options);
    assert.deepStrictEqual((await runUnwrapped(connection, ["zz"], options)).text, ["42"]);
    assert.deepStrictEqual((await runUnwrapped(connection, ['system "d"'], options)).text, ["`."]);
    assert.deepStrictEqual((await runUnwrapped(connection, ["\\cd"], options)).ok, true);
  });

  await t.test("unwrapped: a q error is the answer, and stops the statements after it", async () => {
    assert.deepStrictEqual(await runUnwrapped(connection, ["ub:1", "1+`a", "ub:2"], options), { ok: false, error: "type", trace: "" });
    assert.deepStrictEqual((await runUnwrapped(connection, ["ub"], options)).text, ["1"]);
    await assert.rejects(connection.evaluate("'boom"), (e) => e instanceof QError && e.message === "boom");
  });

  await t.test("unwrapped: text is cut at the console size unless unlimited, and grid mode gets rows", async () => {
    const cut = await runUnwrapped(connection, ["big"], options);
    assert.strictEqual(cut.text.length, SIZE[0]);
    const whole = await runUnwrapped(connection, ["big"], { ...options, unlimited: true });
    assert.strictEqual(whole.text.length, 20002);
    const grid = await runUnwrapped(connection, ["big"], { ...options, grid: true });
    assert.strictEqual(grid.grid.count, 20000);
    assert.strictEqual(grid.grid.cells[0].length, 100);
    assert.deepStrictEqual(grid.grid.names, ["i", "s"]);
  });

  await t.test("unwrapped: nothing of ours is defined on the process", async () => {
    const before = (await connection.evaluate("key `.")).value;
    await runUnwrapped(connection, ["1+1", "t"], options);
    assert.deepStrictEqual((await connection.evaluate("key `.")).value, before);
  });

  await t.test("a timeout aborts a query still running, as Abort does", async () => {
    const started = Date.now();
    const running = connection.query(["slow 3"], SIZE);
    const disarm = armTimeout(0.5, () => connection.abort());
    await assert.rejects(running, /closed before the process answered/);
    disarm();
    const took = Date.now() - started;
    assert.ok(took < 2000, `${took} ms`);
    assert.strictEqual(connection.isOpen, false);
    // A new connection works once the process has finished the query.
    connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
    assert.deepStrictEqual(await connection.query(["1+1"], SIZE), { ok: true, type: -7, text: ["2"] });
  });

  await t.test("a query that finishes first is not aborted", async () => {
    let fired = false;
    const disarm = armTimeout(1, () => {
      fired = true;
      connection.abort();
    });
    assert.deepStrictEqual((await connection.query(["slow 0"], SIZE)).text, ["0"]);
    disarm();
    await new Promise((r) => setTimeout(r, 1200));
    assert.strictEqual(fired, false);
    assert.strictEqual(connection.isOpen, true);
  });
});
