// Run File with Arguments (#1005): the saved argument sets, the quick pick
// through the stand-in `vscode` module, and what the q terminal is sent -
// the words after the file and the lines typed after it. With QLINT_TEST_Q,
// the line the terminal is sent is run by a real shell and q, which shows
// the words arrive as `.z.x` - less q's own options, such as `-c`, which q
// takes from anywhere on the line - and the input is read by q's console.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const runargs = require("../out/runargs.js");
const { RunWithArguments } = require("../out/runargsview.js");
const { QTerminals } = require("../out/live.js");

const { RUN_ARGS_COMMAND, RUN_ARGS_KEY, RUN_ARGS_OFF, MAX_SETS, describe, extraOf, inputLines, readRunArgs, setsFor, withSet, withoutSet } = runargs;
const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";

test("argument sets are kept per file, newest first, at most ten, and forgotten", () => {
  const a = { args: "-p 5001", input: "" };
  const b = { args: '1 "two words"', input: "show .z.x\nx:1" };
  let stored = withSet(undefined, "file:///a.q", a);
  stored = withSet(stored, "file:///a.q", b);
  stored = withSet(stored, "file:///b.q", a);
  assert.deepStrictEqual(setsFor(stored, "file:///a.q"), [b, a]);
  // Run again: moved to the front, not doubled.
  stored = withSet(stored, "file:///a.q", a);
  assert.deepStrictEqual(setsFor(stored, "file:///a.q"), [a, b]);
  for (let i = 0; i < 20; i++) stored = withSet(stored, "file:///a.q", { args: String(i), input: "" });
  assert.strictEqual(setsFor(stored, "file:///a.q").length, MAX_SETS);
  assert.strictEqual(setsFor(stored, "file:///a.q")[0].args, "19");
  stored = withoutSet(stored, "file:///b.q", a);
  assert.deepStrictEqual(setsFor(stored, "file:///b.q"), []);
  assert.ok(!("file:///b.q" in stored));
  // What is not a set is dropped.
  assert.deepStrictEqual(setsFor({ "file:///c.q": [{ args: 1 }, "x", { args: "", input: "" }] }, "file:///c.q"), [{ args: "", input: "" }]);
  assert.deepStrictEqual(setsFor("junk", "file:///c.q"), []);
});

test("a set is the words after the file and the lines typed after", () => {
  assert.deepStrictEqual(extraOf({ args: '-p 5001 -name "a b"', input: 'show "x\\ny"\n\n' }), { args: ["-p", "5001", "-name", "a b"], input: ['show "x\\ny"'] });
  assert.deepStrictEqual(inputLines(""), []);
  assert.deepStrictEqual(inputLines("a\r\nb"), ["a", "b"]);
  assert.deepStrictEqual(describe({ args: "", input: "" }), { label: "(no arguments)", description: "" });
  assert.deepStrictEqual(describe({ args: "1 2", input: "a\nb" }), { label: "1 2", description: "then 2 lines of input" });
});

test("the command is on by default, contributed, and hidden while off", () => {
  assert.deepStrictEqual(readRunArgs((_k, f) => f), { enabled: true });
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: terminal");
  assert.strictEqual(section.properties["q-lint.terminal.runWithArguments.enable"].default, true);
  assert.ok(pkg.contributes.commands.some((c) => c.command === RUN_ARGS_COMMAND && c.category === "q-lint"));
  const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === RUN_ARGS_COMMAND);
  assert.strictEqual(menus.length, 3);
  for (const m of menus) assert.match(m.when, /config\.q-lint\.terminal\.runWithArguments\.enable/);
});

