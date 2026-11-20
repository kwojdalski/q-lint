// The language-model tool's query (#886) against a real q process: what an
// agent is given for each kind of value, that values survive JSON, that the
// process is left as it was, and that a query is stopped as Abort stops one.
// Needs a q binary, so it runs only when QLINT_TEST_Q names one, as
// qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { ROW_LIMIT, runAgentQuery } = require("../out/agent.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const SIZE = [25, 80];

const SERVER = `
t:([] sym:\`a\`b\`c; px:1.5 0n 3.5; ok:101b)
kt:([k:\`b\`a] v:2 1)
big:([] i:til 1000)
odd:([] j:9007199254740993 0N 0W; p:2026.11.20D10:11:12.123456789,0N 0Wp; d:2026.11.20,0N 2026.11.21d; l:(1 2;\`a;"q"))
slow:{system "sleep ",string x; x}
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-agent-"));
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

test("an agent's query against a real q process", { skip }, async (t) => {
  const q = await startQ(SERVER);
  t.after(() => q.stop());
  const connection = await QConnection.open({ host: "127.0.0.1", port: q.port });
  t.after(() => connection.close());
  const run = (code) => runAgentQuery(connection, code, SIZE);
  // Every answer is sent to the agent as JSON, so read it back from JSON.
  const json = async (code) => JSON.parse(JSON.stringify(await run(code)));
  const globals = async () => (await connection.query(['(key `.;system "v";key `.q)'], SIZE)).text.join("\n");
  const before = await globals();

  await t.test("a table", async () => {
    assert.deepStrictEqual(await json("t"), {
      columns: ["sym", "px", "ok"],
      types: ["symbol (s)", "float (f)", "boolean (b)"],
      rowCount: 3,
      data: [
        ["a", 1.5, true],
        ["b", null, false],
        ["c", 3.5, true],
      ],
    });
  });

  await t.test("a keyed table, a dictionary and a list", async () => {
    const keyed = await json("kt");
    assert.deepStrictEqual(keyed.columns, ["k", "v"]);
    assert.strictEqual(keyed.keyColumns, 1);
    assert.deepStrictEqual(keyed.data, [
      ["b", 2],
      ["a", 1],
    ]);
    assert.deepStrictEqual(await json("`x`y!10 20"), {
      columns: ["key", "value"],
      types: ["symbol (s)", "long (j)"],
      keyColumns: 1,
      rowCount: 2,
      data: [
        ["x", 10],
        ["y", 20],
      ],
    });
    assert.deepStrictEqual(await json("1 2 3"), { columns: ["value"], types: ["long (j)"], rowCount: 3, data: [[1], [2], [3]] });
  });

  await t.test("the rows are capped, and the count is the whole result's", async () => {
    const r = await json("big");
    assert.strictEqual(r.rowCount, 1000);
    assert.strictEqual(r.data.length, ROW_LIMIT);
    assert.strictEqual(r.truncated, true);
    assert.deepStrictEqual(r.data[ROW_LIMIT - 1], [ROW_LIMIT - 1]);
  });

  await t.test("a long past 2^53, a timestamp's nanoseconds, nulls and infinities survive JSON", async () => {
    const r = await json("odd");
    assert.deepStrictEqual(r.types, ["long (j)", "timestamp (p)", "date (d)", "list"]);
    assert.deepStrictEqual(r.data, [
      ["9007199254740993", "2026.11.20D10:11:12.123456789", "2026.11.20", "1 2"],
      [null, null, null, "`a"],
      ["0W", "0W", "2026.11.21", '"q"'],
    ]);
  });

  await t.test("a real is the number q wrote, not its float32 widened", async () => {
    assert.deepStrictEqual((await json("1.1 0.3 2 0N 0We")).data, [[1.1], [0.3], [2], [null], ["0w"]]);
  });

  await t.test("any other value is the process's text", async () => {
    assert.deepStrictEqual(await json("6*7"), { output: "42" });
    assert.deepStrictEqual(await json('"abc"'), { output: '"abc"' });
    assert.deepStrictEqual(await json("a:1\nb:a+1\nb*10"), { output: "20" });
  });

  await t.test("an error is the error and its trace", async () => {
    const r = await json("{x+1} `a");
    assert.strictEqual(r.error, "type");
    // PeachQ has no .Q.trp, so no trace.
    if (r.trace !== undefined) {
      assert.match(r.trace, /x\+1/);
    }
  });

  await t.test("nothing is defined on the process but what the query defines", async () => {
    // `a` and `b` were the query's own.
    await run("delete a, b from `.");
    assert.strictEqual(await globals(), before);
  });

  await t.test("a query stopped as Abort stops one rejects, and the process is still there", async () => {
    const started = Date.now();
    const slow = run("slow 2");
    setTimeout(() => connection.abort(), 300);
    await assert.rejects(slow, /closed before the process answered/);
    assert.ok(Date.now() - started < 1500);
    const again = await QConnection.open({ host: "127.0.0.1", port: q.port });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await runAgentQuery(again, "1+1", SIZE))), { output: "2" });
    await again.close();
  });
});
