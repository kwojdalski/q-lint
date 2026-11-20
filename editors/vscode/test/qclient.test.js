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
const { GATHER, LIMITS, explorerTree, previewCode, readGathered } = require("../out/explorer.js");
const { toGrid } = require("../out/grid.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 80];

const SERVER = `
t:([] sym:\`a\`b\`c; px:1.5 2.5 3.5)
slow:{system "sleep ",string x; x}
.z.pw:{[u;p] not u~\`locked}
types:([] b:10b; g:("G"$"8c680a01-5a49-5aab-5a65-d4bfddb6a661";0Ng); x:0x01ff; h:1 0Nh; i:1 0Wi;
  j:9007199254740993 -0Wj; e:1.5 0Ne; f:3.14159265358979 -0w; c:"a "; s:\`abc\`;
  p:2026.11.20D10:11:12.123456789 0Np; m:2026.11 0Wm; d:2026.11.20 -0Wd; z:2026.11.20T10:11:12.123 0Wz;
  n:-0D01:02:03.000000001 0Wn; u:10:11 0Nu; v:10:11:12 0Wv; tt:10:11:12.123 -0Wt; str:("ab";"c"); l:(1 2 3;\`a\`b))
kt:([k:\`b\`a] v:2 1)
`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// Start a q process running `source` - a script, or a function of the
/// temporary directory it runs in giving one - listening on a free port;
/// resolves once it accepts.
async function startQ(source = SERVER) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-qclient-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, typeof source === "function" ? source(dir) : source);
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

  await t.test("a statement that starts with a backtick runs, not arrives as a symbol", async () => {
    assert.deepStrictEqual(await connection.query(["`a`b"], SIZE), { ok: true, type: 11, text: ["`a`b"] });
    assert.deepStrictEqual((await connection.query(["`c"], SIZE)).text, ["`c"]);
  });

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