/// The command over the stand-in, with an in-memory workspaceState; what
/// it ran is in `runs`.
function setUp(t, file = "/w/main.q") {
  stub.reset();
  const context = stub.newContext();
  const state = new Map();
  context.workspaceState = { get: (k, d) => (state.has(k) ? structuredClone(state.get(k)) : d), update: async (k, v) => void state.set(k, structuredClone(v)), keys: () => [...state.keys()] };
  const runs = [];
  const command = new RunWithArguments(context, async (extra) => void runs.push(extra));
  vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file(file) } };
  t.after(() => {
    vscode.window.activeTextEditor = undefined;
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { context, runs, command, stored: () => state.get(RUN_ARGS_KEY) };
}

test("a new set is asked for, run and saved; a saved one is run from the pick", async (t) => {
  const { runs, stored } = setUp(t);
  let offered;
  stub.picks.push((o) => ((offered = o.items.map((i) => i.label)), o.items.find((i) => i.action === "new")));
  stub.inputs.push('-p 5001 "a b"', "show .z.x", "x:1", "");
  const set = await stub.commands.get(RUN_ARGS_COMMAND)();
  assert.deepStrictEqual(offered, ["$(add) New arguments..."]);
  assert.deepStrictEqual(set, { args: '-p 5001 "a b"', input: "show .z.x\nx:1" });
  assert.deepStrictEqual(runs, [{ args: ["-p", "5001", "a b"], input: ["show .z.x", "x:1"] }]);
  assert.deepStrictEqual(setsFor(stored(), "file:///w/main.q"), [set]);
  // Next time it is offered first, with a forget item.
  stub.picks.push((o) => ((offered = o.items.map((i) => [i.label, i.description])), o.items[0]));
  await stub.commands.get(RUN_ARGS_COMMAND)();
  assert.deepStrictEqual(offered, [['-p 5001 "a b"', "then 2 lines of input"], ["$(add) New arguments...", undefined], ["$(trash) Forget saved arguments...", undefined]]);
  assert.strictEqual(runs.length, 2);
  // Escape at the input: nothing runs or is saved.
  stub.picks.push((o) => o.items.find((i) => i.action === "new"));
  stub.inputs.push("9", undefined);
  assert.strictEqual(await stub.commands.get(RUN_ARGS_COMMAND)(), undefined);
  assert.strictEqual(runs.length, 2);
  assert.strictEqual(setsFor(stored(), "file:///w/main.q").length, 1);
  // Forget it.
  stub.picks.push((o) => o.items.find((i) => i.action === "forget"), (o) => o.items[0]);
  await stub.commands.get(RUN_ARGS_COMMAND)();
  assert.deepStrictEqual(setsFor(stored(), "file:///w/main.q"), []);
  assert.strictEqual(runs.length, 2);
});

test("a set given as the argument (a keybinding's) runs without asking; a URI from a menu does not count", async (t) => {
  const { runs, stored } = setUp(t);
  const set = await stub.commands.get(RUN_ARGS_COMMAND)({ args: "1 2", input: ["show 3", "x:4"] });
  assert.deepStrictEqual(set, { args: "1 2", input: "show 3\nx:4" });
  assert.deepStrictEqual(runs, [{ args: ["1", "2"], input: ["show 3", "x:4"] }]);
  assert.deepStrictEqual(setsFor(stored(), "file:///w/main.q"), [set]);
  assert.deepStrictEqual(runargs.givenSet({ args: "a" }), { args: "a", input: "" });
  assert.strictEqual(runargs.givenSet(vscode.Uri.file("/w/main.q")), undefined);
  stub.picks.push(undefined);
  await stub.commands.get(RUN_ARGS_COMMAND)(vscode.Uri.file("/w/main.q"));
  assert.strictEqual(runs.length, 1);
});

test("an editor that is not a saved file is refused", async (t) => {
  const { runs } = setUp(t);
  vscode.window.activeTextEditor = { document: { uri: { scheme: "untitled", toString: () => "untitled:Untitled-1" } } };
  await stub.commands.get(RUN_ARGS_COMMAND)();
  assert.match(stub.messages.at(-1)[1], /saved on disk/);
  assert.deepStrictEqual(runs, []);
});

test("turned off, the command refuses and runs nothing; on again, without a reload", async (t) => {
  const { runs } = setUp(t);
  stub.config.user["terminal.runWithArguments.enable"] = false;
  stub.changeConfig("q-lint.terminal.runWithArguments.enable");
  assert.strictEqual(await stub.commands.get(RUN_ARGS_COMMAND)(), undefined);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", RUN_ARGS_OFF]);
  assert.deepStrictEqual(runs, []);
  stub.config.user["terminal.runWithArguments.enable"] = true;
  stub.changeConfig("q-lint.terminal.runWithArguments.enable");
  stub.picks.push((o) => o.items.find((i) => i.action === "new"));
  stub.inputs.push("", "");
  await stub.commands.get(RUN_ARGS_COMMAND)();
  assert.deepStrictEqual(runs, [{ args: [], input: [] }]);
});

/// Run Code from Terminal's start, with its terminal recorded.
async function runInFakeTerminal(t, file, extra, qBinary) {
  stub.reset();
  if (qBinary) stub.config.user["terminal.qBinary"] = qBinary;
  const terminals = [];
  const make = vscode.window.createTerminal;
  vscode.window.createTerminal = (options) => {
    const terminal = { options, sent: [], sendText: (text) => void terminal.sent.push(text), show() {}, dispose() {} };
    terminals.push(terminal);
    return terminal;
  };
  const oldEnv = vscode.env;
  vscode.env = { shell: "/bin/sh" };
  vscode.workspace.getWorkspaceFolder = () => undefined;
  vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file(file), isDirty: false } };
  t.after(() => {
    vscode.window.createTerminal = make;
    vscode.env = oldEnv;
    vscode.window.activeTextEditor = undefined;
  });
  const q = new QTerminals(stub.newContext());
  await q.runFile(extra);
  return terminals;
}

test("the file's q terminal is sent the words after the file, then each input line", async (t) => {
  const terminals = await runInFakeTerminal(t, "/w/main.q", { args: ["-p", "5001", "a b"], input: ["show .z.x", "\\\\"] });
  assert.strictEqual(terminals.length, 1);
  assert.deepStrictEqual(terminals[0].sent, ["q main.q -p 5001 'a b'", "show .z.x", "\\\\"]);
  // Run Code from Terminal itself is unchanged.
  const plain = await runInFakeTerminal(t, "/w/main.q", undefined);
  assert.deepStrictEqual(plain[0].sent, ["q main.q"]);
});

test("q reads the words as .z.x and the input lines from its console (real q)", { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-runargs-"));
  const wrapper = path.join(dir, "q.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${Q} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const file = path.join(dir, "main.q");
  fs.writeFileSync(file, "-1 \"args:\",.Q.s1 .z.x;\n");
  const terminals = await runInFakeTerminal(t, file, { args: ["one", "two words", "-name", "x", "-c", "30", "80"], input: ['-1 "input:",string 6*7', "\\\\"] }, wrapper);
  const [line, ...input] = terminals[0].sent;
  const run = spawnSync("/bin/sh", ["-c", line], { cwd: terminals[0].options.cwd, input: `${input.join("\n")}\n`, encoding: "utf8", timeout: 30000 });
  assert.match(run.stdout, /args:\("one";"two words";"-name";,"x"\)/, run.stdout + run.stderr);
  assert.match(run.stdout, /input:42/, run.stdout + run.stderr);
});
