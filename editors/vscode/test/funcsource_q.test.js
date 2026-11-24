// The process-insight calls against a real q process: a function's source
// and Redefine (#929), a table's details (#930), the HDB browser (#931),
// the Process Monitor (#932) and callers (#935). Needs a q binary, so it
// runs only when QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { SOURCE, REDEFINE, CALLERS, readSource, readCallers, sourceDocument, editedText } = require("../out/funcsource.js");
const { TABLE_INFO, readTableInfo, tableMarkdown } = require("../out/tableinfo.js");
const { MONITOR, monitorTree } = require("../out/monitor.js");
const { HDB, readHdb, hdbTree } = require("../out/hdb.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const EXCLUDED = "q Q h j o s z help";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-insight-"));
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

const FUNCTIONS = [
  "f:{[a;b] a+g b}",
  "g:{x*2}",
  "\\d .ns",
  "lim:5",
  "h:{[x] x+lim}",
  "k:{.ns.h[x]+`g}",
  "u:{[x] f x}",
  "\\d .",
  "m:{[x] {f y}[x;1]}",
  "byname:{value(`f;x;1)}",
  "shadow:{[f] f+1}",
  'str:{"f is not called"}',
  "/ f in a comment",
  "multi:{[x]",
  "  y:x+1;",
  "  g y}",
  "p:f[1]",
  "",
].join("\n");

test("a lambda's source and context come back as the process has them", { skip }, async (t) => {
  const c = await connect(t, FUNCTIONS);
  const h = readSource(await c.call(SOURCE, ".ns.h"));
  assert.deepStrictEqual(h, { type: 100, text: "{[x] x+lim}", ctx: "ns", params: ["x"] });
  assert.strictEqual(sourceDocument(".ns.h", "p", h), "/ .ns.h on p, defined in .ns\n{[x] x+lim}\n");
  const f = readSource(await c.call(SOURCE, "f"));
  assert.deepStrictEqual([f.text, f.ctx, f.params], ["{[a;b] a+g b}", "", ["a", "b"]]);
  assert.strictEqual(readSource(await c.call(SOURCE, "multi")).text, "{[x]\n  y:x+1;\n  g y}");
  // A projection is shown, not editable.
  const p = readSource(await c.call(SOURCE, "p"));
  assert.strictEqual(p.type, 104);
  // A one-character name reaches q as a char atom, and still works.
  assert.strictEqual(readSource(await c.call(SOURCE, "g")).text, "{x*2}");
  await assert.rejects(c.call(SOURCE, ".ns.lim"), /not a function/);
  await assert.rejects(c.call(SOURCE, "nosuch"), /nosuch/);
});

test("Redefine parses the new text in the lambda's context and leaves the process's own", { skip }, async (t) => {
  const c = await connect(t, FUNCTIONS);
  const was = "{[x] x+lim}";
  const edited = editedText("/ .ns.h on p, defined in .ns\n{[x] x+lim*2}\n");
  assert.strictEqual(edited, "{[x] x+lim*2}");
  assert.strictEqual(await c.call(REDEFINE, ".ns.h", was, edited), ".ns.h");
  // `lim` is `.ns.lim`: the new text was parsed in .ns.
  assert.strictEqual((await c.evaluate("\"f\"$.ns.h 1")).value, 11);
  assert.strictEqual((await c.evaluate("system\"d\"")).value, ".");
  // Opened before that change, a second Redefine is refused.
  await assert.rejects(c.call(REDEFINE, ".ns.h", was, "{x}"), /changed on the process/);
  // A text that does not parse, or is not a function, changes nothing.
  await assert.rejects(c.call(REDEFINE, ".ns.h", "{[x] x+lim*2}", "{[x] x+"), (e) => e instanceof Error);
  await assert.rejects(c.call(REDEFINE, ".ns.h", "{[x] x+lim*2}", "42"), /not a function/);
  assert.strictEqual((await c.evaluate("\"f\"$.ns.h 1")).value, 11);
  assert.strictEqual((await c.evaluate("system\"d\"")).value, ".");
  // A root lambda, over several lines.
  assert.strictEqual(await c.call(REDEFINE, "multi", "{[x]\n  y:x+1;\n  g y}", "{[x]\n  y:x+2;\n  g y}"), "multi");
  assert.strictEqual((await c.evaluate("\"f\"$multi 1")).value, 6);
  await assert.rejects(c.call(REDEFINE, "p", "", "{x}"), /not a lambda/);
});

