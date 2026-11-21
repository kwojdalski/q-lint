// Formatting only the changed lines on save (#989): which lines changed
// against git HEAD, in a real repository made for the test - none outside
// git, every line of a file git does not track - and, through the stand-in
// `vscode`, the save hook: off, nothing listens and the server is never
// asked; on, the changed lines go to `q-lint/formatChangedLines` and its
// edits come back as the save's.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { changedLines, committedText } = require("../out/changedlines.js");
const { registerFormatChanged, changedLineEdits, FORMAT_CHANGED, FORMAT_CHANGED_NOW } = require("../out/formatchangedview.js");
const pkg = require("../package.json");

test("the changed lines are those of the new text not in the old", () => {
  assert.deepStrictEqual(changedLines("a\nb\nc\n", "a\nb\nc\n"), []);
  assert.deepStrictEqual(changedLines("a\nb\nc\n", "a\nB\nc\n"), [[1, 1]]);
  // Added lines, two places.
  assert.deepStrictEqual(changedLines("a\nb\nc\nd\n", "x\na\nb\ny\nz\nc\nd\n"), [[0, 0], [3, 4]]);
  // Deleted only: the line that took their place.
  assert.deepStrictEqual(changedLines("a\nb\nc\nd\n", "a\nd\n"), [[1, 1]]);
  // Moved, by the longest common subsequence: where it went, and the line
  // that took its old place.
  assert.deepStrictEqual(changedLines("a\nb\nc\n", "b\nc\na\n"), [[0, 0], [2, 2]]);
  // A line replaced is that line alone.
  assert.deepStrictEqual(changedLines("a\nb\nc\n", "a\nB\nc"), [[1, 2]]);
  assert.deepStrictEqual(changedLines("a\nb\nc\nd\n", "a\nB\nC\nd\n"), [[1, 2]]);
  // Everything new.
  assert.deepStrictEqual(changedLines("", "a\nb"), [[0, 1]]);
  // Line endings are not a change.
  assert.deepStrictEqual(changedLines("a\r\nb\r\n", "a\nb\n"), []);
  // Past the budget, the middle is changed whole.
  assert.deepStrictEqual(changedLines("a\nb\nc\nd\n", "a\nc\nb\nd\n", 1), [[1, 2]]);
});

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qlint-changed-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return { dir, git };
}

test("the committed text comes from git HEAD; untracked is empty; outside git, none", async (t) => {
  const { dir, git } = repo(t);
  const file = path.join(dir, "sub", "a.q");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, "a:1\n");
  // No commit yet: every line is new.
  assert.strictEqual(await committedText(file), "");
  git("add", ".");
  git("commit", "-qm", "one");
  fs.writeFileSync(file, "a:1\nb:2\n");
  assert.strictEqual(await committedText(file), "a:1\n");
  const loose = path.join(dir, "new.q");
  fs.writeFileSync(loose, "x\n");
  assert.strictEqual(await committedText(loose), "");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-nogit-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "c.q"), "c\n");
  assert.strictEqual(await committedText(path.join(outside, "c.q")), undefined);
});

function document(file, text) {
  return { languageId: "q", uri: { scheme: "file", fsPath: file, toString: () => `file://${file}` }, getText: () => text };
}

function fakeVscode() {
  const listeners = [];
  vscode.workspace.onWillSaveTextDocument = (l) => (listeners.push(l), { dispose: () => listeners.splice(listeners.indexOf(l), 1) });
  vscode.Range = class {
    constructor(a, b, c, d) {
      Object.assign(this, { start: { line: a, character: b }, end: { line: c, character: d } });
    }
  };
  vscode.TextEdit = class {
    constructor(range, newText) {
      Object.assign(this, { range, newText });
    }
  };
  return listeners;
}

test("the switch is declared off, and the command only where it can run", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.formatChangedLines.enable"].default, false);
  // It reaches the server, so it is in the server's section.
  assert.ok("q-lint.formatChangedLines.enable" in pkg.contributes.configuration[0].properties);
  const palette = pkg.contributes.menus.commandPalette.find((m) => m.command === FORMAT_CHANGED_NOW);
  assert.match(palette.when, /config\.q-lint\.formatChangedLines\.enable/);
});

test("off, nothing listens and the server is never asked; on, a save carries the edits for the changed lines", async (t) => {
  stub.reset();
  const listeners = fakeVscode();
  const { dir, git } = repo(t);
  const file = path.join(dir, "a.q");
  fs.writeFileSync(file, "a:1==1\nb:2==2\nc:3==3\n");
  git("add", ".");
  git("commit", "-qm", "one");
  const asked = [];
  const server = {
    sendRequest: async (method, params) => (asked.push([method, params]), [{ range: { start: { line: 1, character: 3 }, end: { line: 1, character: 5 } }, newText: "=" }]),
  };
  const context = stub.newContext();
  const hook = registerFormatChanged(context, () => server);
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  assert.strictEqual(hook.registered(), false);
  assert.strictEqual(listeners.length, 0);
  assert.deepStrictEqual(await stub.commands.get(FORMAT_CHANGED_NOW)(), []);
  assert.match(stub.messages.at(-1)[1], /Formatting the changed lines on save is turned off\. Set q-lint\.formatChangedLines\.enable to true/);
  assert.deepStrictEqual(asked, []);

  stub.config.user["formatChangedLines.enable"] = true;
  stub.changeConfig("q-lint.formatChangedLines.enable");
  assert.strictEqual(hook.registered(), true);
  assert.strictEqual(listeners.length, 1);
  const edited = document(file, "a:1==1\nb:2==2 \nc:3==3\n");
  let waited;
  listeners[0]({ document: edited, waitUntil: (p) => (waited = p) });
  const edits = await waited;
  assert.deepStrictEqual(asked, [[FORMAT_CHANGED, { textDocument: { uri: `file://${file}` }, lines: [[1, 1]] }]]);
  assert.deepStrictEqual(edits.map((e) => [e.range.start.line, e.newText]), [[1, "="]]);
  // Nothing changed: the server is not asked.
  assert.deepStrictEqual(await changedLineEdits(document(file, "a:1==1\nb:2==2\nc:3==3\n"), server), []);
  assert.strictEqual(asked.length, 1);
  // Outside git, nothing either.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-nogit-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.deepStrictEqual(await changedLineEdits(document(path.join(outside, "x.q"), "x:1==1\n"), server), []);
  assert.strictEqual(asked.length, 1);

  // Off again: the listener goes.
  stub.config.user["formatChangedLines.enable"] = false;
  stub.changeConfig("q-lint.formatChangedLines.enable");
  assert.strictEqual(listeners.length, 0);
  assert.strictEqual(hook.registered(), false);
});
