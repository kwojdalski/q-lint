// Drift detection (#933) and hot reload (#934) against a real q process:
// the file a process loaded compares the same, an edited definition is
// sent with Redefine's lambda and then compares the same again, and a
// process that holds another text is never overwritten. Needs a q binary,
// so it runs only when QLINT_TEST_Q names one, as qclient.test.js does.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { REDEFINE } = require("../out/funcsource.js");
const { DRIFT, definitions, readDrift, driftRows, changedSince, reloadPlan } = require("../out/definitions.js");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-drift-"));
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

// Loaded by the process as its script: blank and comment lines inside a
// lambda, trailing blanks, a `\d` context, a projection and a variable.
const FILE = [
  "f:{[x]   ",
  "  a:x+1;",
  "",
  "/ a comment at column 0",
  "  a*2",
  "  }",
  "g:{x+1} / after",
  "p:g[1]",
  "\\d .ns",
  "k:10",
  "h:{[a] a+k}",
  "\\d .",
  ".ns.m:{x}",
  "",
].join("\n");

const states = async (c, defs) => readDrift(await c.call(DRIFT, defs.map((d) => d.name).join(" ")));

test("the file a process loaded compares the same, name by name", { skip }, async (t) => {
  const c = await connect(t, FILE);
  const defs = definitions(FILE);
  assert.deepStrictEqual(defs.map((d) => d.name), ["f", "g", ".ns.h", ".ns.m"]);
  const rows = driftRows(defs.map((def) => ({ file: "a.q", def })), await states(c, defs));
  assert.deepStrictEqual(rows.map((r) => r.status), ["same", "same", "same", "same"]);
  // A name the process lacks, a projection, a variable; one name alone.
  const held = readDrift(await c.call(DRIFT, "nosuch p .ns.k"));
  assert.deepStrictEqual([...held.values()].map((s) => s.state), ["missing", "other", "other"]);
  const one = readDrift(await c.call(DRIFT, "g"));
  assert.deepStrictEqual([...one.entries()], [["g", { state: "lambda", text: "{x+1}" }]]);
});

// A view is held, and is no lambda: one that would signal is not "missing",
// and asking evaluates neither (#1865).
test("a view compares as something other than a lambda, and is not evaluated (#1865)", { skip }, async (t) => {
  const c = await connect(t, FILE + "t:([] a:1 2)\nspy::select from t\nbad::1+`a\n");
  const pending = () => c.call('{[x] string system"B"}', 0);
  const held = readDrift(await c.call(DRIFT, "spy bad g nosuch"));
  assert.deepStrictEqual([...held.values()].map((s) => s.state), ["other", "other", "lambda", "missing"]);
  assert.deepStrictEqual(await pending(), ["bad", "spy"]);
});

test("hot reload sends an edited definition, parsed in its context, and it then compares the same", { skip }, async (t) => {
  const c = await connect(t, FILE);
  const before = definitions(FILE);
  const edited = FILE.replace("  a*2", "  a*3").replace("h:{[a] a+k}", "h:{[a] a+k*2}");
  const now = definitions(edited);
  const changed = changedSince(before, now);
  assert.deepStrictEqual(changed.map((x) => x.def.name), ["f", ".ns.h"]);
  const plan = reloadPlan(changed, await states(c, now));
  assert.deepStrictEqual(plan.send.map((s) => s.name), ["f", ".ns.h"]);
  for (const s of plan.send) {
    assert.strictEqual(await c.call(REDEFINE, s.name, s.held, s.text), s.text);
  }
  assert.strictEqual((await c.evaluate('"f"$f 1')).value, 6);
  // `k` is `.ns.k`: parsed in .ns.
  assert.strictEqual((await c.evaluate('"f"$.ns.h 1')).value, 21);
  assert.strictEqual((await c.evaluate('system"d"')).value, ".");
  const rows = driftRows(now.map((def) => ({ file: "a.q", def })), await states(c, now));
  assert.deepStrictEqual(rows.map((r) => r.status), ["same", "same", "same", "same"]);
  // Saved again unchanged on the process: nothing more to send.
  assert.deepStrictEqual(reloadPlan(changed, await states(c, now)).already, ["f", ".ns.h"]);
});

test("hot reload never overwrites a function the process holds as the file did not have it", { skip }, async (t) => {
  const c = await connect(t, FILE);
  await c.evaluate("g:{x+100}");
  const before = definitions(FILE);
  const now = definitions(FILE.replace("g:{x+1}", "g:{x+2}").replace(".ns.m:{x}", ".ns.m:{x}\nnew:{x}"));
  const plan = reloadPlan(changedSince(before, now), await states(c, now));
  assert.deepStrictEqual(plan.send, []);
  assert.deepStrictEqual(plan.skipped.map((s) => s.name), ["g", "new"]);
  assert.strictEqual((await c.evaluate('"f"$g 1')).value, 101);
  // And Redefine refuses a stale text on its own, should the process change between the read and the send.
  await assert.rejects(c.call(REDEFINE, "g", "{x+1}", "{x+2}"), /changed on the process/);
  const rows = driftRows(definitions(FILE).map((def) => ({ file: "a.q", def })), await states(c, before));
  assert.deepStrictEqual(rows.find((r) => r.name === "g"), { name: "g", file: "a.q", line: 6, status: "differs", text: "{x+1}", processText: "{x+100}" });
});
