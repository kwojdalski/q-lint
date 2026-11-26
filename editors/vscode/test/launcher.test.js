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
const { LAUNCH_COMMANDS, argsFromText, argsText, commandText, fromWorkspace, inStack, isLocalHost, launchPlan, listenAddress, probeHost, readLauncher, spawnPlan } = require("../out/launcher.js");
const { launchOf, parseProcesses, splitArgs } = require("../out/processes.js");
const { onPath } = require("../out/relations.js");
const { Live } = require("../out/live.js");
const { Launcher } = require("../out/launcherview.js");

const Q = process.env.QLINT_TEST_Q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits until `ready()` holds, failing past a deadline: generous, as a
// process started on a loaded machine took longer than the 5 s the waits
// here once gave it, after which a test went on as though it had started.
async function until(ready, what, ms = 20_000) {
  for (const end = Date.now() + ms; !(await ready()); await sleep(50)) {
    if (Date.now() > end) throw new Error(`not ${what} in ${ms / 1000} s`);
  }
}
const proc = (label, port, launch, extra = {}) => ({ label, host: "127.0.0.1", port, tags: [], ...(launch ? { launch } : {}), ...extra });

test("a process defined on a loopback host listens on the loopback only, not on every interface (#1671)", () => {
  const plan = (host) => launchPlan({ ...proc("l", 47126, {}), host }, "q", undefined, "/home/me").args;
  assert.deepStrictEqual(plan("localhost"), ["-p", "127.0.0.1:47126"]);
  assert.deepStrictEqual(plan("127.0.0.1"), ["-p", "127.0.0.1:47126"]);
  assert.deepStrictEqual(plan("127.0.1.1"), ["-p", "127.0.1.1:47126"]);
  // q takes no ::1:port and binds IPv4 only, and a connect dials ::1 as
  // written: a process at ::1 is not started, as it could not be reached (#2130).
  assert.deepStrictEqual(launchPlan({ ...proc("l", 47126, {}), host: "::1" }, "q", undefined, "/home/me"), {
    error: "l is at ::1, and q listens on IPv4 only: give it the host 127.0.0.1 or localhost to start it here.",
  });
  assert.strictEqual(listenAddress("::1", 47126), "127.0.0.1:47126");
  // Asked for every interface, or by the machine's name: a bare port.
  assert.deepStrictEqual(plan("0.0.0.0"), ["-p", "47126"]);
  assert.strictEqual(listenAddress("box", 5), "5");
  // Its own -p is left as it is.
  assert.deepStrictEqual(launchPlan({ ...proc("l", 1, { args: ["-p", "5001"] }), host: "localhost" }, "q", undefined, "/home/me").args, ["-p", "5001"]);
});

test("a TorQ process on a loopback host listens on a bare port, where its stack reaches it by .z.h; its probe is its own address (#1742)", () => {
  const plan = (launch) => launchPlan({ ...proc("t", 47127, launch), host: "localhost" }, "q", undefined, "/home/me").args;
  assert.deepStrictEqual(plan({ script: "/opt/torq/torq.q", args: ["-load", "code/processes/rdb.q"] }), ["/opt/torq/torq.q", "-p", "47127", "-load", "code/processes/rdb.q"]);
  assert.deepStrictEqual(plan({ args: ["-proctype", "rdb", "-procname", "rdb1"] }), ["-p", "47127", "-proctype", "rdb", "-procname", "rdb1"]);
  // A lone q stays on the loopback.
  assert.deepStrictEqual(plan({ script: "/opt/tick.q" }), ["/opt/tick.q", "-p", "127.0.0.1:47127"]);
  assert.strictEqual(inStack("C:\\torq\\TORQ.q", []), true);
  assert.strictEqual(inStack("notorq.q", []), false);
  assert.strictEqual(probeHost("127.0.0.2"), "127.0.0.2");
  assert.strictEqual(probeHost("localhost"), "127.0.0.1");
  assert.strictEqual(probeHost("box"), "127.0.0.1");
});

