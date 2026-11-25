// A value's whole text against a real q process whose console is narrow
// (#1866, #1870): `-3!` there cuts every piece at `\c`, and FULL_TEXT and
// LAID_OUT must read what a wide console would show, without touching `\c`.
// Needs a q binary, so it runs only when QLINT_TEST_Q names one.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { ESCAPE_CUT, FULL_TEXT, LAID_OUT, UTF8_CUT } = require("../out/qtext.js");
const { writes } = require("../out/guard.js");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-qtext-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source);
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

const SERVER = [
  "sym:`u#`a`b`c",
  "f:{[a;b;c] a+b+c}",
  "long:{[anArgument;anotherArgument] theFirstLocal:anArgument+anotherArgument; theFirstLocal*theFirstLocal}",
  "t:([] n:til 60; s:60#`alpha`beta`gamma; p:60#1.5 2 0n)",
].join("\n");

// One of each shape `-3!` writes its own way, every one longer than 40
// characters: what a console 2000 wide shows is what is expected.
const VALUES = [
  "til 100",
  "100#0b",
  "`int$til 60",
  "`short$til 60",
  "`real$til 60",
  "`float$til 60",
  "0.5*til 60",
  "60#0N 1 0W",
  "60#1.5 0n 0w",
  "`byte$til 60",
  "60#\"a\\\"b\\\\c\\n\"",
  "60#`alpha`beta`gamma",
  "2000.01.01+til 20",
  "60#0Np",
  "60#0Nd,0Wd",
  "40#2000.01.01D00:00:00.000000000 0Np",
  "`minute$til 60",
  "`second$til 60",
  "`time$til 20",
  "`month$til 40",
  "40#0Ng",
  "`s#til 100",
  "`sym$60#`a`b`c",
  "`u#`sym$`a`b`c",
  "enlist til 100",
  "(til 100;til 100)",
  "(til 100;`a;\"xy\";60#1.5;(til 50;60#`a))",
  "(60#`a)!til 60",
  "(enlist 1)!enlist til 100",
  "`s#(til 60)!til 60",
  "([] a:til 60; b:60#`x`y)",
  "([k:til 60] v:60#1.5)",
  "`s#([] a:til 60)",
  "t",
  "f[til 60]",
  "f[til 60;;til 60]",
  "f[;til 60;(::)]",
  "long",
  "{x+y}[til 60]'",
  "{x+y}[til 60]/:",
  "+[til 60]",
  "(100#\"a\";101#\"a\")",
  "()",
  "(::)",
  "`long$()",
  "enlist 42",
];

test("FULL_TEXT reads what -3! writes on a wide console, whatever the process's \\c", { skip }, async (t) => {
  const wide = await connect(t, `${SERVER}\n\\c 2000 2000\n`);
  const narrow = await connect(t, `${SERVER}\n\\c 25 40\n`);
  const state = "(system\"c\";key`.;key`)";
  const before = (await narrow.evaluate(`-3!${state}`)).value;
  for (const v of VALUES) {
    const expected = (await wide.evaluate(`-3!(${v})`)).value;
    const cut = (await narrow.evaluate(`-3!(${v})`)).value;
    const got = (await narrow.evaluate(`${FULL_TEXT}[0W;${v}]`)).value;
    assert.strictEqual(got, expected, v);
    // The corpus is worth its place only where the console does cut.
    if (expected.length > 40) assert.notStrictEqual(cut, expected, `${v} is cut at \\c 25 40`);
  }
  // Nothing defined, and the console as the user set it.
  assert.strictEqual((await narrow.evaluate(`-3!${state}`)).value, before);
  assert.deepStrictEqual(Array.from((await narrow.evaluate("system\"c\"")).value, Number), [25, 40]);
});

test("FULL_TEXT writes no more of a long vector than it was asked for", { skip }, async (t) => {
  const c = await connect(t, "\\c 25 40\n");
  const text = (await c.evaluate(`${FULL_TEXT}[200;til 1000000]`)).value;
  assert.ok(text.startsWith("0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23"), text);
  assert.ok(text.length >= 200 && text.length < 2000, String(text.length));
  // What was left out is marked as q marks it, in a vector and in a list.
  assert.ok(text.endsWith(" 198 199.."), text.slice(-20));
  assert.strictEqual((await c.evaluate(`${FULL_TEXT}[30;(til 20;til 20;til 20)]`)).value, "(0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19;..)");
  assert.strictEqual((await c.evaluate(`${FULL_TEXT}[30;30#"ab"]`)).value, `"${"ab".repeat(15)}"`);
});

