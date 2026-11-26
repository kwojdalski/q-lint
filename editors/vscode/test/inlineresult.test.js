// Inline results after Run Line (#1047): the short form of an answer, which
// lines an edit wipes - and, through the stand-in `vscode`: Run Line and Run
// Selection hand their answer and line to `Live.onDidAnswer`, Run Block and
// Run File do not; on, the answer is drawn at that line until the line is
// edited; off, nothing is drawn, the decoration is gone and Clear refuses.
const { stub, vscode, EventEmitter } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { setUp } = require("./fakeq.js");
const { shortForm, shiftLines, hoverForm, INLINE_WIDTH } = require("../out/inlineresult.js");
const { registerInlineResults } = require("../out/inlineresultview.js");
const { PROCESS_TOOL_COMMANDS } = require("../out/processtools.js");
const pkg = require("../package.json");

test("the hover cuts q's output by code point, never inside a surrogate pair (#1810)", () => {
  const text = ["a".repeat(1999) + "😀" + "b".repeat(10)];
  assert.strictEqual(hoverForm({ ok: true, text }), "a".repeat(1999) + "😀");
  assert.strictEqual(hoverForm({ ok: true, text: ["1", "2"] }), "1\n2");
  assert.strictEqual(hoverForm({ ok: true, text: ["😀".repeat(2500)] }), "😀".repeat(2000));
  assert.strictEqual(hoverForm({ ok: false, error: "type" }), "'type");
});

test("the short form joins q's text, says an error, counts a grid, and is cut", () => {
  assert.strictEqual(shortForm({ ok: true, type: -7, text: ["42"] }), "42");
  assert.strictEqual(shortForm({ ok: true, type: 98, text: ["a b", "---", "1 2", "3 4"] }), "a b 1 2 3 4");
  assert.strictEqual(shortForm({ ok: false, error: "type", trace: "" }), "'type");
  assert.strictEqual(shortForm({ ok: true, type: 98, text: [], grid: { count: 3 } }), "3 rows");
  assert.strictEqual(shortForm({ ok: true, type: 101, text: [] }), "::");
  const long = shortForm({ ok: true, type: 7, text: ["1 ".repeat(100)] });
  assert.strictEqual(long.length, INLINE_WIDTH);
  assert.ok(long.endsWith("..."));
});

test("the cut never splits a character outside the BMP (#1428)", () => {
  const cut = shortForm({ ok: true, type: 10, text: ["a".repeat(76) + "\u{1F600}".repeat(5)] });
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), JSON.stringify(cut));
  assert.strictEqual(cut, "a".repeat(76) + "\u{1F600}...");
  // Under the width in characters, though not in UTF-16 units: not cut.
  const emoji = "\u{1F600}".repeat(50);
  assert.strictEqual(shortForm({ ok: true, type: 10, text: [emoji] }), emoji);
});

test("an edit wipes the lines it touches and moves those below", () => {
  // Typing on line 3: its result goes, the others stay.
  assert.deepStrictEqual(shiftLines([1, 3, 5], 3, 3, 0), [1, 5]);
  // Two lines added at line 2: those below move down by two.
  assert.deepStrictEqual(shiftLines([1, 3, 5], 2, 2, 2), [1, 5, 7]);
  // Lines 2 to 4 joined into one: 5 moves up by two.
  assert.deepStrictEqual(shiftLines([1, 3, 5], 2, 4, 0), [1, 3]);
});

test("the switch is declared on, and Clear only where it is", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.query.inlineResults.enable"].default, true);
  const palette = pkg.contributes.menus.commandPalette.find((m) => m.command === PROCESS_TOOL_COMMANDS.clearInlineResults);
  assert.match(palette.when, /config\.q-lint\.query\.inlineResults\.enable/);
});

/// A live stand-in that fires answers, and the decorations each editor got.
function harness(t, on) {
  stub.reset();
  stub.config.user["query.inlineResults.enable"] = on;
  const answered = new EventEmitter();
  const drawn = [];
  let types = 0;
  vscode.window.createTextEditorDecorationType = () => ({ id: ++types, dispose() {} });
  const lines = ["a:1", "b:2", "c:3", "d:4"];
  const editor = {
    document: { uri: { toString: () => "file:///w/a.q" }, lineCount: lines.length, lineAt: (n) => ({ range: { end: { line: n, character: lines[n].length } } }) },
    setDecorations: (type, ranges) => drawn.push({ type: type.id, ranges }),
  };
  vscode.window.visibleTextEditors = [editor];
  const changes = new EventEmitter();
  vscode.workspace.onDidChangeTextDocument = changes.event;
  const context = stub.newContext();
  const feature = registerInlineResults(context, { onDidAnswer: answered.event });
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  return { answered, drawn, feature, changes, editor };
}

