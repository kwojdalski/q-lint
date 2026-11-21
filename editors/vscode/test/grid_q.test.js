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
});