test("LAID_OUT shows every row and each cell to its end on a narrow console", { skip }, async (t) => {
  const c = await connect(t, `${SERVER}\n\\c 10 20\n`);
  const lay = async (v) => (await c.evaluate(`${LAID_OUT}[${FULL_TEXT};20000;${v}]`)).value;
  assert.strictEqual(await lay("2 4 6"), "2 4 6\n");
  assert.strictEqual(await lay("`a`b!1 2"), "a| 1\nb| 2\n");
  assert.strictEqual(await lay("(::)"), "");
  assert.strictEqual(await lay("til 30"), `${Array.from({ length: 30 }, (_, i) => i).join(" ")}\n`);
  assert.strictEqual(await lay("([] x:til 12; s:12#`a`bb)"), `x  s \n-----\n${Array.from({ length: 12 }, (_, i) => `${String(i).padEnd(2)} ${i % 2 ? "bb" : "a "}`).join("\n")}\n`);
  assert.strictEqual(await lay("([k:`a`b] v:(til 12;\"xy\"))"), `k| v                        \n-| -------------------------\na| 0 1 2 3 4 5 6 7 8 9 10 11\nb| "xy"                     \n`);
  assert.strictEqual(await lay("(til 12;`a;\"xy\")"), "0 1 2 3 4 5 6 7 8 9 10 11\n`a\n\"xy\"\n");
  assert.strictEqual(await lay("`a`b!(til 12;`c)"), "a| 0 1 2 3 4 5 6 7 8 9 10 11\nb| `c\n");
  // Cut to the characters asked for.
  assert.strictEqual((await c.evaluate(`${LAID_OUT}[${FULL_TEXT};7;til 30]`)).value, "0 1 2 3");
  assert.deepStrictEqual(Array.from((await c.evaluate("system\"c\"")).value, Number), [10, 20]);
});

test("LAID_OUT rules a dictionary with a table on one side as .Q.s does at a wide console (#2070)", { skip }, async (t) => {
  const c = await connect(t, `${SERVER}\n\\c 10 20\n`);
  const values = [
    "(enlist`a)!([]x:enlist til 4)",
    "([]x:enlist til 4)!enlist `a",
    "`ab`cde!([]x:1 2)",
    "([]x:1 2)!`ab`cde",
    "([]x:1 2;yy:3 4)!`ab`cde",
    "(`ab;`cdefg)!([]xxxxxxxxx:1 2;yy:3 4)",
    "([k:`a`b] v:1 2)",
  ];
  for (const v of values) {
    const laid = (await c.evaluate(`${LAID_OUT}[${FULL_TEXT};20000;${v}]`)).value;
    const wide = (await c.evaluate(`{system"c 2000 3000";r:.Q.s x;system"c 10 20";r}${v}`)).value;
    assert.strictEqual(laid, wide, v);
  }
});

test("UTF8_CUT and ESCAPE_CUT cut on a character, and define nothing (#2071)", { skip }, async (t) => {
  const c = await connect(t, `${SERVER}\n`);
  const cut = async (f, n, s) => (await c.evaluate(`${f}[${n};${s}]`)).value;
  const before = (await c.evaluate("key `.")).value;
  assert.strictEqual(await cut(UTF8_CUT, 10, '"abc"'), "abc");
  assert.strictEqual(await cut(UTF8_CUT, 2, '"abc"'), "ab");
  assert.strictEqual(await cut(UTF8_CUT, 0, '"abc"'), "");
  // é is two bytes, 日 three, 😀 four: never half of one.
  assert.strictEqual(await cut(UTF8_CUT, 1, '"\\303\\251"'), "");
  assert.strictEqual(await cut(UTF8_CUT, 3, '"a\\303\\251b"'), "aé");
  assert.strictEqual(await cut(UTF8_CUT, 2, '"\\346\\227\\245"'), "");
  assert.strictEqual(await cut(UTF8_CUT, 7, '"\\360\\237\\230\\200\\360\\237\\230\\200"'), "😀");
  assert.strictEqual(await cut(UTF8_CUT, 8, '"\\360\\237\\230\\200\\360\\237\\230\\200"'), "😀😀");
  // An escape -3! wrote is kept whole or not at all; an escaped backslash is whole.
  assert.strictEqual(await cut(ESCAPE_CUT, 6, '"\\"\\\\346\\\\227\\""'), '"\\346');
  assert.strictEqual(await cut(ESCAPE_CUT, 7, '"\\"\\\\346\\\\227\\""'), '"\\346');
  assert.strictEqual(await cut(ESCAPE_CUT, 9, '"\\"\\\\346\\\\227\\""'), '"\\346\\227');
  assert.strictEqual(await cut(ESCAPE_CUT, 3, '"\\"a\\\\\\\\b\\""'), '"a');
  assert.strictEqual(await cut(ESCAPE_CUT, 4, '"\\"a\\\\\\\\b\\""'), '"a\\\\');
  assert.strictEqual(await cut(ESCAPE_CUT, 2, '"ab"'), "ab");
  assert.deepStrictEqual((await c.evaluate("key `.")).value, before);
});

test("the text lambdas are reads to the guard", () => {
  assert.deepStrictEqual(writes(`${FULL_TEXT}[0W;1]`), []);
  assert.deepStrictEqual(writes(`${LAID_OUT}[${FULL_TEXT};100;1]`), []);
});
