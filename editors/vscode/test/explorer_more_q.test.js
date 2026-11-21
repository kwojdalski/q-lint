// The Process Explorer's excluded namespaces, nested ones too: what the
// gathering call leaves unread on a real q process (when QLINT_TEST_Q
// names one; skipped otherwise, as CI has no q), and what the tree leaves
// out.
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

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// A q process running `source`, listening on a free port, once it accepts.
async function startQ(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-explorer-more-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source);
  const port = await freePort();
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (up) {
      return { port, stop };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  throw new Error("q did not start listening");
}

const EXCLUDED = "q Q h j o s z help";

const entry = (ns, name) => ({ ns, name, kind: "variable", type: -7, count: 1, cols: [], keys: [], params: [], partitioned: false });

// `processExplorer.excludedNamespaces` took only a root namespace: a nested
// one (`ns.sub`, or `.ns.sub`) excluded nothing, though the setting says it
// leaves out the namespaces it names "with those nested in them".
test("a nested namespace excluded is left out of the tree, with those under it", () => {
  const g = {
    entries: [entry(".", "a"), entry(".ns", "b"), entry(".ns.sub", "c"), entry(".ns.sub.deep", "d"), entry(".ns.subway", "e")],
    spaces: [".", ".ns", ".ns.sub", ".ns.sub.deep", ".ns.subway"].map((ns) => ({ ns, total: 1 })),
    more: 0,
  };
  assert.deepStrictEqual(explorerTree(g, ["ns.sub"]).map((n) => n.label), [".", ".ns", ".ns.subway"]);
  assert.deepStrictEqual(explorerTree(g, ["ns"]).map((n) => n.label), ["."]);
});

test("a nested namespace excluded is not read from the process", { skip }, async (t) => {
  const q = await startQ(".ns.a:1;.ns.sub.b:2;.ns.sub.deep.c:3;.ns.subway.d:4;.other.e:5;\n");
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const spaces = async (excluded) =>
    readGathered(await connection.call(GATHER, `${EXCLUDED} ${excluded}`, LIMITS)).spaces.map((s) => s.ns).sort();
  assert.deepStrictEqual(await spaces("ns.sub"), [".", ".ns", ".ns.subway", ".other"]);
  // Not read, the nested namespace is not a variable of its parent either.
  const g = readGathered(await connection.call(GATHER, `${EXCLUDED} ns.sub`, LIMITS));
  assert.deepStrictEqual(g.entries.filter((e) => e.ns === ".ns").map((e) => e.name), ["a"]);
  assert.deepStrictEqual(await spaces("ns"), [".", ".other"]);
});
