// The log viewer (#1004): reading a file a piece at a time while it is
// appended to, truncated and large; and the viewer through the stand-in
// `vscode` module - open, filter, follow, off. With QLINT_TEST_Q, a real q
// process writes the log the view follows.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const { readFrom, START } = require("../out/logreader.js");
const { LOG_COMMANDS, LOG_VIEWER_OFF } = require("../out/logparse.js");
const { LogViewer } = require("../out/logview.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qlint-log-"));

test("a file is read from where the last read stopped, a line still being written kept for the next", async () => {
  const file = path.join(tmp(), "a.log");
  fs.writeFileSync(file, "one\r\ntwo\nthr");
  const got = [];
  let at = await readFrom(file, START, (l) => got.push(l));
  assert.deepStrictEqual(got, ["one", "two"]);
  assert.deepStrictEqual([at.offset, at.partial, at.restarted], [12, "thr", false]);
  assert.strictEqual(typeof at.ino, "number");
  fs.appendFileSync(file, "ee\nfour\n");
  at = await readFrom(file, at, (l) => got.push(l));
  assert.deepStrictEqual(got, ["one", "two", "three", "four"]);
  // Nothing new: nothing read.
  const same = await readFrom(file, at, (l) => got.push(l));
  assert.deepStrictEqual(same.offset, at.offset);
  // Truncated (rotated): read again from the start.
  fs.writeFileSync(file, "new\n");
  at = await readFrom(file, at, (l) => got.push(l));
  assert.strictEqual(at.restarted, true);
  assert.deepStrictEqual(got.slice(-1), ["new"]);
});

test("a log rotated to a new file already longer than the old read position is read from its start (#1688)", async () => {
  const file = path.join(tmp(), "a.log");
  fs.writeFileSync(file, "old line 1\nold line 2\n");
  let at = await readFrom(file, START, () => {});
  fs.renameSync(file, `${file}.1`);
  fs.writeFileSync(file, "NEW entry A\nNEW entry B\nNEW entry C\n");
  const got = [];
  at = await readFrom(file, at, (l) => got.push(l));
  assert.strictEqual(at.restarted, true);
  assert.deepStrictEqual(got, ["NEW entry A", "NEW entry B", "NEW entry C"]);
});

test("the offset counts the file's bytes, a byte that is not UTF-8 and a character cut in two included (#1079)", async () => {
  const file = path.join(tmp(), "latin1.log");
  fs.writeFileSync(file, Buffer.from("caf\xE9 ok\nline2\n", "latin1"));
  const got = [];
  let at = await readFrom(file, START, (l) => got.push(l));
  assert.strictEqual(at.offset, 14);
  fs.appendFileSync(file, "line3\n");
  at = await readFrom(file, at, (l) => got.push(l));
  assert.deepStrictEqual(got.slice(1), ["line2", "line3"]);
  assert.strictEqual(at.restarted, false);
  // A two-byte character whose second byte is not written yet.
  fs.appendFileSync(file, Buffer.from([0x62, 0xc3]));
  at = await readFrom(file, at, (l) => got.push(l));
  assert.deepStrictEqual([at.offset, at.partial], [21, "b"]);
  fs.appendFileSync(file, Buffer.from([0xa9, 0x0a]));
  at = await readFrom(file, at, (l) => got.push(l));
  assert.deepStrictEqual(got.slice(-1), ["b\u00e9"]);
  assert.strictEqual(at.offset, 24);
});

test("a large file is streamed: every line read, in pieces, and the heap does not hold it", async () => {
  const file = path.join(tmp(), "big.log");
  const line = `2026.11.07D00:00:00.000000000|h|rdb|rdb1|INFO|x|${"m".repeat(150)}\n`;
  const fd = fs.openSync(file, "w");
  const block = line.repeat(10000);
  for (let i = 0; i < 40; i++) fs.writeSync(fd, block); // ~73 MB, 400,000 lines
  fs.closeSync(fd);
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  let n = 0;
  let peak = 0;
  await readFrom(file, START, () => {
    if (++n % 50000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - before);
  });
  assert.strictEqual(n, 400000);
  assert.ok(peak < 60 * 1024 * 1024, `heap grew ${peak} bytes`);
  fs.rmSync(file);
});