test("on, an answer is drawn at its line until the line is edited", (t) => {
  const { answered, drawn, feature, changes, editor } = harness(t, true);
  assert.strictEqual(feature.active(), true);
  answered.fire({ process: "rdb", answer: { ok: true, type: -7, text: ["42"] }, millis: 3, uri: "file:///w/a.q", line: 2 });
  answered.fire({ process: "rdb", answer: { ok: false, error: "type", trace: "" }, millis: 1, uri: "file:///w/a.q", line: 0 });
  assert.deepStrictEqual(feature.shown("file:///w/a.q"), [
    { line: 0, text: "'type" },
    { line: 2, text: "42" },
  ]);
  const last = drawn.at(-1);
  assert.deepStrictEqual(last.ranges.map((r) => r.renderOptions.after.contentText).sort(), [" => 'type", " => 42"]);
  // q's output is a code block in the hover, not Markdown (#1264).
  const hover = last.ranges.find((r) => r.renderOptions.after.contentText === " => 42").hoverMessage;
  assert.ok(hover instanceof vscode.MarkdownString);
  assert.deepStrictEqual(hover.blocks, [["text", "42"]]);
  // Typing on line 2 wipes its result.
  changes.fire({ document: editor.document, contentChanges: [{ range: { start: { line: 2 }, end: { line: 2 } }, text: "x" }] });
  assert.deepStrictEqual(feature.shown("file:///w/a.q"), [{ line: 0, text: "'type" }]);
  assert.strictEqual(feature.clear(), undefined);
  assert.deepStrictEqual(feature.shown("file:///w/a.q"), []);
});

test("off, nothing is drawn and Clear refuses; turned on, it draws", (t) => {
  const { answered, feature } = harness(t, false);
  assert.strictEqual(feature.active(), false);
  answered.fire({ process: "rdb", answer: { ok: true, type: -7, text: ["42"] }, millis: 3, uri: "file:///w/a.q", line: 2 });
  assert.deepStrictEqual(feature.shown("file:///w/a.q"), []);
  assert.match(stub.commands.get(PROCESS_TOOL_COMMANDS.clearInlineResults)(), /Inline results is turned off\. Set q-lint\.query\.inlineResults\.enable to true/);
  stub.config.user["query.inlineResults.enable"] = true;
  stub.changeConfig("q-lint.query.inlineResults.enable");
  answered.fire({ process: "rdb", answer: { ok: true, type: -7, text: ["42"] }, millis: 3, uri: "file:///w/a.q", line: 2 });
  assert.deepStrictEqual(feature.shown("file:///w/a.q"), [{ line: 2, text: "42" }]);
  stub.config.user["query.inlineResults.enable"] = false;
  stub.changeConfig("q-lint.query.inlineResults.enable");
  assert.strictEqual(feature.active(), false);
  assert.deepStrictEqual(feature.shown("file:///w/a.q"), []);
});

test("an answer lands on the line its statement was moved to while it ran, and not in a document closed meanwhile (#2553)", (t) => {
  const { answered, feature, changes, editor } = harness(t, true);
  editor.document.version = 1;
  vscode.workspace.textDocuments = [editor.document];
  t.after(() => (vscode.workspace.textDocuments = []));
  // Sent from line 2 at version 1; two lines are added at the top meanwhile.
  editor.document.version = 2;
  changes.fire({ document: editor.document, contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: "x:0\ny:0\n" }] });
  answered.fire({ process: "rdb", answer: { ok: true, type: -7, text: ["3"] }, millis: 3, uri: "file:///w/a.q", line: 2, version: 1 });
  assert.deepStrictEqual(feature.shown("file:///w/a.q"), [{ line: 4, text: "3" }]);
  // Its own line edited meanwhile: not drawn.
  feature.clear();
  editor.document.version = 3;
  changes.fire({ document: editor.document, contentChanges: [{ range: { start: { line: 4 }, end: { line: 4 } }, text: "z" }] });
  answered.fire({ process: "rdb", answer: { ok: true, type: -7, text: ["3"] }, millis: 3, uri: "file:///w/a.q", line: 4, version: 2 });
  assert.deepStrictEqual(feature.shown("file:///w/a.q"), []);
  // Closed meanwhile: not kept for when it opens again.
  vscode.workspace.textDocuments = [];
  answered.fire({ process: "rdb", answer: { ok: true, type: -7, text: ["3"] }, millis: 3, uri: "file:///w/a.q", line: 4, version: 3 });
  assert.deepStrictEqual(feature.shown("file:///w/a.q"), []);
});

test("Run Line and Run Selection hand over their answer and line; Run Block does not", async (t) => {
  const { live } = await setUp(t, { answer: (m) => (Array.isArray(m) ? { ok: true, type: -7, text: ["42"] } : null) });
  const got = [];
  live.onDidAnswer((a) => got.push(a));
  const lines = ["a:1", "1+41", "b:2"];
  vscode.window.activeTextEditor = {
    document: { uri: vscode.Uri.file("/w/a.q"), version: 7, lineAt: (n) => ({ text: lines[n] }), getText: (sel) => (sel ? "1+41\nb:2" : lines.join("\n")) },
    selection: { active: { line: 1 }, isEmpty: true },
  };
  t.after(() => (vscode.window.activeTextEditor = undefined));
  await live.connectTo("rdb");
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].line, 1);
  assert.strictEqual(got[0].uri, "file:///w/a.q");
  assert.strictEqual(got[0].version, 7);
  assert.deepStrictEqual(got[0].answer.text, ["42"]);
  // A selection from line 1 to the start of line 3 ends on line 2.
  vscode.window.activeTextEditor.selection = { active: { line: 3 }, isEmpty: false, start: { line: 1, character: 0 }, end: { line: 3, character: 0 } };
  await stub.commands.get("q-lint.querySelection")();
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[1].line, 2);
  vscode.window.activeTextEditor.selection = { active: { line: 1 }, isEmpty: true };
  await stub.commands.get("q-lint.queryBlock")();
  assert.strictEqual(got.length, 2);
});
