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
const { columnScript, RUN_SCRIPT, readRun } = require("../out/colmanager.js");
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
const { TPLOG_INIT, readTpLog, readTpPage, readReplayed } = require("../out/tplog.js");

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

test("the test data generator's q makes the rows asked for, and its CSV loads back", { skip }, async (t) => {
  const { connection, dir } = await connect(t, "t:([k:`symbol$()] time:`timestamp$(); px:`float$(); qty:`long$(); d:`date$(); note:())\n");
  const info = readTableInfo(await connection.call(TABLE_INFO, "t", 100));
  info.columns.find((c) => c.name === "note").type = "C";
  const options = { rows: 50, symbols: ["AAPL", "MSFT"], low: 10, high: 20, sorted: "time", seed: 7 };
  const q = testDataQ(info, "gen", options);
  const ran = readRun(await connection.call(RUN_SCRIPT, statements(q)));
  assert.ok(ran.ok, ran.error);
  assert.deepStrictEqual(await connection.call("{exec t from meta gen}", 0), "spfjdC");
  assert.strictEqual(await connection.call('{"f"$count gen}', 0), 50);
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
