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
const { REDEFINE, SOURCE } = require("../out/funcsource.js");
const { FUNCTION_TEXTS, readTexts } = require("../out/fndiff.js");
const { LOG_LIST, addLogpoint, readLogpoints, redefineKeepingLogpoint } = require("../out/logpoint.js");
const { coveragePlan } = require("../out/coverage.js");
const { installLambda, restoreExpression, readInstalled, readRestored } = require("../out/instrument.js");
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

// `files`, by path under the script's directory, are written beside it,
// and that directory is the process's QPATH, where `use` finds a module.
async function startQ(source, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-drift-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source.replaceAll("$DIR", dir));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const port = await freePort();
  const env = { ...process.env, QPATH: dir };
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true, cwd: dir, env });
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

async function connect(t, source, files) {
  const q = await startQ(source, files);
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

// q defines `g` from `q)g:{x}`, in the context the script is in; a k lambda's
// text is another, and it is left out (#3009).
test("a definition behind q) prompts compares the same on the process that loaded it (#3009)", { skip }, async (t) => {
  const prompted = "q)pg:{x+1}\nk)q)pg2:{x+2}\nq) pg3:{[a]\n  a}\nk)pk:{x}\n\\d .pn\nq)pg:{x*2}\n\\d .\n";
  const c = await connect(t, prompted);
  const defs = definitions(prompted);
  assert.deepStrictEqual(defs.map((d) => d.name), ["pg", "pg2", "pg3", ".pn.pg"]);
  const rows = driftRows(defs.map((def) => ({ file: "a.q", def })), await states(c, defs));
  assert.deepStrictEqual(rows.map((r) => `${r.name}:${r.status}:${r.processText}`), ["pg:same:{x+1}", "pg2:same:{x+2}", "pg3:same:{[a]\n  a}", ".pn.pg:same:{x*2}"]);
  assert.strictEqual((await c.evaluate("string pk")).value, "k){x}");
});

// KDB-X runs a module in `.m.<module>`: after `` md:use`modd ``, `` key`.m.modd ``
// is ``` ``hlp`fd`export ``` and the root has no `fd`, which Check Drift
// asked about and called missing (#2321).
test("a KDB-X module's functions are compared where use put them (#2321)", { skip }, async (t) => {
  const mod = "hlp:{x*2}\nfd:{hlp x+1}\nexport:([fd])\n";
  const c = await connect(t, "md:use`modd\nps:use`pkg.sub\n", { "modd/init.q": mod, "pkg/sub/init.q": "k:{x+100}\nexport:([k])\n" });
  const defs = definitions(mod, "modd/init.q");
  assert.deepStrictEqual(defs.map((d) => d.name), [".m.modd.hlp", ".m.modd.fd"]);
  const rows = driftRows(defs.map((def) => ({ file: "modd/init.q", def })), await states(c, defs));
  assert.deepStrictEqual(rows.map((r) => `${r.name}:${r.status}`), [".m.modd.hlp:same", ".m.modd.fd:same"]);
  const nested = definitions("k:{x+100}\nexport:([k])\n", "pkg/sub/init.q");
  const held = await states(c, nested);
  assert.deepStrictEqual([...held.entries()], [[".m.pkg.0sub.k", { state: "lambda", text: "{x+100}" }]]);
});

test("the process that loaded a file holds every definition read from it (#2921)", { skip }, async (t) => {
  const file = 'h:{x};k:{y}\n.ns._g:{x}\n.ns.1a:{x+1}\na:1;m:{x*2}\n\\d .dd\nq1:{x};system "d .ee";q2:{y}\n\\d .\nf::{x+1}\n';
  const c = await connect(t, file);
  const defs = definitions(file);
  const rows = driftRows(defs.map((def) => ({ file: "a.q", def })), await states(c, defs));
  assert.deepStrictEqual(rows.map((r) => `${r.name}:${r.status}`), ["h:same", "k:same", ".ns._g:same", ".ns.1a:same", "m:same", ".dd.q1:same", ".ee.q2:same"]);
  // Behind `q)` prompts too, where a `system "d .ns"` switches as well (#3009, #2916).
  const prompted = 'q)ph:{x};pk:{y}\n\\d .pq\nq)p1:{x};system "d .pr";p2:{y}\np3:{z}\n\\d .\nq)system "d .ps"\np4:{x}\n\\d .\n';
  const p = await connect(t, prompted);
  const behind = definitions(prompted);
  const same = driftRows(behind.map((def) => ({ file: "a.q", def })), await states(p, behind));
  assert.deepStrictEqual(same.map((r) => `${r.name}:${r.status}`), ["ph:same", "pk:same", ".pq.p1:same", ".pr.p2:same", ".pr.p3:same", ".ps.p4:same"]);
  // `f::{x+1}` at the top level is a view there, which is no lambda (#1865).
  assert.deepStrictEqual((await c.evaluate("string views[]")).value, ["f"]);
});

// The process holds a name's last definition, as the file leaves it: one
// row, the same, where every definition compared gave a "differs" (#1927).
test("a name the file defines twice compares the same on the process that loaded it (#1927)", { skip }, async (t) => {
  const twice = "w:{x+1}\nv:{x}\nw:{x+2}\n";
  const c = await connect(t, twice);
  const defs = definitions(twice);
  assert.deepStrictEqual(defs.map((d) => d.name), ["w", "v", "w"]);
  const rows = driftRows(defs.map((def) => ({ file: "a.q", def })), await states(c, defs));
  assert.deepStrictEqual(rows.map((r) => `${r.name}:${r.status}:${r.processText}`), ["v:same:{x}", "w:same:{x+2}"]);
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

test("a file run as a query compares the same, its lambdas' blank and comment lines kept (#2282)", { skip }, async (t) => {
  const { statements } = require("../out/statements.js");
  const file = "dr1:{[x]\n  / double it\n  y:x*2;\n\n  y+1}\ndr2:{[x]\n  a:x;\n/\n  not run\n\\\n  a}\n";
  const c = await connect(t, "");
  const ran = await c.query(statements(file), [25, 80]);
  assert.strictEqual(ran.ok, true);
  const defs = definitions(file);
  const rows = driftRows(defs.map((def) => ({ file: "a.q", def })), await states(c, defs));
  assert.deepStrictEqual(rows.map((r) => `${r.name}:${r.status}`), ["dr1:same", "dr2:same"]);
  // And edited, hot reload replaces what the query defined.
  const edited = file.replace("y+1", "y+2");
  const plan = reloadPlan(changedSince(defs, definitions(edited)), await states(c, definitions(edited)));
  assert.deepStrictEqual(plan.send.map((s) => s.name), ["dr1"]);
});

// A logpoint is q-lint's text in the function's own: what compares a
// definition, or replaces one, reads the function it was put on.
test("a function with a logpoint compares the same, is covered, and takes a reload with its logpoint (#2971)", { skip }, async (t) => {
  const c = await connect(t, FILE);
  const call = (...sent) => c.call(...sent);
  await addLogpoint(call, "f");
  await addLogpoint(call, ".ns.h");
  const defs = definitions(FILE);
  const held = await states(c, defs);
  assert.deepStrictEqual([...held].map(([name, s]) => [name, s.via]), [["f", "log"], ["g", undefined], [".ns.h", "log"], [".ns.m", undefined]]);
  assert.deepStrictEqual(driftRows(defs.map((def) => ({ file: "a.q", def })), held).map((r) => r.status), ["same", "same", "same", "same"]);
  // Diff Function and Open Function Source read the function too.
  assert.strictEqual(readTexts(await c.call(FUNCTION_TEXTS, ".ns.h")).texts.get(".ns.h"), "{[a] a+k}");
  assert.strictEqual(readTexts(await c.call(FUNCTION_TEXTS, ".ns")).texts.get(".ns.h"), "{[a] a+k}");
  assert.strictEqual((await c.call(SOURCE, ".ns.h")).text, "{[a] a+k}");
  // A coverage run takes it, and its end puts the logpoint back.
  const plan = coveragePlan([{ uri: "a.q", text: FILE }], held);
  assert.deepStrictEqual(plan.skipped, []);
  assert.deepStrictEqual(readInstalled(await c.call(installLambda("cov"), plan.names, plan.was, plan.src, plan.probes.length), plan.names.length), plan.names.map(() => "ok"));
  assert.strictEqual((await c.evaluate('"f"$f 1')).value, 4);
  assert.deepStrictEqual(readRestored(await c.call(restoreExpression("cov"))).kept, []);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).names, ["f", ".ns.h"]);
  // Hot reload sends the edit, and the new definition has the logpoint.
  const now = definitions(FILE.replace("  a*2", "  a*3"));
  const reload = reloadPlan(changedSince(defs, now), await states(c, now));
  assert.deepStrictEqual(reload.skipped, []);
  assert.deepStrictEqual(reload.send.map((s) => s.name), ["f"]);
  const [s] = reload.send;
  assert.deepStrictEqual(await redefineKeepingLogpoint(call, s.name, s.held, s.text, true), { held: s.text });
  assert.strictEqual((await c.evaluate('"f"$f 1')).value, 6);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).names, ["f", ".ns.h"]);
  assert.deepStrictEqual(driftRows(now.map((def) => ({ file: "a.q", def })), await states(c, now)).map((r) => r.status), ["same", "same", "same", "same"]);
  // Asked of the process when the caller has not read it.
  assert.deepStrictEqual(await redefineKeepingLogpoint(call, ".ns.h", "{[a] a+k}", "{[a] a+k*2}"), { held: "{[a] a+k*2}" });
  assert.strictEqual((await c.evaluate('"f"$.ns.h 1')).value, 21);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).names, ["f", ".ns.h"]);
});