test("the commands are contributed and hidden while off", () => {
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process connections");
  assert.strictEqual(section.properties["q-lint.processes.logViewer.enable"].default, true);
  for (const command of Object.values(LOG_COMMANDS)) {
    assert.ok(pkg.contributes.commands.some((c) => c.command === command && c.category === "q-lint"), command);
    const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === command);
    assert.ok(menus.length >= 2, command);
    for (const m of menus) assert.match(m.when, /config\.q-lint\.processes\.logViewer\.enable/, command);
  }
});

/// The viewer over the stand-in: documents opened from it are kept, the
/// last shown is the active editor, and the content provider is captured.
function setUp(t) {
  stub.reset();
  const providers = new Map();
  const saved = {
    parse: vscode.Uri.parse,
    register: vscode.workspace.registerTextDocumentContentProvider,
    open: vscode.workspace.openTextDocument,
    show: vscode.window.showTextDocument,
  };
  vscode.Uri.parse = (s) => ({ scheme: s.slice(0, s.indexOf(":")), query: s.split("?")[1] ?? "", path: s, toString: () => s });
  vscode.workspace.registerTextDocumentContentProvider = (scheme, provider) => {
    providers.set(scheme, provider);
    return { dispose: () => providers.delete(scheme) };
  };
  vscode.workspace.openTextDocument = async (uri) => ({ uri, lineCount: 1 });
  vscode.window.showTextDocument = async (document) => {
    vscode.window.activeTextEditor = { document, setDecorations() {}, revealRange() {} };
    return vscode.window.activeTextEditor;
  };
  const context = stub.newContext();
  const viewer = new LogViewer(context);
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
    vscode.Uri.parse = saved.parse;
    vscode.workspace.registerTextDocumentContentProvider = saved.register;
    vscode.workspace.openTextDocument = saved.open;
    vscode.window.showTextDocument = saved.show;
    vscode.window.activeTextEditor = undefined;
  });
  const text = () => providers.get("q-log")?.provideTextDocumentContent(vscode.window.activeTextEditor.document.uri);
  return { viewer, providers, text };
}

const torq = (time, proc, level, msg) => `2026.11.07D${time}.000000000|h|rdb|${proc}|${level}|id|${msg}`;