test("on Windows a q.cmd or q.bat wrapper is run by cmd.exe, which Node needs for one (#1680)", () => {
  const cmd = "C:\\Windows\\system32\\cmd.exe";
  assert.deepStrictEqual(spawnPlan("C:\\kdb\\q.cmd", ["C:\\my dir\\x.q", "-p", "127.0.0.1:5000", ""], "win32", cmd), {
    command: cmd,
    args: ["/d", "/s", "/c", '"C:\\kdb\\q.cmd "C:\\my dir\\x.q" -p 127.0.0.1:5000 """'],
    verbatim: true,
  });
  assert.strictEqual(spawnPlan("C:\\kdb\\Q.BAT", ["-q"], "win32", cmd).command, cmd);
  assert.match(spawnPlan("C:\\kdb\\q.cmd", ["50%"], "win32", cmd).error, /cmd cannot pass "50%"/);
  // An .exe, and anything off Windows, as it is.
  assert.deepStrictEqual(spawnPlan("C:\\kdb\\q.exe", ["-q"], "win32", cmd), { command: "C:\\kdb\\q.exe", args: ["-q"], verbatim: false });
  assert.deepStrictEqual(spawnPlan("/opt/q.cmd", ["-q"], "linux", cmd), { command: "/opt/q.cmd", args: ["-q"], verbatim: false });
});

test("on Windows a bare q is found as the q.cmd or q.bat PATH holds, in PATHEXT's order, where it is started through spawnPlan (#1844)", () => {
  const on = (...files) => (file) => files.includes(file);
  // Only a q.cmd on PATH: found with PATHEXT, missed without (git, node and tar, run by execFile, cannot start one).
  assert.strictEqual(onPath("q", "C:\\kx", on("C:\\kx\\q.cmd"), "win32", ".COM;.EXE;.BAT;.CMD"), "C:\\kx\\q.cmd");
  assert.strictEqual(onPath("q", "C:\\kx", on("C:\\kx\\q.cmd"), "win32"), undefined);
  // An empty PATHEXT is Windows' default; within one directory the order is PATHEXT's.
  assert.strictEqual(onPath("q", "C:\\kx", on("C:\\kx\\q.bat", "C:\\kx\\q.exe"), "win32", ""), "C:\\kx\\q.exe");
  assert.strictEqual(onPath("q", "C:\\kx", on("C:\\kx\\q.bat", "C:\\kx\\q.exe"), "win32", ".BAT;.EXE"), "C:\\kx\\q.bat");
  // launchPlan's own find uses PATHEXT, and spawnPlan runs the wrapper by cmd.exe.
  const find = (bin) => onPath(bin, "C:\\kx", on("C:\\kx\\q.cmd"), "win32", "");
  const plan = launchPlan(proc("w", 1, {}), "q", "C:\\w", "C:\\Users\\me", find);
  assert.strictEqual(plan.command, "C:\\kx\\q.cmd");
  assert.strictEqual(spawnPlan(plan.command, plan.args, "win32", "cmd.exe").command, "cmd.exe");
});

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
  assert.deepStrictEqual(launchPlan(proc("b", 7, {}), "q", undefined, "/home/me"), { command: "q", args: ["-p", "127.0.0.1:7"], cwd: "/home/me", env: {} });
  // ~\ is home too, as Windows writes it (#1284), in the definition and in q-lint.qBinary.
  const winHome = path.join("/home/me", "q\\w64\\q.exe");
  assert.strictEqual(launchPlan(proc("w", 1, { command: "~\\q\\w64\\q.exe" }), "q", undefined, "/home/me").command, winHome);
  assert.strictEqual(launchPlan(proc("w", 1, {}), "~\\q\\w64\\q.exe", undefined, "/home/me").command, winHome);
  assert.strictEqual(launchPlan(proc("w", 1, {}), "~q", undefined, "/home/me").command, "~q");
  // A bare program is the file PATH holds it in: on Windows the folder q
  // starts in is never asked (#1286), and none on PATH is not started.
  const on = (...files) => (file) => files.includes(file);
  const find = (bin) => onPath(bin, ".;C:\\q\\w64", on("C:\\w\\q.exe", "q.exe", "C:\\q\\w64\\q.exe"), "win32");
  assert.strictEqual(launchPlan(proc("w", 1, {}), "q", "C:\\w", "C:\\Users\\me", find).command, "C:\\q\\w64\\q.exe");
  assert.strictEqual(launchPlan(proc("w", 1, { command: "C:\\w\\q.exe" }), "q", "C:\\w", "C:\\Users\\me", find).command, "C:\\w\\q.exe");
  const none = (bin) => onPath(bin, ".;bin", on("q.exe", "bin\\q.exe"), "win32");
  assert.strictEqual(launchPlan(proc("w", 1, {}), "q", "C:\\w", "C:\\Users\\me", none).error, "q is not on PATH, so w was not started: name the program by its path.");
  assert.strictEqual(launchPlan(proc("w", 1, {}), "q", "/w", "/home/me", (bin) => onPath(bin, "", on(), "linux")).command, "q");
  assert.match(launchPlan(proc("c", 1), "q", "/w").error, /c has no launch definition/);
  assert.match(launchPlan({ ...proc("d", 1, {}), host: "rdb.example" }, "q", "/w").error, /only a local process can be started/);
  assert.match(launchPlan(proc("e", 1, { cwd: "rel" }), "q", undefined).error, /relative, and there is no workspace folder/);
  assert.strictEqual(commandText({ command: "q", args: ["a b.q", "-p", "1"] }, "linux"), "q 'a b.q' -p 1");
  assert.ok(isLocalHost("localhost") && isLocalHost("127.0.0.1") && isLocalHost("::1") && isLocalHost("MyBox", "mybox"));
  assert.ok(!isLocalHost("rdb.example", "mybox"));
});

