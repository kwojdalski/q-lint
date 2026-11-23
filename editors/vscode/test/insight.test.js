// The process-insight modules without a process: reading what each call
// answers, the trees and hovers made of it, and the helpers around a
// function's source (#929-#932, #935). funcsource_q.test.js runs the calls
// themselves against a real q.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("../out/funcsource.js");
const { TABLE_INFO, readTableInfo, tableMarkdown, bytes } = require("../out/tableinfo.js");
const { MONITOR, monitorTree, readMonitorInterval } = require("../out/monitor.js");
const { HDB, readHdb, hdbTree } = require("../out/hdb.js");
const { charKinds } = require("../out/explorer.js");

test("only Redefine assigns on the process, and only by the one set it was asked for", () => {
  for (const code of [fs.SOURCE, fs.CALLERS, TABLE_INFO, MONITOR, HDB]) {
    // No global assignment (`x::`) and no `set`; `(::)` is the generic null.
    assert.ok(!/[\w\]]\s*::/.test(code), code);
    assert.ok(!/\bset\b/.test(code), code);
    assert.ok(code.startsWith("{[") && code.endsWith("}"), code);
  }
  assert.strictEqual(fs.REDEFINE.match(/\bset\b/g).length, 1);
  // The process's own context is put back before the assignment.
  assert.ok(fs.REDEFINE.indexOf('system"d ",string d') < fs.REDEFINE.indexOf("nm set"));
});