test("a log opens in a view, and filters by level, process, time and text read it again", async (t) => {
  const dir = tmp();
  const a = path.join(dir, "out_rdb1.log");
  const b = path.join(dir, "out_hdb1.log");
  fs.writeFileSync(a, [torq("10:00:00", "rdb1", "INFO", "started"), torq("10:05:00", "rdb1", "ERROR", "boom"), "  [1] backtrace", ""].join("\n"));
  fs.writeFileSync(b, ["plain q line", "'type", "  [2] f:{x+`a}", ""].join("\n"));
  const { viewer, text } = setUp(t);
  const state = await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(a), [vscode.Uri.file(a), vscode.Uri.file(b)]);
  assert.deepStrictEqual(state.processes, ["hdb1", "rdb1"]);
  assert.deepStrictEqual(state.levels, ["ERROR", "INFO"]);
  // Merged by time (a line with none before any that has one), each file's
  // last entry - still open, since a line could continue it - too (#1778);
  // a line of the plain file names its process.
  assert.strictEqual(
    text(),
    ["[hdb1] plain q line", "[hdb1] 'type", "[hdb1]   [2] f:{x+`a}", torq("10:00:00", "rdb1", "INFO", "started"), torq("10:05:00", "rdb1", "ERROR", "boom"), "  [1] backtrace"].join("\n"),
  );
  stub.picks.push((o) => o.items.filter((i) => i.label === "ERROR"));
  await stub.commands.get(LOG_COMMANDS.levels)();
  assert.strictEqual(text(), ["[hdb1] 'type", "[hdb1]   [2] f:{x+`a}", torq("10:05:00", "rdb1", "ERROR", "boom"), "  [1] backtrace"].join("\n"));
  stub.picks.push((o) => o.items.filter((i) => i.label === "rdb1"));
  await stub.commands.get(LOG_COMMANDS.processes)();
  assert.strictEqual(text(), [torq("10:05:00", "rdb1", "ERROR", "boom"), "  [1] backtrace"].join("\n"));
  await stub.commands.get(LOG_COMMANDS.clear)();
  stub.inputs.push("10:01", "");
  await stub.commands.get(LOG_COMMANDS.time)();
  assert.strictEqual(viewer.state().filter.from, "10:01");
  assert.strictEqual(text(), [torq("10:05:00", "rdb1", "ERROR", "boom"), "  [1] backtrace"].join("\n"));
  await stub.commands.get(LOG_COMMANDS.clear)();
  stub.inputs.push("PLAIN");
  await stub.commands.get(LOG_COMMANDS.text)();
  assert.strictEqual(text(), "[hdb1] plain q line");
  // Each takes its value as an argument, as a keybinding gives it; a menu's
  // URI is not one.
  await stub.commands.get(LOG_COMMANDS.clear)();
  await stub.commands.get(LOG_COMMANDS.levels)(["error"]);
  await stub.commands.get(LOG_COMMANDS.processes)(["rdb1"]);
  await stub.commands.get(LOG_COMMANDS.time)({ from: "10:01", to: "nonsense" });
  assert.deepStrictEqual(viewer.state().filter, { levels: ["ERROR"], processes: ["rdb1"], from: "10:01", to: undefined });
  assert.strictEqual(text(), [torq("10:05:00", "rdb1", "ERROR", "boom"), "  [1] backtrace"].join("\n"));
  stub.inputs.push(undefined);
  await stub.commands.get(LOG_COMMANDS.time)(vscode.Uri.file(a));
  assert.strictEqual(viewer.state().filter.from, "10:01");
  await stub.commands.get(LOG_COMMANDS.text)("nothing like it");
  assert.strictEqual(text(), "(nothing passes the filter)");
});

// Two views side by side: a title-bar button in the one not focused
// filtered or paused the focused one (#1524).
test("a title-bar button filters and pauses the view it was clicked in, not the active one", async (t) => {
  const dir = tmp();
  const a = path.join(dir, "server.log");
  const b = path.join(dir, "gateway.log");
  fs.writeFileSync(a, [torq("10:00:00", "rdb1", "INFO", "a"), torq("10:01:00", "rdb1", "ERROR", "b"), ""].join("\n"));
  fs.writeFileSync(b, [torq("10:00:00", "gw1", "INFO", "c"), ""].join("\n"));
  const { viewer } = setUp(t);
  await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(a));
  const left = vscode.window.activeTextEditor.document.uri;
  await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(b));
  const views = [...viewer.views.values()];
  stub.picks.push((o) => o.items.filter((i) => i.label === "ERROR"));
  await stub.commands.get(LOG_COMMANDS.levels)(left);
  assert.deepStrictEqual(views.map((v) => v.filter.levels), [["ERROR"], []]);
  await stub.commands.get(LOG_COMMANDS.follow)(left);
  assert.deepStrictEqual(views.map((v) => v.follow), [false, true]);
  await stub.commands.get(LOG_COMMANDS.clear)(left);
  assert.deepStrictEqual(views.map((v) => v.filter.levels), [[], []]);
  await stub.commands.get(LOG_COMMANDS.follow)(left);
  // Without a Uri - a keybinding - the active view, as before.
  await stub.commands.get(LOG_COMMANDS.follow)();
  assert.deepStrictEqual(views.map((v) => v.follow), [true, false]);
});