test("the command line the output shows is the command that ran, to a shell it is pasted into (#3119)", () => {
  const plan = { command: "/opt/q/q", args: ["a b", "$HOME", "x;y", "`sym", "*", "-e", "it's", "", "-p", "127.0.0.1:5010", "a=b,c@d%e+f"] };
  assert.strictEqual(commandText(plan, "linux"), "/opt/q/q 'a b' '$HOME' 'x;y' '`sym' '*' -e 'it'\\''s' '' -p 127.0.0.1:5010 a=b,c@d%e+f");
  // A shell reads it back as the words that were passed.
  if (process.platform !== "win32") {
    const { execFileSync } = require("node:child_process");
    const read = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${commandText({ command: "x", args: plan.args }, "linux")}`], { encoding: "utf8" });
    assert.deepStrictEqual(read.split("\n").slice(1, -1), plan.args);
  }
  // On Windows, as PowerShell reads one.
  assert.strictEqual(commandText({ command: "C:\\q\\w64\\q.exe", args: ["a b", "$env:X", "it's", "-p", "5010"] }, "win32"), "C:\\q\\w64\\q.exe 'a b' '$env:X' 'it''s' -p 5010");
});

test("this machine by any spelling of it: its short name, the root's dot, a loopback address written short, long, mapped or in brackets (#3115)", () => {
  for (const host of ["Mac", "mac.lan.", "MAC.LAN", "localhost.", "127.1", "127.0.1", "127.0.0.2", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "[::FFFF:7f00:1]", "0.0.0.0"]) {
    assert.strictEqual(isLocalHost(host, "Mac.lan"), true, host);
  }
  // Another machine: one of another name or domain, an address that is no
  // loopback, and the first number of this machine's address.
  for (const [host, here] of [["mac2", "Mac.lan"], ["mac.other", "Mac.lan"], ["lan", "Mac.lan"], ["128.1", "Mac.lan"], ["::2", "Mac.lan"], ["::ffff:10.0.0.1", "Mac.lan"], ["127.0.0.256", "Mac.lan"], ["127", "Mac.lan"], ["10", "10.0.0.5"], ["", "Mac.lan"]]) {
    assert.strictEqual(isLocalHost(host, here), false, host);
  }
  // And each is started where it was said to be: on the loopback, by the
  // address in full, not on every interface (#1671).
  assert.deepStrictEqual(
    ["127.1", "127.0.513", "localhost.", "::ffff:127.0.0.3", "Mac"].map((host) => listenAddress(host, 5)),
    ["127.0.0.1:5", "127.0.2.1:5", "127.0.0.1:5", "127.0.0.3:5", "5"],
  );
  assert.deepStrictEqual(["127.1", "::ffff:127.0.0.3", "localhost."].map(probeHost), ["127.0.0.1", "127.0.0.3", "127.0.0.1"]);
  assert.deepStrictEqual(launchPlan({ ...proc("l", 47126, {}), host: "127.1" }, "q", undefined, "/home/me").args, ["-p", "127.0.0.1:47126"]);
  // ::1 by another spelling is still not started (#2130).
  for (const host of ["[::1]", "0:0:0:0:0:0:0:1"]) {
    assert.match(launchPlan({ ...proc("l", 47126, {}), host }, "q", undefined, "/home/me").error, /is at ::1, and q listens on IPv4 only/);
  }
});

// A saved process's relative cwd or script is whichever workspace is open:
// in one not trusted, its script (#1527).
test("a relative cwd, or a relative script with no cwd, is from the workspace folder", () => {
  assert.strictEqual(fromWorkspace({ cwd: "db" }, "/home/u"), true);
  assert.strictEqual(fromWorkspace({ script: "rdb.q" }, "/home/u"), true);
  assert.strictEqual(fromWorkspace({ cwd: "/srv/db", script: "rdb.q" }, "/home/u"), false);
  assert.strictEqual(fromWorkspace({ cwd: "~/db", script: "rdb.q" }, "/home/u"), false);
  assert.strictEqual(fromWorkspace({ script: "/srv/rdb.q" }, "/home/u"), false);
  assert.strictEqual(fromWorkspace({ args: ["-p", "1"] }, "/home/u"), false);
  // A relative program path runs the repository's binary (#1714).
  assert.strictEqual(fromWorkspace({ command: "./bin/q" }, "/home/u"), true);
  assert.strictEqual(fromWorkspace({ command: "bin\\q.exe" }, "/home/u"), true);
  assert.strictEqual(fromWorkspace({ command: "q" }, "/home/u"), false);
  assert.strictEqual(fromWorkspace({ command: "/opt/kx/q" }, "/home/u"), false);
  assert.strictEqual(fromWorkspace({ command: "~/q/m64/q" }, "/home/u"), false);
  assert.strictEqual(fromWorkspace({ command: "./bin/q", cwd: "/srv/db" }, "/home/u"), false);
});

test("a definition is read from the saved list and an import, never from a discovery server", () => {
  const entry = { label: "a", host: "localhost", port: 1, launch: { command: "q", script: "s.q", args: "-t 1000 \"x y\"", env: { A: "1", "B=C": "no", D: 2 }, junk: 1 } };
  // A number is its text: D's 2 was dropped, as was 5010 from ["-p", 5010] (#2521).
  assert.deepStrictEqual(parseProcesses([entry], true).processes[0].launch, { command: "q", script: "s.q", args: ["-t", "1000", "x y"], env: { A: "1", D: "2" } });
  assert.deepStrictEqual(launchOf({ args: ["-p", 5010, true, null], env: { SLAVES: 4, X: null, Y: false } }), { args: ["-p", "5010", "true"], env: { SLAVES: "4", Y: "false" } });
  assert.strictEqual(parseProcesses([entry]).processes[0].launch, undefined);
  // A variable's name is any the system takes, not an identifier only (#3112).
  const named = { "ProgramFiles(x86)": "C:\\x86", "A.B": "1", "my-var": "2", OK: "3", __proto__: null };
  assert.deepStrictEqual(launchOf({ env: { ...named, "": "x", "A=B": "x", "N\0": "x" } }).env, { "ProgramFiles(x86)": "C:\\x86", "A.B": "1", "my-var": "2", OK: "3" });
  assert.deepStrictEqual(splitArgs('-a "b c" d'), ["-a", "b c", "d"]);
  // A quote groups anywhere in a word, as a shell's does (#1695).
  assert.deepStrictEqual(splitArgs('-name="a b" -x "" c'), ["-name=a b", "-x", "", "c"]);
  assert.deepStrictEqual(splitArgs('  a"b c"d  e" '), ["ab cd", 'e"']);
  assert.deepStrictEqual(splitArgs(""), []);
  // A pair of single quotes groups too, and each kind keeps the other (#3111).
  assert.deepStrictEqual(splitArgs("-load 'my dir/rdb.q' -x 'c d'"), ["-load", "my dir/rdb.q", "-x", "c d"]);
  assert.deepStrictEqual(splitArgs(`-e 'say "hi"' "it's" -n='a b' '' don't`), ["-e", 'say "hi"', "it's", "-n=a b", "", "don't"]);
  assert.deepStrictEqual(launchOf({ args: "-load 'my dir/rdb.q'" }), { args: ["-load", "my dir/rdb.q"] });
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
  // A discovery server's row never has a launch definition (#1693).
  for (const m of pkg.contributes.menus["view/item/context"].filter((m) => Object.values(LAUNCH_COMMANDS).includes(m.command))) {
    assert.doesNotMatch(m.when, /discovered/, m.command);
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
  const closed = new Set();
  const make = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = (name) => {
    const lines = (channels[name] = []);
    closed.delete(name);
    return { append: (x) => lines.push(x), appendLine: (x) => lines.push(`${x}\n`), clear() {}, show() {}, dispose: () => closed.add(name) };
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
  return { live, launcher, channels, closed, dispose, output: (label) => (channels[`q: ${label}`] ?? []).join("") };
}

// A process standing in for q: listens on the port after -p, says so, and
// ends on SIGTERM saying that too.
const FAKE = `const net = require("net");
const port = Number(process.argv[process.argv.indexOf("-p") + 1].split(":").pop());
net.createServer((s) => s.end()).listen(port, "127.0.0.1", () => console.log("listening on " + port + " in " + process.cwd() + " A=" + process.env.A));
process.on("SIGTERM", () => { console.error("bye"); process.exit(0); });
`;

test("Start Process starts the definition, shows its output, and Stop Process ends it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  const port = await freePort();
  const { live, launcher, output } = await setUp(t, [proc("fake", port, { command: process.execPath, script: "fake.js", cwd: dir, env: { A: "x" } }), proc("bare", port), proc("dup", port, { command: process.execPath, script: "fake.js", cwd: dir })]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("fake");
  await until(() => accepts(port), "listening on port");
  assert.ok(await accepts(port));
  const [running] = launcher.running();
  assert.deepStrictEqual([running.label, running.port], ["fake", port]);
  assert.match(stub.messages.at(-1)[1], new RegExp(`^q-lint: started fake \\(pid \\d+\\) on port ${port}\\.$`));
  assert.ok(live.launched("fake"));
  await until(() => output("fake").includes("listening"), "listening in fake's output");
  const realDir = fs.realpathSync(dir);
  assert.match(output("fake"), new RegExp(`^\\$ .*node.* ${path.join(dir, "fake.js").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -p 127\\.0\\.0\\.1:${port}    \\(in .*\\)\\nlistening on ${port} in (${dir}|${realDir}) A=x\\n`));
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
  await until(() => output("fake").includes("ended"), "ended in fake's output");
  assert.match(output("fake"), /bye\n\[fake ended: exit code 0\]\n$/);
  // A process not started from here is not stopped from here.
  await stub.commands.get(LAUNCH_COMMANDS.stop)("bare");
  assert.strictEqual(stub.messages.at(-1)[1], "q-lint: bare was not started from here, so it is not stopped from here.");
});

test("Start Process run twice at once starts one process (#1249)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  const port = await freePort();
  const { launcher, output, dispose } = await setUp(t, [proc("fake", port, { command: process.execPath, script: "fake.js", cwd: dir })]);
  await Promise.all([stub.commands.get(LAUNCH_COMMANDS.start)("fake"), stub.commands.get(LAUNCH_COMMANDS.start)("fake")]);
  await until(() => accepts(port), "listening on port");
  assert.strictEqual(launcher.running().length, 1);
  assert.ok(stub.messages.some((m) => m[1] === "q-lint: fake is already running from here."), JSON.stringify(stub.messages));
  // One command line in its output: the second was never spawned.
  assert.strictEqual(output("fake").split("\n").filter((l) => l.startsWith("$ ")).length, 1);
  dispose();
  await until(async () => !(await accepts(port)), "stopped listening on port");
  assert.strictEqual(await accepts(port), false);
});

test("what was started is stopped when VS Code closes, and when the launcher is turned off", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  const [a, b] = [await freePort(), await freePort()];
  const { launcher, dispose } = await setUp(t, [proc("a", a, { command: process.execPath, script: "fake.js", cwd: dir }), proc("b", b, { command: process.execPath, script: "fake.js", cwd: dir })]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("a");
  await until(() => accepts(a), "listening on a");
  stub.config.user["processes.launcher.enable"] = false;
  stub.changeConfig("q-lint.processes.launcher.enable");
  await until(async () => !(await accepts(a)), "stopped listening on a");
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
  await until(() => accepts(b), "listening on b");
  dispose();
  await until(async () => !(await accepts(b)), "stopped listening on b");
  assert.strictEqual(await accepts(b), false);
});

test("turned off, or VS Code closing, the launcher's output channels go too (#1433)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  const [a, b] = [await freePort(), await freePort()];
  const { closed, dispose, output } = await setUp(t, [proc("a", a, { command: process.execPath, script: "fake.js", cwd: dir }), proc("b", b, { command: process.execPath, script: "fake.js", cwd: dir })]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("a");
  await until(() => accepts(a), "listening on a");
  stub.config.user["processes.launcher.enable"] = false;
  stub.changeConfig("q-lint.processes.launcher.enable");
  await until(() => closed.has("q: a"), "q: a closed");
  assert.ok(closed.has("q: a"));
  // It ended before its channel went: its end is in it.
  assert.match(output("a"), /\[a ended: /);
  stub.config.user["processes.launcher.enable"] = true;
  await stub.commands.get(LAUNCH_COMMANDS.start)("b");
  await until(() => accepts(b), "listening on b");
  dispose();
  await until(() => closed.has("q: b"), "q: b closed");
  assert.ok(closed.has("q: b"));
});

test("turned off while a Start is on its way, nothing is spawned (#1434)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  const port = await freePort();
  const { launcher, output } = await setUp(t, [proc("a", port, { command: process.execPath, script: "fake.js", cwd: dir })]);
  const started = stub.commands.get(LAUNCH_COMMANDS.start)("a");
  stub.config.user["processes.launcher.enable"] = false;
  stub.changeConfig("q-lint.processes.launcher.enable");
  await started;
  await sleep(300);
  assert.deepStrictEqual(launcher.running(), []);
  assert.strictEqual(await accepts(port), false);
  assert.ok(!output("a").includes("$ "), output("a"));
});

test("turned off while a Start waits for the spawn, the process is stopped, not kept (#1740)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  const port = await freePort();
  const { launcher } = await setUp(t, [proc("a", port, { command: process.execPath, script: "fake.js", cwd: dir })]);
  // Turned off just as the command line is written: past the check before
  // the spawn, while it waits for the spawn event.
  const vscode = require("vscode");
  const make = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = (name) => {
    const channel = make(name);
    const appendLine = channel.appendLine;
    channel.appendLine = (x) => {
      appendLine(x);
      if (x.startsWith("$ ")) {
        stub.config.user["processes.launcher.enable"] = false;
        stub.changeConfig("q-lint.processes.launcher.enable");
      }
    };
    return channel;
  };
  t.after(() => (vscode.window.createOutputChannel = make));
  await stub.commands.get(LAUNCH_COMMANDS.start)("a");
  await sleep(500);
  assert.deepStrictEqual(launcher.running(), []);
  assert.strictEqual(await accepts(port), false);
  assert.match(stub.messages.at(-1)?.[1] ?? "", /launcher was turned off; a was not started/, JSON.stringify(stub.messages));
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
  await until(() => accepts(port), "listening on port");
  assert.ok(await accepts(port), output("q"));
  // Still running with no stdin: q does not take its end for an exit.
  await sleep(500);
  assert.strictEqual(launcher.running().length, 1);
  assert.match(output("q"), /server up/);
  assert.strictEqual(await live.connectTo("q"), true);
  assert.deepStrictEqual((await live.borrow((c) => c.query(["answer"], [10, 80]))).text, ["42"]);
  await stub.commands.get(LAUNCH_COMMANDS.stop)("q");
  assert.strictEqual(await accepts(port), false);
  await until(() => live.activeLabel() === undefined, "disconnected");
  assert.strictEqual(live.activeLabel(), undefined);
});

test("the Arguments box gives back the arguments it was filled with (#1430)", () => {
  const args = ["-e", "", 'say "hi" now', "-p", "5000"];
  assert.deepStrictEqual(argsFromText(argsText(args), args), args);
  // An empty argument is shown quoted, so splitting the box keeps it.
  assert.strictEqual(argsText(["-e", "", "a b"]), '-e "" "a b"');
  assert.deepStrictEqual(argsFromText('-e "" "a b" -x', ["-e", "", "a b"]), ["-e", "", "a b", "-x"]);
  // One with a single quote too, now that a pair of them groups (#3111).
  assert.strictEqual(argsText(["it's", "that's"]), `"it's" "that's"`);
  assert.deepStrictEqual(argsFromText(`"it's" "that's" -x`, ["it's", "that's"]), ["it's", "that's", "-x"]);
});

test("Stop Process ends what a wrapper script started too, and frees its port (#1672)", { skip: process.platform === "win32" ? "no process groups" : false }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  // Runs its program without exec, as TorQ's start script and rlwrap do.
  fs.writeFileSync(path.join(dir, "wrap.sh"), `#!/bin/sh\n"${process.execPath}" "$@"\necho wrapper done\n`, { mode: 0o755 });
  const port = await freePort();
  const { launcher } = await setUp(t, [proc("w", port, { command: path.join(dir, "wrap.sh"), script: "fake.js", cwd: dir })]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("w");
  await until(() => accepts(port), "listening on port");
  assert.ok(await accepts(port));
  const stopped = stub.commands.get(LAUNCH_COMMANDS.stop)("w").then(() => true);
  assert.strictEqual(await Promise.race([stopped, sleep(5000).then(() => false)]), true);
  assert.deepStrictEqual(launcher.running(), []);
  assert.strictEqual(await accepts(port), false);
});

test("Stop Process ends what a wrapper left running after it exited (#1744)", { skip: process.platform === "win32" ? "no process groups" : false }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  // Starts its program in the background and exits, as `q tick.q &` does.
  fs.writeFileSync(path.join(dir, "bg.sh"), `#!/bin/sh\n"${process.execPath}" "$@" &\nexit 0\n`, { mode: 0o755 });
  const port = await freePort();
  const { launcher } = await setUp(t, [proc("bg", port, { command: path.join(dir, "bg.sh"), script: "fake.js", cwd: dir })]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("bg");
  await until(() => accepts(port), "listening on port");
  assert.ok(await accepts(port));
  const stopped = stub.commands.get(LAUNCH_COMMANDS.stop)("bg").then(() => true);
  assert.strictEqual(await Promise.race([stopped, sleep(8000).then(() => false)]), true);
  assert.deepStrictEqual(launcher.running(), []);
  assert.strictEqual(await accepts(port), false);
});

test("in a workspace not trusted, a launch with no working directory starts in the home directory, so no argument names the repository's file (#3094)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-home-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  fs.writeFileSync(path.join(ws, "evil.q"), "");
  const port = await freePort();
  const { output } = await setUp(t, [proc("rdb", port, { command: process.execPath, script: path.join(dir, "fake.js"), args: ["evil.q"] })]);
  const vscode = require("vscode");
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: "ws", index: 0 }];
  vscode.workspace.isTrusted = false;
  t.after(() => {
    vscode.workspace.isTrusted = true;
    vscode.workspace.workspaceFolders = undefined;
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  await stub.commands.get(LAUNCH_COMMANDS.start)("rdb");
  await until(() => output("rdb").includes("listening"), "listening in rdb's output");
  const cwd = output("rdb").match(/listening on \d+ in (.*) A=/)[1];
  assert.strictEqual(fs.realpathSync(cwd), fs.realpathSync(home), output("rdb"));
  assert.ok(output("rdb").includes(`[the workspace is not trusted: started in ${home}, not in ${ws}]`), output("rdb"));
});

test("a working directory that does not exist is what the error names, and ${workspaceFolder} before one is the folder (#3104)", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-")));
  fs.mkdirSync(path.join(dir, "torq"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  fs.writeFileSync(path.join(dir, "file"), "");
  const fake = { command: process.execPath, script: path.join(dir, "fake.js") };
  const [a, b] = [await freePort(), await freePort()];
  const { launcher, output } = await setUp(t, [proc("gone", a, { ...fake, cwd: path.join(dir, "renamed") }), proc("file", a, { ...fake, cwd: path.join(dir, "file") }), proc("var", b, { ...fake, cwd: "${workspaceFolder}/torq" })]);
  const vscode = require("vscode");
  const folders = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(dir), name: "ws", index: 0 }];
  t.after(() => (vscode.workspace.workspaceFolders = folders));
  await stub.commands.get(LAUNCH_COMMANDS.start)("gone");
  await stub.commands.get(LAUNCH_COMMANDS.start)("file");
  assert.deepStrictEqual(stub.messages, [
    ["error", `q-lint: gone's working directory ${path.join(dir, "renamed")} does not exist; it was not started.`],
    ["error", `q-lint: file's working directory ${path.join(dir, "file")} is not a directory; it was not started.`],
  ]);
  assert.deepStrictEqual([launcher.running(), output("gone")], [[], ""]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("var");
  await until(() => output("var").includes("listening"), "listening in var's output");
  assert.match(output("var"), new RegExp(`listening on ${b} in ${path.join(dir, "torq")} A=`));
  // As data: the folder alone, and only where it starts the path.
  const cwd = (text, ...folder) => launchPlan(proc("v", 1, { cwd: text }), "q", folder.length > 0 ? folder[0] : "/w", "/home/me");
  assert.deepStrictEqual([cwd("${workspaceFolder}").cwd, cwd("${workspaceFolder}/a/b").cwd, cwd("/x/${workspaceFolder}").cwd], ["/w", "/w/a/b", "/x/${workspaceFolder}"]);
  assert.match(cwd("${workspaceFolder}/torq", undefined).error, /is relative, and there is no workspace folder/);
  // Not trusted, it is the folder still: not started there (#1527).
  assert.strictEqual(fromWorkspace({ cwd: "${workspaceFolder}/torq" }, "/home/me"), true);
});

test("a program that does not exist is one error, never 'started' (#1679)", async (t) => {
  const port = await freePort();
  const { launcher, output } = await setUp(t, [proc("gone", port, { command: path.join(os.tmpdir(), "no-such-q-1679") })]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("gone");
  await sleep(100);
  assert.deepStrictEqual(
    stub.messages.map((m) => m[0]),
    ["error"],
    JSON.stringify(stub.messages),
  );
  assert.match(stub.messages[0][1], /^q-lint: could not start gone: spawn .*no-such-q-1679 ENOENT$/);
  assert.match(output("gone"), /could not start: spawn .*ENOENT/);
  assert.deepStrictEqual(launcher.running(), []);
});

test("a process started here and then renamed is still running and stopped under its new label (#1692)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fake.js"), FAKE);
  const port = await freePort();
  const { live, launcher } = await setUp(t, [proc("rdb", port, { command: process.execPath, script: "fake.js", cwd: dir })]);
  await stub.commands.get(LAUNCH_COMMANDS.start)("rdb");
  await until(() => accepts(port), "listening on port");
  stub.inputs = ["rdb1", "127.0.0.1", String(port), "", ""];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.editProcess")("rdb");
  assert.deepStrictEqual(live.processes().map((p) => p.label), ["rdb1"]);
  assert.deepStrictEqual(launcher.running().map((r) => r.label), ["rdb1"]);
  assert.ok(live.launched("rdb1"));
  await stub.commands.get(LAUNCH_COMMANDS.stop)("rdb1");
  assert.deepStrictEqual(launcher.running(), []);
  assert.strictEqual(await accepts(port), false);
});

