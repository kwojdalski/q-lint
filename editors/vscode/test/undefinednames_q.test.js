// The undefined-name check's q against a real process (#945): DEFINED
// answers, for each name, whether its namespace's key holds it - a bare one
// in the root or .q - evaluating nothing. Needs a q binary, so it runs only
// when QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { DEFINED, readDefined } = require("../out/undefinednames.js");

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
  "\\d .lib",
  "r:2",
  "d.x:3",
  "f:{[a;b] a+b}",
  "\\d .",
  ".q.myq:{x}",
  "t:([] a:til 100000; b:100000#`x`y)",
  "calls:0",
  "v::calls+::1",
  "s:5000#\"ab\"",
  "x:7",
  "",
].join("\n");

test("DEFINED answers whether each name is defined, a bare one in the root or .q", { skip }, async (t) => {
  const c = await connect(t, SERVER);
  const names = ["rate", "nope", ".lib.r", ".lib.nope", ".nons.x", ".lib.d.x", "myq", "x", "v"];
  const defined = readDefined(await c.call(DEFINED, names.join(" ")), names);
  assert.deepStrictEqual(Object.fromEntries(defined), {
    rate: true,
    nope: false,
    ".lib.r": true,
    ".lib.nope": false,
    ".nons.x": false,
    ".lib.d.x": true,
    myq: true,
    x: true,
    v: true,
  });
  // A table's column read as t.c is defined where t is a table (#2808).
  const columns = ["t.a", "t.b", "t.z"];
  assert.deepStrictEqual(Object.fromEntries(readDefined(await c.call(DEFINED, columns.join(" ")), columns)), { "t.a": true, "t.b": true, "t.z": false });
  // One name, one character long.
  assert.deepStrictEqual([...readDefined(await c.call(DEFINED, "x"), ["x"])], [["x", true]]);
  assert.strictEqual(String((await c.evaluate("calls")).value), "0", "the view was not evaluated");
});
