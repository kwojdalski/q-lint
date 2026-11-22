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
  // A process with no database says so.
  const { connection: plain } = await connect(t, "a:1\n");
  assert.strictEqual(readPartitions(await plain.call(PARTITION_CHECK, 1000, false)).hdb, false);
});

const { SYM_INSPECT, readSym, symReport } = require("../out/syminspect.js");
const { TABLE_INFO, readTableInfo } = require("../out/tableinfo.js");

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