test("callers are read from what q parsed: globals in context, nested lambdas, and mentions by symbol", { skip }, async (t) => {
  const c = await connect(t, FUNCTIONS);
  const of = async (name) =>
    readCallers(await c.call(CALLERS, EXCLUDED, name, 1000))
      .callers.map((x) => `${x.name} ${x.how}`)
      .sort();
  // `.ns.u` calls `.ns.f`, not `f`; `shadow` has a parameter f; `str` a string.
  assert.deepStrictEqual(await of("f"), ["byname mentions", "m calls"]);
  // `.ns.k` mentions `g by symbol, which q resolves from the root when it runs.
  assert.deepStrictEqual(await of("g"), [".ns.k mentions", "f calls", "multi calls"]);
  assert.deepStrictEqual(await of(".ns.h"), [".ns.k calls"]);
  assert.deepStrictEqual(await of(".ns.f"), [".ns.u calls"]);
  assert.deepStrictEqual(await of(".ns.g"), []);
  const all = readCallers(await c.call(CALLERS, EXCLUDED, "f", 1000));
  assert.ok(all.scanned >= 10, String(all.scanned));
  assert.strictEqual(all.more, 0);
  assert.deepStrictEqual(all.callers.find((x) => x.name === "m").params, ["x"]);
});

// A view has a lambda's type, 100h, and `get` of its name evaluates it: it
// is not read as a caller, and one that signals does not fail the read
// (#1864).
test("callers are found on a process with views, and no view is evaluated (#1864)", { skip }, async (t) => {
  const c = await connect(t, FUNCTIONS + "tab:([] a:1 2)\nspy::select from tab\nbad::1+`a\ncalls::f[1;2]\n");
  const pending = () => c.call('{[x] string system"B"}', 0);
  assert.deepStrictEqual(await pending(), ["bad", "calls", "spy"]);
  const all = readCallers(await c.call(CALLERS, EXCLUDED, "f", 1000));
  assert.deepStrictEqual(all.callers.map((x) => `${x.name} ${x.how}`).sort(), ["byname mentions", "m calls"]);
  const without = readCallers(await (await connect(t, FUNCTIONS)).call(CALLERS, EXCLUDED, "f", 1000));
  assert.strictEqual(all.scanned, without.scanned);
  assert.deepStrictEqual(await pending(), ["bad", "calls", "spy"]);
});

test("a table's details: meta, attributes, keys, rows and bytes", { skip }, async (t) => {
  const c = await connect(t, 't:([]a:`s#1 2 3;b:`g#`x`y`z;c:("ab";"c";"d"))\nk:([id:1 2]v:3 4)\n.ns.e:([]x:`long$())\n');
  const info = readTableInfo(await c.call(TABLE_INFO, "t", 30));
  assert.strictEqual(info.kind, "table");
  assert.strictEqual(info.rows, 3);
  assert.ok(info.bytes > 0);
  assert.deepStrictEqual(
    info.columns.map((x) => [x.name, x.type, x.attr]),
    [
      ["a", "j", "s"],
      ["b", "s", "g"],
      ["c", "C", ""],
    ],
  );
  const md = tableMarkdown("t", "p", info);
  assert.match(md, /\*\*t\*\* on p: table, 3 rows, 3 columns, \d+ B in memory/);
  assert.match(md, /`s` sorted/);
  const k = readTableInfo(await c.call(TABLE_INFO, "k", 30));
  assert.deepStrictEqual([k.kind, k.keys, k.rows], ["keyed", ["id"], 2]);
  const e = readTableInfo(await c.call(TABLE_INFO, ".ns.e", 1));
  assert.deepStrictEqual([e.rows, e.ncols, e.columns.length], [0, 1, 1]);
  await assert.rejects(c.call(TABLE_INFO, "x", 30), /x/);
});

