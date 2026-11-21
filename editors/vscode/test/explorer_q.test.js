// The explorer's call against a real q process (#901): odd values it must
// read past, and what it must say of a large table. Needs a q binary, so it
// runs only when QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { GATHER, LIMITS, explorerTree, readGathered } = require("../out/explorer.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const EXCLUDED = "q Q h j o s z help";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-explorer-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source);
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

async function gathered(t, source) {
  const q = await startQ(source);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  return readGathered(await connection.call(GATHER, EXCLUDED, LIMITS));
}

// A dictionary whose first value is `::` looks like a namespace, but one
// keyed by anything other than symbols is a variable: the explorer read its
// keys as names, and `except` on them failed the whole call with 'type.
test("a dictionary keyed by numbers with :: first is a variable, not a namespace", { skip }, async (t) => {
  const g = await gathered(t, ".ns.a:1;\n.ns.d:1 2!(::;3);\n");
  assert.deepStrictEqual(g.spaces.map((s) => s.ns).sort(), [".", ".ns"]);
  const d = g.entries.find((e) => e.ns === ".ns" && e.name === "d");
  assert.deepStrictEqual([d.kind, d.type, d.count], ["variable", 99, 2]);
});

// Only a table's first `LIMITS[0]` columns are sent; its row said that was
// how many it had.
test("a table with more columns than are read says how many it has", { skip }, async (t) => {
  const g = await gathered(t, 'w:flip(`$"c",/:string til 600)!600#enlist 1 2;\n');
  const w = g.entries.find((e) => e.name === "w");
  assert.strictEqual(w.cols.length, LIMITS[0]);
  const node = explorerTree(g, []).find((n) => n.label === ".").children[0].children[0];
  assert.strictEqual(node.description, "2 rows · 600 columns");
  assert.deepStrictEqual(node.children.slice(-1)[0], { kind: "note", label: "100 more columns not shown", description: "the first 500 are" });
});
