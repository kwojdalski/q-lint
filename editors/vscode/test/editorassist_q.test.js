// The process names in workspace symbol search, against a real process
// (#996): `PROCESS_NAMES` lists the root's and each namespace's functions,
// variables and tables, and the root's views, without evaluating a view and
// without defining anything. Needs a q binary, so it runs only when
// QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { PROCESS_NAMES, readProcessNames, matching } = require("../out/editorassist.js");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-live-"));
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
  "rate:1",
  "f:{x}",
  "t:([] a:1 2)",
  "calls:0",
  "v::calls+::1",
  ".lib.add:{[a;b] a+b}",
  ".lib.cfg:3",
  ".lib.trades:([] p:1 2.)",
  ".e.x:1",
  "",
].join("\n");

test("a process's names are listed by kind, a view named and never run", { skip }, async (t) => {
  const connection = await connect(t, SERVER);
  const before = await connection.call("{key `.}", 0);
  const names = readProcessNames(await connection.call(PROCESS_NAMES, 20000));
  const kind = Object.fromEntries(names.map((n) => [n.name, n.kind]));
  assert.strictEqual(kind.f, "function");
  assert.strictEqual(kind.rate, "variable");
  assert.strictEqual(kind.t, "table");
  assert.strictEqual(kind.v, "view");
  assert.strictEqual(kind[".lib.add"], "function");
  assert.strictEqual(kind[".lib.cfg"], "variable");
  assert.strictEqual(kind[".lib.trades"], "table");
  // A one-letter namespace is q's own, and left out.
  assert.strictEqual(kind[".e.x"], undefined);
  assert.ok(!names.some((n) => /^\.[a-zA-Z]\./.test(n.name)), JSON.stringify(names));
  // The view was not evaluated, and nothing was defined.
  assert.strictEqual(Number(await connection.call("{calls}", 0)), 0);
  assert.deepStrictEqual(await connection.call("{key `.}", 0), before);
  assert.deepStrictEqual(matching(names, "libadd").map((n) => n.name), [".lib.add"]);
  // At most the limit.
  const two = readProcessNames(await connection.call(PROCESS_NAMES, 2));
  assert.strictEqual(two.length, 2);
});