// `use` answers the module's `export`, a dictionary of the functions
// themselves: a reload of `.m.modd.fd` alone left `md.fd` the old one.
test("a reloaded module function is the one its use handles call (#2972)", { skip }, async (t) => {
  const mod = "hlp:{x*2}\nfd:{hlp x+1}\nexport:([fd])\n";
  const script = "md:use`modd\n.app.sub.h:use`modd\nother:([fd:{hlp x+1}])\nfv::md\n";
  const c = await connect(t, script, { "modd/init.q": mod });
  const value = async (text) => Number((await c.evaluate(`"f"$${text}`)).value);
  assert.strictEqual(await value("md.fd 1"), 4);
  const before = definitions(mod, "modd/init.q");
  const now = definitions(mod.replace("hlp x+1", "hlp x+2"), "modd/init.q");
  const plan = reloadPlan(changedSince(before, now), await states(c, now));
  assert.deepStrictEqual(plan.send.map((s) => s.name), [".m.modd.fd"]);
  const [s] = plan.send;
  assert.strictEqual(await c.call(REDEFINE, s.name, s.held, s.text), s.text);
  assert.strictEqual(await value(".m.modd.fd 1"), 6);
  // The handles the process holds, and the next `use`, call the new one.
  assert.strictEqual(await value("md.fd 1"), 6);
  assert.strictEqual(await value(".app.sub.h.fd 1"), 6);
  assert.strictEqual(await value("(use`modd)[`fd] 1"), 6);
  // A dictionary that is not the module's is left alone, and no view is evaluated.
  assert.strictEqual((await c.evaluate(".Q.s1 other")).value, "(,`fd)!,{hlp x+1}");
  assert.deepStrictEqual((await c.evaluate('string system"B"')).value, ["fv"]);
  // With a logpoint on it, what the module exported is still found.
  await addLogpoint((...sent) => c.call(...sent), ".m.modd.fd");
  const held = (await states(c, now)).get(".m.modd.fd").text;
  await redefineKeepingLogpoint((...sent) => c.call(...sent), ".m.modd.fd", held, "{hlp x+3}");
  assert.strictEqual(await value("md.fd 1"), 8);
  assert.strictEqual(await value(".m.modd.fd 1"), 8);
});
