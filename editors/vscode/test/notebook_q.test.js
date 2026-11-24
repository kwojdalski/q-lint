// A notebook's cells against a real q process (#857): the data lambda a
// `@grid` cell sends, what a `@chart` cell asks for and the chart item it
// makes (#870), the outputs a cell shows from what it answers, and an
// exported notebook loaded by q. Needs a q binary, so it
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
const { CHART_MIME, DATA, cellOutputs, chartCellOutputs, GRID_ROWS, readCellData, tableText } = require("../out/celldata.js");
const { cellDirective } = require("../out/celldirectives.js");
const { rowsArgument } = require("../out/liveconfig.js");
const { exportScript } = require("../out/qnb.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 80];

const SERVER = `
t:([] sym:\`a\`b\`c; ts:2024.01.01D12:00:00.123456789+0 1 2; px:1.5 0n 3.5; note:(enlist "x";"<b>y</b>";enlist "z"); n:(1 2;\`a;"q"))
kt:([k:1 2] v:\`x\`y)
kt2:([k:1 2; j:\`a\`bb] v:\`xx\`y; w:3 4)
big:([] i:til 2000)
sp:get (hsym \`$(string .z.f),"_db/sp/") set ([] s:("ab";enlist "c";"de"); n:1 2 3)
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

  await t.test("a table's text is the text q's console shows for it, a keyed table's rule included", async () => {
    for (const name of ["kt", "kt2", "([] a:1 22; b:`x`yyy)"]) {
      const console = await connection.query([name], SIZE);
      assert.deepStrictEqual(tableText((await data(name)).table), console.text.map((l) => l.trimEnd()), name);
    }
  });

  await t.test("a column named by the null symbol is shown with no name, as the console shows it (#1981)", async () => {
    const name = "flip(`a,`,`b)!(1 2;3 4;5 6)";
    const answer = await data(name);
    assert.deepStrictEqual(answer.table.columns, ["a", "", "b"]);
    const console = await connection.query([name], SIZE);
    assert.deepStrictEqual(tableText(answer.table), console.text.map((l) => l.trimEnd()));
  });

  await t.test("a large table is cut by the process, and its count kept", async () => {
    const answer = await data("big", 10);
    assert.strictEqual(answer.table.total, 2000);
    assert.deepStrictEqual(answer.table.data[0], ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    const [grid] = cellOutputs({ mode: "grid" }, answer);
    assert.match(grid.items[0].text, /Showing the first 10 of 2,000 rows\./);
  });

  await t.test("the row limit takes the last rows, or every row, on the process (#889)", async () => {
    const last = await data("big", rowsArgument({ rowLimit: 3, rowLimitFrom: "last" }));
    assert.strictEqual(last.table.total, 2000);
    assert.deepStrictEqual(last.table.data[0], ["1997", "1998", "1999"]);
    const [grid] = cellOutputs({ mode: "grid" }, last, "last");
    assert.match(grid.items[0].text, /Showing the last 3 of 2,000 rows\./);
    // A keyed table's last rows keep their keys.
    const keyed = await data("kt", rowsArgument({ rowLimit: 1, rowLimitFrom: "last" }));
    assert.deepStrictEqual([keyed.table.keys, keyed.table.data], [1, [["2"], ["y"]]]);
    for (const rowLimitFrom of ["first", "last"]) {
      const all = await data("big", rowsArgument({ rowLimit: 0, rowLimitFrom }));
      assert.strictEqual(all.table.data[0].length, 2000, rowLimitFrom);
      assert.deepStrictEqual([all.table.data[0][0], all.table.data[0][1999]], ["0", "1999"]);
      assert.ok(!cellOutputs({ mode: "grid" }, all, rowLimitFrom)[0].items[0].text.includes("Showing"));
    }
    // A table shorter than the limit comes back whole, from either end.
    assert.deepStrictEqual((await data("kt", rowsArgument({ rowLimit: 10, rowLimitFrom: "last" }))).table.data[0], ["1", "2"]);
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

  await t.test("a splayed table on disk comes back as a table, its string column as strings", async () => {
    // A table mapped from disk, as an HDB's splayed tables are; its string
    // column is a mapped list (77h on KDB-X, 87h on PeachQ).
    for (const rows of [1000, 2]) {
      const answer = await data("sp", rows);
      assert.ok(answer.table !== undefined, JSON.stringify(answer));
      assert.deepStrictEqual(answer.table.columns, ["s", "n"]);
      assert.deepStrictEqual(answer.table.data, [["ab", "c", "de"].slice(0, rows), ["1", "2", "3"].slice(0, rows)]);
      assert.strictEqual(answer.table.total, 3);
    }
    assert.deepStrictEqual((await data("select from sp where n>1")).table.data[0], ["c", "de"]);
  });

  await t.test("a table with two columns of one name keeps both, as q shows them", async () => {
    // A keyed table may name a value column as its key column.
    const keyed = await data("([a:1 2] a:3 4)");
    assert.deepStrictEqual([keyed.table.columns, keyed.table.keys, keyed.table.data], [["a", "a"], 1, [["1", "2"], ["3", "4"]]]);
    const flipped = await data("flip `a`a!(1 2;3 4)");
    assert.deepStrictEqual(flipped.table.data, [["1", "2"], ["3", "4"]]);
  });

  await t.test("a dictionary keyed by a table, with a list for its value, comes back as text", async () => {
    const answer = await data("([] a:1 2)!3 4");
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    assert.strictEqual(answer.type, 99);
    assert.deepStrictEqual(answer.text.map((l) => l.trimEnd()), ["a|", "-| -", "1| 3", "2| 4"]);
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

  const chart = async (source) => {
    const mode = cellDirective(source);
    return chartCellOutputs(mode, await connection.queryGrid(statements(source), SIZE, GRID_ROWS));
  };

  await t.test("a chart cell makes the chart item and the table as text", async () => {
    const [part] = await chart("/ @chart scatter\n/ @title Prices\nselect ts, px from t");
    assert.deepStrictEqual(part.items.map((i) => i.mime), [CHART_MIME, "text/plain"]);
    const spec = JSON.parse(part.items[0].text);
    assert.strictEqual(spec.kind, "scatter");
    assert.strictEqual(spec.title, "Prices");
    assert.deepStrictEqual(spec.grid.columns.map((c) => [c.name, c.type, c.temporal, c.numeric]), [
      ["ts", 12, true, false],
      ["px", 9, false, true],
    ]);
    // The timestamp in nanoseconds since 2000.01.01, the null float a null.
    assert.deepStrictEqual(spec.grid.values[0], [757425600123456789, 757425600123456790, 757425600123456791].map(Number));
    assert.deepStrictEqual(spec.grid.values[1], [1.5, null, 3.5]);
    assert.strictEqual(spec.note, undefined);
    assert.match(part.items[1].text, /^ts +px\n-+\n2024\.01\.01D12:00:00\.123456789 1\.5\n/);
  });

  await t.test("a chart cell charts a keyed table, a dictionary and a list as the panel does, and cuts a large table", async () => {
    const keyed = JSON.parse((await chart("/ @chart bar\nkt"))[0].items[0].text);
    assert.deepStrictEqual(keyed.grid.columns.map((c) => [c.name, c.key]), [["k", true], ["v", false]]);
    const dict = JSON.parse((await chart("/ @chart bar\n`a`b!1 2"))[0].items[0].text);
    assert.deepStrictEqual(dict.grid.columns.map((c) => c.name), ["key", "value"]);
    const list = JSON.parse((await chart("/ @chart histogram\n1 2 2 3f"))[0].items[0].text);
    assert.deepStrictEqual(list.grid.values[0], [1, 2, 2, 3]);
    const big = JSON.parse((await chart("/ @chart line\nbig"))[0].items[0].text);
    assert.strictEqual(big.grid.cells[0].length, GRID_ROWS);
    assert.strictEqual(big.note, "Showing the first 1,000 of 2,000 rows.");
  });

  await t.test("a chart cell's row limit takes the last rows, or every row, on the process (#889)", async () => {
    const lastChart = async (source, limit) =>
      chartCellOutputs(cellDirective(source), await connection.queryGrid(statements(source), SIZE, rowsArgument(limit)), limit.rowLimitFrom);
    const [part] = await lastChart("/ @chart line\nbig", { rowLimit: 5, rowLimitFrom: "last" });
    const spec = JSON.parse(part.items[0].text);
    assert.deepStrictEqual(spec.grid.cells[0], ["1995", "1996", "1997", "1998", "1999"]);
    assert.deepStrictEqual(spec.grid.values[0], [1995, 1996, 1997, 1998, 1999]);
    assert.strictEqual(spec.note, "Showing the last 5 of 2,000 rows.");
    assert.strictEqual(part.items[1].text.split("\n").at(-1), "Showing the last 5 of 2,000 rows.");
    const all = JSON.parse((await lastChart("/ @chart line\nbig", { rowLimit: 0, rowLimitFrom: "last" }))[0].items[0].text);
    assert.strictEqual(all.grid.cells[0].length, 2000);
    assert.strictEqual(all.note, undefined);
  });

  await t.test("a chart cell whose value is no table, or fails, shows it as other cells do", async () => {
    const [atom] = await chart("/ @chart line\n1+1");
    assert.deepStrictEqual(atom.items.map((i) => i.mime), ["text/plain"]);
    assert.match(atom.items[0].text, /^2\n\(@chart shows a table/);
    const [error] = await chart("/ @chart line\n1+`a");
    assert.strictEqual(error.kind, "error");
    assert.strictEqual(error.message, "'type");
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

test("a grid cell shows a partitioned table, cut as the result panel cuts it (#1368)", { skip }, async (t) => {
  const q = await startQ(`
{[d] .Q.dd[hsym \`$(string .z.f),"_hdb";d,\`p\`] set .Q.en[hsym \`$(string .z.f),"_hdb"] ([] sym:\`a\`b\`c; px:1 2 3f)} each 2026.01.01 2026.01.02;
system "l ",(string .z.f),"_hdb";
`);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const data = async (rows) => readCellData(await connection.call(DATA, statements("p"), rows, SIZE));
  const first = await data(4);
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.deepStrictEqual(first.table.columns, ["date", "sym", "px"]);
  assert.strictEqual(first.table.total, 6);
  assert.deepStrictEqual(first.table.data[1], ["a", "b", "c", "a"]);
  const last = await data(-2);
  assert.deepStrictEqual(last.table.data[0], ["2026.01.02", "2026.01.02"]);
  assert.deepStrictEqual(last.table.data[1], ["b", "c"]);
  assert.strictEqual((await data(Infinity)).table.data[0].length, 6);
});

test("an exported notebook whose comments hold a lone / loads to its end", { skip }, async (t) => {
  // KDB-X opens a block comment inside a block comment on a lone `/`, and
  // one `\` then closes only that one: the rest of the script was comment.
  const cells = [
    { kind: "markdown", source: "a path:\n/\nthe root" },
    { kind: "code", source: "a:1\n/\nnot code\n/\nstill not\n\\" },
    { kind: "code", source: "b:2\n\\\nended, and\n/\nstill ended" },
    // Nested, as the cell runs it (#1731): only e:5 is code.
    { kind: "code", source: "/\n/\n\\\nz:9\n\\\ne:5" },
    { kind: "code", source: "c:a+b+e" },
  ];
  const q = await startQ("");
  t.after(() => q.stop());
  const file = path.join(q.dir, "exported.q");
  fs.writeFileSync(file, exportScript(cells, "a.qnb"));
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const loaded = await connection.query([`system "l ${file}"`], SIZE);
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded));
  assert.deepStrictEqual((await connection.query(["(a;b;e;c;`z in key `.)"], SIZE)).text, ["1", "2", "5", "8", "0b"]);
});

/// `probe` after the cells ran as the notebook runs them - each cell one
/// call, in a process that starts clean - and after q loaded their export.
async function ranAndLoaded(t, cells, probe) {
  const sources = cells.map((source) => ({ kind: "code", source }));
  const answers = [];
  for (const way of ["cells", "script"]) {
    const q = await startQ("");
    t.after(() => q.stop());
    const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
    t.after(() => connection.close());
    if (way === "cells") {
      for (const cell of cells) {
        const ran = readCellData(await connection.call(DATA, statements(cell), 10, SIZE));
        assert.strictEqual(ran.ok, true, JSON.stringify(ran));
      }
    } else {
      const file = path.join(q.dir, "exported.q");
      fs.writeFileSync(file, exportScript(sources));
      const loaded = await connection.query([`system "l ${file}"`], SIZE);
      assert.strictEqual(loaded.ok, true, JSON.stringify(loaded));
    }
    answers.push((await connection.query([probe], SIZE)).text);
  }
  return { cells: answers[0], script: answers[1] };
}

test("an exported notebook defines a name where its cell does: a cell's \\d ends with the cell (#1934)", { skip }, async (t) => {
  const where = "(`a`b`c in key `.;`a`b`c in key `.foo)";
  for (const cells of [
    ["\\d .foo\na:1", "b:2", "c:3"],
    ['system "d .foo"\na:1', "b:2\n\\\nnot code", "c:3"],
    // Back in the root by the cell's end: nothing to undo.
    ["\\d .foo\na:1\n\\d .\nb:2", "c:3"],
  ]) {
    const { cells: ran, script } = await ranAndLoaded(t, cells, where);
    assert.deepStrictEqual(script, ran, JSON.stringify(cells));
    assert.strictEqual(ran[0].replace(/\s/g, ""), "011b");
  }
});

test("an exported cell that opens with an indented comment does not continue the cell above (#1935)", { skip }, async (t) => {
  for (const cells of [
    ["f:{x+1}", " / note\n g:3"],
    ["f:{x+1}", "\t/ one\n  / two\n\n  g:3"],
  ]) {
    const { cells: ran, script } = await ranAndLoaded(t, cells, "(-3!f;g)");
    assert.deepStrictEqual(script, ran, JSON.stringify(cells));
    assert.deepStrictEqual(ran, ['"{x+1}"', "3"]);
  }
});
