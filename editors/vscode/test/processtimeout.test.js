// Per-process query timeout and Interrupt Query on Local Process (#1036):
// which timeout applies, the commands through the stand-in `vscode`
// module, on and off, and - when QLINT_TEST_Q names a q - a query dropped
// at its process's own timeout, and a running query stopped by SIGINT with
// the connection kept.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const { Live } = require("../out/live.js");
const { Launcher } = require("../out/launcherview.js");
const { ADMIN_COMMANDS, adminOff, readAdmin } = require("../out/admin.js");
const { effectiveTimeout, ownTimeout, timeoutDropped, timeoutProblem, timeoutSource } = require("../out/processtimeout.js");
const { callApart } = require("../out/fndiffview.js");
const { ProcessTimeouts } = require("../out/timeoutview.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("which timeout applies: the process's own while on, else q-lint.query.timeout", () => {
  assert.strictEqual(effectiveTimeout({ timeout: 2 }, 10, true), 2);
  assert.strictEqual(effectiveTimeout({ timeout: 2 }, 10, false), 10);
  assert.strictEqual(effectiveTimeout({}, 10, true), 10);
  assert.strictEqual(effectiveTimeout(undefined, 0, true), 0);
  assert.strictEqual(timeoutSource({ label: "p", timeout: 2 }, true), "p's own timeout");
  assert.strictEqual(timeoutSource({ label: "p", timeout: 2 }, false), "q-lint.query.timeout");
  assert.strictEqual(timeoutProblem(""), undefined);
  assert.strictEqual(timeoutProblem("2.5"), undefined);
  for (const bad of ["0", "-1", "x", "86401"]) assert.ok(timeoutProblem(bad), bad);
});

test("where only the process's own timeout holds (runOnActive, callSeparate): it while on, else none", () => {
  assert.strictEqual(ownTimeout({ timeout: 2 }, true), 2);
  assert.strictEqual(ownTimeout({ timeout: 2 }, false), 0);
  assert.strictEqual(ownTimeout({}, true), 0);
  assert.strictEqual(ownTimeout(undefined, true), 0);
  assert.strictEqual(
    timeoutDropped({ label: "p", timeout: 2 }, 2, true),
    "q-lint: the call to p timed out after 2 s (p's own timeout), and its connection was closed. p may still be running it.",
  );
});

test("the switches: on by default, contributed, commands hidden while off", () => {
  const on = readAdmin((_k, f) => f);
  assert.strictEqual(on.processTimeout, true);
  assert.strictEqual(on.cancelLocal, true);
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process admin");
  for (const [id, key] of [
    [ADMIN_COMMANDS.setTimeout, "query.processTimeout.enable"],
    [ADMIN_COMMANDS.interrupt, "query.cancelLocal.enable"],
  ]) {
    assert.strictEqual(section.properties[`q-lint.${key}`].default, true);
    assert.ok(pkg.contributes.commands.some((c) => c.command === id && c.category === "q-lint"));
    const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === id);
    assert.ok(menus.length > 0);
    for (const m of menus) assert.ok(m.when.includes(`config.q-lint.${key}`), m.when);
  }
});

async function setUp(t, processes, launcher = { interrupt: () => undefined }) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const timeouts = new ProcessTimeouts(context, live, launcher);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, timeouts, context };
}

test("Set Process Timeout sets, keeps the rest, validates, and clears", async (t) => {
  const { live } = await setUp(t, [{ label: "a", host: "h", port: 1, tags: [], credentialCommand: "c" }]);
  stub.inputs.push((options) => {
    assert.strictEqual(options.validateInput("0"), "Seconds, more than 0 and at most 86400; empty for none.");
    return "2.5";
  });
  await stub.commands.get(ADMIN_COMMANDS.setTimeout)("a");
  assert.deepStrictEqual(live.processes(), [{ label: "a", host: "h", port: 1, tags: [], credentialCommand: "c", timeout: 2.5 }]);
  stub.inputs.push("");
  await stub.commands.get(ADMIN_COMMANDS.setTimeout)("a");
  assert.deepStrictEqual(live.processes(), [{ label: "a", host: "h", port: 1, tags: [], credentialCommand: "c" }]);
  await stub.commands.get(ADMIN_COMMANDS.setTimeout)("a", 3);
  assert.strictEqual(live.processes()[0].timeout, 3);
  await stub.commands.get(ADMIN_COMMANDS.setTimeout)("a", null);
  assert.strictEqual(live.processes()[0].timeout, undefined);
});

