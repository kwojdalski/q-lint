// Line timings' q against a real process (#986): LINE_TIMINGS runs each
// statement in order - assignments global, `\d` carried to the statements
// after it - times it by .z.p with \ts's memory, stops at the first failure,
// and defines nothing of its own. Needs a q binary, so it runs only when
// QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { LINE_TIMINGS, readTimings, statementSpans } = require("../out/linetimings.js");

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

test("each statement is timed in order, its effects kept, until one fails", { skip }, async (t) => {
  const c = await connect(t, "\\d .foo\nold:1\n\\d .\n");
  const before = (await c.evaluate("asc key `.")).value;
  const code = ["x:til 1000000", "y:sum x", "\\d .foo", "z:3", "\\d .", "w:1+`a", "never:1"].join("\n");
  const spans = statementSpans(code);
  const result = readTimings(await c.call(LINE_TIMINGS, spans.map((s) => s.text)), spans);
  assert.deepStrictEqual(
    result.timings.map((s) => [s.text, s.ok]),
    [
      ["x:til 1000000", true],
      ["y:sum x", true],
      ["\\d .foo", true],
      ["z:3", true],
      ["\\d .", true],
      ["w:1+`a", false],
    ],
  );
  assert.strictEqual(result.notRun, 1);
  assert.strictEqual(result.timings[5].error, "type");
  // A million longs: 8 MB allocated, by \ts; a system command has no figure.
  assert.ok(result.timings[0].bytes >= 8_000_000, String(result.timings[0].bytes));
  assert.strictEqual(result.timings[2].bytes, undefined);
  assert.ok(result.timings.every((s) => s.ns >= 0));
  assert.ok(result.overheadNs > 0 && result.overheadNs < 1e6, String(result.overheadNs));
  // The statements' effects are the process's, as a query's would be, and
  // nothing else was defined: the root holds what it held, and x and y.
  assert.strictEqual(String((await c.evaluate("y")).value), "499999500000");
  assert.strictEqual(String((await c.evaluate(".foo.z")).value), "3");
  assert.strictEqual((await c.evaluate("system \"d\"")).value, ".");
  assert.strictEqual((await c.evaluate("@[value;`never;{`undefined}]")).value, "undefined");
  const after = (await c.evaluate("asc key `.")).value;
  assert.deepStrictEqual(after.filter((n) => !before.includes(n)), ["x", "y"]);
});

test("one statement answers atoms, and reads back the same", { skip }, async (t) => {
  const c = await connect(t, "");
  const spans = statementSpans("1+1");
  const result = readTimings(await c.call(LINE_TIMINGS, ["1+1"]), spans);
  assert.strictEqual(result.timings.length, 1);
  assert.strictEqual(result.timings[0].ok, true);
});