// Stopping the connected process looked like a dropped connection: with
// auto-reconnect on, q-lint warned, retried the process just stopped, and
// said it could not reconnect (#2134).
test("Stop Process on the connected process disconnects it: nothing reconnects to it (#2134)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  // Answers the handshake as q does.
  fs.writeFileSync(path.join(dir, "fakeq.js"), FAKE.replace("(s) => s.end()", "(s) => s.once(\"data\", () => s.write(Buffer.from([3])))"));
  const port = await freePort();
  const { live } = await setUp(t, [proc("dev", port, { command: process.execPath, script: "fakeq.js", cwd: dir })]);
  stub.config.user["connection.autoReconnect.enable"] = true;
  await stub.commands.get(LAUNCH_COMMANDS.start)("dev");
  await until(() => accepts(port), "listening on port");
  assert.strictEqual(await live.connectTo("dev"), true);
  const said = stub.messages.length;
  await stub.commands.get(LAUNCH_COMMANDS.stop)("dev");
  await sleep(1500);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.doesNotMatch(live.api().statusText(), /reconnecting/);
  assert.deepStrictEqual(stub.messages.slice(said).filter(([, m]) => /reconnect/i.test(m)), []);
});

test("Restart and turning the launcher off close the connection first: no drop, no reconnect (#2564)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-launch-"));
  fs.writeFileSync(path.join(dir, "fakeq.js"), FAKE.replace("(s) => s.end()", "(s) => s.once(\"data\", () => s.write(Buffer.from([3])))"));
  const port = await freePort();
  const { live, launcher } = await setUp(t, [proc("dev", port, { command: process.execPath, script: "fakeq.js", cwd: dir })]);
  stub.config.user["connection.autoReconnect.enable"] = true;
  await stub.commands.get(LAUNCH_COMMANDS.start)("dev");
  await until(() => accepts(port), "listening on port");
  assert.strictEqual(await live.connectTo("dev"), true);
  const said = stub.messages.length;
  assert.strictEqual(await launcher.restart("dev"), undefined);
  await sleep(1500);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.deepStrictEqual(stub.messages.slice(said).filter(([, m]) => /reconnect/i.test(m)), []);
  // Off: the same.
  assert.strictEqual(await live.connectTo("dev"), true);
  stub.config.user["processes.launcher.enable"] = false;
  stub.changeConfig("q-lint.processes.launcher.enable");
  await until(async () => !(await accepts(port)), "stopped listening");
  await sleep(1500);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.deepStrictEqual(stub.messages.slice(said).filter(([, m]) => /reconnect/i.test(m)), []);
});
