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
const { columnScript, columnsOf, COLUMN_DIRS, HELPERS, opProblem, readColumnDirs, RUN_SCRIPT, readRun } = require("../out/colmanager.js");
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
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
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

/// What a q of its own makes of the database at `db` once it loads it: the
/// truth on disk, not what the process that changed it says (#2137).
async function onDisk(t, db, query) {
  const q = await startQ(`\\l ${db}\n`);
  try {
    const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
    try {
      return await connection.call(query, 0);
    } finally {
      connection.close();
    }
  } finally {
    q.stop();
  }
}

/// Each partition's table directory's column `c`, as a fresh q reads it:
/// its type, attribute, compression (algorithm and level, or none), count
/// and values - a copy: q sends no compressed column with an attribute.
const COLUMN_ON_DISK = '{[t;c] {[t;c;p] f:` sv(hsym`$string p),t,c; z:-21!f; v:get f; (string p;"h"$type v;string attr v;$[count z;"f"$z`algorithm`zipLevel;()];"f"$count v;v til count v)}[t;c] each .Q.pv}';

// A column of a compressed partition is written back compressed as it was,
// and one of a plain partition plain, whatever the process's .z.zd (#2137).
test("the column manager's cast and attribute keep each partition's compression (#2137)", { skip }, async (t) => {
  const source = [
    'r:hsym`$"$DIR/hdb";',
    "mk:{[r;d] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:`a`b`c`a;px:1 2 3 4f;sz:10 20 30 40;ex:(\"NY\";\"LN\";\"TK\";\"NY\"))};",
    "mk[r;2026.01.05];",
    ".z.zd:17 2 6; mk[r;2026.01.06];",
    ".z.zd:16 1 0; mk[r;2026.01.07];",
    ".z.zd:17 2 6;",
    "\\l $DIR/hdb",
    "",
  ].join("\n");
  const { connection, dir } = await connect(t, source);
  assert.match(await run(connection, columnScript("trade", { op: "attr", column: "px", attr: "s" }, "hdb")), /changed 3 of 3 directories/);
  assert.match(await run(connection, columnScript("trade", { op: "cast", column: "sz", type: "i" }, "hdb")), /changed 3 of 3 directories/);
  assert.match(await run(connection, columnScript("trade", { op: "cast", column: "ex", type: "s" }, "hdb")), /changed 3 of 3 directories/);
  const zips = [[], [2, 6], [1, 0]];
  const px = await onDisk(t, `${dir}/hdb`, `{${COLUMN_ON_DISK}[\`trade;\`px]}`);
  assert.deepStrictEqual(px, ["2026.01.05", "2026.01.06", "2026.01.07"].map((p, i) => [p, 9, "s", zips[i], 4, [1, 2, 3, 4]]));
  const sz = await onDisk(t, `${dir}/hdb`, `{${COLUMN_ON_DISK}[\`trade;\`sz]}`);
  assert.deepStrictEqual(sz.map((r) => r.slice(0, 5)), ["2026.01.05", "2026.01.06", "2026.01.07"].map((p, i) => [p, 6, "", zips[i], 4]));
  const ex = await onDisk(t, `${dir}/hdb`, `{${COLUMN_ON_DISK}[\`trade;\`ex]}`);
  assert.deepStrictEqual(ex.map((r) => r.slice(0, 5)), ["2026.01.05", "2026.01.06", "2026.01.07"].map((p, i) => [p, 20, "", zips[i], 4]));
  assert.deepStrictEqual(await onDisk(t, `${dir}/hdb`, '{"f"$(count select from trade;first(select sum sz from trade)`sz)}'), [12, 300]);
  assert.deepStrictEqual(await onDisk(t, `${dir}/hdb`, "{exec t from meta trade}"), "dsfis");
});

// A column added to the newest partitions only, or left in the oldest
// only: meta reads the newest, and select fails on the others (#2138).
test("the column manager adds a column the newest partitions have to the rest, and deletes one only the oldest have (#2138)", { skip }, async (t) => {
  const source = [
    'r:hsym`$"$DIR/hdb";',
    "mk:{[r;d;t] .Q.dd[r;d,`trade`] set .Q.en[r] t};",
    "mk[r;;([] sym:`a`b`c;px:1 2 3f;old:1 2 3)] each 2026.02.02 2026.02.03;",
    "mk[r;;([] sym:`a`b`c;px:1 2 3f)] each 2026.02.04 2026.02.05;",
    "mk[r;;([] sym:`a`b`c;px:1 2 3f;ex:`X`Y`X)] each 2026.02.09 2026.02.10;",
    "\\l $DIR/hdb",
    "",
  ].join("\n");
  const { connection, dir } = await connect(t, source);
  const info = readTableInfo(await connection.call(TABLE_INFO, "trade", 100));
  const meta = info.columns.map((c) => c.name);
  assert.deepStrictEqual(meta, ["date", "sym", "px", "ex"]);
  const { columns, everywhere } = columnsOf(meta, readColumnDirs(await connection.call(COLUMN_DIRS, "trade")));
  assert.deepStrictEqual([columns, everywhere], [["date", "sym", "px", "ex", "old"], ["date", "sym", "px"]]);
  const add = { op: "add", column: "ex", value: "`" };
  assert.strictEqual(opProblem(add, columns, "date", everywhere), undefined);
  assert.strictEqual(opProblem({ op: "delete", column: "old" }, columns, "date", everywhere), undefined);
  assert.match(await run(connection, columnScript("trade", add, "hdb")), /changed 4 of 6 directories; left as they were: .*2026\.02\.09\/trade: has ex/);
  assert.match(await run(connection, columnScript("trade", { op: "delete", column: "old" }, "hdb")), /changed 2 of 6 directories/);
  // A q of its own: every partition lists the same columns, ex in each.
  const db = `${dir}/hdb`;
  assert.deepStrictEqual(
    await onDisk(t, db, '{{f:` sv(hsym`$string x),`trade; (string x;string get` sv f,`.d;"h"$type get` sv f,`ex;string get` sv f,`ex)} each .Q.pv}'),
    ["2026.02.02", "2026.02.03", "2026.02.04", "2026.02.05", "2026.02.09", "2026.02.10"].map((p, i) => [p, ["sym", "px", "ex"], 20, i < 4 ? ["", "", ""] : ["X", "Y", "X"]]),
  );
  assert.deepStrictEqual(await onDisk(t, db, '{"f"$exec x from select count i by date from trade where null ex}'), [3, 3, 3, 3]);
  assert.deepStrictEqual(await onDisk(t, db, "{exec c from meta trade}"), ["date", "sym", "px", "ex"]);
  assert.deepStrictEqual(await onDisk(t, db, '{key` sv(hsym`$string first .Q.pv),`trade}'), [".d", "ex", "px", "sym"]);
});