test("a followed view shows appended lines once they end, the last entry before the next starts; paused, it reads nothing until resumed", async (t) => {
  const file = path.join(tmp(), "q.log");
  fs.writeFileSync(file, "first\n");
  const { viewer, text } = setUp(t);
  await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(file));
  assert.strictEqual(text(), "first");
  fs.appendFileSync(file, "'boom\n  [0] trace\nhalf");
  for (let i = 0; i < 60 && !text().includes("trace"); i++) await sleep(50);
  assert.strictEqual(text(), "first\n'boom\n  [0] trace");
  await stub.commands.get(LOG_COMMANDS.follow)();
  assert.strictEqual(viewer.state().follow, false);
  fs.appendFileSync(file, " done\nlater\n");
  await sleep(1200);
  assert.strictEqual(text(), "first\n'boom\n  [0] trace");
  await stub.commands.get(LOG_COMMANDS.follow)();
  assert.strictEqual(text(), "first\n'boom\n  [0] trace\nhalf done\nlater");
});

// Each file's open entry was shown after the rest, and followed entries
// were added file by file, never merged (#1778).
test("several files followed stay in time order, each file's open entry and appended lines merged in", async (t) => {
  const dir = tmp();
  const a = path.join(dir, "out_a.log");
  const b = path.join(dir, "out_b.log");
  const line = (time, proc) => torq(time, proc, "INFO", proc + time.slice(-1));
  fs.writeFileSync(a, [line("12:00:00", "a"), line("12:00:04", "a"), ""].join("\n"));
  fs.writeFileSync(b, [line("12:00:01", "b"), line("12:00:03", "b"), ""].join("\n"));
  const { text } = setUp(t);
  await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(a), [vscode.Uri.file(a), vscode.Uri.file(b)]);
  const order = () => text().split("\n").map((l) => l.split("|").pop());
  assert.deepStrictEqual(order(), ["a0", "b1", "b3", "a4"]);
  fs.appendFileSync(a, [line("12:00:06", "a"), line("12:00:08", "a"), ""].join("\n"));
  fs.appendFileSync(b, [line("12:00:05", "b"), line("12:00:07", "b"), ""].join("\n"));
  for (let i = 0; i < 60 && !text().includes("b7"); i++) await sleep(50);
  assert.deepStrictEqual(order(), ["a0", "b1", "b3", "a4", "b5", "a6", "b7", "a8"]);
});

test("only the last maxLines entries that pass are kept", async (t) => {
  const file = path.join(tmp(), "many.log");
  fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n");
  stub.reset();
  const { text } = setUp(t);
  stub.config.user["processes.logViewer.maxLines"] = 100;
  const state = await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(file));
  // The last line is still open - another could continue it - and shown.
  assert.strictEqual(state.entries, 100);
  const lines = text().split("\n");
  assert.strictEqual(lines.length, 101);
  assert.deepStrictEqual([lines[0], lines.at(-1)], ["line 899", "line 999"]);
});

test("a followed view shows no more than maxLines entries as lines are appended (#1431)", async (t) => {
  const file = path.join(tmp(), "grow.log");
  fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n");
  stub.reset();
  const { viewer, text } = setUp(t);
  stub.config.user["processes.logViewer.maxLines"] = 100;
  await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(file));
  fs.appendFileSync(file, Array.from({ length: 5 }, (_, i) => `more ${i}`).join("\n") + "\n");
  for (let i = 0; i < 60 && !text().includes("more 4"); i++) await sleep(50);
  const lines = text().split("\n");
  // The last 100 entries, and the one still open.
  assert.deepStrictEqual([lines.length, lines[0], lines.at(-1)], [101, "line 4", "more 4"]);
  assert.strictEqual(viewer.state().entries, 100);
});