test("a source and callers are read, and anything else is refused", () => {
  assert.deepStrictEqual(fs.readSource({ type: 100, text: "{x}", ctx: "", params: "x" }), { type: 100, text: "{x}", ctx: "", params: ["x"] });
  assert.throws(() => fs.readSource("nope"), /something other than a function's source/);
  assert.strictEqual(fs.editable({ type: 104 }), false);
  const c = fs.readCallers({ rows: [{ name: "f", params: ["a"], how: "calls" }, { name: "g", params: [], how: "other" }], scanned: 3, more: null });
  assert.deepStrictEqual(c, { callers: [{ name: "f", params: ["a"], how: "calls" }], scanned: 3, more: 0 });
  assert.throws(() => fs.readCallers({}), /something other than its callers/);
});

test("the name under the cursor, dots and all", () => {
  assert.strictEqual(fs.nameAt("r:.ns.f[1]", 5), ".ns.f");
  assert.strictEqual(fs.nameAt("r:.ns.f[1]", 2), ".ns.f");
  assert.strictEqual(fs.nameAt("trade", 5), "trade");
  assert.strictEqual(fs.nameAt("a+ b", 2), undefined);
  assert.strictEqual(fs.nameAt("x:1.5", 3), undefined);
  // A trailing dot is not part of the name.
  assert.strictEqual(fs.nameAt(".ns.", 2), ".ns");
});

test("where a caller uses a name: as code, not in a string or a comment, or by its short name", () => {
  const at = (text, name) => fs.firstUse(text, name, charKinds(text));
  const doc = "/ g on p\n{[x] \"f\";fx:1; f x}";
  assert.strictEqual(at(doc, "f"), doc.lastIndexOf("f x"));
  assert.strictEqual(at("{.ns.h[x]}", ".ns.h"), 1);
  // Defined in .ns, it calls .ns.h as h.
  assert.strictEqual(at("{[x] h x}", ".ns.h"), 5);
  // Named by symbol only.
  assert.strictEqual(at("{value(`f;x)}", "f"), 7);
  assert.strictEqual(at("{x}", "f"), -1);
});

test("a source document names its function, and an edit is read back without the header", () => {
  const doc = fs.sourceDocument(".ns.h", "rdb", { type: 100, text: "{[x] x+lim}", ctx: "ns", params: ["x"] });
  assert.strictEqual(doc, "/ .ns.h on rdb, defined in .ns\n{[x] x+lim}\n");
  assert.strictEqual(fs.sourceDocument("f", "rdb", { type: 100, text: "{x}", ctx: "" }), "/ f on rdb, defined in the root\n{x}\n");
  assert.match(fs.sourceDocument("p", "rdb", { type: 104, text: "{x+y}[1]", ctx: "" }), /not a lambda: not editable/);
  assert.strictEqual(fs.editedText(doc.replace("lim", "lim*2")), "{[x] x+lim*2}");
  // A CRLF editor's lines go to q as a script's would, with LF.
  assert.strictEqual(fs.editedText("{[x]\r\n  x}\r\n\r\n"), "{[x]\n  x}");
  assert.strictEqual(fs.nameFromPath(fs.sourcePath(".ns.h")), ".ns.h");
});

test("Redefine asks first, and warns of a production process as an agent's query does", () => {
  const dev = fs.redefineConfirmation(".ns.h", { label: "rdb", host: "h", port: 1, tags: ["dev"] });
  assert.strictEqual(dev.message, "Redefine .ns.h on rdb?");
  assert.ok(!/production/.test(dev.detail));
  const prod = fs.redefineConfirmation("f", { label: "rdb1", host: "h", port: 1, tags: ["prod", "eu"] });
  assert.match(prod.detail, /^rdb1 is a production process \(tagged prod, eu\)/);
});

const INFO = {
  kind: "table",
  rows: 1234,
  bytes: 2048,
  partitions: null,
  keys: ["id"],
  ncols: 3,
  cols: ["id", "sym_x", "c|d"],
  types: ["j", "s", " "],
  fkeys: ["", "ref", ""],
  attrs: ["u", "g", ""],
};

test("a table's details become a short hover, every name escaped", () => {
  const info = readTableInfo(INFO);
  assert.deepStrictEqual(info.columns[2], { name: "c|d", type: "", fkey: "", attr: "" });
  const md = tableMarkdown("*t*", "rdb_1", info);
  assert.ok(md.startsWith("**\\*t\\*** on rdb\\_1: table, 1,234 rows, 3 columns, 2.0 KB in memory (-22!)"), md);
  assert.match(md, /\| id \(key\) \| `j` \| `u` unique \|  \|/);
  assert.match(md, /\| sym\\_x \| `s` \| `g` grouped \| ref \|/);
  assert.match(md, /\| c\\\|d \|  \|  \|  \|/);
  // Cut to `limit` columns, saying how many more.
  assert.match(tableMarkdown("t", "p", info, 1), /2 more columns not shown/);
  assert.match(tableMarkdown("t", "p", readTableInfo({ ...INFO, kind: "partitioned", bytes: null, partitions: 20 })), /partitioned table, 1,234 rows, 3 columns, 20 partitions, on disk, not measured/);
  assert.throws(() => readTableInfo({ kind: "x" }), /something other than a table's details/);
  assert.deepStrictEqual([bytes(0), bytes(1023), bytes(1536), bytes(5 * 1024 ** 3)], ["0 B", "1023 B", "1.5 KB", "5.0 GB"]);
});

test("the Process Monitor's tree", () => {
  const raw = {
    memory: { key: ["used", "heap", "syms"], value: [1048576, 67108864, 800] },
    handles: { handle: [5, 7], queued: [0, 2048], self: [false, true] },
    timer: "1000i",
    ts: "{0N!x}",
    torq: [{ id: "1i", active: "1b", period: "0D00:01:00.000000000", nextrun: "2026.11.21D10:00:00.000000000", description: "\"flush\"" }],
    settings: { key: ["p", "t"], value: ["5000i", "1000i"] },
    process: { key: ["version", "pid"], value: ["4.1", "123i"] },
  };
  const tree = monitorTree(raw, "rdb");
  assert.deepStrictEqual(
    tree.map((n) => [n.label, n.description]),
    [
      ["Process", "rdb"],
      ["Memory", "1.0 MB used"],
      ["Handles", "2"],
      ["Timers", "\\t 1000i · 1 TorQ"],
      ["Settings", "2"],
    ],
  );
  assert.deepStrictEqual(tree[1].children.map((n) => n.description), ["1.0 MB", "64 MB", "800"]);
  assert.deepStrictEqual(tree[2].children.map((n) => n.description), ["0 B queued", "2.0 KB queued · this connection"]);
  assert.strictEqual(tree[3].children[2].description, "active · every 0D00:01:00.000000000 · next 2026.11.21D10:00:00.000000000");
  assert.deepStrictEqual(tree[4].children[0], { label: "\\p", description: "5000i", tooltip: "listening port" });
  assert.throws(() => monitorTree(null, "p"), /something other than its state/);
});

test("the Monitor's interval is whole seconds, at least one, or never", () => {
  const read = (v) => readMonitorInterval((key, fallback) => (key === "processMonitor.refreshInterval" ? v : fallback));
  assert.deepStrictEqual([read(undefined), read(0), read(0.5), read(5), read(7.9), read("5"), read(-3)], [0, 0, 0, 5, 7, 0, 0]);
});

// A hand-edited interval of 2147484 s or more overflowed setInterval,
// which Node then ran every millisecond.
test("the Monitor's interval is at most an hour, as the setting declares (#1110)", () => {
  const read = (v) => readMonitorInterval((key, fallback) => (key === "processMonitor.refreshInterval" ? v : fallback));
  assert.deepStrictEqual([read(3600), read(3601), read(3000000), read(Infinity)], [3600, 3600, 3600, 0]);
});

test("the HDB browser's tree, newest partition first", () => {
  const h = readHdb({
    hdb: true,
    pf: "date",
    root: "/data/hdb",
    segments: [":/d1", ":/d2"],
    symbytes: 4096,
    npart: 3,
    parts: ["2024.01.02", "2024.01.03"],
    tables: ["trade"],
    counts: [5, 0],
    totals: [12],
    others: ["ref"],
    otherrows: [2],
  });
  // One table's counts may come flat.
  assert.deepStrictEqual(h.tables, [{ name: "trade", counts: [5, 0], total: 12 }]);
  const [database, partitions, tables] = hdbTree(h, "hdb");
  assert.deepStrictEqual(database.children.map((n) => [n.label, n.description]), [
    ["partition field", "date"],
    ["root", "/data/hdb"],
    ["partitions", "3 partitions"],
    ["sym file", "4.0 KB"],
    ["segments", "2"],
  ]);
  assert.deepStrictEqual(database.children[4].children.map((n) => n.label), ["/d1", "/d2"]);
  assert.strictEqual(partitions.description, "3 partitions · … 2024.01.03");
  assert.deepStrictEqual(partitions.children.map((n) => [n.label, n.description]), [
    ["2024.01.03", "trade 0"],
    ["2024.01.02", "trade 5"],
    ["1 older partition not shown", undefined],
  ]);
  assert.deepStrictEqual(tables.children.map((n) => n.description), ["partitioned · 12 rows · empty in 1 partition shown", "splayed · 2 rows"]);
  assert.deepStrictEqual(hdbTree(readHdb({ hdb: false, root: "/tmp" }), "p").map((n) => n.label), ["p has no partitioned database loaded"]);
  assert.throws(() => readHdb({}), /something other than its database/);
});
