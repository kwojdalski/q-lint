// The pure halves of running code interactively: what a cell is in a q file
// (#956, #958), where Smart Send moves to (#957), the REPL's input rules
// (#959), the `.qlint.view` message (#960), and the switches. q's own
// reading of the files below - that `/ %%` and `/%%` are comments, that a
// marker inside a block comment, after `\` or inside a statement is too -
// was checked on KDB-X and PeachQ; interactive_q.test.js runs cells there.
const test = require("node:test");
const assert = require("node:assert");
const { serialize } = require("node-q/lib/c.js");
const { markers, cells, cellAt, cellCode, cellName, nextStatement, smartStep, looksLikeMarker, shownCode } = require("../out/cells.js");
const { blockAt, statements } = require("../out/statements.js");
const { isComplete, replScript, wordAt, completionsFor, pushHistory, searchHistory } = require("../out/repl.js");
const { viewDefinition, readViewMessage } = require("../out/qview.js");
const { readInteractive, SMART_SEND_TARGETS } = require("../out/interactiveconfig.js");
const pkg = require("../package.json");

const L = (text) => text.split("\n");

test("a line starting / %% or /%% at column 0 starts a cell, its text the title", () => {
  const lines = L("a:1\n/ %% load\nb:2\n/%%\nc:3\n/ %%   spaced title  \nd:4");
  assert.deepStrictEqual(markers(lines), [1, 3, 5]);
  const all = cells(lines);
  assert.deepStrictEqual(all, [
    { start: 0, end: 0, title: "" },
    { start: 1, end: 2, marker: 1, title: "load" },
    { start: 3, end: 4, marker: 3, title: "" },
    { start: 5, end: 6, marker: 5, title: "spaced title" },
  ]);
  assert.deepStrictEqual(all.map((c) => cellName(all, c)), ["Cell 1", "load", "Cell 3", "spaced title"]);
  assert.strictEqual(cellCode(lines, all[1]), "/ %% load\nb:2");
  assert.strictEqual(cellAt(all, 4), all[2]);
  // Not markers: an indented one, `%%` not first, another comment.
  assert.deepStrictEqual(markers(L("a:1\n  / %% indented\n/ x %%\n// %%\n%% x")), []);
});

test("the lines above the first marker are a cell only when a statement starts there", () => {
  assert.deepStrictEqual(cells(L("/ a comment\n\n/ %% one\nx:1")), [{ start: 2, end: 3, marker: 2, title: "one" }]);
  assert.deepStrictEqual(cells(L("x:1\ny:2")), [], "a file with no marker has no cells");
  assert.strictEqual(cellAt(cells(L("/ c\n/ %% one\nx:1")), 0), undefined);
});

test("a / %% line inside a block comment, after the script's end or after a shebang line is not a marker", () => {
  // `/` alone opens a block comment, `\` alone closes it.
  assert.deepStrictEqual(markers(L("a:1\n/\n/ %% inside\nb:2\n\\\n/ %% after\nc:3")), [5]);
  // `/ %%` is not `/` alone: it opens nothing.
  assert.deepStrictEqual(markers(L("/ %% one\na:1\n/ %% two\nb:2")), [0, 2]);
  // `\` alone outside a block comment ends the script.
  assert.deepStrictEqual(markers(L("a:1\n\\\n/ %% gone\nb:2")), []);
  // Trailing spaces do not hide a lone `/` or `\`.
  assert.deepStrictEqual(markers(L("a:1\n/  \n/ %% inside\n\\ \n/ %% out")), [4]);
  assert.deepStrictEqual(markers(L("#!/usr/bin/env q\n/ %% one\na:1")), [1]);
});

test("a marker between a statement and its indented continuation is a comment in the statement", () => {
  // q defines f from all three lines: the marker does not end the statement.
  const lines = L("f:{x+\n/ %% mid\n  y}\n/ %% real\ng:1");
  assert.deepStrictEqual(markers(lines), [3]);
  // Past blank and comment lines too.
  assert.deepStrictEqual(markers(L("f:{x+\n/ %% mid\n\n/ note\n  y}")), []);
  // Before any statement an indented line starts one, so the marker counts.
  assert.deepStrictEqual(markers(L("/ %% one\n  x:1")), [0]);
  // A cell's code cuts into the statements q would run.
  const all = cells(lines);
  assert.deepStrictEqual(statements(cellCode(lines, all[0])), ["f:{x+\n  y}"]);
});

test("looksLikeMarker is the cheap test by text alone", () => {
  assert.ok(looksLikeMarker("/ %% x"));
  assert.ok(looksLikeMarker("/%%"));
  assert.ok(!looksLikeMarker(" / %%"));
});

