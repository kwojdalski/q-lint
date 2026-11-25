// The one reader of q text every feature shares (#2278-#2287): what each
// cuts from a file is what q's loader runs from it. scriptload_q.test.js
// holds the cutter against a real q's `\l`; these hold the rules it found.
const test = require("node:test");
const assert = require("node:assert");
const { statements, statementSpans, scriptCode, selectionCode, blockAt, lineKinds, isBlankLine } = require("../out/statements.js");
const { statementSpans: timedSpans } = require("../out/linetimings.js");
const { cells, shownCode } = require("../out/cells.js");
const { isComplete } = require("../out/repl.js");
const { replLines } = require("../out/terminal.js");
const { definitions } = require("../out/definitions.js");
const { testStatements } = require("../out/testing.js");

test("only a space, a tab and a carriage return are blank to q (#2279)", () => {
  // `/` and a no-break space is a comment line, no block comment: b runs.
  assert.deepStrictEqual(statements("a:1\n/ \nb:2\n\\\nc:3"), ["a:1", "b:2"]);
  assert.deepStrictEqual(statements("a:1\n/\f\nb:2\n\\\nc:3"), ["a:1", "b:2"]);
  // A line of a no-break space or an em space starts a statement.
  assert.deepStrictEqual(statements("f:{x+\n \n  y}"), ["f:{x+", " \n  y}"]);
  assert.deepStrictEqual(statements("f:{x+\n \n  y}"), ["f:{x+", " \n  y}"]);
  assert.deepStrictEqual(statements("a:1\n\f\nb:2"), ["a:1", "\f", "b:2"]);
  assert.strictEqual(isBlankLine(" \t\r"), true);
  assert.strictEqual(isBlankLine(" "), false);
  // Every reader reads them alike.
  assert.strictEqual(isComplete("/ \n("), false);
  assert.deepStrictEqual(cells(["a:1", "/ ", "/ %% two", "b:2"]).map((c) => c.start), [0, 2]);
  assert.strictEqual(shownCode("/ %% x\n \na:1", { marker: 0 }), " \na:1");
  assert.deepStrictEqual(timedSpans("a:1\n/ \nb:2"), statementSpans("a:1\n/ \nb:2"));
});

test("a comment line q refuses with 'char is sent, for value to refuse too (#2279)", () => {
  // q's loader refuses a vertical tab anywhere before the script's end.
  assert.deepStrictEqual(statements("a:1\n/\u000b\nb:2\n\\\nc:3"), ["a:1", "/\u000b", "b:2"]);
  assert.deepStrictEqual(statements("a:1\n/\nx\u0001\n\\\nb:2"), ["a:1", "/x\u0001", "b:2"]);
  // In a statement it is in the statement's text already.
  assert.deepStrictEqual(statements("f:{x+\n/ \u0001\n  y}"), ["f:{x+\n/ \u0001\n  y}"]);
  assert.deepStrictEqual(statements("a:1\n\\\n/\u000b"), ["a:1"]);
});

test("blank and comment lines inside a statement stay in it, as q keeps them (#2281, #2282)", () => {
  // q's text of the lambda holds them; drift compares against it.
  assert.deepStrictEqual(statements("dr1:{[x]\n  / double it\n  y:x*2;\n\n  y+1}"), ["dr1:{[x]\n  / double it\n  y:x*2;\n\n  y+1}"]);
  // A block comment's lines as comment lines, as q makes them.
  assert.deepStrictEqual(statements("f:{x+\n/\nfoo\n  bar\n\\\n  y}"), ["f:{x+\n/\n/foo\n/  bar\n/\n  y}"]);
  // In an open string the comment line reaches value, which refuses it as
  // \l does.
  assert.deepStrictEqual(statements('a:("x\n/ y\n  z")\nb:1'), ['a:("x\n/ y\n  z")', "b:1"]);
  assert.deepStrictEqual(statements('a:("x\n/\nq\n\\\n  z")\nb:1'), ['a:("x\n/\n/q\n/\n  z")', "b:1"]);
  // Not after the statement's last line: there they end nothing.
  assert.deepStrictEqual(statements("a:1\n\n/ note\nb:2"), ["a:1", "b:2"]);
  // The definitions drift compares are cut the same way.
  assert.deepStrictEqual(definitions("dr1:{[x]\n  / double it\n  y:x*2;\n\n  y+1}").map((d) => d.text), ["{[x]\n  / double it\n  y:x*2;\n\n  y+1}"]);
});

