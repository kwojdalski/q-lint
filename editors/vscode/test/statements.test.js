// The one reader of q text every feature shares (#2278-#2287): what each
// cuts from a file is what q's loader (`\l`) runs from it, by the rules
// it follows, checked on KDB-X.
const test = require("node:test");
const assert = require("node:assert");
const { statements, statementSpans, isBlankLine } = require("../out/statements.js");
const { statementSpans: timedSpans } = require("../out/linetimings.js");
const { cells, shownCode } = require("../out/cells.js");
const { isComplete } = require("../out/repl.js");
const { definitions } = require("../out/definitions.js");

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