const DATABASE = [
  "dir:`$\":$DIR/db\";",
  "{[dir;d] .Q.dd[dir;d,`trade`] set .Q.en[dir;([]sym:`a`b`c;px:1 2 3f)]}[dir] each 2024.01.01 2024.01.02 2024.01.03;",
  ".Q.dd[dir;2024.01.01,`quote`] set .Q.en[dir;([]sym:`a`b;bid:1 2f)];",
  ".Q.dd[dir;2024.01.02,`quote`] set .Q.en[dir;([]sym:`a`b`c`d;bid:1 2 3 4f)];",
  ".Q.dd[dir;2024.01.03,`quote`] set .Q.en[dir;([]sym:enlist`a;bid:enlist 1f)];",
  ".Q.dd[dir;`ref`] set .Q.en[dir;([]sym:`a`b;v:1 2)];",
  "system\"l $DIR/db\";",
  "mem:([]a:1 2);",
  "",
].join("\n");

test("a partitioned or splayed table is counted without loading it, and not measured", { skip }, async (t) => {
  const c = await connect(t, DATABASE);
  const trade = readTableInfo(await c.call(TABLE_INFO, "trade", 30));
  assert.deepStrictEqual([trade.kind, trade.rows, trade.partitions, trade.bytes], ["partitioned", 9, 3, null]);
  assert.deepStrictEqual(trade.columns.map((x) => x.name), ["date", "sym", "px"]);
  assert.match(tableMarkdown("trade", "hdb", trade), /3 partitions, on disk, not measured/);
  const ref = readTableInfo(await c.call(TABLE_INFO, "ref", 30));
  assert.deepStrictEqual([ref.kind, ref.rows, ref.bytes], ["splayed", 2, null]);
});

test("the HDB browser: partitions, counts per partition, splayed tables and the sym file", { skip }, async (t) => {
  const c = await connect(t, DATABASE);
  const h = readHdb(await c.call(HDB, 1000));
  assert.strictEqual(h.hdb, true);
  assert.strictEqual(h.field, "date");
  assert.deepStrictEqual(h.partitions, ["2024.01.01", "2024.01.02", "2024.01.03"]);
  assert.deepStrictEqual(
    h.tables.map((x) => [x.name, x.counts, x.total]),
    [
      ["quote", [2, 4, 1], 7],
      ["trade", [3, 3, 3], 9],
    ],
  );
  assert.deepStrictEqual(h.splayed, [{ name: "ref", rows: 2 }]);
  assert.ok(h.symBytes > 0);
  assert.ok(h.root.endsWith("/db"), h.root);
  const tree = hdbTree(h, "hdb");
  assert.deepStrictEqual(tree.map((n) => [n.label, n.description]).slice(1), [
    ["Partitions", "3 partitions · 2024.01.01 – 2024.01.03"],
    ["Tables", "3"],
  ]);
  assert.strictEqual(tree[1].children[0].description, "quote 1 · trade 3");
  // Only the newest partitions are sent; the totals cover all of them.
  const two = readHdb(await c.call(HDB, 2));
  assert.deepStrictEqual(two.partitions, ["2024.01.02", "2024.01.03"]);
  assert.deepStrictEqual(two.tables.map((x) => x.total), [7, 9]);
  assert.match(hdbTree(two, "hdb")[1].children.at(-1).label, /1 older partition not shown/);
});

