// Scratch buffers per process (#1051): each process's file name, and -
// through the stand-in `vscode` - the command's life: off, it refuses and
// writes nothing; on, it creates the process's file in the extension's
// storage once, opens it, binds it to the process, and never overwrites
// what the user wrote; nothing is sent to the process.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setUp } = require("./fakeq.js");
const { registerScratchBuffers, scratchFileName, scratchHeader } = require("../out/scratch.js");
const { PROCESS_TOOL_COMMANDS } = require("../out/processtools.js");
const { CONTROL_COMMANDS } = require("../out/querycontrols.js");
const pkg = require("../package.json");

test("each process has a file name of its own, safe on any file system", () => {
  assert.match(scratchFileName("rdb"), /^rdb-[0-9a-f]{8}\.q$/);
  assert.match(scratchFileName("eu/rdb 1:5010"), /^eu_rdb_1_5010-[0-9a-f]{8}\.q$/);
  assert.notStrictEqual(scratchFileName("a/b"), scratchFileName("a:b"));
  assert.match(scratchFileName("../.."), /^process-[0-9a-f]{8}\.q$/);
  assert.match(scratchHeader("rdb"), /^\/ Scratch buffer for rdb/);
});

test("the switch is declared on, and the command only where it is", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.processes.scratchBuffer.enable"].default, true);
  const entries = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === PROCESS_TOOL_COMMANDS.openScratch);
  assert.ok(entries.length === 2 && entries.every((m) => /config\.q-lint\.processes\.scratchBuffer\.enable/.test(m.when)));
  assert.match(entries.find((m) => m.when.includes("view == q-lint.processes")).when, /viewItem =~/);
});

test("off, nothing is written; on, the process's file is made once, opened and bound", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-scratch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { q, context } = await setUp(t, { config: { "processes.scratchBuffer.enable": false }, register: registerScratchBuffers });
  context.globalStorageUri = vscode.Uri.file(dir);
  const bound = [];
  stub.commands.set(CONTROL_COMMANDS.chooseFileConnection, (label) => void bound.push(label));
  const opened = [];
  vscode.workspace.openTextDocument = async (uri) => (opened.push(uri.fsPath), {});
  vscode.window.showTextDocument = async () => ({});

  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.openScratch)("rdb"), /Scratch buffers is turned off\. Set q-lint\.processes\.scratchBuffer\.enable to true/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);

  stub.config.user["processes.scratchBuffer.enable"] = true;
  stub.changeConfig("q-lint.processes.scratchBuffer.enable");
  const first = await stub.commands.get(PROCESS_TOOL_COMMANDS.openScratch)("rdb");
  assert.strictEqual(first.path, path.join(dir, "scratch", scratchFileName("rdb")));
  assert.strictEqual(fs.readFileSync(first.path, "utf8"), scratchHeader("rdb"));
  assert.deepStrictEqual(opened, [first.path]);
  assert.deepStrictEqual(bound, ["rdb"]);
  // What the user wrote is kept: it is opened again, not written over.
  fs.writeFileSync(first.path, "select from trade\n");
  await stub.commands.get(PROCESS_TOOL_COMMANDS.openScratch)("rdb");
  assert.strictEqual(fs.readFileSync(first.path, "utf8"), "select from trade\n");
  assert.strictEqual(q.sent.length, 0);
});

// The buffer is kept by label: a renamed process opened an empty one, and
// the next process given the old label got the old one's queries (#2405).
test("a renamed process keeps its buffer, and a deleted one's is put aside, not given to the next of its label (#2405)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-scratch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { context, live } = await setUp(t, { register: registerScratchBuffers });
  context.globalStorageUri = vscode.Uri.file(dir);
  stub.commands.set(CONTROL_COMMANDS.chooseFileConnection, () => {});
  vscode.workspace.openTextDocument = async () => ({});
  vscode.window.showTextDocument = async () => ({});
  const open = (label) => stub.commands.get(PROCESS_TOOL_COMMANDS.openScratch)(label);
  const first = await open("rdb");
  fs.appendFileSync(first.path, "select from trade\n");
  const port = String(live.processes()[0].port);
  stub.inputs = ["rdb-eu", "127.0.0.1", port, "", "", ""];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.editProcess")("rdb");
  assert.deepStrictEqual(live.processes().map((p) => p.label), ["rdb-eu"]);
  const renamed = await open("rdb-eu");
  assert.strictEqual(fs.readFileSync(renamed.path, "utf8"), scratchHeader("rdb-eu") + "select from trade\n");
  assert.strictEqual(fs.existsSync(first.path), false);
  stub.picks = ["Delete"];
  await stub.commands.get("q-lint.deleteProcess")("rdb-eu");
  assert.strictEqual(fs.existsSync(renamed.path), false);
  assert.strictEqual(fs.readdirSync(path.join(dir, "scratch", "deleted")).length, 1);
  // Another process given the label starts empty.
  stub.inputs = ["rdb-eu", "127.0.0.1", port, "", ""];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.addProcess")();
  assert.strictEqual(fs.readFileSync((await open("rdb-eu")).path, "utf8"), scratchHeader("rdb-eu"));
});