test("a continuation line's leading tab is read as a space, as q reads it (#2280)", () => {
  assert.deepStrictEqual(statements('sql:"select *\n\tfrom t"'), ['sql:"select *\n from t"']);
  assert.deepStrictEqual(statements('s:"a\n\t\tb"'), ['s:"a\n \tb"']);
  // In a block comment inside a statement too.
  assert.deepStrictEqual(statements("f:{x+\n/\n\tbar\n\\\n  y}"), ["f:{x+\n/\n/ bar\n/\n  y}"]);
  assert.deepStrictEqual(replLines('sql:"select *\n\tfrom t"'), ['sql:"select *\\n from t"']);
});

test("a script's indented lines before its first statement are skipped, as q skips them (#2278)", () => {
  assert.deepStrictEqual(statements(scriptCode("  a:1\nb:2")), ["b:2"]);
  assert.deepStrictEqual(statements(scriptCode("/ c\n  a:1\nb:2")), ["b:2"]);
  assert.deepStrictEqual(statements(scriptCode("/\nx\n\\\n  a:1\nb:2")), ["b:2"]);
  // Never made a command: `  \\` in a script is no exit.
  assert.deepStrictEqual(statements(scriptCode("  \\\\\nb:2")), ["b:2"]);
  // Lines keep their numbers.
  assert.strictEqual(scriptCode("  a:1\nb:2\n  +1"), "\nb:2\n  +1");
  // A piece of code that is no script starts at its first line, but never
  // as a command it is not.
  assert.deepStrictEqual(statements("  a:1\n  +2"), ["a:1\n  +2"]);
  assert.deepStrictEqual(statements("  \\\\"), ["  \\\\"]);
  assert.deepStrictEqual(statements("  \\d .x"), ["  \\d .x"]);
  assert.deepStrictEqual(statements("  / note\na:1"), ["a:1"]);
  // Block, cells and definitions read the file as q does.
  assert.strictEqual(blockAt(["  a:1", "b:2"], 0), undefined);
  assert.deepStrictEqual(blockAt(["  a:1", "b:2", "  +1"], 2), { start: 1, end: 2 });
  assert.deepStrictEqual(lineKinds(["  a:1", "b:2", "  +1"]), ["commented", "starts", "continues"]);
  assert.deepStrictEqual(cells(["  a:1", "/ %% one", "b:2"]).map((c) => c.start), [1]);
  assert.deepStrictEqual(definitions("  f:{x}\ng:{y}").map((d) => d.name), ["g"]);
});

test("a selection is read as the document reads at its first line (#2287)", () => {
  const lines = ["a:1", "/", "Usage example (not run):", "  dropAll[]", "\\", "b:2", "c:3"];
  const picked = selectionCode(lines, 3, lines.slice(3).join("\n"));
  assert.deepStrictEqual(statements(picked), ["b:2", "c:3"]);
  // Its lines keep their numbers, for line timings.
  assert.deepStrictEqual(statementSpans(picked, 3).map((s) => s.start), [5, 6]);
  // Nested block comments close one at a time.
  assert.deepStrictEqual(statements(selectionCode(["/", "/", "x", "\\", "y", "\\", "z:1"], 2, "x\n\\\ny\n\\\nz:1")), ["z:1"]);
  // After the script's end nothing runs.
  assert.deepStrictEqual(statements(selectionCode(["a:1", "\\", "b:2"], 2, "b:2")), []);
  // Outside them it is the selection.
  assert.strictEqual(selectionCode(["a:1", "b:2"], 1, "b:2"), "b:2");
});

test("a test's code is cut as q loads it, a block comment inside no end (#2283)", () => {
  const code = "test_blk:{\n  a:1;\n/\n  junk\n\\\n  a~1}";
  assert.deepStrictEqual(testStatements({ code, call: "test_blk[]" }), ["test_blk:{\n  a:1;\n/\n/  junk\n/\n  a~1}", "test_blk[]"]);
  assert.deepStrictEqual(testStatements({ code: `\\d .ns\n${code}\n\\d .`, call: ".ns.test_blk[]" }), [
    "\\d .ns",
    "test_blk:{\n  a:1;\n/\n/  junk\n/\n  a~1}",
    "\\d .",
    ".ns.test_blk[]",
  ]);
});
