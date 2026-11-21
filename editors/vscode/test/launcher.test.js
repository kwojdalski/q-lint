// The process launcher (#954): what a launch definition starts, and Start,
// Stop and Set Launch Definition through the stand-in `vscode` module - a
// node script standing in for a process that listens on its -p port, and a
// real q process when QLINT_TEST_Q names one.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const pkg = require("../package.json");
const { LAUNCH_COMMANDS, commandText, isLocalHost, launchPlan, readLauncher } = require("../out/launcher.js");
const { launchOf, parseProcesses, splitArgs } = require("../out/processes.js");
const { Live } = require("../out/live.js");
const { Launcher } = require("../out/launcherview.js");

const Q = process.env.QLINT_TEST_Q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = (label, port, launch, extra = {}) => ({ label, host: "127.0.0.1", port, tags: [], ...(launch ? { launch } : {}), ...extra });

test("a launch definition starts its program with its script, -p and its arguments", () => {
  const p = proc("rdb", 5010, { script: "torq.q", args: ["-proctype", "rdb", "-procname", "rdb1"], env: { KDBCODE: "code" } });
  assert.deepStrictEqual(launchPlan(p, "q", "/w", "/home/me"), {
    command: "q",
    args: ["/w/torq.q", "-p", "5010", "-proctype", "rdb", "-procname", "rdb1"],
    cwd: "/w",
    env: { KDBCODE: "code" },
  });
  // Its own program, cwd and -p; ~ is home.
  const own = launchPlan(proc("a", 1, { command: "~/q/m64/q", cwd: "~/torq", script: "x.q", args: ["-p", "6000"] }), "q", undefined, "/home/me");
  assert.deepStrictEqual(own, { command: "/home/me/q/m64/q", args: ["/home/me/torq/x.q", "-p", "6000"], cwd: "/home/me/torq", env: {} });
  assert.deepStrictEqual(launchPlan(proc("b", 7, {}), "q", undefined, "/home/me"), { command: "q", args: ["-p", "7"], cwd: "/home/me", env: {} });
  assert.match(launchPlan(proc("c", 1), "q", "/w").error, /c has no launch definition/);
  assert.match(launchPlan({ ...proc("d", 1, {}), host: "rdb.example" }, "q", "/w").error, /only a local process can be started/);
  assert.match(launchPlan(proc("e", 1, { cwd: "rel" }), "q", undefined).error, /relative, and there is no workspace folder/);
  assert.strictEqual(commandText({ command: "q", args: ["a b.q", "-p", "1"] }), 'q "a b.q" -p 1');
  assert.ok(isLocalHost("localhost") && isLocalHost("127.0.0.1") && isLocalHost("::1") && isLocalHost("MyBox", "mybox"));
  assert.ok(!isLocalHost("rdb.example", "mybox"));
});

test("a definition is read from the saved list and an import, never from a discovery server", () => {
  const entry = { label: "a", host: "localhost", port: 1, launch: { command: "q", script: "s.q", args: "-t 1000 \"x y\"", env: { A: "1", "B-C": "no", D: 2 }, junk: 1 } };
  assert.deepStrictEqual(parseProcesses([entry], true).processes[0].launch, { command: "q", script: "s.q", args: ["-t", "1000", "x y"], env: { A: "1" } });
  assert.strictEqual(parseProcesses([entry]).processes[0].launch, undefined);
  assert.deepStrictEqual(splitArgs('-a "b c" d'), ["-a", "b c", "d"]);
  assert.deepStrictEqual(launchOf({}), {});
  assert.strictEqual(launchOf("q"), undefined);
});

test("the launcher is on by default, and its commands are hidden while it is off", () => {
  assert.deepStrictEqual(readLauncher((_k, f) => f), { enabled: true });
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process connections");
  assert.strictEqual(section.properties["q-lint.processes.launcher.enable"].default, true);
  for (const command of Object.values(LAUNCH_COMMANDS)) {
    const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === command);
    assert.ok(menus.length >= 2, command);
    for (const m of menus) assert.match(m.when, /config\.q-lint\.processes\.launcher\.enable/, command);
  }
});

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const accepts = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
    s.on("error", () => resolve(false));
  });

