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
strs:([] s:(150#"a";"b\\"c\\n";"caf\\303\\251";enlist "x";""))
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
});
