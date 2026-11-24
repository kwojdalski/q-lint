// The database features' q against a real process (#1022-#1029), each on a
// database this file writes into a temporary directory: the column
// manager's script changes every partition and reloads; the documenter,
// the partition check, the sym inspector, the attribute advisor and the
// test data generator read what they say they read; and the tickerplant
// log is read and replayed. Needs a q binary, so it runs only when
// QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");
const { columnScript, HELPERS, RUN_SCRIPT, readRun } = require("../out/colmanager.js");
const { DOCUMENT, readDoc, docMarkdown } = require("../out/dbdoc.js");
const { PARTITION_CHECK, readPartitions, partitionProblems } = require("../out/partcheck.js");

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

/// A q process running `source` in a fresh directory (`$DIR` in the source
/// is it), listening on a free port.
async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-db-"));
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
        dir,
        port,
        stop: () => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
          fs.rmSync(dir, { recursive: true, force: true });
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
  return { connection, dir: q.dir };
}

/// Write a partitioned database under $DIR/hdb and load it. `extra` runs
/// after the partitions are written, before the load.
const HDB = (extra = "") =>
  [
    'r:hsym`$"$DIR/hdb";',
    "mk:{[r;d;n] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:asc n#`a`b`c;px:n#1 2 3f;sz:n#10 20 30)};",
    "mk[r;;6] each 2026.01.05 2026.01.06 2026.01.07;",
    "{[r;d] .Q.dd[r;d,`quote`] set .Q.en[r] ([] sym:`a`b;bid:1 2f)}[r] each 2026.01.05 2026.01.06 2026.01.07;",
    extra,
    '\\l $DIR/hdb',
    ".lib.add:{[a;b] a+b}",
    "",
  ].join("\n");

const run = async (connection, script) => {
  const answer = readRun(await connection.call(RUN_SCRIPT, statements(script)));
  assert.ok(answer.ok, answer.error);
  return answer.text;
};

test("the column manager's script changes every partition, reports, reloads and leaves nothing behind", { skip }, async (t) => {
  const { connection } = await connect(t, HDB());
  const say = await run(connection, columnScript("trade", { op: "add", column: "ex", value: "`NYSE" }, "hdb"));
  assert.match(say, /changed 3 of 3 directories/);
  await run(connection, columnScript("trade", { op: "rename", column: "px", to: "price" }, "hdb"));
  await run(connection, columnScript("trade", { op: "cast", column: "sz", type: "f" }, "hdb"));
  await run(connection, columnScript("trade", { op: "attr", column: "sym", attr: "p" }, "hdb"));
  await run(connection, columnScript("trade", { op: "delete", column: "ex" }, "hdb"));
  await run(connection, columnScript("trade", { op: "reorder", order: ["price", "sym", "sz"] }, "hdb"));
  assert.deepStrictEqual(await connection.call("{exec c from meta trade}", 0), ["date", "price", "sym", "sz"]);
  assert.deepStrictEqual(await connection.call("{exec t from meta trade}", 0), "dfsf");
  assert.strictEqual(await connection.call("{attr get ` sv .Q.par[hsym`$system\"cd\";first .Q.pv;`trade],`sym}", 0), "p");
  assert.strictEqual(await connection.call("{\"f\"$count select from trade}", 0), 18);
  // A column that is not there: every directory is left as it was, and named.
  const none = await run(connection, columnScript("trade", { op: "delete", column: "nope" }, "hdb"));
  assert.match(none, /changed 0 of 3 directories; left as they were: .*no nope/);
  // A symbol default is enumerated against the sym file, which it extends.
  await run(connection, columnScript("trade", { op: "add", column: "venue", value: "`XLON" }, "hdb"));
  assert.strictEqual(await connection.call("{\"f\"$count select from trade where venue=`XLON}", 0), 18);
  assert.ok((await connection.call("{get`:sym}", 0)).includes("XLON"));
  assert.strictEqual(await connection.call("{`cm in key`.qlint}", 0), false);
  // A script that fails says why, and leaves no helpers behind either.
  const failed = readRun(await connection.call(RUN_SCRIPT, statements(columnScript("nosuch", { op: "delete", column: "x" }, "hdb"))));
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(await connection.call("{`cm in key`.qlint}", 0), false);
});

test("under a .Q.view the column manager changes no partition and says why; the view cleared, it changes them all (#1959)", { skip }, async (t) => {
  const { connection } = await connect(t, HDB());
  const dotd = () => connection.call("{string get each ` sv'(hsym each `$string .Q.PV),\\:`trade`.d}", 0);
  const before = await dotd();
  assert.deepStrictEqual(await connection.call("{.Q.view 2026.01.06; string .Q.pv}", 0), ["2026.01.06"]);
  // An add, and a migration's steps, stop before the first change.
  for (const op of [{ op: "add", column: "extra", value: "0n" }, { op: "delete", column: "sz" }]) {
    const refused = readRun(await connection.call(RUN_SCRIPT, statements(columnScript("trade", op, "hdb"))));
    assert.strictEqual(refused.ok, false, JSON.stringify(refused));
    assert.match(refused.error, /^\.Q\.view is in force, showing 1 of 3 partitions: nothing was changed\. .*clear it with \.Q\.view\[\] and run again$/);
  }
  assert.deepStrictEqual(await dotd(), before);
  // The view is still the process's, the helpers gone, and every partition selects.
  assert.deepStrictEqual(await connection.call("{string .Q.pv}", 0), ["2026.01.06"]);
  assert.strictEqual(await connection.call("{`cm in key`.qlint}", 0), false);
  assert.strictEqual(await connection.call('{.Q.view[]; "f"$count select from trade}', 0), 18);
  const say = await run(connection, columnScript("trade", { op: "add", column: "extra", value: "0n" }, "hdb"));
  assert.match(say, /changed 3 of 3 directories/);
  assert.strictEqual(await connection.call('{"f"$count select extra from trade where date in 2026.01.05 2026.01.07}', 0), 12);
  // A splayed table is under no view: it changes as before.
  const { connection: flat } = await connect(t, 'r:hsym`$"$DIR/sp";\n(` sv r,`one`) set .Q.en[r] ([] sym:`a`b; px:1 2f);\n\\l $DIR/sp\n');
  assert.match(await run(flat, columnScript("one", { op: "add", column: "extra", value: "0n" }, "sp")), /changed 1 of 1 directories/);
});