async function setUp(t, processes) {
  stub.reset();
  const vscode = require("vscode");
  const channels = {};
  const make = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = (name) => {
    const lines = (channels[name] = []);
    return { append: (x) => lines.push(x), appendLine: (x) => lines.push(`${x}\n`), clear() {}, show() {}, dispose() {} };
  };
  t.after(() => (vscode.window.createOutputChannel = make));
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const launcher = new Launcher(context, live);
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      for (const d of context.subscriptions) d.dispose?.();
    }
  };
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    dispose();
  });
  return { live, launcher, channels, dispose, output: (label) => (channels[`q: ${label}`] ?? []).join("") };
}

// A process standing in for q: listens on the port after -p, says so, and
// ends on SIGTERM saying that too.
const FAKE = `const net = require("net");
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
net.createServer((s) => s.end()).listen(port, "127.0.0.1", () => console.log("listening on " + port + " in " + process.cwd() + " A=" + process.env.A));
process.on("SIGTERM", () => { console.error("bye"); process.exit(0); });
`;

test("Start Process starts the definition, shows its output, and Stop Process ends it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  const port = await freePort();
  const { live, launcher, output } = await setUp(t, [proc("fake", port, { command: process.execPath, script: "fake.js", cwd: dir, env: { A: "x" } }), proc("bare", port), proc("dup", port, { command: process.execPath, script: "fake.js", cwd: dir })]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("fake");
  for (let i = 0; i < 100 && !(await accepts(port)); i++) await sleep(50);
  assert.ok(await accepts(port));
  const [running] = launcher.running();
  assert.deepStrictEqual([running.label, running.port], ["fake", port]);
  assert.match(stub.messages.at(-1)[1], new RegExp(`^q-lint: started fake \\(pid \\d+\\) on port ${port}\\.$`));
  assert.ok(live.launched("fake"));
  for (let i = 0; i < 50 && !output("fake").includes("listening"); i++) await sleep(20);
  const realDir = fs.realpathSync(dir);
  assert.match(output("fake"), new RegExp(`^\\$ .*node.* ${path.join(dir, "fake.js").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -p ${port}    \\(in .*\\)\\nlistening on ${port} in (${dir}|${realDir}) A=x\\n`));
  // Started twice: said, not started.
  await stub.commands.get(LAUNCH_COMMANDS.start)("fake");
  assert.strictEqual(stub.messages.at(-1)[1], "q-lint: fake is already running from here.");
  // Something on its port already: not started.
  await stub.commands.get(LAUNCH_COMMANDS.start)("dup");
  assert.strictEqual(stub.messages.at(-1)[1], `q-lint: something already listens on port ${port}; dup was not started.`);
  assert.strictEqual(launcher.running().length, 1);
  // No definition: said.
  await stub.commands.get(LAUNCH_COMMANDS.start)("bare");
  assert.match(stub.messages.at(-1)[1], /bare has no launch definition/);
  await stub.commands.get(LAUNCH_COMMANDS.stop)();
  assert.deepStrictEqual(launcher.running(), []);
  assert.strictEqual(await accepts(port), false);
  for (let i = 0; i < 50 && !output("fake").includes("ended"); i++) await sleep(20);
  assert.match(output("fake"), /bye\n\[fake ended: exit code 0\]\n$/);
  // A process not started from here is not stopped from here.
  await stub.commands.get(LAUNCH_COMMANDS.stop)("bare");
  assert.strictEqual(stub.messages.at(-1)[1], "q-lint: bare was not started from here, so it is not stopped from here.");
});

