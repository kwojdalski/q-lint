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
const { TOO_DEEP, UNLIMITED, UNLIMITED_ROWS, UNLIMITED_SIZE, armTimeout, readUnlimited, runUnwrapped } = require("../out/querycontrols.js");

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

  await t.test("unlimited: a cell, an item, a dictionary's value and an atom are whole whatever the process's \\c, which is left as it was (#1995)", async () => {
    const width = async () => (await connection.query(['system"c"'], SIZE)).text[0];
    assert.strictEqual(await width(), "25 80i");
    const text = async (code) => {
      const answer = readUnlimited(await connection.call(UNLIMITED, [code], UNLIMITED_SIZE));
      assert.strictEqual(answer.ok, true, code);
      return answer.text;
    };
    const x = "x".repeat(300);
    const n = Array.from({ length: 300 }, (_, i) => i).join(" ");
    assert.deepStrictEqual(await text('`$300#"a"'), ["`" + "a".repeat(300)]);
    assert.deepStrictEqual((await text('([]a:enlist 300#"x")')).map((l) => l.trimEnd()), ["a", "-".repeat(302), `"${x}"`]);
    assert.deepStrictEqual(await text("(1;til 300)"), ["1", n]);
    assert.deepStrictEqual((await text('`a`b!(300#"x";1)')).map((l) => l.trimEnd()), [`a| "${x}"`, "b| 1"]);
    assert.deepStrictEqual((await text('([k:`a`b]v:(til 300;"y"))')).map((l) => l.trimEnd()), ["k| v", "-| " + "-".repeat(n.length), `a| ${n}`, 'b| "y"']);
    // A value nothing cut is the process's own .Q.S, two dots and all.
    assert.deepStrictEqual(await text('("a..b";`c)'), ['"a..b"', "`c"]);
    assert.deepStrictEqual((await text("((1;\"ab\");(2;\"cd\"))")).map((l) => l.trimEnd()), ['1 "ab"', '2 "cd"']);
    assert.deepStrictEqual(await text("()"), []);
    assert.strictEqual(await width(), "25 80i");
    // And an error inside leaves it too.
    assert.strictEqual(readUnlimited(await connection.call(UNLIMITED, ['(1;til 300);\'"stop"'], UNLIMITED_SIZE)).error, "stop");
    assert.strictEqual(await width(), "25 80i");
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

  // The padding was trimmed before the cut, and blanks a cell holds with it (#2572).
  await t.test("unwrapped: a line is cut padded, as q cuts it, and a cell's own blank, tab or newline is kept", async () => {
    const at = async (code, width) => (await runUnwrapped(connection, [code], { ...options, size: [25, width] })).text;
    const own = async (code, width) => (await connection.query([code], [25, width])).text;
    for (const [code, width] of [["([] a:2#0Ng)", 20], ["([] a:`a`b; b:2#enlist `x`y)", 4], ["([] a:(\" \";\"\"))", 2]]) {
      assert.deepStrictEqual(await at(code, width), await own(code, width), code);
    }
    assert.deepStrictEqual(await at('([] a:"a b")', 80), ["a", "-", "a", " ", "b"]);
    assert.deepStrictEqual(await at('([] a:"\n\t")', 80), ["a", "-", "\n", "\t"]);
    assert.deepStrictEqual(await at("([] a:(12:30 0Nu;12:30 0Nu))", 80), ["a", "------", "12:30", "12:30"]);
    assert.deepStrictEqual(await at("([] a:`a`bbb; b:`x`)", 80), ["a   b", "-----", "a   x", "bbb"]);
  });

  await t.test("unwrapped: a string is evaluated, and its value and type come back", async () => {
    const r = await connection.evaluate("1+1");
    assert.strictEqual(r.type, -7);
    assert.strictEqual(String(r.value), "2");
    // A string starting with a backtick is code, not a symbol.
    const s = await connection.evaluate("`a`b");
    assert.strictEqual(s.type, 11);
    assert.deepStrictEqual(s.value, ["a", "b"]);
  });

  await t.test("unwrapped: a value nested thousands deep is shown as -3! writes it, or said to be too deep, never a RangeError (#2650)", async () => {
    for (const n of [1000, 2000]) {
      const deep = await runUnwrapped(connection, [`{enlist x}/[${n};1]`], { ...options, size: [25, 80], grid: true });
      assert.strictEqual(deep.ok, true, `${n}: ${JSON.stringify(deep).slice(0, 200)}`);
      assert.match(deep.text[0], /^,{77}\.\.$/, String(n));
    }
    const deeper = await runUnwrapped(connection, ["dd:{enlist x}/[20000;1]", "dd"], options);
    assert.deepStrictEqual(deeper, { ok: false, error: TOO_DEEP, trace: "" });
    assert.deepStrictEqual((await runUnwrapped(connection, ["count dd"], options)).text, ["1"]);
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

  await t.test("unwrapped: a system command runs, and a \\d holds for the statements after it, as in q's console (#2476)", async () => {
    // q reads each string a client sends in the root context, so the
    // statements after a \d are sent with it in front: zz is .uw.zz.
    await runUnwrapped(connection, ["zz:0"], options);
    await runUnwrapped(connection, statements("\\d .uw\nzz:42\nh1:{x+1}\n\\d ."), options);
    assert.deepStrictEqual((await runUnwrapped(connection, ["(zz;.uw.zz;`h1 in key `.uw;`h1 in key `.)"], options)).text, ["0", "42", "1b", "0b"]);
    // A system "d .ns" holds too, and a \d . ends it.
    assert.deepStrictEqual((await runUnwrapped(connection, statements('\\d .bar\nsystem "d"'), options)).text, ["`.bar"]);
    assert.deepStrictEqual((await runUnwrapped(connection, statements('system "d .uw"\nzz\n\\d .\nzz'), options)).text, ["0"]);
    assert.deepStrictEqual((await runUnwrapped(connection, statements("\\d .uw\nzz"), options)).text, ["42"]);
    assert.deepStrictEqual((await runUnwrapped(connection, statements("\\d .uw\nw:5\nw"), options)).text, ["5"]);
    // A query is read afresh in the root.
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

// A direct answer holding a string past V8's longest (0x1fffffe8
// characters) failed: the codec makes every char vector a string, and it
// threw before the typed reading, which keeps chars as bytes, was tried
// (#2583). The limit is injected here - the codec refuses an answer past a
// few thousand bytes as V8 refuses a string past its longest - so no
// half-gigabyte string is made.
test("a direct answer the codec cannot make, of a string past V8's longest, is shown cut, as wrapped shows it (#2583)", { skip }, async (t) => {
  const codec = require("node-q/lib/c.js");
  const deserialize = codec.deserialize;
  codec.deserialize = (body, ...rest) => {
    if (body.length > 5000) {
      throw Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
    }
    return deserialize(body, ...rest);
  };
  t.after(() => (codec.deserialize = deserialize));
  const q = await startQ("");
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const options = { size: [25, 30], limit: 100, unlimited: false, grid: true };
  const x = "x".repeat(27);
  const list = await runUnwrapped(connection, ['(10000#"x";1)'], options);
  assert.deepStrictEqual(list.text, [`"${x}..`, "1"]);
  assert.strictEqual(list.grid.cells[0][0], `"${"x".repeat(196)}...`);
  assert.deepStrictEqual((await runUnwrapped(connection, ['10000#"x"'], options)).text, [`"${x}..`]);
  const table = await runUnwrapped(connection, ['([] a:(10000#"x";"b"))'], options);
  assert.deepStrictEqual(table.grid.rank[0], [1, 0]);
  // A wrapped call is answered as before: the codec's error.
  await assert.rejects(connection.call("{x}", "y".repeat(6000)), /0x1fffffe8/);
});
