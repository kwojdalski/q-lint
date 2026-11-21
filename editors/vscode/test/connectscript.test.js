// A process's connect script (#916): how it is kept on a process, read from
// a file but never from a discovery server, where its file is read from, and
// the commands that set it, through the stand-in `vscode` module.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const { parseProcesses, processTooltip, readProcessFile } = require("../out/processes.js");
const { CONNECT_SCRIPT_COMMANDS, scriptOf, scriptPath, scriptsBrought, scriptSummary, withScript } = require("../out/connectscript.js");
const { Live } = require("../out/live.js");

const proc = (label, extra = {}) => ({ label, host: "h", port: 1, tags: [], ...extra });

test("a process runs init code or an init file, and code wins over a file", () => {
  assert.deepStrictEqual(scriptOf(proc("a", { init: "x:1" })), { kind: "code", code: "x:1" });
  assert.deepStrictEqual(scriptOf(proc("a", { initFile: "init.q" })), { kind: "file", file: "init.q" });
  assert.deepStrictEqual(scriptOf(proc("a", { init: "x:1", initFile: "init.q" })), { kind: "code", code: "x:1" });
  assert.strictEqual(scriptOf(proc("a", { init: "  " })), undefined);
  assert.strictEqual(scriptOf(proc("a")), undefined);
  assert.deepStrictEqual(withScript(proc("a", { initFile: "f.q" }), { kind: "code", code: "y" }), proc("a", { init: "y" }));
  assert.deepStrictEqual(withScript(proc("a", { init: "y" }), { kind: "file", file: "f.q" }), proc("a", { initFile: "f.q" }));
  assert.deepStrictEqual(withScript(proc("a", { init: "y" }), undefined), proc("a"));
});

test("a process file's scripts are read; a discovery server's never", () => {
  const json = [{ label: "a", host: "h", port: 1, init: "x:1" }, { label: "b", host: "h", port: 2, initFile: " i.q " }, { label: "c", host: "h", port: 3, init: "y", initFile: "i.q" }, { label: "d", host: "h", port: 4, init: 5 }];
  const read = readProcessFile(JSON.stringify(json));
  assert.deepStrictEqual(read.processes.map(scriptOf), [{ kind: "code", code: "x:1" }, { kind: "file", file: "i.q" }, { kind: "code", code: "y" }, undefined]);
  assert.deepStrictEqual(read.problems, ["Entry 3 (c) has both init and initFile: its init code was kept."]);
  assert.deepStrictEqual(read.processes[2].initFile, undefined);
  // parseProcesses is what discovery reads a server's list with.
  assert.ok(parseProcesses(json).processes.every((p) => scriptOf(p) === undefined));
  assert.deepStrictEqual(parseProcesses(json).problems, []);
});

test("the tooltip says a process runs a script on connect", () => {
  assert.match(processTooltip(proc("a", { init: "x:1" })), /runs q code on connect/);
  assert.match(processTooltip(proc("a", { initFile: "my_init.q" })), /runs my\\_init\\.q on connect/);
  assert.doesNotMatch(processTooltip(proc("a")), /on connect/);
});

test("a script file is read from the home directory or the workspace folder", () => {
  assert.strictEqual(scriptPath("/abs/i.q", "/home/u", "/ws"), "/abs/i.q");
  assert.strictEqual(scriptPath("~/i.q", "/home/u", "/ws"), "/home/u/i.q");
  assert.strictEqual(scriptPath("q/i.q", "/home/u", "/ws"), "/ws/q/i.q");
  assert.strictEqual(scriptPath("q/i.q", "/home/u", undefined), undefined);
});

test("an import brings scripts that are new or changed, not ones already kept", () => {
  const before = [proc("a", { init: "x:1" }), proc("b")];
  assert.deepStrictEqual(scriptsBrought(before, [proc("a", { init: "x:1" }), proc("b", { init: "y" }), proc("c", { initFile: "f.q" }), proc("d")]), ["b", "c"]);
  assert.deepStrictEqual(scriptsBrought(before, [proc("a", { init: "x:2" })]), ["a"]);
});

