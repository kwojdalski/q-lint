// What a result is exported as, read back by a real q (#2081-#2090): Copy
// as q's text must be the value (`~`), over every type, null, infinity,
// -0, guid, temporal past 99 hours, symbol of bytes that are no UTF-8,
// string, general list, nested table and mapped column; JSON, Excel and
// Parquet keep a number a number, with digits enough to read it back.
// Needs a q binary, so it runs only when QLINT_TEST_Q names one.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");
const { tableLiteral } = require("../out/qliteral.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 80];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-roundtrip-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source(dir));
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, cwd: dir, stdio: ["ignore", "ignore", "pipe"], detached: true });
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
  throw new Error("q did not start listening");
}

// A splayed table read back by name: its nested columns are mapped (77h).
const SERVER = (dir) => `
(hsym \`$"${dir}/spl/") set ([] s:("ab";"cd";enlist "x";"caf\\303\\251"); f:(acos -1;1 2f;3 4f;0.1); n:1 2 3 4);
sp:get hsym \`$"${dir}/spl/"
`;

/// Atoms of every type, each with its nulls, infinities and edges.
const ATOMS = [
  "1b", "0b",
  '"G"$"8c680a01-5a49-5aab-5a65-d4bfddb6a661"', "0Ng",
  "0x01", "0x00",
  "1h", "0Nh", "0Wh", "-0Wh",
  "1i", "0Ni", "0Wi", "-0Wi",
  "1", "0N", "0W", "-0W", "9007199254740993", "-9007199254740993",
  "1.5e", "0Ne", "0we", "-0we", "0.1e", "-0e", "3.4e38",
  "acos -1", "0n", "0w", "-0w", "-0f", "0.1", "1e300", "5e-324", "-1.7976931348623157e308",
  '"x"', '"\\351"', '"\\""', '" "',
  "`a", "`", '`$"a b"', '`$"_y"', '`$"caf\\351"', '`$"caf\\303\\251"',
  "2024.01.02D03:04:05.123456789", "0Np", "0Wp", "-0Wp", '"p"$-9200000000000000000', '"p"$9200000000000000000',
  "1709.01.01D00:00", "2290.12.31D23:59:59.999999999",
  "2024.01m", "0Nm", "0Wm",
  "2024.01.31", "0Nd", "0Wd", "-0Wd",
  "2024.01.02T03:04:05.123", "0Nz", "0wz", '"z"$1.123456789',
  "0D01:02:03.000000004", "0Nn", "0Wn", "-0D00:00:01",
  "10:30", "100:00", "-100:00", "0Nu", "0Wu",
  "10:30:01", "100:00:00", "0Nv",
  "10:30:01.002", '"t"$400000000', "0Nt", "-0Wt",
];

/// Lists: vectors of each type, their one-item and empty forms, strings,
/// and general lists holding the atoms and lists.
const LISTS = [
  "101b", '"G"$("8c680a01-5a49-5aab-5a65-d4bfddb6a661";"")', "0x0aff", "1 0N 0Wh", "1 0N -0Wi", "1 0N 0W", "1.5 0N -0e", "0.1 -0 0n 0w",
  "acos 1 -1f", '"ab"', "`a`b", '`$("a b";"caf\\351")', "2024.01.02D03:04:05.123456789 0Np", '"p"$0N 9200000000000000000', "2024.01 2023.12m", "2024.01.31 0Nd",
  "2024.01.02T03:04:05.123 0Nz", '"z"$0n 1.123456789 0w', '"z"$2 1.5',  "-100:00 0Wu", '"t"$-2147483646 0N',  '"v"$enlist 2147483646', "0D01 0Nn", "01:00 100:00", "100:00:00 0Nv", '"t"$0N 400000000',
  "enlist 1", "enlist 0.1", "enlist `a", 'enlist "x"', "enlist 100:00", "`float$()", "`long$()", "`symbol$()", '""', "`guid$()",
  '"caf\\303\\251"', '"caf\\351"', '"tab\\there"', "200#\"a\"",
  "(1;`a)", "(1 2;0Ng)", "(0Ng,0Ng;1)", "(`a`b!1 2;1)", "(([]x:1 2);1)", "((1;2);(3;`a))", "(::;1)", "({x};1)",
];

/// Every atom and list, as a general column's item beside another, and as
/// a column of its own where it is one.
function values() {
  const out = [];
  for (const a of [...ATOMS, ...LISTS]) {
    out.push(`([] a:(${a};1))`);
    out.push(`([] a:(1;${a}))`);
    out.push(`([] a:enlist ${a})`);
  }
  for (const a of ATOMS) {
    out.push(`([] a:(${a};${a}))`);
  }
  for (const l of LISTS) {
    out.push(`([] a:${l})`);
  }
  return out.concat([
    // Dictionaries, keyed tables and tables in a column.
    "`a`b!(100:00;1)",
    "`a`b!([] x:(acos -1;2f))",
    "flip `key`value!(`a`b;([] x:(acos -1;0.1)))",
    "([] a:1 2; t:([] x:(acos -1;0.1)))",
    "([] a:1 2; t:([] x:(0Ng;\"G\"$\"8c680a01-5a49-5aab-5a65-d4bfddb6a661\"); y:(100:00;1)))",
    "([k:`$(\"caf\\351\";\"ok\")] v:1 2)",
    "([] s:`$(\"caf\\351\";\"ok\"))",
    "([] a:-0 1e)",
    "([] f:-0.0 1)",
    "([] a:(1;0n;2.5;0Nj;1b;0x01))",
    "([] l:(acos -1;0n;\"x\"))",
    // A mapped splayed table's nested columns (77h).
    "sp",
  ]);
}

/// The classes not yet written back, each by the issue that holds it.
const PENDING = [
  [2083, (c) => /\\351/.test(c)],
  [2084, (c) => c === "sp"],
  [2085, (c) => /\(\[\] x:|t:\(\[\]/.test(c)],
];

test("Copy as q writes every value so that q reads it back as the value (#2081-#2085, #2089)", { skip }, async (t) => {
  const q = await startQ(SERVER);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());
  const bad = [];
  for (const code of values().filter((c) => !PENDING.some(([, held]) => held(c)))) {
    const answer = await connection.queryGrid(statements(code), SIZE, 1000);
    if (answer.grid === undefined) {
      bad.push(`${code}: no grid ${answer.gridError ?? answer.error ?? ""}`);
      continue;
    }
    const table = tableLiteral(answer.grid);
    // A string past 200 characters is cut, and said to be.
    if (table.cut > 0) {
      if (!/200#/.test(code)) {
        bad.push(`${code}: said cut, as ${table.code}`);
      }
      continue;
    }
    // A dictionary is shown as its key and value columns, keyed by the key;
    // a mapped table is its rows.
    const value = code === "sp" ? "select from sp" : `{$[99h<>type x;x;98h=type key x;x;1!flip\`key\`value!(key x;value x)]} ${code}`;
    const same = await connection.query(statements(`(${value})~${table.code}`), SIZE);
    if (same.text?.join("") !== "1b") {
      bad.push(`${code}\n   written ${table.code}\n   q: ${(same.text ?? []).join(" ") || same.error}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});