test("what was started is stopped when VS Code closes, and when the launcher is turned off", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  const [a, b] = [await freePort(), await freePort()];
  const { launcher, dispose } = await setUp(t, [proc("a", a, { command: process.execPath, script: "fake.js", cwd: dir }), proc("b", b, { command: process.execPath, script: "fake.js", cwd: dir })]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("a");
  for (let i = 0; i < 100 && !(await accepts(a)); i++) await sleep(50);
  stub.config.user["processes.launcher.enable"] = false;
  stub.changeConfig("q-lint.processes.launcher.enable");
  for (let i = 0; i < 100 && (await accepts(a)); i++) await sleep(50);
  assert.strictEqual(await accepts(a), false);
  // Off: Start refuses and starts nothing.
  stub.messages = [];
  await stub.commands.get(LAUNCH_COMMANDS.start)("b");
  await stub.commands.get(LAUNCH_COMMANDS.stop)("b");
  await stub.commands.get(LAUNCH_COMMANDS.set)("b", null);
  const off = "q-lint: The process launcher is turned off. Set q-lint.processes.launcher.enable to true to turn it on.";
  assert.deepStrictEqual(stub.messages, [["info", off], ["info", off], ["info", off]]);
  assert.deepStrictEqual(launcher.running(), []);
  await sleep(300);
  assert.strictEqual(await accepts(b), false);
  // On again; closing VS Code stops it.
  stub.config.user["processes.launcher.enable"] = true;
  await stub.commands.get(LAUNCH_COMMANDS.start)("b");
  for (let i = 0; i < 100 && !(await accepts(b)); i++) await sleep(50);
  dispose();
  for (let i = 0; i < 100 && (await accepts(b)); i++) await sleep(50);
  assert.strictEqual(await accepts(b), false);
});

test("Set Launch Definition asks for the program, script and arguments", async (t) => {
  const { live } = await setUp(t, [proc("rdb", 5010, undefined, { tags: ["dev"] })]);
  stub.inputs.push("", "torq.q", '-proctype rdb -procname "rdb 1"');
  await stub.commands.get(LAUNCH_COMMANDS.set)("rdb");
  assert.deepStrictEqual(live.processes()[0].launch, { script: "torq.q", args: ["-proctype", "rdb", "-procname", "rdb 1"] });
  await stub.commands.get(LAUNCH_COMMANDS.set)("rdb", null);
  assert.strictEqual(live.processes()[0].launch, undefined);
});

test("a real q process is started, connected to, and stopped", { skip: Q ? false : "QLINT_TEST_Q names no q binary" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-q-"));
  fs.writeFileSync(path.join(dir, "server.q"), "-1 \"server up\";\nanswer:42\n");
  const port = await freePort();
  // QLINT_TEST_Q may be a command line, `env QLIC=.. QHOME=.. q`, as the
  // other real-q tests take it: a launch definition gives its program and
  // environment apart.
  const words = Q.trim().split(/\s+/);
  if (words[0] === "env") words.shift();
  const env = {};
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const [key, ...value] = words.shift().split("=");
    env[key] = value.join("=");
  }
  const { live, launcher, output } = await setUp(t, [proc("q", port, { command: words[0], script: "server.q", cwd: dir, ...(words.length > 1 ? { args: words.slice(1) } : {}), env })]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("q");
  for (let i = 0; i < 100 && !(await accepts(port)); i++) await sleep(100);
  assert.ok(await accepts(port), output("q"));
  // Still running with no stdin: q does not take its end for an exit.
  await sleep(500);
  assert.strictEqual(launcher.running().length, 1);
  assert.match(output("q"), /server up/);
  assert.strictEqual(await live.connectTo("q"), true);
  assert.deepStrictEqual((await live.borrow((c) => c.query(["answer"], [10, 80]))).text, ["42"]);
  await stub.commands.get(LAUNCH_COMMANDS.stop)("q");
  assert.strictEqual(await accepts(port), false);
  for (let i = 0; i < 50 && live.activeLabel() !== undefined; i++) await sleep(20);
  assert.strictEqual(live.activeLabel(), undefined);
});