// A table missing from one partition (no .Q.chk): .Q.cn fails, so its
// counts are unknown, and so is its total - not 0 rows (#1566).
test("the HDB browser does not call a table missing from a partition empty", { skip }, async (t) => {
  const c = await connect(t, [
    "dir:`$\":$DIR/db\";",
    ".Q.dd[dir;2024.01.01,`quote`] set .Q.en[dir;([]sym:`a`b;bid:1 2f)];",
    ".Q.dd[dir;2024.01.02,`trade`] set .Q.en[dir;([]sym:`a`b`c;px:1 2 3f)];",
    ".Q.dd[dir;2024.01.03,`quote`] set .Q.en[dir;([]sym:`a`b;bid:1 2f)];",
    "system\"l $DIR/db\";",
    "",
  ].join("\n"));
  const h = readHdb(await c.call(HDB, 1000));
  const quote = h.tables.find((x) => x.name === "quote");
  assert.deepStrictEqual([quote.counts, quote.total], [[null, null, null], null]);
});

test("a process with no partitioned database says so", { skip }, async (t) => {
  const c = await connect(t, "a:1\n");
  const h = readHdb(await c.call(HDB, 1000));
  assert.strictEqual(h.hdb, false);
  assert.match(hdbTree(h, "p")[0].label, /no partitioned database/);
});

test("the Process Monitor reads memory, handles, timers and settings", { skip }, async (t) => {
  const c = await connect(t, "\\t 0\n.z.ts:{0N!x}\n.timer.timer:([id:1 2i]period:0D00:01 0D00:05;active:10b;nextrun:2 #.z.P;description:(\"a\";\"b\"));\n");
  const tree = monitorTree(await c.call(MONITOR, null), "p");
  const node = (label) => tree.find((n) => n.label === label);
  assert.deepStrictEqual(tree.map((n) => n.label), ["Process", "Memory", "Handles", "Timers", "Settings"]);
  assert.ok(node("Memory").children.some((n) => n.label === "used"));
  assert.match(node("Memory").description, /used$/);
  // Our own connection is among the handles.
  assert.ok(node("Handles").children.some((n) => /this connection/.test(n.description)), JSON.stringify(node("Handles")));
  const timers = node("Timers").children;
  assert.strictEqual(timers[1].description, "{0N!x}");
  assert.strictEqual(timers.length, 4);
  assert.match(timers[2].description, /^active · every 0D00:01/);
  const settings = Object.fromEntries(node("Settings").children.map((n) => [n.label, n.description]));
  assert.strictEqual(settings["\\t"], "0i");
  assert.strictEqual(settings["\\d"], "`.");
  assert.ok(String(settings["\\p"]).length > 0);
  const about = Object.fromEntries(node("Process").children.map((n) => [n.label, n.description]));
  assert.ok(about.pid.length > 0);
});

// With no TorQ timer table, `cols` of the empty list failed the whole call.
test("the Process Monitor of a process with no TorQ timers, and a long working directory", { skip }, async (t) => {
  const c = await connect(t, "a:1\n");
  const tree = monitorTree(await c.call(MONITOR, null), "p");
  assert.deepStrictEqual(tree.find((n) => n.label === "Timers").children.map((n) => n.label), ["\\t", ".z.ts"]);
  const cd = tree.find((n) => n.label === "Settings").children.find((n) => n.label === "\\cd").description;
  assert.ok(cd.startsWith("/") && !cd.endsWith(".."), cd);
});

// One-character descriptions are char atoms: each its own string, not run
// together into the first job's (#1581).
test("the Timers view keeps each job's one-character description", { skip }, async (t) => {
  const { TIMERS, readTimers } = require("../out/timers.js");
  const c = await connect(t, '.timer.timer:([id:1 2i]period:0D00:01 0D00:05;active:10b;nextrun:2#.z.P;lastrun:2#.z.P;description:("a";"b");funcparam:2#enlist({x};1));\n');
  assert.deepStrictEqual(readTimers(await c.call(TIMERS, null)).jobs.map((j) => j.description), ["a", "b"]);
});