test("the column manager's add with a list default gives every row that list (#1082)", { skip }, async (t) => {
  const { connection } = await connect(t, HDB());
  assert.match(await run(connection, columnScript("trade", { op: "add", column: "note", value: '""' }, "hdb")), /changed 3 of 3 directories/);
  assert.strictEqual(await connection.call("{exec t from meta trade where c=`note}", 0), "C");
  assert.strictEqual(await connection.call("{\"f\"$count select from trade where note~\\:\"\"}", 0), 18);
  await run(connection, columnScript("trade", { op: "add", column: "n", value: "0" }, "hdb"));
  assert.strictEqual(await connection.call("{exec t from meta trade where c=`n}", 0), "j");
});

test("the column manager renames under a root with a space and a quote in its path (#1083)", { skip }, async (t) => {
  const source = [
    'r:hsym`$"$DIR/it\'s a db";',
    "{[r;d] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:`a`b;px:1 2f;s:(\"xa\";\"yb\"))}[r] each 2026.01.05 2026.01.06;",
    'system "cd $DIR/it\'s a db";',
    'system "l .";',
    "",
  ].join("\n");
  const { connection } = await connect(t, source);
  assert.match(await run(connection, columnScript("trade", { op: "rename", column: "px", to: "price" }, "hdb")), /changed 2 of 2 directories/);
  assert.match(await run(connection, columnScript("trade", { op: "rename", column: "s", to: "note" }, "hdb")), /changed 2 of 2 directories/);
  assert.deepStrictEqual(await connection.call("{exec c from meta trade}", 0), ["date", "sym", "price", "note"]);
  assert.strictEqual(await connection.call("{exec t from meta trade where c=`note}", 0), "C");
  assert.strictEqual(await connection.call("{\"f\"$count select from trade where note like \"[xy]?\"}", 0), 4);
});

test("the column manager parses string and symbol columns it casts to numbers (#1135)", { skip }, async (t) => {
  const source = [
    'r:hsym`$"$DIR/db";',
    '{[r;d] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:`a`b;q:("12";"3");p:`7`8;w:("ab";"c"))}[r] each 2026.01.05 2026.01.06;',
    'system "cd $DIR/db";',
    'system "l .";',
    "",
  ].join("\n");
  const { connection } = await connect(t, source);
  for (const [column, type] of [["q", "j"], ["p", "f"], ["w", "s"]]) {
    assert.match(await run(connection, columnScript("trade", { op: "cast", column, type }, "hdb")), /changed 2 of 2 directories/);
  }
  assert.deepStrictEqual(await connection.call("{exec t from meta trade}", 0), "dsjfs");
  assert.deepStrictEqual(await connection.call('{"f"$(select q from trade)`q}', 0), [12, 3, 12, 3]);
  assert.deepStrictEqual(await connection.call("{(select p from trade)`p}", 0), [7, 8, 7, 8]);
  assert.deepStrictEqual(await connection.call("{string (select w from trade)`w}", 0), ["ab", "c", "ab", "c"]);
  // The string column's nested data file goes with it.
  assert.strictEqual(await connection.call('{(`$"q#") in key .Q.par[hsym`$system"cd";first .Q.pv;`trade]}', 0), false);
});

// A table or column whose name is no plain name is written as `$"..." (#1569).
test("the column manager changes a table and columns whose names have a space", { skip }, async (t) => {
  const source = [
    'r:hsym`$"$DIR/db";',
    '{[r;d] .Q.dd[r;d,(`$"my trade"),`] set .Q.en[r] flip(`sym;`$"px bid";`$"sz ask")!(`a`b;1 2f;3 4)}[r] each 2026.01.05 2026.01.06;',
    'system "cd $DIR/db";',
    'system "l .";',
    "",
  ].join("\n");
  const { connection } = await connect(t, source);
  const ops = [
    { op: "cast", column: "sz ask", type: "f" },
    { op: "attr", column: "sym", attr: "g" },
    { op: "reorder", order: ["sz ask", "px bid", "sym"] },
    { op: "delete", column: "px bid" },
  ];
  for (const op of ops) {
    assert.match(await run(connection, columnScript("my trade", op, "hdb")), /changed 2 of 2 directories/, JSON.stringify(op));
  }
  assert.deepStrictEqual(await connection.call('{exec c from meta get`$"my trade"}', 0), ["date", "sz ask", "sym"]);
  assert.deepStrictEqual(await connection.call('{exec t from meta get`$"my trade"}', 0), "dfs");
});

test("the column manager's rename command quotes for sh, and for cmd with backslashes (#1137)", { skip }, async (t) => {
  const { connection } = await connect(t, "");
  const mvcmd = HELPERS.find((h) => h.startsWith(".qlint.cm.mvcmd:")).slice(".qlint.cm.mvcmd:".length);
  const mv = (w, a, b) => connection.call(`{${mvcmd}[${w};hsym\`$"${a}";hsym\`$"${b}"]}`, 0);
  assert.strictEqual(await mv("0b", "/d/it's a/px", "/d/it's a/price"), String.raw`mv '/d/it'\''s a/px' '/d/it'\''s a/price'`);
  assert.strictEqual(await mv("1b", "C:/my db/trade/px", "C:/my db/trade/price"), String.raw`move "C:\my db\trade\px" "C:\my db\trade\price"`);
});

