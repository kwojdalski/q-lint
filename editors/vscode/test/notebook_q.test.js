// A notebook's cells against a real q process (#857): the data lambda a
// `@grid` or `@chart` cell sends, the outputs a cell shows from what it
// answers, and an exported notebook loaded by q. Needs a q binary, so it
// runs only when QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");
const { DATA, cellOutputs, readCellData } = require("../out/celldata.js");
const { cellDirective } = require("../out/celldirectives.js");
const { exportScript } = require("../out/qnb.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 80];

const SERVER = `
t:([] sym:\`a\`b\`c; ts:2024.01.01D12:00:00.123456789+0 1 2; px:1.5 0n 3.5; note:(enlist "x";"<b>y</b>";enlist "z"); n:(1 2;\`a;"q"))
kt:([k:1 2] v:\`x\`y)
big:([] i:til 2000)
`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// Start a q process on a free port, loading `body`; resolves once it accepts.
async function startQ(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-notebook-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, body);
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
        dir,
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

test("notebook cells against a real q process", { skip }, async (t) => {
  const q = await startQ(SERVER);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const data = async (code, rows = 1000) => readCellData(await connection.call(DATA, statements(code), rows, SIZE));

  await t.test("a table comes back as strings per column, nanoseconds kept", async () => {
    const answer = await data("t");
    assert.deepStrictEqual(answer, {
      ok: true,
      table: {
        columns: ["sym", "ts", "px", "note", "n"],
        types: [11, 12, 9, 0, 0],
        keys: 0,
        data: [
          ["a", "b", "c"],
          ["2024.01.01D12:00:00.123456789", "2024.01.01D12:00:00.123456790", "2024.01.01D12:00:00.123456791"],
          ["1.5", "", "3.5"],
          ["x", "<b>y</b>", "z"],
          ["1 2", "`a", "\"q\""],
        ],
        total: 3,
      },
    });
  });

  await t.test("a keyed table is unkeyed and says how many key columns it had", async () => {
    const answer = await data("kt");
    assert.deepStrictEqual(answer.table, { columns: ["k", "v"], types: [7, 11], keys: 1, data: [["1", "2"], ["x", "y"]], total: 2 });
  });

  await t.test("a large table is cut by the process, and its count kept", async () => {
    const answer = await data("big", 10);
    assert.strictEqual(answer.table.total, 2000);
    assert.deepStrictEqual(answer.table.data[0], ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    const [grid] = cellOutputs({ mode: "grid" }, answer);
    assert.match(grid.items[0].text, /Showing the first 10 of 2,000 rows\./);
  });

  await t.test("an empty table has its columns and no rows", async () => {
    const answer = await data("0#t");
    assert.deepStrictEqual(answer.table.columns, ["sym", "ts", "px", "note", "n"]);
    assert.deepStrictEqual(answer.table.data, [[], [], [], [], []]);
    assert.strictEqual(answer.table.total, 0);
  });

  await t.test("a value that is not a table comes back as text", async () => {
    assert.deepStrictEqual(await data("1+1"), { ok: true, type: -7, text: ["2"] });
    const dict = await data("`a`b!1 2");
    assert.strictEqual(dict.type, 99);
  });

  await t.test("an error comes back with its message and trace", async () => {
    const answer = await data("g:{x+`a}\ng 1");
    assert.strictEqual(answer.ok, false);
    assert.strictEqual(answer.error, "type");
    assert.match(answer.trace, /\{x\+`a\}/);
    assert.doesNotMatch(answer.trace, /\.Q\.trp|value each/);
    const [part] = cellOutputs({ mode: "grid" }, answer);
    assert.strictEqual(part.kind, "error");
    assert.strictEqual(part.message, "'type");
  });

  await t.test("the data lambda defines nothing on the process", async () => {
    const before = await connection.query(["system \"v\""], SIZE);
    await data("select from t where px>1");
    await data("kt");
    await data("1+`a");
    assert.deepStrictEqual(await connection.query(["system \"v\""], SIZE), before);
  });

  await t.test("a cell with a directive runs to the outputs it asks for", async () => {
    const source = "/ @grid\nselect sym, note from t";
    const mode = cellDirective(source);
    const [grid] = cellOutputs(mode, await data(source));
    assert.deepStrictEqual(grid.items.map((i) => i.mime), ["text/html", "text/plain"]);
    assert.ok(grid.items[0].text.includes("<td>&lt;b&gt;y&lt;/b&gt;</td>"), grid.items[0].text);
    assert.ok(!grid.items[0].text.includes("<b>y</b>"));
  });
});

test("an exported notebook loads in q and defines what its cells define", { skip }, async (t) => {
  const cells = [
    { kind: "markdown", source: "# A notebook\n\nwith a lone\n\\\nin it" },
    { kind: "code", source: "/ @console\na:1\nf:{[x]\n  x+a}" },
    { kind: "code", source: "/ @grid\nr:([] v:f each 1 2 3)\nr" },
    { kind: "code", source: "b:2\n/\nnot code\n" },
    { kind: "code", source: "c:3\n\\\nthe rest of this cell is not code" },
    { kind: "code", source: "d:a+b+c" },
  ];
  const q = await startQ("");
  t.after(() => q.stop());
  const file = path.join(q.dir, "exported.q");
  fs.writeFileSync(file, exportScript(cells, "a.qnb"));
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const loaded = await connection.query([`system "l ${file}"`], SIZE);
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded));
  assert.deepStrictEqual((await connection.query(["(a;f 1;exec v from r;b;c;d)"], SIZE)).text, ["1", "2", "2 3 4", "2", "3", "6"]);
});