test("Launcher.interrupt signals only a process it started and that still runs", () => {
  stub.reset();
  const context = stub.newContext();
  const launcher = new Launcher(context, { launched: undefined, refreshProcesses() {} });
  const sent = [];
  launcher.started.set("mine", { child: { pid: 42, exitCode: null, signalCode: null, kill: (s) => sent.push(s) } });
  launcher.started.set("gone", { child: { pid: 43, exitCode: 0, signalCode: null, kill: (s) => sent.push(s) } });
  assert.strictEqual(launcher.interrupt("mine"), 42);
  assert.strictEqual(launcher.interrupt("gone"), undefined);
  assert.strictEqual(launcher.interrupt("other"), undefined);
  assert.deepStrictEqual(sent, ["SIGINT"]);
  launcher.started.clear();
  for (const d of context.subscriptions) d.dispose?.();
});

test("on Windows Interrupt Query sends nothing: kill() there ends q (#1250)", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  stub.reset();
  const context = stub.newContext();
  const launcher = new Launcher(context, { launched: undefined, refreshProcesses() {} });
  const sent = [];
  launcher.started.set("mine", { child: { pid: 42, exitCode: null, signalCode: null, kill: (s) => sent.push(s) } });
  assert.strictEqual(launcher.interrupt("mine"), undefined);
  launcher.started.clear();
  for (const d of context.subscriptions) d.dispose?.();
  const { timeouts, live } = await setUp(t, [{ label: "a", host: "h", port: 1, tags: [] }], { interrupt: (l) => (sent.push(l), 1) });
  live.activeProcess = () => ({ label: "a", host: "h", port: 1, tags: [] });
  live.isBusy = () => true;
  assert.strictEqual(timeouts.interrupt(), undefined);
  assert.match(stub.messages.at(-1)[1], /cannot be interrupted on Windows.*Abort Current Query/);
  assert.deepStrictEqual(sent, []);
});

test("Interrupt Query with nothing running, or a process not started here, sends no signal", async (t) => {
  const sent = [];
  const { timeouts, live } = await setUp(t, [{ label: "a", host: "h", port: 1, tags: [] }], { interrupt: (l) => (sent.push(l), undefined) });
  assert.strictEqual(timeouts.interrupt(), undefined);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: no query is running."]);
  live.activeProcess = () => ({ label: "a", host: "h", port: 1, tags: [] });
  live.isBusy = () => true;
  assert.strictEqual(timeouts.interrupt(), undefined);
  assert.match(stub.messages.at(-1)[1], /was not started from here/);
  assert.deepStrictEqual(sent, ["a"]);
});