test("the documenter reads tables, keys, foreign keys and functions", { skip }, async (t) => {
  const { connection } = await connect(t, HDB() + "\ns:([sym:`a`b] nm:(\"x\";\"y\"))\nf:([] sym:`s$`a`b`a; v:1 2 3)\nkt:([k:1 2] v:`p#`x`x)\n");
  const doc = readDoc(await connection.call(DOCUMENT, 100));
  assert.strictEqual(doc.field, "date");
  assert.strictEqual(doc.partitions, 3);
  const byName = Object.fromEntries(doc.tables.map((x) => [x.name, x]));
  assert.strictEqual(byName.trade.kind, "partitioned");
  assert.strictEqual(byName.trade.rows, 18);
  assert.deepStrictEqual(byName.s.keys, ["sym"]);
  assert.strictEqual(byName.f.columns.find((c) => c.name === "sym").fkey, "s");
  assert.strictEqual(byName.kt.columns.find((c) => c.name === "v").attr, "p");
  assert.ok(doc.functions.some((f) => f.name === ".lib.add" && f.params.join() === "a,b"));
  const text = docMarkdown(doc, "hdb", "now", new Map([[".lib.add", "Adds."]]));
  assert.match(text, /### \.lib\.add\[a;b\]\n\nAdds\./);
});

// Only a lambda's parameters are its own: a projection's bound argument or
// a composition's part is none (#1575).
test("the documenter gives a projection and a composition no parameters", { skip }, async (t) => {
  const { connection } = await connect(t, "add:{[a;b] a+b}\nprj:{x+y}[100]\ncmp:neg abs::\n");
  const params = Object.fromEntries(readDoc(await connection.call(DOCUMENT, 100)).functions.map((f) => [f.name, f.params]));
  assert.deepStrictEqual([params.add, params.prj, params.cmp], [["a", "b"], [], []]);
});

// KDB-X's own .s namespace (its SQL) is not the process's (#1576).
test("the documenter leaves out q's own namespaces, .s too", { skip }, async (t) => {
  const { connection } = await connect(t, "x:1\n");
  assert.deepStrictEqual(readDoc(await connection.call(DOCUMENT, 100)).functions.filter((f) => /^\.[qQhjozms]\./.test(f.name)), []);
});

// A dictionary at a dotted top-level name is in key` like a namespace, and
// \f of it signals: it costs its own functions, not the document (#1867).
test("the documenter survives a plain dictionary at a dotted top-level name (#1867)", { skip }, async (t) => {
  const { connection } = await connect(t, "t:([] a:1 2)\nadd:{[a;b] a+b}\n.lib.f:{[x] x}\n.dd:`x`y!1 2\n.cfg:(`$())!()\n.one:(enlist`a)!enlist 1\n.fd:`f`g!({x};{y})\n");
  const doc = readDoc(await connection.call(DOCUMENT, 100));
  assert.deepStrictEqual(doc.tables.map((x) => x.name), ["t"]);
  const names = doc.functions.map((f) => f.name);
  assert.ok(names.includes("add") && names.includes(".lib.f"), names.join());
  assert.deepStrictEqual(names.filter((n) => /^\.(dd|cfg|one)\./.test(n)), []);
  assert.deepStrictEqual((await connection.evaluate("(.dd~`x`y!1 2;key`.)")).value, [true, ["t", "add"]]);
});

// A table whose enumeration domain is gone cannot be described: meta of it
// signals. It costs that table's entry, as in the schema diagram (#1868).
test("the documenter says which table it could not read, and documents the rest (#1868)", { skip }, async (t) => {
  const { connection } = await connect(t, "t:([] a:1 2)\nsym2:`a`b\nem:([] s:`sym2$`a`b`a)\nkt:([k:1 2] v:3 4)\ndelete sym2 from `.\nadd:{[a;b] a+b}\n");
  const doc = readDoc(await connection.call(DOCUMENT, 100));
  assert.deepStrictEqual(doc.tables.map((x) => [x.name, x.error ?? ""]), [["em", "..sym2"], ["kt", ""], ["t", ""]]);
  assert.deepStrictEqual(doc.tables[0].columns, []);
  assert.deepStrictEqual(doc.tables[2].columns, [{ name: "a", type: "j", fkey: "", attr: "" }]);
  assert.deepStrictEqual(doc.functions, [{ name: "add", params: ["a", "b"] }]);
  assert.match(docMarkdown(doc, "rdb", "now"), /### em\n\nNot read: \.\.sym2\.\n\n### kt\n/);
  // Every table unreadable is still a document, and one alone still a list.
  await connection.evaluate("delete t,kt from `.");
  const alone = readDoc(await connection.call(DOCUMENT, 100));
  assert.deepStrictEqual(alone.tables.map((x) => [x.name, x.error]), [["em", "..sym2"]]);
});

// #2007: a partition holding no rows of a table with a string or a nested
// column - a quiet day, or a table .Q.chk filled in - is a healthy one: q
// writes those columns as an empty general list there.
test("the partition check takes an empty partition's string and nested columns as the table's (#2007)", { skip }, async (t) => {
  const extra = [
    'mke:{[r;d;t;n] .Q.dd[r;d,t,`] set .Q.en[r] ([] sym:n#`a`b`c;note:n#("x";"yy";"zzz");tags:n#(1 2;3 4 5;enlist 6))};',
    "mke[r;;`ev;3] each 2026.01.05 2026.01.07;",
    "mke[r;2026.01.06;`ev;0];",
    "mke[r;;`filled;3] each 2026.01.05 2026.01.07;",
    ".Q.chk r;",
  ].join("\n");
  const { connection } = await connect(t, HDB(extra));
  assert.deepStrictEqual(await connection.call('{"f"$(count select from ev;count select from filled where date=2026.01.06)}', 0), [6, 0]);
  const problems = partitionProblems(readPartitions(await connection.call(PARTITION_CHECK, 1000, true)));
  assert.deepStrictEqual(problems.filter((p) => p.kind !== "row count").map((p) => [p.kind, p.what, p.partitions]), []);
  assert.deepStrictEqual(problems.map((p) => [p.table, p.partitions]).sort(), [["ev", ["2026.01.06"]], ["filled", ["2026.01.06"]]]);
});

test("the partition check finds missing dates, files, differing types and outliers", { skip }, async (t) => {
  const extra = [
    "mk[r;;6] each 2026.01.12 2026.01.13;",
    "mk[r;2026.01.14;5000];",
    "{[r;d] .Q.dd[r;d,`quote`] set .Q.en[r] ([] sym:`a`b;bid:1 2f)}[r] each 2026.01.12 2026.01.13 2026.01.14;",
    "hdel .Q.dd[r;2026.01.13,`trade`px];",
    ".Q.dd[r;2026.01.12,`trade`sz] set 6#1 2 3i;",
  ].join("\n");
  const { connection } = await connect(t, HDB(extra));
  const answer = readPartitions(await connection.call(PARTITION_CHECK, 1000, true));
  assert.strictEqual(answer.hdb, true);
  assert.deepStrictEqual(answer.tables.sort(), ["quote", "trade"]);
  const problems = partitionProblems(answer);
  const kinds = (k) => problems.filter((p) => p.kind === k);
  assert.deepStrictEqual(kinds("missing dates")[0].partitions, ["2026.01.08", "2026.01.09"]);
  assert.deepStrictEqual(kinds("missing column file")[0].partitions, ["2026.01.13"]);
  assert.match(kinds("different types")[0].what, /trade\.sz is type 6 here, 7/);
  assert.deepStrictEqual(kinds("different types")[0].partitions, ["2026.01.12"]);
  assert.match(kinds("row count")[0].partitions[0], /2026\.01\.14 \(5,000\)/);
  assert.strictEqual(kinds("enumeration").length, 0);
  // Two enum domains of different sizes are each held to their own; an
  // index past its domain's end is found (#1103).
  const twoDomains = [
    'r:hsym`$"$DIR/two";sym:`$string til 1000;src:`x`y`z;',
    "(` sv r,`sym) set sym;(` sv r,`src) set src;",
    "{[r;d] .Q.dd[r;d,`trade`] set ([] sym:`sym$`$string 999 1 2;src:`src$`x`y`z)}[r] each 2026.01.05 2026.01.06;",
    ".Q.dd[r;2026.01.06,`trade`src] set `src!0 1 5;",
    "\\l $DIR/two",
    "",
  ].join("\n");
  const { connection: two } = await connect(t, twoDomains);
  const enumerations = partitionProblems(readPartitions(await two.call(PARTITION_CHECK, 1000, true))).filter((p) => p.kind === "enumeration");
  assert.deepStrictEqual(enumerations.map((p) => [p.what, p.partitions]), [["trade.src has a symbol index past the end of src", ["2026.01.06"]]]);
  // A nested column's # data file gone is a missing file (#1577).
  const { connection: nested } = await connect(t, HDB('{[r;d] .Q.dd[r;d,`book`] set .Q.en[r] ([] sym:`a`b;sz:(1 2;3 4 5))}[r] each 2026.01.05 2026.01.06 2026.01.07;\nhdel .Q.dd[r;2026.01.06,`book,`$"sz#"];'));
  const gone = partitionProblems(readPartitions(await nested.call(PARTITION_CHECK, 1000, false))).filter((p) => p.table === "book");
  assert.deepStrictEqual(gone.map((p) => [p.kind, p.what, p.partitions]), [["missing column file", "book.sz has no sz# data file", ["2026.01.06"]]]);
  // A .Q.view hides no partition from the check: the file gone from one it
  // does not show is found, and every partition on disk is counted (#1959).
  await connection.call("{.Q.view 2026.01.05 2026.01.06}", 0);
  const viewed = readPartitions(await connection.call(PARTITION_CHECK, 1000, false));
  assert.strictEqual(await connection.call('{"f"$count .Q.pv}', 0), 2);
  assert.deepStrictEqual([viewed.all.length, viewed.checked], [6, 6]);
  assert.deepStrictEqual(partitionProblems(viewed).filter((p) => p.kind === "missing column file").map((p) => p.partitions), [["2026.01.13"]]);
  assert.deepStrictEqual([...viewed.domains.keys()], ["sym"]);
  // One table in one partition is healthy (#1102).
  const { connection: lone } = await connect(t, 'r:hsym`$"$DIR/one";\n.Q.dd[r;2026.01.05,`trade`] set .Q.en[r] ([] sym:`a`b;px:1 2f);\n\\l $DIR/one\n');
  assert.deepStrictEqual(partitionProblems(readPartitions(await lone.call(PARTITION_CHECK, 1000, true))), []);
  // A process with no database says so.
  const { connection: plain } = await connect(t, "a:1\n");
  assert.strictEqual(readPartitions(await plain.call(PARTITION_CHECK, 1000, false)).hdb, false);
});

const { SYM_INSPECT, readSym, symReport } = require("../out/syminspect.js");
const { ATTRIBUTE_SAMPLE, readAttributeSample, advise } = require("../out/attradvice.js");
const { TABLE_INFO, readTableInfo } = require("../out/tableinfo.js");
const { testDataQ, testDataCsv, loadTypes } = require("../out/testdata.js");
const { migrationScript } = require("../out/migrate.js");
const { TPLOG_INIT, readOthers, readTpLog, readTpPage, readReplayed } = require("../out/tplog.js");

test("the sym inspector counts the file, its columns' shares and its growth", { skip }, async (t) => {
  const extra = [
    "{[r;d;s] .Q.dd[r;d,`orders`] set .Q.en[r] ([] sym:s;oid:`$string til count s)}[r]'[2026.01.05 2026.01.06 2026.01.07 2026.01.08 2026.01.09;(`a;`a;`a`b;`a`b;`a`b`c`d)];",
  ].join("\n");
  const { connection } = await connect(t, HDB(extra).replace("mk[r;;6] each 2026.01.05 2026.01.06 2026.01.07;", "mk[r;;6] each 2026.01.05 2026.01.06 2026.01.07 2026.01.08 2026.01.09;").replace("each 2026.01.05 2026.01.06 2026.01.07;\n", "each 2026.01.05 2026.01.06 2026.01.07 2026.01.08 2026.01.09;\n"));
  const answer = readSym(await connection.call(SYM_INSPECT, 20));
  assert.strictEqual(answer.sym, true);
  assert.ok(answer.count >= 8, `count ${answer.count}`);
  assert.ok(answer.bytes > 0);
  const oid = answer.columns.find((c) => c.table === "orders" && c.column === "oid");
  assert.ok(oid !== undefined, JSON.stringify(answer.columns));
  assert.strictEqual(oid.distinct, 4);
  assert.ok(answer.growth.length >= 2);
  assert.ok(answer.growth.at(-1).size >= answer.growth[0].size);
  assert.match(symReport(answer, "hdb", 5), /Warning/);
  assert.doesNotMatch(symReport(answer, "hdb", 1e6), /Warning/);
  const { connection: plain } = await connect(t, "a:1\n");
  assert.strictEqual(readSym(await plain.call(SYM_INSPECT, 20)).sym, false);
});

// A null symbol is no entry of the file, and a partition of no symbols
// (empty, or all null) says nothing of its size (#1567, #1568).
test("the sym inspector leaves out null symbols and partitions that hold none", { skip }, async (t) => {
  const { connection } = await connect(t, [
    'r:hsym`$"$DIR/e";',
    ".Q.dd[r;2026.01.05,`trade`] set .Q.en[r] ([] sym:`x`y`z``;px:1 2 3 4 5f);",
    ".Q.dd[r;2026.01.06,`trade`] set .Q.en[r] ([] sym:`$();px:`float$());",
    ".Q.dd[r;2026.01.07,`trade`] set .Q.en[r] ([] sym:``;px:1 2f);",
    "\\l $DIR/e",
    "",
  ].join("\n"));
  const answer = readSym(await connection.call(SYM_INSPECT, 20));
  assert.strictEqual(answer.count, 3);
  assert.deepStrictEqual(answer.columns.map((c) => [c.table, c.column, c.distinct]), [["trade", "sym", 3]]);
  assert.deepStrictEqual(answer.growth, [{ partition: "2026.01.05", size: 3 }]);
  assert.doesNotMatch(symReport(answer, "hdb", 1e6), /-9,223|133/);
});

test("the attribute advisor samples a table's columns without changing it", { skip }, async (t) => {
  const { connection } = await connect(t, HDB() + "\nm:([] time:asc 1000?0D; sym:1000?`a`b`c; id:til 1000; px:1000?1f)\n");
  const s = readAttributeSample(await connection.call(ATTRIBUTE_SAMPLE, "m", 100000));
  assert.strictEqual(s.kind, "table");
  assert.strictEqual(s.rows, 1000);
  const byName = Object.fromEntries(s.columns.map((c) => [c.name, c]));
  assert.strictEqual(byName.time.sorted, true);
  assert.strictEqual(byName.sym.distinct, 3);
  assert.strictEqual(byName.id.distinct, 1000);
  const advice = Object.fromEntries(advise(s, new Map([["sym", 2], ["id", 1]])).map((a) => [a.column, a.suggest]));
  assert.deepStrictEqual(advice, { time: "s", sym: "g", id: "s", px: "" });
  const p = readAttributeSample(await connection.call(ATTRIBUTE_SAMPLE, "trade", 100000));
  assert.strictEqual(p.kind, "partitioned");
  assert.strictEqual(p.rows, 18);
  assert.strictEqual(p.sampled, 6);
  assert.deepStrictEqual(p.columns.map((c) => c.name), ["sym", "px", "sz"]);
  assert.strictEqual(advise(p, new Map([["sym", 1]]))[0].suggest, "s");
  assert.strictEqual(await connection.call("{(attr m`sym)~`}", 0), true);
});

// `asc` marks a vector already in order `s#` where it is, and a table
// sampled whole is its own columns: the advisor must not set what it then
// reports (#1863).
test("the attribute advisor leaves a sorted column of the table without s# (#1863)", { skip }, async (t) => {
  const { connection } = await connect(t, "m:([] time:09:00 09:01 09:02; id:til 3; sym:`c`a`b)\nkt:([k:1 3 5] v:10 30 50)\n");
  const state = "{(attr each flip m;attr each flip key kt;attr each flip value kt;raze string md5 `char$raze -8!'(m;kt))}";
  const before = await connection.call(state, 0);
  assert.deepStrictEqual(before.slice(0, 3), [{ time: null, id: null, sym: null }, { k: null }, { v: null }]);
  for (const name of ["m", "kt"]) {
    const s = readAttributeSample(await connection.call(ATTRIBUTE_SAMPLE, name, 100000));
    assert.deepStrictEqual(s.columns.map((c) => [c.sorted, c.attr]), name === "m" ? [[true, ""], [true, ""], [false, ""]] : [[true, ""], [true, ""]]);
  }
  assert.deepStrictEqual(await connection.call(state, 0), before);
});

test("the attribute advisor refuses a view by its name, and does not evaluate it (#1865)", { skip }, async (t) => {
  const { connection } = await connect(t, "m:([] id:til 3)\nspy::select from m\n");
  await assert.rejects(connection.call(ATTRIBUTE_SAMPLE, "spy", 100000), /a view, not a table/);
  assert.deepStrictEqual(await connection.call('{[x] string system"B"}', 0), ["spy"]);
});

test("the test data generator's q makes the rows asked for, and its CSV loads back", { skip }, async (t) => {
  const { connection, dir } = await connect(t, "t:([k:`symbol$()] time:`timestamp$(); px:`float$(); qty:`long$(); d:`date$(); note:())\n");
  const info = readTableInfo(await connection.call(TABLE_INFO, "t", 100));
  info.columns.find((c) => c.name === "note").type = "C";
  const options = { rows: 50, symbols: ["AAPL", "MSFT"], low: 10, high: 20, sorted: "time", seed: 7 };
  const q = testDataQ(info, "gen", options);
  const ran = readRun(await connection.call(RUN_SCRIPT, statements(q)));
  assert.ok(ran.ok, ran.error);
  assert.deepStrictEqual(await connection.call("{exec t from meta gen}", 0), "spfjdC");
  // Keyed by k, drawn from two symbols: one row a key, never two (#1282).
  assert.strictEqual(await connection.call('{"f"$count gen}', 0), 2);
  assert.strictEqual(await connection.call("{count[gen]=count distinct key gen}", 0), true);
  assert.strictEqual(await connection.call("{all 10<=exec px from gen}", 0), true);
  assert.strictEqual(await connection.call("{(exec time from gen)~asc exec time from gen}", 0), true);
  assert.deepStrictEqual(await connection.call("{asc distinct exec k from gen}", 0), ["AAPL", "MSFT"]);
  fs.writeFileSync(path.join(dir, "gen.csv"), testDataCsv(info, options));
  const loaded = await connection.call(`{c:("${loadTypes(info)}";enlist",")0:\`:gen.csv; (count c;exec t from meta c;all 10<=c\`px;c[\`time]~asc c\`time)}`, 0);
  assert.strictEqual(Number(loaded[0]), 50);
  assert.strictEqual(loaded[1], "spfjdC");
  assert.strictEqual(loaded[2], true);
  assert.strictEqual(loaded[3], true);
});

test("the test data generator's q takes symbols a bare symbol cannot write (#1279)", { skip }, async (t) => {
  const { connection } = await connect(t, "");
  const info = { kind: "table", rows: 0, bytes: null, partitions: null, keys: [], ncols: 1, columns: [{ name: "s", type: "s", fkey: "", attr: "" }] };
  for (const symbols of [["a/b", "c:d/e", "_f", "g"], ["x/y"]]) {
    const ran = readRun(await connection.call(RUN_SCRIPT, statements(testDataQ(info, "gen", { rows: 40, symbols, low: 0, high: 1, seed: 2 }))));
    assert.ok(ran.ok, ran.error);
    assert.deepStrictEqual([].concat(await connection.call("{string asc distinct exec s from gen}", 0)).flat().map(String), [...symbols].sort());
  }
});

// A range past a short's or an int's bounds is cut to them, not every
// value 0W (#1580).
test("the test data generator's shorts and ints stay in their type's range", { skip }, async (t) => {
  const { connection } = await connect(t, "");
  const info = { kind: "table", rows: 0, bytes: null, partitions: null, keys: [], ncols: 2, columns: [{ name: "h", type: "h", fkey: "", attr: "" }, { name: "i", type: "i", fkey: "", attr: "" }] };
  for (const [low, high] of [[40000, 70000], [-3000000000, -2999999990], [-1e10, 1e10]]) {
    const ran = readRun(await connection.call(RUN_SCRIPT, statements(testDataQ(info, "gen", { rows: 40, symbols: ["a"], low, high, seed: 2 }))));
    assert.ok(ran.ok, ran.error);
    assert.strictEqual(await connection.call("{h:exec h from gen;i:exec i from gen;all(not null h),(not null i),(abs[h]<0Wh),abs[i]<0Wi}", 0), true, `${low} ${high}`);
  }
});

// A range past what a long holds made q that q could not read, or a
// column of floats (#1904).
test("the test data generator's longs are longs whatever the range", { skip }, async (t) => {
  const { connection } = await connect(t, "");
  const info = { kind: "table", rows: 0, bytes: null, partitions: null, keys: [], ncols: 1, columns: [{ name: "j", type: "j", fkey: "", attr: "" }] };
  for (const [low, high] of [[0, 1e19], [0, 1e21], [-1e21, 1e21], [1e25, 1e26]]) {
    const ran = readRun(await connection.call(RUN_SCRIPT, statements(testDataQ(info, "gen", { rows: 40, symbols: ["a"], low, high, seed: 2 }))));
    assert.ok(ran.ok, `${low} ${high}: ${ran.error}`);
    assert.strictEqual(await connection.call("{j:exec j from gen;(7h=type j)&all(not null j)&abs[j]<0W}", 0), true, `${low} ${high}`);
  }
});

// A table or column name q cannot parse is written by its symbol (#1583).
test("the test data generator and a migration in memory write names with a space", { skip }, async (t) => {
  const { connection } = await connect(t, '(`$"my t") set ([] a:1 2);\ntgt:([] a:1 2; b:3 4);\nw:flip(`$("px bid";"a"))!(1 2f;3 4);\n');
  const info = async (n) => readTableInfo(await connection.call(TABLE_INFO, n, 100));
  const o = { rows: 3, symbols: ["A"], low: 0, high: 1, seed: 1 };
  for (const [table, name] of [["my t", "my t"], ["w", "w2"]]) {
    const ran = readRun(await connection.call(RUN_SCRIPT, statements(testDataQ(await info(table), name, o))));
    assert.ok(ran.ok, ran.error);
  }
  assert.deepStrictEqual(await connection.call('{("f"$count get`$"my t";cols w2)}', 0), [3, ["px bid", "a"]]);
  const ran = readRun(await connection.call(RUN_SCRIPT, statements(migrationScript("my t", await info("my t"), "my t", await info("tgt"), "tgt", "p"))));
  assert.ok(ran.ok, ran.error);
  assert.deepStrictEqual(await connection.call('{cols get`$"my t"}', 0), ["a", "b"]);
  // An added column q-sql cannot name, then ordered and keyed by (#1719).
  await connection.call('{w3::(`$"new c") xkey flip(`$("new c";"a"))!(`long$();`long$())}', 0);
  const added = readRun(await connection.call(RUN_SCRIPT, statements(migrationScript("my t", await info("my t"), "my t", await info("w3"), "w3", "p"))));
  assert.ok(added.ok, added.error);
  assert.deepStrictEqual(await connection.call('{(cols get`$"my t";keys get`$"my t";"f"$count get`$"my t")}', 0), [["new c", "a"], ["new c"], 3]);
  const dropped = readRun(await connection.call(RUN_SCRIPT, statements(migrationScript("w", await info("w"), "w", await info("tgt"), "tgt", "p"))));
  assert.ok(dropped.ok, dropped.error);
  assert.deepStrictEqual(await connection.call("{cols w}", 0), ["a", "b"]);
});

test("the test data generator keys a table by distinct keys, of two columns too, in the sorted column's order (#1282)", { skip }, async (t) => {
  const { connection } = await connect(t, "");
  const col = (name, type) => ({ name, type, fkey: "", attr: "" });
  const info = { kind: "keyed", rows: 0, bytes: null, partitions: null, keys: ["s", "j"], ncols: 3, columns: [col("s", "s"), col("j", "j"), col("t", "p")] };
  const ran = readRun(await connection.call(RUN_SCRIPT, statements(testDataQ(info, "gen", { rows: 200, symbols: ["A", "B"], low: 0, high: 5, sorted: "t", seed: 4 }))));
  assert.ok(ran.ok, ran.error);
  assert.strictEqual(await connection.call('{"f"$count gen}', 0), 10);
  assert.strictEqual(await connection.call("{(keys gen)~`s`j}", 0), true);
  assert.strictEqual(await connection.call("{(exec t from gen)~asc exec t from gen}", 0), true);
});

test("the test data CSV's bytes load back as the bytes written (#1278)", { skip }, async (t) => {
  const { connection, dir } = await connect(t, "");
  const info = { kind: "table", rows: 0, bytes: null, partitions: null, keys: [], ncols: 2, columns: [{ name: "b", type: "x", fkey: "", attr: "" }, { name: "j", type: "j", fkey: "", attr: "" }] };
  const csv = testDataCsv(info, { rows: 20, symbols: ["A"], low: 0, high: 10, seed: 5 });
  fs.writeFileSync(path.join(dir, "bytes.csv"), csv);
  const written = csv.trim().split("\n").slice(1).map((l) => l.split(",")[0]);
  assert.ok(written.some((b) => b !== "00"));
  const loaded = await connection.call(`{c:("${loadTypes(info)}";enlist",")0:\`:bytes.csv; string c\`b}`, 0);
  assert.deepStrictEqual(loaded, written);
});

test("a schema migration's q turns one table into the other, in memory and on disk", { skip }, async (t) => {
  const { connection } = await connect(t, HDB() + "\na:([k:1 2] x:1 2; y:`p`q; z:3 4f)\nb:([k:`long$()] z:`long$(); x:`float$(); w:`symbol$())\ntrade2:([] sym:`$(); px:`long$(); sz:`long$(); ex:`symbol$())\n");
  const info = async (n) => readTableInfo(await connection.call(TABLE_INFO, n, 100));
  const script = migrationScript("a", await info("a"), "a", await info("b"), "b", "p");
  assert.match(script, /drop {3}y/);
  const ran = readRun(await connection.call(RUN_SCRIPT, statements(script)));
  assert.ok(ran.ok, ran.error);
  assert.deepStrictEqual(await connection.call("{(cols a;exec t from meta a;keys a)}", 0), [["k", "z", "x", "w"], "jjfs", ["k"]]);
  // On disk, through the column manager's helpers.
  const disk = migrationScript("trade", await info("trade"), "trade", await info("trade2"), "trade2", "p");
  const done = readRun(await connection.call(RUN_SCRIPT, statements(disk)));
  assert.ok(done.ok, done.error);
  assert.match(done.text, /^changed (\d+) of \1 directories$/);
  assert.deepStrictEqual(await connection.call("{(cols trade;exec t from meta trade)}", 0), [["date", "sym", "px", "sz", "ex"], "dsjjs"]);
});

// A list column to an atom one, or back, is no cast: not written, and the
// script runs; a symbol to a char is its first character (#1578).
test("a schema migration writes no list-atom cast, in memory or on disk", { skip }, async (t) => {
  const extra = '{[r;d] .Q.dd[r;d,`book`] set .Q.en[r] ([] sym:`a`b;sz:(1 2;3 4 5);px:1 2f)}[r] each 2026.01.05 2026.01.06 2026.01.07;';
  const { connection } = await connect(t, HDB(extra) + '\na:([] c:("ab";"c"); z:(1 2;3); s:`xy`z; n:1 2)\nb:([] c:"ab"; z:1 2; s:"xz"; n:(1 2;3))\nbook2:([] sym:`$(); sz:`long$(); px:`float$())\n');
  const info = async (n) => readTableInfo(await connection.call(TABLE_INFO, n, 100));
  const script = migrationScript("a", await info("a"), "a", await info("b"), "b", "p");
  assert.match(script, /not written: a cast of c from C to c/);
  const ran = readRun(await connection.call(RUN_SCRIPT, statements(script)));
  assert.ok(ran.ok, ran.error);
  assert.deepStrictEqual(await connection.call("{exec t from meta a}", 0), "CJcj");
  assert.deepStrictEqual(await connection.call("{a`s}", 0), "xz");
  const disk = migrationScript("book", await info("book"), "book", await info("book2"), "book2", "p");
  assert.match(disk, /not written: a cast of sz from J to j/);
  const done = readRun(await connection.call(RUN_SCRIPT, statements(disk)));
  assert.ok(done.ok, done.error);
  assert.doesNotMatch(done.text, /left as they were/);
});

test("a schema migration parses text and symbols it casts to numbers (#1096)", { skip }, async (t) => {
  const { connection } = await connect(t, 'a:([] x:("12";"3"); y:`4`5)\nb:([] x:`long$(); y:`long$())\n');
  const info = async (n) => readTableInfo(await connection.call(TABLE_INFO, n, 100));
  const ran = readRun(await connection.call(RUN_SCRIPT, statements(migrationScript("a", await info("a"), "a", await info("b"), "b", "p"))));
  assert.ok(ran.ok, ran.error);
  assert.deepStrictEqual(await connection.call("{(exec t from meta a;\"f\"$a`x;\"f\"$a`y)}", 0), ["jj", [12, 3], [4, 5]]);
});

test("a schema migration adds a mixed column to a table with rows (#1097)", { skip }, async (t) => {
  const { connection } = await connect(t, "a:([] k:1 2)\nb:([] k:`long$(); m:())\n");
  const info = async (n) => readTableInfo(await connection.call(TABLE_INFO, n, 100));
  const ran = readRun(await connection.call(RUN_SCRIPT, statements(migrationScript("a", await info("a"), "a", await info("b"), "b", "p"))));
  assert.ok(ran.ok, ran.error);
  assert.strictEqual(await connection.call("{\"f\"$count select from a where 0=count each m}", 0), 2);
});

test("a tickerplant log's one-row messages, a list of atoms, have a time and are filtered by it (#1090)", { skip }, async (t) => {
  const log = [
    'f:hsym`$"$DIR/tp.log";',
    ".[f;();:;()];",
    "h:hopen f;",
    "h enlist(`upd;`trade;(2026.01.05D09:00:00;`a;1f));",
    "h enlist(`upd;`trade;(2026.01.05D11:00:00 2026.01.05D11:30:00;`b`c;2 3f));",
    "hclose h;",
    "",
  ].join("\n");
  const { connection, dir } = await connect(t, log + TPLOG_INIT + "\n");
  readTpLog(await connection.call(".qlint.tp.load", path.join(dir, "tp.log")));
  const all = readTpPage(await connection.call(".qlint.tp.page", "", NaN, NaN, 0, 100));
  assert.deepStrictEqual(all.rows.map((r) => r.rows), [1, 2]);
  assert.match(all.rows[0].time, /2026\.01\.05D09:00:00/);
  const early = readTpPage(await connection.call(".qlint.tp.page", "", 8 * 3600000, 10 * 3600000, 0, 100));
  assert.deepStrictEqual(early.rows.map((r) => r.index), [0]);
});

// Replay ran `value` on each message: a log naming system, set on .z.pw or
// a lambda ran it in the local q, which runs as the user (#1829).
test("a replay passes only upd's messages to upd, to a table's name, and skips the rest", { skip }, async (t) => {
  const log = [
    'f:hsym`$"$DIR/tp.log";',
    ".[f;();:;()];",
    "h:hopen f;",
    "h enlist(`upd;`trade;([]sym:enlist`a;px:enlist 1f));",
    'h enlist(`system;"touch $DIR/pwned1");',
    "h enlist(`set;`.z.pw;{[u;p]1b});",
    'h enlist({system"touch $DIR/pwned2"};1);',
    "h enlist(`upd;`.z.pw;([]a:enlist 1));",
    "hclose h;",
    "",
  ].join("\n");
  const { connection, dir } = await connect(t, log + TPLOG_INIT + "\n");
  readTpLog(await connection.call(".qlint.tp.load", path.join(dir, "tp.log")));
  assert.deepStrictEqual(readOthers(await connection.call(".qlint.tp.others", 0, 4)), { count: 3, heads: ["system", "set", ""] });
  const replayed = readReplayed(await connection.call(".qlint.tp.replay", 0, 4));
  assert.deepStrictEqual([replayed.replayed, replayed.failed, replayed.skipped], [2, 1, 3]);
  assert.deepStrictEqual(replayed.heads, ["system", "set", ""]);
  assert.match(replayed.errors[0], /not a table name: `\.z\.pw/);
  assert.deepStrictEqual(Object.fromEntries(replayed.tables.map((x) => [x.name, x.rows])), { trade: 1 });
  assert.strictEqual(fs.existsSync(path.join(dir, "pwned1")), false);
  assert.strictEqual(fs.existsSync(path.join(dir, "pwned2")), false);
  assert.strictEqual(await connection.call("{[x] @[{100h=type .z.pw};::;0b]}", 0), false);
});

test("a tickerplant log whose first temporal column is a date or a month opens, with no time of day (#1248)", { skip }, async (t) => {
  const log = [
    'f:hsym`$"$DIR/tp.log";',
    ".[f;();:;()];",
    "h:hopen f;",
    "h enlist(`upd;`eod;([]date:enlist 2026.01.05;sym:enlist`a));",
    "h enlist(`upd;`mon;([]m:enlist 2026.01m;sym:enlist`b));",
    "h enlist(`upd;`trade;([]time:enlist 2026.01.05D09:00:00;sym:enlist`c));",
    "hclose h;",
    "",
  ].join("\n");
  const { connection, dir } = await connect(t, log + TPLOG_INIT + "\n");
  const summary = readTpLog(await connection.call(".qlint.tp.load", path.join(dir, "tp.log")));
  assert.strictEqual(summary.count, 3);
  const all = readTpPage(await connection.call(".qlint.tp.page", "", NaN, NaN, 0, 100));
  assert.deepStrictEqual(all.rows.map((r) => r.time), ["2026.01.05", "2026.01", "2026.01.05D09:00:00.000000000"]);
  const timed = readTpPage(await connection.call(".qlint.tp.page", "", 8 * 3600000, NaN, 0, 100));
  assert.deepStrictEqual(timed.rows.map((r) => r.index), [2]);
});

test("the tickerplant log is read, paged, filtered, shown and replayed in a q of its own", { skip }, async (t) => {
  const log = [
    'f:hsym`$"$DIR/tp.log";',
    ".[f;();:;()];",
    "h:hopen f;",
    "h enlist(`upd;`trade;([]time:2026.01.05D09:00:00 2026.01.05D09:30:00;sym:`a`b;px:1 2f));",
    "h enlist(`upd;`quote;([]time:enlist 2026.01.05D10:00:00;sym:enlist`a;bid:enlist 1f));",
    "h enlist(`upd;`trade;([]time:enlist 2026.01.05D11:00:00;sym:enlist`c;px:enlist 3f));",
    "hclose h;",
    'b:read1 f; (hsym`$"$DIR/cut.log") 1:(count[b]-4)#b;',
    "",
  ].join("\n");
  const { connection, dir } = await connect(t, log + TPLOG_INIT + "\n");
  const summary = readTpLog(await connection.call(".qlint.tp.load", path.join(dir, "tp.log")));
  assert.deepStrictEqual(summary.tables, ["quote", "trade"]);
  assert.strictEqual(summary.count, 3);
  assert.strictEqual(summary.complete, true);
  const all = readTpPage(await connection.call(".qlint.tp.page", "", NaN, NaN, 0, 100));
  assert.strictEqual(all.total, 3);
  assert.deepStrictEqual(all.rows.map((r) => [r.index, r.fn, r.table, r.rows]), [[0, "upd", "trade", 2], [1, "upd", "quote", 1], [2, "upd", "trade", 1]]);
  assert.match(all.rows[0].time, /2026\.01\.05D09:00:00/);
  const trades = readTpPage(await connection.call(".qlint.tp.page", "trade", 9.5 * 3600000, NaN, 0, 100));
  assert.deepStrictEqual(trades.rows.map((r) => r.index), [2]);
  const shown = await connection.call(".qlint.tp.show", 1, 200);
  assert.match([].concat(shown).join("\n"), /quote/);
  const replayed = readReplayed(await connection.call(".qlint.tp.replay", 0, 2));
  assert.strictEqual(replayed.replayed, 3);
  assert.strictEqual(replayed.failed, 0);
  assert.deepStrictEqual(Object.fromEntries(replayed.tables.map((x) => [x.name, x.rows])), { quote: 1, trade: 3 });
  // A log cut short is read to its last whole message.
  const cut = readTpLog(await connection.call(".qlint.tp.load", path.join(dir, "cut.log")));
  assert.strictEqual(cut.count, 2);
  assert.strictEqual(cut.complete, false);
  assert.ok(cut.bytes < cut.size);
  assert.strictEqual(readTpPage(await connection.call(".qlint.tp.page", "", NaN, NaN, 0, 100)).total, 2);
});
