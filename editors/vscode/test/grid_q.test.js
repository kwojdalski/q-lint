// Grid and chart mode's lambda (`GRID`, src/grid.ts) against a real q
// process: the shapes a result can take that only q can show. Needs a q
// binary, so it runs only when QLINT_TEST_Q names one, as qclient.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { statements } = require("../out/statements.js");

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

/// Start q on `source(dir)`, a script written in a fresh directory, on a
/// free port; resolves once it accepts.
async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-grid-"));
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

// An HDB of two date partitions, loaded as an HDB process loads it.
const SERVER = (dir) => `
{[d] .Q.dd[hsym \`$"${dir}/hdb";d,\`p\`] set .Q.en[hsym \`$"${dir}/hdb"] ([] sym:\`a\`b\`c; px:1 2 3f)} each 2026.01.01 2026.01.02;
\\l ${dir}/hdb
strs:([] s:(250#"a";"b\\"c\\n";"caf\\303\\251";enlist "x";""))
`;

test("the grid lambda against a real q process", { skip }, async (t) => {
  const q = await startQ(SERVER);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.abort());

  await t.test("a partitioned table queried by name is shown, cut as a select is", async () => {
    const answer = await connection.queryGrid(statements("p"), SIZE, 4);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    assert.deepStrictEqual(answer.grid.names, ["date", "sym", "px"]);
    assert.strictEqual(answer.grid.count, 6);
    assert.deepStrictEqual(answer.grid.cells[1], ["a", "b", "c", "a"]);
    const last = await connection.queryGrid(statements("p"), SIZE, -2);
    assert.deepStrictEqual(last.grid.cells[0], ["2026.01.02", "2026.01.02"]);
    assert.deepStrictEqual(last.grid.cells[1], ["b", "c"]);
    const all = await connection.queryGrid(statements("p"), SIZE, Infinity);
    assert.strictEqual(all.grid.cells[0].length, 6);
  });

  await t.test("a string column's cells are not cut at the process's console width", async () => {
    const answer = await connection.queryGrid(statements("strs"), SIZE, 10);
    const cells = answer.grid.cells[0];
    // Cut at 200 characters, as the cell's text is, not at \\c's 80.
    assert.strictEqual(cells[0], `"${"a".repeat(196)}...`);
    // Escaped as q writes them, one character with its comma.
    const own = (await connection.query(statements('-3!\'1_strs`s'), [25, 2000])).text.join("");
    assert.deepStrictEqual(cells.slice(1), ['"b\\"c\\n"', '"caf\\303\\251"', ',"x"', '""'], own);
  });

  await t.test("a char column's raw is its bytes, so a byte past ASCII is written back as itself (#1489)", async () => {
    const { atomLiteral } = require("../out/qliteral.js");
    const answer = await connection.queryGrid(statements('([]c:"a\\303\\251")'), SIZE, 10);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    assert.deepStrictEqual(answer.grid.raw[0], [97, 0xc3, 0xa9]);
    assert.deepStrictEqual(answer.grid.cells[0].map((c, r) => atomLiteral(10, c, answer.grid.raw[0][r]).literal), ['"a"', '"\\303"', '"\\251"']);
  });

  await t.test("a general column's float and real items come with every digit, for a literal (#1485)", async () => {
    const { tableLiteral } = require("../out/qliteral.js");
    const answer = await connection.queryGrid(statements("([]a:(1.23456789;`x;0n;0.1e;1 2))"), SIZE, 10);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    assert.deepStrictEqual(answer.grid.cells[0], ["1.234568", "`x", "0n", "0.1e", "1 2"]);
    assert.strictEqual(tableLiteral(answer.grid).code, "([] a:(1.23456789f;`x;0n;0.1e;1 2))");
  });

  await t.test("a dictionary or a nested list comes with its tree, as unwrapped mode makes it (#928)", async () => {
    const { runUnwrapped } = require("../out/querycontrols.js");
    const { TREE_NODES } = require("../out/grid.js");
    const code = '`a`b`c!(1;"xy";(1 2;`p`q!(3 4;`z)))';
    const answer = await connection.queryGrid(statements(code), SIZE, 100, true);
    assert.strictEqual(answer.gridError, undefined, answer.gridError);
    const tree = answer.grid.tree;
    // Not asked for (q-lint.results.tree.enable off, a notebook, an agent): not sent.
    const without = await connection.queryGrid(statements(code), SIZE, 100);
    assert.strictEqual(without.grid.tree, undefined);
    assert.deepStrictEqual(without.grid.cells, answer.grid.cells);
    assert.deepStrictEqual([tree.type, tree.count], [99, 3]);
    assert.deepStrictEqual(tree.children.map((c) => [c.key, c.text, c.type, c.count]), [["a", "1", -7, 1], ["b", '"xy"', 10, 2], ["c", "", 0, 2]]);
    const inner = tree.children[2].children[1];
    assert.deepStrictEqual(inner.children.map((c) => [c.key, c.text, c.type]), [["p", "", 7], ["q", "`z", -11]]);
    assert.deepStrictEqual(inner.children[0].children.map((c) => c.text), ["3", "4"]);
    // Unwrapped mode decodes the value and makes the same tree here.
    const here = await runUnwrapped(connection, [code], { size: SIZE, limit: 100, unlimited: false, grid: true });
    assert.deepStrictEqual(here.grid.tree, tree);
    // Wide: cut to the budget at every level, and the counts say how much.
    const wide = (await connection.queryGrid(statements("10000#enlist til 100"), SIZE, 10, true)).grid.tree;
    const nodes = (n) => 1 + n.children.reduce((k, c) => k + nodes(c), 0);
    assert.strictEqual(nodes(wide), TREE_NODES);
    assert.strictEqual(wide.count, 10000);
    // A table, a keyed table and a simple list have none.
    for (const plain of ["([] a:1 2)", "([k:1 2] v:3 4)", "til 5"]) {
      assert.strictEqual((await connection.queryGrid(statements(plain), SIZE, 10, true)).grid.tree, undefined, plain);
    }
  });
  await t.test("a cut result held for paging is sent page by page, ranked as q ranks the whole (#922)", async () => {
    const { gridLambda, PAGE, readPage, appendPage, readGridAnswer } = require("../out/grid.js");
    const code = "([k:til 23] v:23#3 1 2 0n 5f; s:23#`c`a`b)";
    const full = (await connection.queryGrid(statements(code), SIZE, 100)).grid;
    let grid = readGridAnswer(await connection.call(gridLambda(false, true), statements(code), SIZE, 10)).grid;
    assert.strictEqual(grid.cells[0].length, 10);
    while (grid.cells[0].length < grid.count) {
      const page = readPage(await connection.call(PAGE, grid.cells[0].length, 10));
      assert.notStrictEqual(typeof page, "string", page);
      grid = appendPage(grid, page);
    }
    assert.deepStrictEqual(grid.cells, full.cells);
    assert.deepStrictEqual(grid.rank, full.rank);
    // Past the end: no rows; a result not cut empties what was held.
    assert.strictEqual(readPage(await connection.call(PAGE, 23, 10)).cells[0].length, 0);
    await connection.call(gridLambda(false, true), statements("([] a:1 2)"), SIZE, 10);
    assert.strictEqual(readPage(await connection.call(PAGE, 0, 10)), "held");
    // A partitioned table is held by reference and read with .Q.ind.
    grid = readGridAnswer(await connection.call(gridLambda(false, true), statements("p"), SIZE, 4)).grid;
    grid = appendPage(grid, readPage(await connection.call(PAGE, 4, 4)));
    assert.deepStrictEqual(grid.cells[1], ["a", "b", "c", "a", "b", "c"]);
    assert.deepStrictEqual(grid.cells[0].slice(3), ["2026.01.02", "2026.01.02", "2026.01.02"]);
    // Asked without hold, nothing is defined.
    const before = (await connection.query(statements("key `.qlint"), SIZE)).text.join("");
    await connection.queryGrid(statements("([] a:til 50)"), SIZE, 10);
    assert.strictEqual((await connection.query(statements("key `.qlint"), SIZE)).text.join(""), before);
  });

  await t.test("an exported q literal rebuilds the table exactly, and a drill-down's value runs as written (#921, #927)", async () => {
    const { tableLiteral } = require("../out/qliteral.js");
    const { fillDrilldown } = require("../out/drilldown.js");
    const code =
      '([k:(`a;`b;`$"c d")] b:101b; x:0x0a00ff; h:1 0N 0Wh; i:1 0N -0Wi; j:9007199254740993 0N 0W; e:(1.5e;0Ne;0we); f:3.14159265358979 0n -0w; c:"x y"; ' +
      "p:(2024.01.02D03:04:05.123456789;0Np;0Wp); m:(2024.01m;0Nm;2023.12m); d:(2024.01.31;0Nd;1999.12.31); z:(2024.01.02T03:04:05.123;0Nz;0wz); " +
      'n:(0D01:02:03.000000004;0Nn;-0D00:00:01); u:(10:30;0Nu;23:59); v:(10:30:01;0Nv;00:00:00); t:(10:30:01.002;0Nt;23:59:59.999); ' +
      'g:("G"$"8c680a01-5a49-5aab-5a65-d4bfddb6a661";0Ng;"G"$"00000000-0000-0000-0000-000000000001"); l:("abc";`x`y;1 2 3); q:("say \\"hi\\"|x";"";"tab\\there"))';
    const grid = (await connection.queryGrid(statements(code), SIZE, 100)).grid;
    const literal = tableLiteral(grid).code;
    const same = await connection.query(statements(`(${code})~${literal}`), SIZE);
    assert.deepStrictEqual(same.text, ["1b"], literal);
    // Each cell drills down to a query that finds its own row.
    for (const [column, row] of [[0, 2], [6, 0], [10, 1], [18, 0]]) {
      const filled = fillDrilldown(`exec i from 0!(${code}) where {{column}}={{value}}`, grid, column, row);
      assert.ok("code" in filled, filled.error);
    }
    const filled = fillDrilldown(`exec i from 0!(${code}) where k={{value}}, d={{row.d}}`, grid, 0, 2);
    assert.deepStrictEqual((await connection.query(statements(filled.code), SIZE)).text, [",2"]);
  });

  await t.test("an exported q literal rebuilds a one-character string in a list, a symbol starting with _ and the other awkward cells (0.29.0 bug)", async () => {
    const { tableLiteral } = require("../out/qliteral.js");
    const tables = [
      // A one-character string among strings, `-3!`'s `,"x"`, which q refuses
      // as a list item; an empty string; quotes, a backslash and a two-byte
      // character; symbols q cannot read bare: one starting with _, the
      // empty one, one with a space.
      '([] s:`$("a";"_y";"";"a b";"x.y"); w:("ab";enlist "x";"";"\\"q\\"\\\\";"é"); c:"ab cd")',
      // A general column's items as `-3!` writes them: a monadic , before a
      // string, a list, a symbol and a dictionary's values, and a symbol
      // starting with _, alone and first in a vector.
      '([] l:(enlist "x";`$"_z";enlist 1 2;enlist `$"_w";`a`b!(1;enlist 2);enlist enlist "y";`$("_v";"u")))',
      // One row: every column enlisted once more.
      '([] s:enlist `$"_y"; w:enlist enlist "x"; l:enlist enlist `$"_q")',
      // Keyed by a symbol starting with _, so a name list is written too.
      '([k:`$("_a";"b")] v:(enlist "x";"yz"))',
      // Tables in a general column, which -3! writes with k's monadic + (#1501).
      '([] t:(([]a:`p`r);([k:1 2]v:3 4);enlist ([]a:1 2);flip(`$"a b";`c)!(1 2;3 4);1))',
    ];
    for (const code of tables) {
      const grid = (await connection.queryGrid(statements(code), SIZE, 100)).grid;
      const literal = tableLiteral(grid).code;
      const same = await connection.query(statements(`(${code})~${literal}`), SIZE);
      assert.deepStrictEqual(same.text, ["1b"], `${code}\nwritten as\n${literal}`);
    }
  });
});