// q drops an attribute writing a nested column, but on an empty one (#2141).
test("the column manager sets no attribute on a nested column, and says so in each directory (#2141)", { skip }, async (t) => {
  const source = [
    'r:hsym`$"$DIR/hdb";',
    "mk:{[r;d;n] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:n#`a`b`c;ex:n#(\"NY\";\"LN\";\"TK\"))};",
    "mk[r;2026.01.05;3]; mk[r;2026.01.06;0]; mk[r;2026.01.07;3];",
    "\\l $DIR/hdb",
    "",
  ].join("\n");
  const { connection, dir } = await connect(t, source);
  const db = `${dir}/hdb`;
  const info = readTableInfo(await connection.call(TABLE_INFO, "trade", 100));
  const columns = info.columns.map((c) => c.name);
  const types = Object.fromEntries(info.columns.map((c) => [c.name, c.type]));
  // q's own: g# on the strings is kept on the empty partition's file alone.
  assert.deepStrictEqual(await onDisk(t, db, `{{f:hsym\`$"${dir}/probe/",string x; f set \`g#get\` sv(hsym\`$string x),\`trade\`ex; string attr get f} each .Q.pv}`), ["", "g", ""]);
  assert.match(opProblem({ op: "attr", column: "ex", attr: "g" }, columns, "date", columns, types), /^ex is a nested column, which q writes to disk with no attribute$/);
  // The script, run anyway, writes no directory.
  const before = await onDisk(t, db, '{{string attr get` sv(hsym`$string x),`trade`ex} each .Q.pv}');
  assert.match(await run(connection, columnScript("trade", { op: "attr", column: "ex", attr: "g" }, "hdb")), /^changed 0 of 3 directories; left as they were: .*nested, which q writes with no attribute/);
  assert.deepStrictEqual(await onDisk(t, db, '{{string attr get` sv(hsym`$string x),`trade`ex} each .Q.pv}'), before);
  assert.deepStrictEqual(before, ["", "", ""]);
  // An attribute on a column q keeps it on is set, and the file says so.
  assert.match(await run(connection, columnScript("trade", { op: "attr", column: "sym", attr: "g" }, "hdb")), /^changed 3 of 3 directories$/);
  assert.deepStrictEqual(await onDisk(t, db, '{{string attr get` sv(hsym`$string x),`trade`sym} each .Q.pv}'), ["g", "g", "g"]);
});