test("grid and chart mode: what the process sends for a result", { skip }, async (t) => {
  const q = await startQ();
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const grid = async (code, limit = 100) => {
    const answer = await connection.queryGrid(statements(code), SIZE, limit);
    return { answer, grid: answer.grid && toGrid(answer.grid, -1) };
  };

  await t.test("every type is shown as kdb+ prints it in a table, nulls and infinities too", async () => {
    const { answer, grid: g } = await grid("types");
    assert.strictEqual(answer.type, 98);
    assert.ok(answer.text.length > 0, "the console text comes too");
    const cells = Object.fromEntries(g.columns.map((c, i) => [c.name, g.cells[i]]));
    assert.deepStrictEqual(cells, {
      b: ["1", "0"],
      g: ["8c680a01-5a49-5aab-5a65-d4bfddb6a661", "00000000-0000-0000-0000-000000000000"],
      x: ["01", "ff"],
      h: ["1", ""],
      i: ["1", "0W"],
      j: ["9007199254740993", "-0W"],
      e: ["1.5", ""],
      f: ["3.141593", "-0w"],
      c: ["a", " "],
      s: ["abc", ""],
      p: ["2026.11.20D10:11:12.123456789", ""],
      m: ["2026.11", "0W"],
      d: ["2026.11.20", "-0W"],
      z: ["2026.11.20T10:11:12.123", "0w"],
      n: ["-0D01:02:03.000000001", "0W"],
      u: ["10:11", ""],
      v: ["10:11:12", "0W"],
      tt: ["10:11:12.123", "-0W"],
      str: ['"ab"', '"c"'],
      l: ["1 2 3", "`a`b"],
    });
    assert.deepStrictEqual(
      g.columns.map((c) => c.type),
      [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0, 0],
    );
    // Values for charting, in q's own units; nulls and infinities null.
    const values = Object.fromEntries(g.columns.map((c, i) => [c.name, g.values[i]]));
    assert.deepStrictEqual(values.f, [3.14159265358979, null]);
    assert.deepStrictEqual(values.d, [9820, null]);
    assert.deepStrictEqual(values.u, [611, null]);
    assert.strictEqual(values.s, null);
    // Ranks as q sorts: a null first.
    assert.deepStrictEqual(g.rank[g.columns.findIndex((c) => c.name === "h")], [1, 0]);
  });

  await t.test("floats to the decimals asked for", async () => {
    const answer = await connection.queryGrid(["([] f:1.23456 2 0n)"], SIZE, 100);
    assert.deepStrictEqual(toGrid(answer.grid, 2).cells, [["1.23", "2.00", ""]]);
  });

  await t.test("a keyed table is unkeyed, with its key columns marked", async () => {
    const { grid: g } = await grid("kt");
    assert.deepStrictEqual(g.columns.map((c) => [c.name, c.key]), [["k", true], ["v", false]]);
    assert.deepStrictEqual(g.cells, [["b", "a"], ["2", "1"]]);
    assert.deepStrictEqual(g.rank, [[1, 0], [1, 0]]);
  });

  await t.test("a dictionary is key and value columns, a list one value column", async () => {
    const dict = (await grid("`x`y!10 20")).grid;
    assert.deepStrictEqual(dict.columns.map((c) => [c.name, c.key]), [["key", true], ["value", false]]);
    assert.deepStrictEqual(dict.cells, [["x", "y"], ["10", "20"]]);
    const list = (await grid("(1;`a;\"bc\")")).grid;
    assert.deepStrictEqual(list.columns.map((c) => c.name), ["value"]);
    assert.deepStrictEqual(list.cells, [["1", "`a", '"bc"']]);
  });

  await t.test("a large result is cut at the limit, and says how many rows it had", async () => {
    const { grid: g } = await grid("([] a:til 100000; b:100000?1f)", 250);
    assert.strictEqual(g.cells[0].length, 250);
    assert.strictEqual(g.total, 100000);
    assert.strictEqual(g.cells[0][249], "249");
  });

  await t.test("an atom, a string, a function and :: are not tabular: text only", async () => {
    for (const code of ["42", "\"abc\"", "{x+1}", "a:1;"]) {
      const { answer } = await grid(code);
      assert.strictEqual(answer.ok, true, code);
      assert.strictEqual(answer.grid, undefined, code);
      assert.strictEqual(answer.gridError, undefined, code);
    }
    assert.deepStrictEqual((await grid("42")).answer.text, ["42"]);
  });

  await t.test("an error reads as in console mode, with a trace of the user's code only", async () => {
    const { answer } = await grid("g:{x+`a}\ng 1");
    assert.strictEqual(answer.ok, false);
    assert.strictEqual(answer.error, "type");
    assert.match(answer.trace, /\{x\+`a\}/);
    assert.doesNotMatch(answer.trace, /\.Q\.trp|value each|sublist/);
  });

  await t.test("nothing is defined on the process", async () => {
    const before = (await connection.query(["(key `.;key `.q;key `.Q)"], [100, 2000])).text.join("\n");
    await grid("types");
    await grid("kt");
    await grid("`x`y!1 2");
    await grid("1+`a");
    const after = (await connection.query(["(key `.;key `.q;key `.Q)"], [100, 2000])).text.join("\n");
    assert.strictEqual(after, before);
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

// A process with what the explorer shows (#854): namespaces nested two deep,
// tables in memory, a keyed one, a partitioned one on disk, functions, and a
// namespace of 3,000 names.
const EXPLORED = (dir) => `
{[d;dt] .Q.dd[d;dt,\`trade\`] set .Q.en[d] ([] sym:\`a\`b\`c; px:1.5 2.5 3.5)}[hsym \`$"${dir}/hdb"] each 2024.01.01 2024.01.02;
system "l ${dir}/hdb";
t:([] a:1 2 3);
kt:([k:1 2] v:3 4);
f:{[x;y] x+y};
p:f[1];
v:1 2 3f;
.ns.g:{[a] a};
.ns.sub.z:"abc";
.ns.sub.deep.w:42;
{(\` sv \`.big,x) set 1} each \`$"n",/:string til 3000;
`;

/// What a process holds, as names: root, namespaces, and each namespace's.
const NAMES = "{(key`.;key`;{key x}each` sv'`,'key`)}";
/// The explorer's settings in these tests: what differs between kdb+ and
/// PeachQ (`.z`, `.help`) is excluded too.
const EXCLUDED = "q Q h j o s z help";

test("the explorer's call against a real q process", { skip }, async (t) => {
  const q = await startQ(EXPLORED);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const before = await connection.call(NAMES);
  const g = readGathered(await connection.call(GATHER, EXCLUDED, LIMITS));
  const entry = (ns, name) => g.entries.find((e) => e.ns === ns && e.name === name);

  await t.test("it defines nothing on the process", async () => {
    assert.deepStrictEqual(await connection.call(NAMES), before);
  });

  await t.test("namespaces nested at any depth, the excluded ones left out", () => {
    assert.deepStrictEqual(g.spaces.map((s) => s.ns).sort(), [".", ".big", ".ns", ".ns.sub", ".ns.sub.deep"]);
    assert.strictEqual(g.more, 0);
  });

  await t.test("tables with their counts and columns, and a keyed table's keys", () => {
    assert.deepStrictEqual(entry(".", "t"), {
      ns: ".", name: "t", kind: "table", type: 98, count: 3, cols: ["a"], keys: [], params: [], partitioned: false,
    });
    assert.deepStrictEqual(
      [entry(".", "kt").type, entry(".", "kt").count, entry(".", "kt").cols, entry(".", "kt").keys],
      [99, 2, ["k", "v"], ["k"]],
    );
  });

  await t.test("a partitioned table is counted by .Q.cn and said to be partitioned", () => {
    const trade = entry(".", "trade");
    assert.deepStrictEqual([trade.kind, trade.type, trade.count, trade.cols, trade.partitioned], ["table", 98, 6, ["date", "sym", "px"], true]);
    const tables = explorerTree(g, []).find((n) => n.label === ".").children.find((c) => c.label === "Tables");
    assert.strictEqual(tables.children.find((c) => c.label === "trade").description, "6 rows (partitioned, counted by .Q.cn) · 3 columns");
  });

  await t.test("functions with their parameters, and variables with type and count", () => {
    assert.deepStrictEqual([entry(".", "f").kind, entry(".", "f").params, entry(".", "f").count], ["function", ["x", "y"], null]);
    assert.deepStrictEqual([entry(".", "p").kind, entry(".", "p").type], ["function", 104]);
    assert.deepStrictEqual([entry(".ns", "g").params], [["a"]]);
    assert.deepStrictEqual([entry(".", "v").kind, entry(".", "v").type, entry(".", "v").count], ["variable", 9, 3]);
    assert.deepStrictEqual([entry(".ns.sub", "z").type, entry(".ns.sub", "z").count], [10, 3]);
    assert.deepStrictEqual([entry(".ns.sub.deep", "w").type, entry(".ns.sub.deep", "w").count], [-7, 1]);
    // A nested namespace is a namespace, not a variable of its parent.
    assert.strictEqual(entry(".ns", "sub"), undefined);
  });

  await t.test("bounded: the first names of a large namespace, and its total", async () => {
    assert.deepStrictEqual(g.spaces.find((s) => s.ns === ".big"), { ns: ".big", total: 3000 });
    assert.strictEqual(g.entries.filter((e) => e.ns === ".big").length, LIMITS[0]);
    const few = readGathered(await connection.call(GATHER, EXCLUDED, [2, 2]));
    assert.deepStrictEqual(few.spaces.map((s) => s.ns), [".", ".big"]);
    assert.strictEqual(few.entries.length, 4);
    assert.strictEqual(few.more, 1);
  });

  await t.test("with nothing excluded, the system namespaces are read too", async () => {
    const all = readGathered(await connection.call(GATHER, "", LIMITS));
    assert.ok(all.spaces.some((s) => s.ns === ".q"), JSON.stringify(all.spaces));
  });

  await t.test("preview shows a partitioned table's first rows", async () => {
    const answer = await connection.query([previewCode({ kind: "table", name: "trade", partitioned: true }, 2)], SIZE);
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    // A header, a rule and two rows; PeachQ also prints the column types.
    assert.ok(answer.text.filter((l) => /\d{4}\.\d\d\.\d\d/.test(l)).length === 2, answer.text.join("\n"));
    const kt = await connection.query([previewCode({ kind: "table", name: "kt" }, 1)], SIZE);
    assert.ok(kt.ok && kt.text.some((l) => /^1\s*\|?\s*3/.test(l.replace(/^\|\s*/, ""))), kt.text.join("\n"));
  });
});

// A root name that is not a namespace: kdb+ lists `.cfg:42` in `key \``
// (PeachQ does not), and the explorer read its "names" with `key 42`,
// `til 42`, failing the whole call with 'type.
test("the explorer's call skips a dotted root name that is not a namespace", { skip }, async (t) => {
  const q = await startQ("x:1;\n.cfg:42;\n.tbl:([]a:1 2);\n.kt:([k:1 2]v:3 4);\n.ok.y:2;\n");
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const g = readGathered(await connection.call(GATHER, EXCLUDED, LIMITS));
  assert.deepStrictEqual(g.spaces.map((s) => s.ns).sort(), [".", ".ok"]);
  assert.deepStrictEqual(g.entries.map((e) => `${e.ns} ${e.name}`).sort(), [". x", ".ok y"]);
});