test("a changed maxLines takes effect on an open view (#1432)", async (t) => {
  const file = path.join(tmp(), "many.log");
  fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n");
  stub.reset();
  const { viewer, text } = setUp(t);
  stub.config.user["processes.logViewer.maxLines"] = 100;
  await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(file));
  stub.config.user["processes.logViewer.maxLines"] = 200;
  stub.changeConfig("q-lint.processes.logViewer.maxLines");
  for (let i = 0; i < 60 && viewer.state().entries !== 200; i++) await sleep(50);
  assert.strictEqual(viewer.state().entries, 200);
  assert.strictEqual(text().split("\n")[0], "line 799");
});

test("turned off, the commands refuse, the provider goes and following stops; on again without a reload", async (t) => {
  const file = path.join(tmp(), "q.log");
  fs.writeFileSync(file, "a\n");
  const { viewer, providers } = setUp(t);
  await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(file));
  assert.ok(providers.has("q-log"));
  stub.config.user["processes.logViewer.enable"] = false;
  stub.changeConfig("q-lint.processes.logViewer.enable");
  assert.ok(!providers.has("q-log"));
  assert.strictEqual(viewer.state(), undefined);
  for (const command of Object.values(LOG_COMMANDS)) {
    stub.messages = [];
    assert.strictEqual(await stub.commands.get(command)(vscode.Uri.file(file)), undefined, command);
    assert.deepStrictEqual(stub.messages, [["info", LOG_VIEWER_OFF]], command);
  }
  stub.config.user["processes.logViewer.enable"] = true;
  stub.changeConfig("q-lint.processes.logViewer.enable");
  assert.ok(providers.has("q-log"));
  assert.ok(await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(file)));
});

test("turned off while a log is still opening, no file is left watched (#1295)", async (t) => {
  const file = path.join(tmp(), "q.log");
  fs.writeFileSync(file, "a\n");
  const { viewer } = setUp(t);
  const watched = new Set();
  const [watchFile, unwatchFile] = [fs.watchFile, fs.unwatchFile];
  fs.watchFile = (f, o, l) => (watched.add(l), watchFile(f, o, l));
  fs.unwatchFile = (f, l) => (watched.delete(l), unwatchFile(f, l));
  t.after(() => ([fs.watchFile, fs.unwatchFile] = [watchFile, unwatchFile]));
  vscode.workspace.openTextDocument = async (uri) => {
    stub.config.user["processes.logViewer.enable"] = false;
    stub.changeConfig("q-lint.processes.logViewer.enable");
    return { uri, lineCount: 1 };
  };
  assert.strictEqual(await viewer.open(vscode.Uri.file(file)), undefined);
  assert.strictEqual(watched.size, 0);
});

test("a view follows the log a real q process writes (real q)", { skip }, async (t) => {
  const dir = tmp();
  const log = path.join(dir, "out_ticker1.log");
  const script = path.join(dir, "ticker.q");
  fs.writeFileSync(script, 'n:0\n.z.ts:{n+:1; -1 string[.z.p]," INFO tick ",string n; if[n=3; -2 string[.z.p]," WARN slow"]; if[n=4; @[{x+`a};1;{-2 "\'",x}]]}\n\\t 100\n');
  const out = fs.openSync(log, "w");
  const child = spawn(`${Q} ${script}`, { shell: true, stdio: ["pipe", out, out], detached: true });
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  });
  const { text } = setUp(t);
  for (let i = 0; i < 100 && !fs.readFileSync(log, "utf8").includes("tick 1"); i++) await sleep(50);
  await stub.commands.get(LOG_COMMANDS.open)(vscode.Uri.file(log));
  for (let i = 0; i < 100 && !text().includes("tick 6"); i++) await sleep(100);
  assert.match(text(), /INFO tick 6/);
  // The levels q's lines carry, and its error, read as they come.
  stub.picks.push((o) => o.items.filter((i) => i.label !== "INFO"));
  await stub.commands.get(LOG_COMMANDS.levels)();
  assert.match(text(), /^\d{4}\.\d\d\.\d\dD[\d:.]+ WARN slow\n'type$/);
});