// sym to c fails in every partition; a nested long column to f makes no
// float column of a partition with rows (the script's parse fails there),
// and one of the empty partition alone, which then differs (#2140).
test("the column manager refuses the casts q does not make, before any partition is written (#2140)", { skip }, async (t) => {
  const source = [
    'r:hsym`$"$DIR/hdb";',
    "mk:{[r;d;n] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:n#`a`b`c;tags:n#(1 2;3 4 5;enlist 6);sz:n#10 20 30)};",
    "mk[r;2026.01.05;3]; mk[r;2026.01.06;0]; mk[r;2026.01.07;3];",
    "\\l $DIR/hdb",
    "",
  ].join("\n");
  const { connection, dir } = await connect(t, source);
  const info = readTableInfo(await connection.call(TABLE_INFO, "trade", 100));
  const columns = info.columns.map((c) => c.name);
  const types = Object.fromEntries(info.columns.map((c) => [c.name, c.type]));
  const db = `${dir}/hdb`;
  // What q's own cast makes of each partition's column, in a q of its own.
  const own = (c, to) => onDisk(t, db, `{{@[{"h"$type ${to}$x};get\` sv(hsym\`$string x),\`trade\`${c};{"'",x}]} each .Q.pv}`);
  assert.deepStrictEqual(await own("sym", '"c"'), ["'type", "'type", "'type"]);
  assert.deepStrictEqual(await own("tags", '"f"'), [0, 9, 0]);
  for (const [column, type] of [["sym", "c"], ["tags", "f"]]) {
    assert.match(opProblem({ op: "cast", column, type }, columns, "date", columns, types), new RegExp(`^${column} is not cast from ${types[column]} to ${type}: `));
  }
  assert.strictEqual(opProblem({ op: "cast", column: "sz", type: "i" }, columns, "date", columns, types), undefined);
  assert.match(await run(connection, columnScript("trade", { op: "cast", column: "sz", type: "i" }, "hdb")), /changed 3 of 3 directories/);
  assert.deepStrictEqual(await onDisk(t, db, "{exec t from meta trade}"), "dsJi");
  assert.deepStrictEqual(await onDisk(t, db, '{{"h"$type get` sv(hsym`$string x),`trade`sz} each .Q.pv}'), [6, 6, 6]);
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

test("the partition check finds a partition whose sym is enumerated against another domain (#2139)", { skip }, async (t) => {
  const extra = [
    "dom2:`x`y; (` sv r,`dom2) set dom2;",
    ".Q.dd[r;2026.01.06,`trade`sym] set `dom2$6#`x`y;",
  ].join("\n");
  const { connection, dir } = await connect(t, HDB(extra));
  // In a q of its own, a select across the two is no symbol column.
  assert.strictEqual(await onDisk(t, `${dir}/hdb`, "{type exec sym from select sym from trade}"), 0);
  const problems = partitionProblems(readPartitions(await connection.call(PARTITION_CHECK, 1000, true)));
  assert.deepStrictEqual(problems.map((p) => [p.kind, p.what, p.partitions]), [["enumeration", "trade.sym is enumerated against dom2 here, sym in most partitions: a select across them makes it a mixed column", ["2026.01.06"]]]);
});

test("the partition check reads a nested column of enumerations for its domain and largest index (#2529)", { skip }, async (t) => {
  const extra = [
    "{[r;d] .Q.dd[r;d,`ev`] set .Q.en[r] ([] sym:`a`b;tags:(`a`b;enlist`c))}[r] each 2026.01.05 2026.01.06 2026.01.07;",
    ".Q.dd[r;2026.01.06,`ev`tags] set (`sym!enlist 9;`sym!7 8);",
  ].join("\n");
  const { connection } = await connect(t, HDB(extra));
  const answer = readPartitions(await connection.call(PARTITION_CHECK, 1000, true));
  const row = answer.rows.find((r) => r.table === "ev" && r.partition === "2026.01.06");
  assert.deepStrictEqual([row.enums[1], row.maxIndexes[1]], ["sym", 9]);
  const problems = partitionProblems(answer);
  assert.deepStrictEqual(problems.map((p) => [p.kind, p.what, p.partitions]), [["enumeration", "ev.tags has a symbol index past the end of sym", ["2026.01.06"]]]);
  assert.ok(answer.rows.filter((r) => r.table === "ev").every((r) => r.enums[1] === "sym"));
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
const { PARTITION_DIRS } = require("../out/partdir.js");
const { TABLE_INFO, readTableInfo } = require("../out/tableinfo.js");
const { testDataQ, testDataCsv, loadTypes } = require("../out/testdata.js");
const { migrationScript } = require("../out/migrate.js");
const { TPLOG_INIT, readOthers, readTpLog, readTpPage, readReplayed } = require("../out/tplog.js");

/// A database under $DIR/seg whose par.txt names $DIR/s1 and $DIR/s2, each
/// partition written to the segment `where` gives it, then loaded.
const SEGMENTED = (where) =>
  [
    'r:hsym`$"$DIR/seg";',
    'system "mkdir -p $DIR/seg";',
    '(` sv r,`par.txt) 0: ("$DIR/s1";"$DIR/s2");',
    "mk:{[r;s;d] (` sv (hsym`$s),(`$string d),`trade`) set .Q.en[r] ([] sym:`p#`a`a`b;px:1 2 3f;sz:10 20 30)};",
    `mk[r] ./: (${where});`,
    "\\l $DIR/seg",
    "",
  ].join("\n");

// q finds a partition wherever par.txt's segments hold it; `.Q.par` names
// the segment a writer would pick, `date mod 2` here. These four are each in
// the other one, as a database segmented by date range or by disk has them,
// and every query works - so every tool must find them too (#1977).
test("a segmented database not laid out as .Q.par would write it is found by every database tool (#1977)", { skip }, async (t) => {
  const { connection, dir } = await connect(t, SEGMENTED('("$DIR/s1";2024.01.02);("$DIR/s2";2024.01.03);("$DIR/s1";2024.01.04);("$DIR/s2";2024.01.05)'));
  assert.deepStrictEqual(await connection.call('{"f"$exec x from select count i by date from trade}', 0), [3, 3, 3, 3]);
  // What .Q.par answers is not there; what q loaded is.
  const real = fs.realpathSync(dir);
  const wrote = ["s1/2024.01.02", "s2/2024.01.03", "s1/2024.01.04", "s2/2024.01.05"].map((d) => `:${dir}/${d}`);
  assert.deepStrictEqual(await connection.call('{"f"$count each key each .Q.par[hsym`$system"cd";;`trade] each .Q.PV}', 0), [0, 0, 0, 0]);
  assert.deepStrictEqual(await connection.call(`{string ${PARTITION_DIRS}[hsym\`$system"cd";.Q.PD;.Q.PV]}`, 0), wrote);
  // A q that sets no .Q.PD is answered by .Q.par, as before.
  assert.strictEqual(await connection.call(`{(${PARTITION_DIRS}[r;();.Q.PV])~{first\` vs .Q.par[x;y;\`trade]}[r:hsym\`$system"cd"] each .Q.PV}`, 0), true);

  const parts = readPartitions(await connection.call(PARTITION_CHECK, 1000, true));
  assert.deepStrictEqual(parts.all, ["2024.01.02", "2024.01.03", "2024.01.04", "2024.01.05"]);
  assert.deepStrictEqual(parts.rows.map((r) => [r.partition, r.dir, r.dotd, r.rows]), parts.all.map((p) => [p, true, true, 3]));
  assert.deepStrictEqual(partitionProblems(parts), []);
  // Fewer than all of them are the newest, each still in its own segment.
  const newest = readPartitions(await connection.call(PARTITION_CHECK, 3, false));
  assert.deepStrictEqual(newest.rows.map((r) => [r.partition, r.dir, r.rows]), ["2024.01.03", "2024.01.04", "2024.01.05"].map((p) => [p, true, 3]));

  const sym = readSym(await connection.call(SYM_INSPECT, 20));
  assert.deepStrictEqual(sym.columns.map((c) => [c.table, c.column, c.distinct]), [["trade", "sym", 2]]);
  assert.deepStrictEqual(sym.growth.map((g) => g.partition), parts.all);
  // A sample of them is read from where each is.
  const sampled = readSym(await connection.call(SYM_INSPECT, 2));
  assert.deepStrictEqual(sampled.growth.map((g) => g.partition), ["2024.01.02", "2024.01.05"]);

  const sample = readAttributeSample(await connection.call(ATTRIBUTE_SAMPLE, "trade", 100000));
  assert.deepStrictEqual([sample.kind, sample.rows, sample.sampled, sample.partitions], ["partitioned", 12, 3, 4]);
  assert.deepStrictEqual(sample.columns.map((c) => [c.name, c.attr]), [["sym", "p"], ["px", ""], ["sz", ""]]);
  // The p# every partition's sym has is what it is told to keep (#1978).
  assert.deepStrictEqual(advise(sample, new Map([["sym", 2]])).map((a) => [a.column, a.current, a.suggest]).slice(0, 1), [["sym", "p", "p"]]);
  // Under a view the last partition shown is the one sampled, from its own segment.
  await connection.call("{.Q.view 2024.01.02 2024.01.03}", 0);
  assert.strictEqual(readAttributeSample(await connection.call(ATTRIBUTE_SAMPLE, "trade", 100000)).sampled, 3);
  await connection.call("{.Q.view[]}", 0);

  // The column manager writes to disk: to the four directories that hold the
  // table, and nowhere else.
  const say = await run(connection, columnScript("trade", { op: "add", column: "ex", value: "`NYSE" }, "hdb"));
  assert.match(say, /changed 4 of 4 directories/);
  assert.deepStrictEqual(await connection.call('{"f"$exec x from select count i by date from trade where ex=`NYSE}', 0), [3, 3, 3, 3]);
  for (const d of wrote) assert.ok(fs.existsSync(path.join(d.slice(1), "trade", "ex")), d);
  const made = (root) => fs.readdirSync(path.join(real, root)).sort();
  assert.deepStrictEqual([made("s1"), made("s2"), made("seg")], [["2024.01.02", "2024.01.04"], ["2024.01.03", "2024.01.05"], ["par.txt", "sym"]]);
  assert.match(await run(connection, columnScript("trade", { op: "attr", column: "sz", attr: "s" }, "hdb")), /changed 4 of 4 directories/);
  assert.match(await run(connection, columnScript("trade", { op: "rename", column: "px", to: "price" }, "hdb")), /changed 4 of 4 directories/);
  assert.deepStrictEqual(await connection.call("{exec c from meta trade}", 0), ["date", "sym", "price", "sz", "ex"]);
  assert.deepStrictEqual(partitionProblems(readPartitions(await connection.call(PARTITION_CHECK, 1000, true))), []);
});

// One value can be in two segments: q lists it twice, with a directory
// each, and selects both. Each is its own directory to check and to change.
test("a partition held in two segments is checked and changed in both (#1977)", { skip }, async (t) => {
  const { connection, dir } = await connect(t, SEGMENTED('("$DIR/s1";2024.01.02);("$DIR/s2";2024.01.02);("$DIR/s1";2024.01.04)'));
  assert.strictEqual(await connection.call('{"f"$count select from trade where date=2024.01.02}', 0), 6);
  const parts = readPartitions(await connection.call(PARTITION_CHECK, 1000, false));
  assert.deepStrictEqual(parts.rows.map((r) => [r.partition, r.dir, r.rows]), [["2024.01.02", true, 3], ["2024.01.02", true, 3], ["2024.01.04", true, 3]]);
  assert.match(await run(connection, columnScript("trade", { op: "add", column: "ex", value: "`NYSE" }, "hdb")), /changed 3 of 3 directories/);
  for (const d of ["s1/2024.01.02", "s2/2024.01.02", "s1/2024.01.04"]) assert.ok(fs.existsSync(path.join(dir, d, "trade", "ex")), d);
  assert.strictEqual(await connection.call('{"f"$count select from trade where ex=`NYSE}', 0), 9);
});

// With no par.txt q loaded every partition from the root, and the
// directories are the ones .Q.par gave.
test("a database with no segments has its partitions under the root, as before (#1977)", { skip }, async (t) => {
  const { connection, dir } = await connect(t, HDB());
  assert.deepStrictEqual(await connection.call("{string .Q.PD}", 0), [":.", ":.", ":."]);
  assert.strictEqual(await connection.call(`{(${PARTITION_DIRS}[r;.Q.PD;.Q.PV])~{first\` vs .Q.par[x;y;\`trade]}[r:hsym\`$system"cd"] each .Q.PV}`, 0), true);
  assert.deepStrictEqual(await connection.call(`{string ${PARTITION_DIRS}[hsym\`$system"cd";.Q.PD;.Q.PV]}`, 0), ["2026.01.05", "2026.01.06", "2026.01.07"].map((d) => `:${fs.realpathSync(dir)}/hdb/${d}`));
  assert.deepStrictEqual(await connection.call(`{${PARTITION_DIRS}[hsym\`$system"cd";();()]}`, 0), []);
  assert.deepStrictEqual(partitionProblems(readPartitions(await connection.call(PARTITION_CHECK, 1000, true))), []);
  assert.strictEqual(readSym(await connection.call(SYM_INSPECT, 2)).growth.length, 2);
  assert.strictEqual(readAttributeSample(await connection.call(ATTRIBUTE_SAMPLE, "trade", 100000)).sampled, 6);
});

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

// The middle partition uses only the first two symbols of a file that held
// four already: it shows four, and the next adds none (#2142).
test("the sym inspector's growth counts from the largest size before, not the partition just before (#2142)", { skip }, async (t) => {
  const { connection } = await connect(t, [
    'r:hsym`$"$DIR/g";',
    "{[r;d;s] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:s;px:count[s]#1f)}[r]'[2026.01.07 2026.01.08 2026.01.09;(`a`b`c`d;`a`b;`d`c`b`a)];",
    "\\l $DIR/g",
    "",
  ].join("\n"));
  const answer = readSym(await connection.call(SYM_INSPECT, 20));
  assert.deepStrictEqual(answer.growth.map((g) => g.size), [4, 2, 4]);
  const rows = symReport(answer, "g", 1e6).split("\n").filter((l) => /^\| 2026/.test(l));
  assert.deepStrictEqual(rows, ["| 2026.01.07 | 4 |  |", "| 2026.01.08 | 4 | 0 |", "| 2026.01.09 | 4 | 0 |"]);
});

// A sym column whose indexes run past the 3-symbol file: 0 1 2 are its
// symbols, 3 4 99 none (#2143).
test("the sym inspector counts no index past the file's end as a symbol, and warns of them (#2143)", { skip }, async (t) => {
  const { connection, dir } = await connect(t, [
    'r:hsym`$"$DIR/b";',
    "{[r;d] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:6#`a`b`c;px:6#1f)}[r] each 2026.03.03 2026.03.04;",
    ".Q.dd[r;2026.03.04,`trade`sym] set `sym!0 1 2 3 4 99;",
    "\\l $DIR/b",
    "",
  ].join("\n"));
  assert.deepStrictEqual(await onDisk(t, `${dir}/b`, '{"f"$(count sym;exec x from select count i by date from trade)}'), [3, [6, 6]]);
  const answer = readSym(await connection.call(SYM_INSPECT, 20));
  assert.deepStrictEqual(answer.columns, [{ table: "trade", column: "sym", distinct: 3, past: 3 }]);
  assert.deepStrictEqual(answer.growth, [{ partition: "2026.03.03", size: 3 }, { partition: "2026.03.04", size: 3 }]);
  const text = symReport(answer, "b", 1e6);
  assert.match(text, /\| trade \| sym \| 3 \| 100\.0% \|/);
  assert.match(text, /trade\.sym has 3 values whose index is past the end of sym/);
});

// tags, a symbol list a row, holds the file's 4th and 5th symbols: they
// are its share, and the file held 5 once the partition was written (#2530).
test("the sym inspector counts a nested column of enumerations, its symbols and its growth (#2530)", { skip }, async (t) => {
  const { connection } = await connect(t, [
    'r:hsym`$"$DIR/n";',
    ".Q.dd[r;2026.01.01,`trade`] set .Q.en[r] ([] sym:`aapl`ibm`msft;tags:(`a`b;enlist`a;enlist`b));",
    "\\l $DIR/n",
    "",
  ].join("\n"));
  const answer = readSym(await connection.call(SYM_INSPECT, 20));
  assert.strictEqual(answer.count, 5);
  assert.deepStrictEqual(answer.columns.map((c) => [c.table, c.column, c.distinct, c.past]).sort(), [["trade", "sym", 3, 0], ["trade", "tags", 2, 0]]);
  assert.deepStrictEqual(answer.growth, [{ partition: "2026.01.01", size: 5 }]);
});

test("the sym inspector under a .Q.view samples every partition on disk (#2533)", { skip }, async (t) => {
  const { connection } = await connect(t, [
    'r:hsym`$"$DIR/v";',
    "{[r;d;s] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:s;px:count[s]#1f)}[r]'[2026.01.01 2026.01.02 2026.01.03;(`a`b;`a`b`c;0#`)];",
    "\\l $DIR/v",
    ".Q.view 2026.01.03",
    "",
  ].join("\n"));
  const answer = readSym(await connection.call(SYM_INSPECT, 20));
  assert.deepStrictEqual([answer.partitions, answer.sampled], [3, 3]);
  assert.deepStrictEqual(answer.columns.map((c) => [c.table, c.column, c.distinct]), [["trade", "sym", 3]]);
  assert.deepStrictEqual(answer.growth, [{ partition: "2026.01.01", size: 2 }, { partition: "2026.01.02", size: 3 }]);
});

// .Q.ens[d;t;`mysym] enumerates against mysym, and a column may be against
// a domain of its own beside sym: each is inspected (#2146).
test("the sym inspector inspects a database enumerated against another domain than sym (#2146)", { skip }, async (t) => {
  const { connection } = await connect(t, [
    'r:hsym`$"$DIR/splay";',
    "(` sv r,`sp`) set .Q.ens[r;([] s:`a`b`c; u:`x`y`z; n:1 2 3);`mysym];",
    "\\l $DIR/splay",
    "",
  ].join("\n"));
  const answer = readSym(await connection.call(SYM_INSPECT, 20));
  assert.deepStrictEqual([answer.sym, answer.domain, answer.count, answer.others], [true, "mysym", 6, []]);
  assert.deepStrictEqual(answer.columns.map((c) => [c.table, c.column, c.distinct]).sort(), [["sp", "s", 3], ["sp", "u", 3]]);
  assert.match(symReport(answer, "splay", 1e6), /\/mysym: 6 symbols/);
  const { connection: two } = await connect(t, [
    'r:hsym`$"$DIR/two";src:`x`y`z;(` sv r,`src) set src;',
    "{[r;d] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:`a`b;src:`src$`x`z)}[r] each 2026.01.05 2026.01.06;",
    "\\l $DIR/two",
    "",
  ].join("\n"));
  const both = readSym(await two.call(SYM_INSPECT, 20));
  assert.deepStrictEqual([both.domain, both.count, both.columns.map((c) => c.column)], ["sym", 2, ["sym"]]);
  assert.deepStrictEqual(both.others.map((d) => [d.domain, d.count, d.columns.map((c) => [c.column, c.distinct]), d.growth.map((g) => g.size)]), [["src", 3, [["src", 2]], [3, 3]]]);
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

// A table one partition lacks cannot be counted: its sample is advised on as
// a sample, and a u# is not costed from the sample's rows (#1979).
// An EOD that wrote no rows leaves the newest partition empty: the sample is
// the newest one with rows, not none (#2144).
test("the attribute advisor samples the newest partition that has rows (#2144)", { skip }, async (t) => {
  const { connection } = await connect(t, [
    'r:hsym`$"$DIR/e";',
    "{[r;d;n] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:`s#n#`a`a`b`b`c`c;px:n#1 2 3f;sz:n#10 20 30)}[r]'[2026.04.01 2026.04.02 2026.04.03 2026.04.06;6 6 5 0];",
    "\\l $DIR/e",
    "",
  ].join("\n"));
  const p = readAttributeSample(await connection.call(ATTRIBUTE_SAMPLE, "trade", 100000));
  assert.deepStrictEqual([p.kind, p.rows, p.sampled, p.partitions], ["partitioned", 17, 5, 4]);
  assert.deepStrictEqual(p.columns.map((c) => [c.name, c.attr, c.distinct, c.sorted]), [["sym", "s", 3, true], ["px", "", 3, false], ["sz", "", 3, false]]);
  // Under a view of the empty one alone, that is what there is to sample.
  await connection.call("{.Q.view 2026.04.06}", 0);
  assert.strictEqual(readAttributeSample(await connection.call(ATTRIBUTE_SAMPLE, "trade", 100000)).sampled, 0);
  await connection.call("{.Q.view 2026.04.01 2026.04.02}", 0);
  assert.strictEqual(readAttributeSample(await connection.call(ATTRIBUTE_SAMPLE, "trade", 100000)).sampled, 6);
});

test("the attribute advisor does not cost a table it could not count from its sample (#1979)", { skip }, async (t) => {
  const { connection } = await connect(t, HDB("{[r;d] .Q.dd[r;d,`late`] set .Q.en[r] ([] sym:`a`b`c`d;qid:40 10 30 20;bid:1 2 3 4f)}[r] each 2026.01.05 2026.01.07;"));
  const s = readAttributeSample(await connection.call(ATTRIBUTE_SAMPLE, "late", 100000));
  assert.deepStrictEqual([s.kind, s.rows, s.sampled, s.partitions], ["partitioned", null, 4, 3]);
  const qid = advise(s, new Map([["qid", 1]])).find((a) => a.column === "qid");
  assert.deepStrictEqual([qid.suggest, qid.cost], ["u", null]);
  assert.match(qid.reason, /^every value distinct \(in 4 rows sampled\): u# makes/);
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

// The script set a global `n` to the row count and deleted it at its end:
// a process's own `n` was gone once the script had run.
test("the test data generator's q defines the table and no other name, however wide the table (#2016)", { skip }, async (t) => {
  const { connection } = await connect(t, "n:`precious`data\nkt:([k:`symbol$(); j:`long$()] v:`float$())\n");
  const col = (name, type) => ({ name, type, fkey: "", attr: "" });
  const wide = (count, types = "bgxhijefcspmdznuvtC") => ({ kind: "table", rows: 0, bytes: null, partitions: null, keys: [], ncols: count, columns: Array.from({ length: count }, (_, i) => col(`c${i}`, types[i % types.length])) });
  const o = { rows: 30, symbols: ["A", "B"], low: 0, high: 5, seed: 4 };
  const state = "{(n;asc key `.;asc system \"v\";asc system \"f\")}";
  const before = await connection.call(state, 0);
  const made = [];
  const run = async (info, name, options) => {
    const ran = readRun(await connection.call(RUN_SCRIPT, statements(testDataQ(info, name, options))));
    assert.ok(ran.ok, `${name}: ${ran.error}`);
    made.push(name);
  };
  await run(readTableInfo(await connection.call(TABLE_INFO, "kt", 100)), "gen", { ...o, sorted: "v" });
  assert.deepStrictEqual(await connection.call('{(keys gen;"f"$count gen;exec t from meta gen;v~asc v:exec v from gen)}', 0), [["k", "j"], 10, "sjf", true]);
  // A lambda holds some 250 columns at most: a wider table is still made,
  // each column of its type, with the rows asked for.
  for (const count of [1, 100, 101, 250, 1000]) {
    const info = wide(count);
    await run(info, `w${count}`, { ...o, sorted: "c12" });
    const got = await connection.call(`{t:get x; (cols[t]~\`$"c",/:string til ${count};exec t from meta t;"f"$count t;\`s=attr t\`c12)}`, `w${count}`);
    assert.deepStrictEqual(got, [true, info.columns.map((c) => c.type).join(""), 30, count > 12], `w${count}`);
  }
  // Strings, each column's drawn by a lambda of its own.
  await run(wide(300, "C"), "strs", o);
  assert.deepStrictEqual(await connection.call('{(distinct exec t from meta strs;"f"$count cols strs;"f"$count strs)}', 0), ["C", 300, 30]);
  // Names q cannot parse, and a column named as the count is.
  const odd = { ...wide(150), columns: wide(150).columns.map((c, i) => (i === 0 ? col("n", "j") : i === 149 ? col("px bid", "f") : c)) };
  await run(odd, "my t", o);
  assert.deepStrictEqual(await connection.call('{t:get`$"my t"; (2#cols t;last cols t;"f"$count t;"f"$count cols t)}', 0), [["n", "c1"], "px bid", 30, 150]);
  const after = await connection.call(state, 0);
  assert.deepStrictEqual(after[0], ["precious", "data"]);
  assert.deepStrictEqual(after[1], [...before[1], ...made].sort());
  assert.deepStrictEqual(after.slice(2), [[...before[2], ...made].sort(), before[3]]);
  // The same seed, the same rows.
  const first = await connection.call("{-8!w250}", 0);
  await run(wide(250), "w250", { ...o, sorted: "c12" });
  made.pop();
  assert.deepStrictEqual(await connection.call("{-8!w250}", 0), first);
  // A table named as the count was is the table (#1084).
  await run(wide(3), "n", o);
  assert.deepStrictEqual(await connection.call('{(exec t from meta n;"f"$count n)}', 0), ["bgx", 30]);
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
// A column the migration adds takes the target's attribute, in memory and
// in every partition on disk; u# on a column of one null a row is left out,
// with why, as q refuses it (#2145).
test("a schema migration sets the target's attribute on the columns it adds (#2145)", { skip }, async (t) => {
  const { connection, dir } = await connect(t, HDB() + "\na:([] k:1 2 3)\nb:([] k:1 2 3; s:`s#`a`b`c; p:`p#`x`x`y; g:`g#1 2 1; u:`u#1 2 3)\ntrade2:([] sym:`$(); px:`float$(); sz:`long$(); ex:`p#`symbol$(); n:`s#`long$(); w:`u#`long$())\n");
  const info = async (n) => readTableInfo(await connection.call(TABLE_INFO, n, 100));
  const script = migrationScript("a", await info("a"), "a", await info("b"), "b", "p");
  assert.match(script, /\n\/ not written: u# on u: it is added with one null in every row, which u# refuses\n/);
  const ran = readRun(await connection.call(RUN_SCRIPT, statements(script)));
  assert.ok(ran.ok, ran.error);
  assert.deepStrictEqual(await connection.call("{(exec t from meta a;string exec a from meta a)}", 0), ["jssjj", ["", "s", "p", "g", ""]]);
  // On disk: every partition, as a q of its own loads it.
  const disk = migrationScript("trade", await info("trade"), "trade", await info("trade2"), "trade2", "p");
  assert.match(disk, /\n\/ not written: u# on w: /);
  const done = readRun(await connection.call(RUN_SCRIPT, statements(disk)));
  assert.ok(done.ok, done.error);
  assert.match(done.text, /^changed (\d+) of \1 directories$/);
  const parts = await onDisk(t, `${dir}/hdb`, '{{f:` sv(hsym`$string x),`trade; (string x;string get` sv f,`.d;{string attr get x} each ` sv\'f,/:`ex`n`w)} each .Q.pv}');
  assert.deepStrictEqual(parts, ["2026.01.05", "2026.01.06", "2026.01.07"].map((p) => [p, ["sym", "px", "sz", "ex", "n", "w"], ["p", "s", ""]]));
  assert.deepStrictEqual(await onDisk(t, `${dir}/hdb`, '{(string exec a from meta trade;"f"$count select from trade where null ex)}'), [["", "", "", "", "p", "s", ""], 18]);
});

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

// Every type a meta names, cast to every other one, on a real q: what q's
// own cast makes of a column is asked of it here, so the casts the script
// leaves out (`castProblem`) cannot drift from what q does. A cast that is
// written runs and gives the type; one left out is one q's cast does not
// make, and says so (#2012).
const SAMPLE = {
  b: "101b", g: "3?0Ng", x: "0x010203", h: "1 2 3h", i: "1 2 3i", j: "1 2 3", e: "1 2 3e", f: "1.5 2.5 3.5", c: '"abc"', s: "`a`b`c",
  p: "2024.01.01D0+1 2 3", m: "2024.01 2024.02 2024.03m", d: "2024.01.01 2024.01.02 2024.01.03", z: "2024.01.01T00:00:00.000+1 2 3",
  n: "0D00:00:01 0D00:00:02 0D00:00:03", u: "00:01 00:02 00:03", v: "00:00:01 00:00:02 00:00:03", t: "00:00:00.001 00:00:00.002 00:00:00.003",
};
const ATOMS = Object.keys(SAMPLE);
const isList = (type) => type !== "" && type === type.toUpperCase();
const sampleOf = (type) => (type === "" ? '(1;`a;"x")' : isList(type) ? `{(2#x;1#x;0#x)}[${SAMPLE[type.toLowerCase()]}]` : SAMPLE[type]);
/// The type q's own cast of mgA's column to `t` gives, or the error.
const OWN_CAST = "{[t] @[{[t] string first exec t from meta ([] c:t$mgA`c)};$[1=count t;first t;t];{\"'\",x}]}";

/// A table whose column `c` is of every type in turn, migrated in memory to
/// the schema of one whose `c` is of every other: `each(from, to, script,
/// own)` is told the script and what q's own cast gives, after checking
/// that a script with a cast in it ran and made the column the target's.
async function everyCast(t, types, each) {
  const { connection } = await connect(t, types.map((type, i) => `mg${i}:([] k:1 2 3; c:${sampleOf(type)})`).join("\n") + "\n");
  const infos = [];
  for (let i = 0; i < types.length; i++) infos.push(readTableInfo(await connection.call(TABLE_INFO, `mg${i}`, 100)));
  assert.deepStrictEqual(infos.map((info) => info.columns[1].type), types);
  for (let a = 0; a < types.length; a++) {
    for (let b = 0; b < types.length; b++) {
      // A mixed column's cast is its values' to allow: it is not asked here.
      if (a === b || types[a] === "") continue;
      const [from, to] = [types[a], types[b]];
      await connection.call("{[a] `mgA set get a;}", `mg${a}`);
      const script = migrationScript("mgA", infos[a], "A", infos[b], "B", "p");
      const own = String(await connection.call(OWN_CAST, to.toLowerCase())).trim();
      if (!/\n\/ not written/.test(script)) {
        const ran = readRun(await connection.call(RUN_SCRIPT, statements(script)));
        assert.ok(ran.ok, `${from} to ${to}: ${script}${ran.error}`);
        const same = await connection.call("{[b;n] b:get b; (meta[mgA]~meta b;(type each mgA`c)~type each b`c;n|(count each mgA`c)~count each b`c)}", `mg${b}`, !(isList(from) && isList(to)));
        assert.deepStrictEqual(same, [true, true, true], `${from} to ${to}: ${script}`);
      }
      each(from, to, script, own);
    }
  }
  return connection;
}

test("a schema migration writes the casts q makes between atom columns, and no other (#2012)", { skip }, async (t) => {
  const written = [];
  const connection = await everyCast(t, ATOMS, (from, to, script, own) => {
    const left = script.match(/\n\/ not written: a cast of c from (\S+) to (\S+): (.*)\n/);
    if (left === null) return written.push(`${from}${to}`);
    // What is left out is what q's own cast refuses, by its name.
    assert.deepStrictEqual([left[1], left[2], own], [from, to, "'type"], script);
    assert.match(left[3], /^q has no cast from \w+ to \w+$/, script);
  });
  // 57 of the 306 are no cast of q's: a guid's but to and from text, a
  // date's or a month's to a time of day, and a time of day's to a date.
  assert.strictEqual(written.length, 306 - 57);
  for (const pair of ["jg", "gj", "bg", "dt", "dn", "mz", "nd", "tp", "um", "vz"]) assert.ok(!written.includes(pair), pair);
  for (const pair of ["gs", "sg", "jf", "dp", "md", "pd", "zt", "pn", "tn", "sc", "cs"]) assert.ok(written.includes(pair), pair);
  // No cast makes a typed column a mixed one, and none is written.
  await connection.call('{`mgA set ([] k:1 2 3; c:1 2 3); `mgM set ([] k:1 2 3; c:(1;`a;"x"));}', 0);
  const info = async (n) => readTableInfo(await connection.call(TABLE_INFO, n, 100));
  const mixed = migrationScript("mgA", await info("mgA"), "A", await info("mgM"), "M", "p");
  assert.match(mixed, /\n\/ not written: a cast of c from j to mixed: no cast makes a mixed column\n$/);
  assert.match(String(await connection.call(OWN_CAST, "")), /^'/);
  // A mixed column's cast is written, as an empty table's untyped column is one.
  for (const to of ATOMS) {
    await connection.call("{`mgA set ([] k:`long$(); c:());}", 0);
    const ran = readRun(await connection.call(RUN_SCRIPT, statements(migrationScript("mgA", await info("mgA"), "A", await info(`mg${ATOMS.indexOf(to)}`), "B", "p"))));
    assert.ok(ran.ok, `mixed to ${to}: ${ran.error}`);
    assert.strictEqual(await connection.call("{[t] first[t]~first exec t from meta mgA where c=`c}", to), true, to);
  }
});

// Between two list columns q's cast is the atoms', made in each item: it
// was refused as if one of the two were an atom column (#2013).
test("a schema migration casts a list column to another list type, as q does, and refuses no cast q makes (#2013)", { skip }, async (t) => {
  const LISTS = ATOMS.map((a) => a.toUpperCase());
  const written = [];
  const scripts = new Map();
  const connection = await everyCast(t, [...ATOMS, ...LISTS, ""], (from, to, script, own) => {
    scripts.set(`${from}>${to}`, script);
    const left = script.match(/\n\/ not written: a cast of c from (\S+) to (\S+): (.*)\n/);
    if (left === null) return written.push(`${from}${to}`);
    // Whatever is left out, q's own cast does not make the target's column of it.
    assert.notStrictEqual(own, to, script);
    if (isList(from) && isList(to)) assert.deepStrictEqual([own, left[3]], ["'type", script.match(/q has no cast from \w+ to \w+/)?.[0]], script);
    else if (to !== "" && isList(from) !== isList(to)) assert.match(left[3], /a list column's items are lists, an atom column's are not|a column of strings holds lists, not chars/, script);
  });
  // List to list is written where atom to atom is, pair for pair.
  const pairs = (types) => written.filter((w) => types.includes(w[0]) && types.includes(w[1]));
  assert.deepStrictEqual(pairs(LISTS).map((w) => w.toLowerCase()), pairs(ATOMS));
  assert.strictEqual(pairs(LISTS).length, 306 - 57);
  assert.match(scripts.get("J>F"), /\nmgA:update c:"f"\$c from mgA\n$/);
  assert.match(scripts.get("S>J"), /\nmgA:update c:\{"J"\$string x\} each c from mgA\n$/);
  assert.match(scripts.get("G>J"), /\n\/ not written: a cast of c from G to J: q has no cast from guid to long\n$/);
  assert.match(scripts.get("J>j"), /\n\/ not written: a cast of c from J to j: a list column's items are lists, an atom column's are not\n$/);
  // The issue's own table, ragged and with an empty item, and the values it holds after.
  await connection.call("{`mgA set ([] a:1 2 3; b:(1 2;`long$();enlist 6)); `mgB set ([] a:1 2 3; b:(1 2f;3 4f;5 6f));}", 0);
  const info = async (n) => readTableInfo(await connection.call(TABLE_INFO, n, 100));
  const ran = readRun(await connection.call(RUN_SCRIPT, statements(migrationScript("mgA", await info("mgA"), "A", await info("mgB"), "B", "p"))));
  assert.ok(ran.ok, ran.error);
  assert.deepStrictEqual(await connection.call("{(meta[mgA]~meta mgB;mgA[`b]~(1 2f;`float$();enlist 6f))}", 0), [true, true]);
});

test("a schema migration casts on disk what the column manager casts, and no other (#2012)", { skip }, async (t) => {
  const cols = [...ATOMS.map((a) => `c${a}:${SAMPLE[a]}`), 'sC:("12";"2024.01.01";"x")', "lJ:(1 2;3 4;5 6)"].join("; ");
  const { connection } = await connect(t, [
    'r:hsym`$"$DIR/hdb";',
    `{[r;n] .Q.dd[r;2026.01.05,n,\`] set .Q.en[r] ([] k:1 2 3; ${cols})}[r] each \`$"mg",/:"${ATOMS.join("")}";`,
    "\\l $DIR/hdb",
    "",
  ].join("\n"));
  const { castProblem } = require("../out/migrate.js");
  for (const to of ATOMS) {
    const from = readTableInfo(await connection.call(TABLE_INFO, `mg${to}`, 100));
    assert.strictEqual(from.columns.map((c) => c.type).join(""), `dj${ATOMS.join("")}CJ`);
    const target = { ...from, kind: "table", columns: from.columns.map((c) => (c.name === "date" || c.name === "k" ? c : { ...c, type: to })) };
    const script = migrationScript(`mg${to}`, from, "disk", target, "B", "p");
    const done = readRun(await connection.call(RUN_SCRIPT, statements(script)));
    assert.ok(done.ok, done.error);
    // Every cast written was made: no directory was left as it was.
    assert.match(done.text, /^changed (\d+) of \1 directories$/, `to ${to}: ${done.text}`);
    const kept = from.columns.slice(2).map((c) => (c.type === to || castProblem(c.type, to, true) === undefined ? to : c.type));
    assert.strictEqual(await connection.call("{[n] exec t from meta get n}", `mg${to}`), `dj${kept.join("")}`, `to ${to}`);
    for (const c of from.columns.slice(2)) assert.strictEqual(script.includes(`/ not written: a cast of ${c.name} from ${c.type} to ${to}: `), kept[from.columns.indexOf(c) - 2] !== to, `${c.name} to ${to}`);
  }
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

// A dictionary's keys were counted as its rows, and its time not found
// (#2415); a row of atoms whose first is a string counted that string's
// length (#2500).
test("a tickerplant log's dictionary and string-first one-row messages are one row each, with a time", { skip }, async (t) => {
  const log = [
    'f:hsym`$"$DIR/tp.log";',
    ".[f;();:;()];",
    "h:hopen f;",
    "h enlist(`upd;`trade;`time`sym`px!(0D09:30;`a;1f));",
    'h enlist(`upd;`news;("ECB raises rates by 25bp";12:00:00.000;`EUR));',
    "h enlist(`upd;`trade;`time`sym!(09:00 09:01;`a`b));",
    'h enlist(`upd;`news;(("up";"down");12:00:01.000 12:00:02.000;`EUR`USD));',
    "hclose h;",
    "",
  ].join("\n");
  const { connection, dir } = await connect(t, log + TPLOG_INIT + "\n");
  readTpLog(await connection.call(".qlint.tp.load", path.join(dir, "tp.log")));
  const all = readTpPage(await connection.call(".qlint.tp.page", "", NaN, NaN, 0, 100));
  assert.deepStrictEqual(all.rows.map((r) => r.rows), [1, 1, 2, 2]);
  assert.deepStrictEqual(all.rows.map((r) => r.time), ["0D09:30:00.000000000", "12:00:00.000", "09:00", "12:00:01.000"]);
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