test("the Interactive Window shows a cell's code without its marker", () => {
  assert.strictEqual(shownCode("/ %% load\n\nx:1\ny:2\n\n", { marker: 0 }), "x:1\ny:2");
  assert.strictEqual(shownCode("x:1\n", {}), "x:1");
});

test("Smart Send sends the statement at the cursor and moves to the next one", () => {
  const lines = L("a:1\nf:{\n  x+1}\n/ comment\n\nb:2\n/\nc:3\n\\\nd:4");
  // On a statement's first line: it, continuation and all; next is b.
  assert.deepStrictEqual(smartStep(lines, 1, blockAt), { send: { start: 1, end: 2 }, next: 5 });
  // On a continuation line: the same statement.
  assert.deepStrictEqual(smartStep(lines, 2, blockAt), { send: { start: 1, end: 2 }, next: 5 });
  // On a comment: nothing sent, the cursor moves on.
  assert.deepStrictEqual(smartStep(lines, 3, blockAt), { next: 5 });
  // c is in the block comment `/` opens and `\` closes: next is d.
  assert.deepStrictEqual(smartStep(lines, 5, blockAt), { send: { start: 5, end: 5 }, next: 9 });
  assert.strictEqual(nextStatement(lines, 0), 1);
  // After the script's end nothing is a statement: the cursor goes down a line.
  const ended = L("a:1\nb:2\n\\\nc:3");
  assert.strictEqual(nextStatement(ended, 1), undefined);
  assert.deepStrictEqual(smartStep(ended, 1, blockAt), { send: { start: 1, end: 1 }, next: 2 });
  // The last line of a file stays the last.
  assert.deepStrictEqual(smartStep(["x:1"], 0, blockAt), { send: { start: 0, end: 0 }, next: 0 });
});

test("Enter runs only a complete input: brackets closed, no string open", () => {
  assert.ok(isComplete("1+1"));
  assert.ok(isComplete(""));
  assert.ok(!isComplete("f:{x+"));
  assert.ok(!isComplete("([] a:1 2"));
  assert.ok(!isComplete('s:"abc'));
  assert.ok(isComplete('s:"a{b"'), "a bracket in a string does not count");
  assert.ok(isComplete('s:"a\\"{"'), "an escaped quote does not end the string");
  assert.ok(isComplete("x:1 / a comment {"), "a bracket in a comment does not count");
  assert.ok(!isComplete("f:{x / y}\n"), "the comment runs to the line's end, taking the }");
  assert.ok(isComplete("+/[1 2 3]"), "/ after a character is over, not a comment");
  assert.ok(isComplete("f:{x+\ny}"));
  // A block comment, `/` alone to `\` alone, counts no bracket (#1111).
  assert.ok(isComplete("/\n(\n\\\n1+1"));
  assert.ok(isComplete("/ \n{\n\\ \n1+1"), "trailing blanks on the / and \\ lines");
  assert.ok(!isComplete("/\n(\n\\\n1+("), "brackets after the block count");
  assert.ok(!isComplete("f:{\n/\n(\n\\\n}"), "inside a bracket a / line is a continuation, not a block");
});

test("lines typed inside a bracket reach q as continuation lines", () => {
  assert.strictEqual(replScript("f:{x+\ny}"), "f:{x+\n y}");
  assert.deepStrictEqual(statements(replScript("f:{x+\ny}\nf[1;2]")), ["f:{x+\n y}", "f[1;2]"]);
  assert.strictEqual(replScript("a:1\nb:2"), "a:1\nb:2", "lines outside a bracket stay statements of their own");
  assert.strictEqual(replScript('s:"a\nb"'), 's:"a\n b"');
  assert.strictEqual(replScript("f:{\n  x}"), "f:{\n  x}", "an indented line is left as it is");
});

test("Tab completes the name before the caret, from the sources in order, each once", () => {
  assert.deepStrictEqual(wordAt("x:cou", 5), { start: 2, prefix: "cou" });
  assert.deepStrictEqual(wordAt(".lib.ad", 7), { start: 0, prefix: ".lib.ad" });
  assert.strictEqual(wordAt("x: 12", 5), undefined, "a number is not a name");
  assert.strictEqual(wordAt("x: ", 3), undefined);
  const items = completionsFor("co", [
    { label: "count", detail: "dev" },
    { label: "cos", detail: "q" },
    { label: "count", detail: "q" },
    { label: "co", detail: "q" },
    { label: "cols", detail: "q" },
    { label: "x", detail: "q" },
  ]);
  assert.deepStrictEqual(items, [
    { label: "cos", detail: "q" },
    { label: "cols", detail: "q" },
    { label: "count", detail: "dev" },
  ]);
  assert.strictEqual(completionsFor("a", Array.from({ length: 80 }, (_, i) => ({ label: `a${i}`, detail: "q" }))).length, 50);
});

