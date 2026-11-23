// The q side of #1054, #1057 and #1061 against a real q process: every
// example in the error catalogue raises the error it explains, the dead
// code report's process check finds the candidates a function the process
// holds names, and the SQL tab's query runs on KDB-X's SQL engine (PeachQ's
// own `.s.e`, backed by DuckDB, refuses it with 'duckdb where DuckDB is not
// installed). Needs a q binary, so it runs only when QLINT_TEST_Q names one.
require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { ERRORS, errorName } = require("../out/errorexplain.js");
const { CALLED } = require("../out/deadcodeview.js");
const { HAS_SQL, SQL_SCHEMA, readSchema, sqlQuery, sqlWrites } = require("../out/sql.js");

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

async function connect(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-lang-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source);
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true, cwd: dir });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  t.after(stop);
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (up) {
      const connection = await QConnection.open({ host: "127.0.0.1", port });
      t.after(() => connection.close());
      return connection;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("q did not start listening");
}

test("every example in the error catalogue raises the error it explains", { skip }, async (t) => {
  const c = await connect(t, "t:([k:1 2]v:3 4)\n");
  for (const [name, entry] of Object.entries(ERRORS)) {
    if (entry.example === undefined || entry.checked === "documented") {
      continue;
    }
    const answer = await c.call("{r:@[{(1b;value x)};x;{(0b;x)}]; $[r 0;\"(no error)\";r 1]}", ` ${entry.example}`);
    const got = errorName(String(answer));
    // PeachQ names some differently, as the catalogue says.
    const alternative = /reports '([a-z-]+)/.exec(entry.peachq ?? "")?.[1];
    assert.ok(got === name || got === alternative, `${name}: ${entry.example} raised '${got}'`);
  }
});

test("the dead code report's process check finds what a function the process holds names", { skip }, async (t) => {
  const c = await connect(t, ["\\d .util", "helper:{x+1}", "caller:{helper x}", "other:{x}", "\\d .", "top:{x}", "usesTop:{top 1}", "alone:{x}", "f:{x}", "runner:{.util.other x}", ""].join("\n"));
  const got = await c.call(CALLED, ".util.helper .util.other top alone nothere f");
  const names = (Array.isArray(got) ? got : [got]).map(String).sort();
  // `alone` and `f` are named by no other function; `nothere` by none;
  // `.util.other` only by its whole name (#1227).
  assert.deepStrictEqual(names, [".util.helper", ".util.other", "top"]);
});

test("the SQL tab's query runs on KDB-X's SQL engine, loading it where there is none", { skip }, async (t) => {
  const c = await connect(t, "t:([]sym:`a`b`a;px:1 2 3f;size:10 20 30)\n");
  const schema = readSchema(await c.call(SQL_SCHEMA));
  assert.deepStrictEqual(schema.get("t"), ["sym", "px", "size"]);
  const had = await c.call(HAS_SQL);
  const kdbx = String(await c.call(".z.K")) >= "5" && had === false;
  let answer;
  try {
    answer = await c.call(sqlQuery("select sym, sum(size) as total -- per sym\nfrom t group by sym", true));
  } catch (error) {
    // PeachQ's `.s.e` needs DuckDB.
    assert.ok(!kdbx && /duckdb/.test(error.message), error.message);
    return;
  }
  assert.strictEqual(await c.call(HAS_SQL), true);
  const rows = Array.isArray(answer) ? answer : [];
  assert.deepStrictEqual(rows.map((r) => [String(r.sym), Number(r.total)]), [["a", 40], ["b", 20]]);
  // Loaded once: the plain form runs now.
  const again = await c.call(sqlQuery("select count(*) as n from t"));
  assert.strictEqual(Number((Array.isArray(again) ? again : [])[0]?.n), 3);
  // A write behind a block comment still writes, and Run SQL asks about it.
  const hidden = "/* note */ insert into t values ('c', 4.0, 40)";
  assert.deepStrictEqual(sqlWrites(hidden), ["INSERT"]);
  await c.call(sqlQuery(hidden));
  assert.strictEqual(Number(await c.call("count t")), 4);
});
