// The reads behind List q Tables (#951) and @q (#952, #953) against a real
// q process: what DESCRIBE says a name holds, the tables GATHER lists and a
// table's schema from TABLE_INFO, partitioned and splayed ones included.
// Needs a q binary, so it runs only when QLINT_TEST_Q names one.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { DESCRIBE, readDescribed, tablesOf, schemaOf } = require("../out/assist.js");
const { GATHER, LIMITS, readGathered } = require("../out/explorer.js");
const { TABLE_INFO, readTableInfo } = require("../out/tableinfo.js");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-assist-"));
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

const SERVER = [
  "dir:`$\":$DIR/db\";",
  "{[dir;d] .Q.dd[dir;d,`trade`] set .Q.en[dir;([]sym:`a`b`c;px:1 2 3f)]}[dir] each 2024.01.01 2024.01.02;",
  ".Q.dd[dir;`ref`] set .Q.en[dir;([]sym:`a`b;v:1 2)];",
  "system\"l $DIR/db\";",
  "f:{[x] x*2}",
  "big:til 1000000",
  "s:\"hello\"",
  "proj:(+)[1]",
  "k:([id:`u#1 2]v:3 4)",
  ".ns.t:([]a:`s#1 2;b:`x`y)",
  "",
].join("\n");

test("DESCRIBE says what each name holds, reading nothing whole", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  const d = readDescribed(await c.call(DESCRIBE, "f big s proj k .ns.t trade ref nosuch"));
  assert.deepStrictEqual(d.map((x) => [x.name, x.kind]), [
    ["f", "lambda"], ["big", "variable"], ["s", "variable"], ["proj", "function"], ["k", "keyed"], [".ns.t", "table"], ["trade", "partitioned"], ["ref", "splayed"], ["nosuch", "missing"],
  ]);
  assert.strictEqual(d[0].text, "{[x] x*2}");
  assert.deepStrictEqual([d[1].count, d[1].text], [1000000, "0 1 2 3 4 5 6 7 8 9"]);
  assert.strictEqual(d[2].text, '"hello"');
  assert.strictEqual(d[6].text, "date sym px");
  // One name, a one-character one.
  assert.deepStrictEqual(readDescribed(await c.call(DESCRIBE, "f")).map((x) => x.kind), ["lambda"]);
});

test("DESCRIBE names a view and does not evaluate it (#1133)", { skip }, async (t) => {
  const c = await connect(t, "calls:0\nvw::calls+::1\n");
  assert.deepStrictEqual(readDescribed(await c.call(DESCRIBE, "vw calls")).map((x) => [x.name, x.kind]), [["vw", "view"], ["calls", "variable"]]);
  assert.strictEqual(String((await c.evaluate("calls")).value), "0");
});

test("the tables GATHER lists, and one table's schema", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  const { tables, more } = tablesOf(readGathered(await c.call(GATHER, "q Q h j o s z help", LIMITS)));
  assert.strictEqual(more, 0);
  const by = Object.fromEntries(tables.map((x) => [x.name, x]));
  assert.deepStrictEqual(Object.keys(by).sort(), [".ns.t", "k", "ref", "trade"]);
  assert.deepStrictEqual(by.trade, { name: "trade", kind: "partitioned", rows: 6, columns: ["date", "sym", "px"] });
  assert.deepStrictEqual(by.k, { name: "k", kind: "keyed", rows: 2, keys: ["id"], columns: ["id", "v"] });
  const k = schemaOf("k", readTableInfo(await c.call(TABLE_INFO, "k", 200)));
  assert.deepStrictEqual(k.columns, [{ name: "id", type: "long", attribute: "unique" }, { name: "v", type: "long" }]);
  const trade = schemaOf("trade", readTableInfo(await c.call(TABLE_INFO, "trade", 200)));
  assert.deepStrictEqual([trade.kind, trade.rows, trade.partitions], ["partitioned", 6, 2]);
  assert.deepStrictEqual(trade.columns.map((x) => x.type), ["date", "symbol", "float"]);
});