test("the history keeps each input once, newest first, and Ctrl+R searches it from the newest", () => {
  let h = pushHistory([], "a:1");
  h = pushHistory(h, "b:2  ");
  h = pushHistory(h, "a:1");
  h = pushHistory(h, "   ");
  assert.deepStrictEqual(h, ["a:1", "b:2"]);
  assert.strictEqual(pushHistory(["x"], "y", 1).length, 1);
  const history = ["select from t", "count t", "select from u"];
  assert.strictEqual(searchHistory(history, "select"), 0);
  assert.strictEqual(searchHistory(history, "select", 1), 2, "Ctrl+R again searches on from the one after");
  assert.strictEqual(searchHistory(history, "nothing"), -1);
  assert.strictEqual(searchHistory(history, ""), -1);
});

test("the .qlint.view definition is four statements, sized as asked", () => {
  const code = viewDefinition([25, 80], 1000);
  const cut = statements(code);
  assert.deepStrictEqual(cut.map((s) => s.split(":")[0]), [".qlint.grid", ".qlint.show", ".qlint.view", ".qlint.plot"]);
  assert.match(code, /\.qlint\.grid\[enlist"\.qlint\.shown";25 80f;1000f\]/);
  assert.match(code, /neg\[\.z\.w\]\(`qlint;how;a\)/);
  assert.match(viewDefinition([25, 80], Infinity), /;0Wf\]/);
});

/// An async message as a process sends it.
const asyncMessage = (value) => {
  const m = serialize(value);
  m.writeUInt8(0, 1);
  return m;
};

test("a .qlint.view or .qlint.plot message is read; any other async message is not ours", () => {
  const grid = { count: 2, keys: 0, names: ["a"], types: [7], cells: [["1", "2"]], raw: [[1, 2]], rank: [[0, 1]], tree: [] };
  const read = readViewMessage(asyncMessage(["qlint", "plot", { ok: true, type: 98, text: ["a", "-"], grid }]));
  assert.strictEqual(read.kind, "plot");
  assert.deepStrictEqual(read.answer.grid.cells, [["1", "2"]]);
  assert.strictEqual(readViewMessage(asyncMessage(["qlint", "other", {}])), undefined);
  assert.strictEqual(readViewMessage(asyncMessage(["upd", "trade", {}])), undefined);
  assert.strictEqual(readViewMessage(asyncMessage(42)), undefined);
  assert.strictEqual(readViewMessage(asyncMessage(["qlint", "view", 42])), undefined, "an answer that is not one is dropped");
  assert.strictEqual(readViewMessage(Buffer.from([1, 0, 0, 0, 9, 0, 0, 0, 99])), undefined);
});

test("the switches: on by default but Smart Send and defining on connect", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  const defaults = {
    "q-lint.cells.enable": true,
    "q-lint.cells.codeLens.enable": true,
    "q-lint.smartSend.enable": false,
    "q-lint.repl.enable": true,
    "q-lint.view.enable": true,
    "q-lint.view.defineOnConnect": false,
  };
  for (const [key, value] of Object.entries(defaults)) {
    assert.strictEqual(props[key]?.default, value, key);
  }
  assert.deepStrictEqual(props["q-lint.smartSend.target"].enum, [...SMART_SEND_TARGETS]);
  const none = readInteractive((_k, fallback) => fallback);
  assert.deepStrictEqual(none, { cells: true, cellLenses: true, smartSend: false, smartSendTarget: "query", repl: true, view: true, defineViewOnConnect: false });
  assert.strictEqual(readInteractive((k, f) => (k === "smartSend.target" ? "nowhere" : f)).smartSendTarget, "query");
  // Every command is hidden from the palette by its own switch.
  const palette = pkg.contributes.menus.commandPalette;
  const when = (command) => palette.find((m) => m.command === command)?.when;
  assert.match(when("q-lint.runCell"), /config\.q-lint\.cells\.enable/);
  assert.match(when("q-lint.runCellsAbove"), /config\.q-lint\.cells\.codeLens\.enable/);
  assert.match(when("q-lint.smartSend"), /config\.q-lint\.smartSend\.enable/);
  assert.match(when("q-lint.openReplPane"), /config\.q-lint\.repl\.enable/);
  assert.match(when("q-lint.defineViewHelpers"), /config\.q-lint\.view\.enable/);
  const keys = pkg.contributes.keybindings;
  assert.match(keys.find((k) => k.command === "q-lint.smartSend").when, /config\.q-lint\.smartSend\.enable/);
  assert.match(keys.find((k) => k.command === "q-lint.runCell").when, /q-lint\.hasCells/);
});