test("a script is summed up in a line", () => {
  assert.strictEqual(scriptSummary(undefined), "none");
  assert.strictEqual(scriptSummary({ kind: "file", file: "i.q" }), "file i.q");
  assert.strictEqual(scriptSummary({ kind: "code", code: "\na:1\nb:2\n" }), "code: a:1 (+1 lines)");
  assert.match(scriptSummary({ kind: "code", code: "x".repeat(100) }), /^code: x{59}…$/);
});

test("Set Connect Script is on a saved process's row only", () => {
  const rows = pkg.contributes.menus["view/item/context"].filter((m) => m.command === CONNECT_SCRIPT_COMMANDS.set);
  assert.deepStrictEqual(rows.map((m) => m.when), ["view == q-lint.processes && viewItem =~ /^process/"]);
});

async function setUp(t, processes) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, run: (...args) => stub.commands.get(CONNECT_SCRIPT_COMMANDS.set)(...args) };
}

test("Set Connect Script asks for code, a file or none, and keeps it on the process", async (t) => {
  const { live, run } = await setUp(t, [proc("a"), proc("b", { tags: ["prod"] })]);
  let offered;
  stub.picks.push(({ items }) => ((offered = items.map((i) => [i.label, i.description])), items[0]));
  stub.inputs.push("\\d .x\nv:1");
  await run("a");
  assert.deepStrictEqual(offered, [["q Code", undefined], ["q File", undefined], ["None", "current: none"]]);
  assert.deepStrictEqual(scriptOf(live.processes()[0]), { kind: "code", code: "\\d .x\nv:1" });
  // The box starts from it; Escape changes nothing.
  let value;
  stub.picks.push("q Code");
  stub.inputs.push((o) => ((value = o.value), undefined));
  await run("a");
  assert.strictEqual(value, "\\d .x\nv:1");
  assert.ok(scriptOf(live.processes()[0]));
  stub.picks.push("None");
  await run("a");
  assert.strictEqual(scriptOf(live.processes()[0]), undefined);
  // On a production process it is asked first, and No sets nothing.
  stub.picks.push(({ message }) => (assert.match(message, /production process/), undefined));
  await run("b", { kind: "code", code: "x:1" });
  assert.strictEqual(scriptOf(live.processes()[1]), undefined);
  stub.picks.push("Set Script");
  await run("b", { kind: "file", file: "init.q" });
  assert.deepStrictEqual(scriptOf(live.processes()[1]), { kind: "file", file: "init.q" });
  await run("b", null);
  assert.strictEqual(scriptOf(live.processes()[1]), undefined);
});

test("Edit Process keeps the connect script; Import asks before taking one", async (t) => {
  const { live } = await setUp(t, [proc("a", { init: "x:1" })]);
  // Edit: label, host, port, TLS, user, tags.
  stub.inputs.push("a2", "h", "1");
  stub.picks.push("No");
  stub.inputs.push("", "");
  await stub.commands.get("q-lint.editProcess")("a");
  assert.deepStrictEqual(live.processes().map((p) => [p.label, scriptOf(p)]), [["a2", { kind: "code", code: "x:1" }]]);
  const vscode = require("vscode");
  const fs = vscode.workspace.fs;
  const list = JSON.stringify({ processes: [{ label: "a2", host: "h", port: 1, init: "evil:1" }, { label: "n", host: "h", port: 2, initFile: "i.q" }] });
  vscode.workspace.fs = { readFile: async () => Buffer.from(list) };
  t.after(() => (vscode.workspace.fs = fs));
  // Without scripts: a2 keeps its own, n gets none.
  let asked;
  stub.picks.push(({ message }) => ((asked = message), "Import without Scripts"));
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.match(asked, /gives 2 process\(es\) a connect script.*: a2, n\. Keep the scripts\?/);
  assert.deepStrictEqual(live.processes().map((p) => [p.label, scriptOf(p)]), [["a2", { kind: "code", code: "x:1" }], ["n", undefined]]);
  // Escape imports nothing; with scripts takes them.
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.strictEqual(scriptOf(live.processes()[0]).code, "x:1");
  stub.picks.push("Import with Scripts");
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.deepStrictEqual(live.processes().map((p) => scriptOf(p)), [{ kind: "code", code: "evil:1" }, { kind: "file", file: "i.q" }]);
});