test("turned off, both commands refuse and nothing is set or signalled; on again without a reload", async (t) => {
  const sent = [];
  const { live, timeouts } = await setUp(t, [{ label: "a", host: "h", port: 1, tags: [] }], { interrupt: (l) => (sent.push(l), 1) });
  live.activeProcess = () => ({ label: "a", host: "h", port: 1, tags: [] });
  live.isBusy = () => true;
  stub.config.user["query.processTimeout.enable"] = false;
  stub.config.user["query.cancelLocal.enable"] = false;
  stub.changeConfig("q-lint.query.processTimeout.enable");
  await stub.commands.get(ADMIN_COMMANDS.setTimeout)("a", 5);
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.interrupt)(), undefined);
  assert.deepStrictEqual(stub.messages, [["info", adminOff("processTimeout")], ["info", adminOff("cancelLocal")]]);
  assert.strictEqual(live.processes()[0].timeout, undefined);
  assert.deepStrictEqual(sent, []);
  stub.config.user["query.processTimeout.enable"] = true;
  stub.config.user["query.cancelLocal.enable"] = true;
  await stub.commands.get(ADMIN_COMMANDS.setTimeout)("a", 5);
  assert.strictEqual(live.processes()[0].timeout, 5);
  assert.strictEqual(timeouts.interrupt(), 1);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-timeout-"));
  fs.writeFileSync(path.join(dir, "server.q"), "busy:{t:.z.p;while[.z.p<t+x*0D00:00:01;];`done}\n");
  const child = spawn(`${Q} ${path.join(dir, "server.q")} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
  const signal = (s) => {
    try {
      process.kill(-child.pid, s);
    } catch {}
  };
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (up) return { stop: () => signal("SIGKILL"), signal, pid: child.pid };
    await sleep(100);
  }
  signal("SIGKILL");
  throw new Error("q did not start listening");
}

test("a query on a process with its own timeout is dropped at it, and said; off, it runs on (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const { live } = await setUp(t, [{ label: "slow", host: "127.0.0.1", port, tags: [], timeout: 0.5 }]);
  assert.strictEqual(await live.connectTo("slow"), true);
  await live.run("busy 1.5");
  const [entry] = live.history();
  assert.strictEqual(entry.outcome, "timeout");
  assert.strictEqual(entry.error, "timed out after 0.5 s");
  assert.ok(stub.messages.some(([, text]) => /timed out after 0\.5 s \(slow's own timeout\)/.test(text)), JSON.stringify(stub.messages));
  // Reconnected once the process was free.
  for (let i = 0; i < 50 && live.activeLabel() === undefined; i++) await sleep(100);
  assert.strictEqual(live.activeLabel(), "slow");
  stub.config.user["query.processTimeout.enable"] = false;
  await live.run("busy 1");
  assert.strictEqual(live.history()[0].outcome, "ok");
});

test("Interrupt Query stops a running query on a local process with 'stop, and the connection stays (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const { live, timeouts } = await setUp(t, [{ label: "local", host: "127.0.0.1", port, tags: [] }], {
    interrupt: (label) => (label === "local" ? (q.signal("SIGINT"), q.pid) : undefined),
  });
  assert.strictEqual(await live.connectTo("local"), true);
  const running = live.run("busy 20");
  await sleep(500);
  assert.strictEqual(live.isBusy(), true);
  const started = Date.now();
  assert.strictEqual(timeouts.interrupt(), q.pid);
  await running;
  assert.ok(Date.now() - started < 5000);
  const [entry] = live.history();
  assert.strictEqual(entry.outcome, "error");
  assert.strictEqual(entry.error, "stop");
  // The same connection answers the next query.
  assert.strictEqual(live.activeLabel(), "local");
  await live.run("1+1");
  assert.strictEqual(live.history()[0].outcome, "ok");
});

test("a call through runOnActive (benchmark, join, aj, system settings, async send) is dropped at the process's own timeout; off, or only q-lint.query.timeout, it runs on (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const { live } = await setUp(t, [{ label: "slow", host: "127.0.0.1", port, tags: [], timeout: 0.5 }]);
  assert.strictEqual(await live.connectTo("slow"), true);
  const started = Date.now();
  await assert.rejects(
    live.runOnActive("busy 3", (connection) => connection.call("busy", 3)),
    { message: "timed out after 0.5 s (slow's own timeout)" },
  );
  assert.ok(Date.now() - started < 2500, `${Date.now() - started} ms`);
  assert.ok(stub.messages.some(([, text]) => /the query timed out after 0\.5 s \(slow's own timeout\), and was aborted/.test(text)), JSON.stringify(stub.messages));
  // The connection was dropped and opened again once the process was free.
  for (let i = 0; i < 80 && live.activeLabel() === undefined; i++) await sleep(100);
  assert.strictEqual(live.activeLabel(), "slow");
  assert.strictEqual(live.isBusy(), false);
  // A call within the timeout answers.
  assert.strictEqual((await live.runOnActive("busy 0", (connection) => connection.call("busy", 0))).value, "done");
  // Off: the process's timeout no longer holds, and q-lint.query.timeout
  // never did here.
  stub.config.user["query.processTimeout.enable"] = false;
  stub.config.user["query.timeout"] = 0.5;
  const ran = await live.runOnActive("busy 1", (connection) => connection.call("busy", 1));
  assert.strictEqual(ran.value, "done");
  delete stub.config.user["query.timeout"];
});

test("a call over a connection of its own (Diff Function, Find in Processes, schema migration) is dropped at the process's own timeout and the connection closed; off, it runs on (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const slow = { label: "slow", host: "127.0.0.1", port, tags: [], timeout: 0.5 };
  const { live } = await setUp(t, [slow]);
  let opened;
  const openSeparate = live.openSeparate.bind(live);
  live.openSeparate = async (p) => (opened = await openSeparate(p));
  const started = Date.now();
  await assert.rejects(callApart(live, slow, "busy", 3), { message: "timed out after 0.5 s (slow's own timeout)" });
  assert.ok(Date.now() - started < 2500, `${Date.now() - started} ms`);
  assert.strictEqual(opened.isOpen, false);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: the call to slow timed out after 0.5 s (slow's own timeout), and its connection was closed. slow may still be running it."]);
  // No active connection was touched.
  assert.strictEqual(live.activeLabel(), undefined);
  stub.config.user["query.processTimeout.enable"] = false;
  assert.strictEqual(await callApart(live, slow, "busy", 1), "done");
  // Closed after, as before (closing is not awaited).
  for (let i = 0; i < 20 && opened.isOpen; i++) await sleep(50);
  assert.strictEqual(opened.isOpen, false);
});

test("Benchmark of an expression that sleeps is stopped at the process's own timeout and says so (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const { live, context } = await setUp(t, [{ label: "slow", host: "127.0.0.1", port, tags: [], timeout: 0.5 }]);
  const { registerBenchmark } = require("../out/benchmarkview.js");
  const { benchmark } = registerBenchmark(context, live);
  assert.strictEqual(await live.connectTo("slow"), true);
  const started = Date.now();
  const said = await benchmark('system "sleep 3"', "", "1 1");
  assert.ok(Date.now() - started < 2500, `${Date.now() - started} ms`);
  assert.strictEqual(said, "q-lint: the benchmark failed: timed out after 0.5 s (slow's own timeout)");
});
