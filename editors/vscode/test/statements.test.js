// The one reader of q text every feature shares (#2278-#2287): what each
// cuts from a file is what q's loader runs from it. scriptload_q.test.js
// holds the cutter against a real q's `\l`; these hold the rules it found.
const test = require("node:test");
const assert = require("node:assert");
const { statements, statementSpans, scriptCode, selectionCode, blockAt, lineKinds, lineContext, isBlankLine, contextAfter, contextLeft, contextSwitch, inContext, scriptInContext } = require("../out/statements.js");
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

test("a k) statement's lines reach the terminal joined as k reads them (#2285)", () => {
  assert.deepStrictEqual(replLines("k)kf:{x+\n  y}\ng:kf[1;2]"), ["k)kf:{x+;y}", "g:kf[1;2]"]);
  assert.deepStrictEqual(replLines('k)e:"ab\n cd"'), ['k)e:"ab\\n cd"']);
  // q's own lines are joined with a blank still.
  assert.deepStrictEqual(replLines("f:{x+\n  y}"), ["f:{x+ y}"]);
});

test("the context a text leaves is the one the next runs in (#2286)", () => {
  assert.strictEqual(contextAfter("\\d .cdlib"), ".cdlib");
  assert.strictEqual(contextAfter("add:{x+y}", ".cdlib"), ".cdlib");
  assert.strictEqual(contextAfter("\\d .a\nf:1\n\\d .", "."), ".");
  assert.strictEqual(contextAfter('system "d .b"'), ".b");
  // A `\d` inside a block comment switches nothing.
  assert.strictEqual(contextAfter("/\n\\d .x\n\\"), ".");
  assert.strictEqual(contextSwitch("f:{\n  \\d .x}"), undefined);
  assert.deepStrictEqual(inContext(["add:{x+y}"], ".cdlib"), ["\\d .cdlib", "add:{x+y}"]);
  assert.deepStrictEqual(inContext(["a:1"], "."), ["a:1"]);
});

// q's statement keeps a block comment in a lambda as `/` lines (KDB-X holds
// "{[x]\n  a:x+1;\n/\n/  a:a*100;\n/\n  a}" from this script), which read as
// a script again open one over the rest of the lambda.
test("code kept behind a \\d is a script that cuts to the statements it ran as (#3162)", () => {
  const lambda = "rp:{[x]\n  a:x+1;\n/\n  a:a*100;\n\\\n  a}";
  const [cut] = statements(lambda);
  assert.strictEqual(cut, "rp:{[x]\n  a:x+1;\n/\n/  a:a*100;\n/\n  a}");
  assert.deepStrictEqual(statements(cut), ["rp:{[x]\n  a:x+1;"]);
  assert.strictEqual(scriptInContext(lambda, ".ns"), `\\d .ns\n${lambda}`);
  assert.deepStrictEqual(statements(scriptInContext(lambda, ".ns")), ["\\d .ns", cut]);
  // A piece of a statement, as a selection is: its first line does not continue the \d.
  for (const code of ["  a:1;\n  b:2", "/ note\n\n  f:{\n  x}\ng:2\n/ after", `/\nblock\n\\\n${lambda}\nh:3`]) {
    assert.deepStrictEqual(statements(scriptInContext(code, ".ns")), inContext(statements(code), ".ns"), code);
  }
  // The root needs none, and no code none either.
  assert.strictEqual(scriptInContext(lambda, "."), lambda);
  assert.strictEqual(scriptInContext("/ only a comment", ".ns"), "/ only a comment");
});

test("a \\d with a trailing comment, or after q), switches the context as q does (#2785)", () => {
  assert.strictEqual(contextSwitch("\\d .a / analytics"), ".a");
  assert.strictEqual(contextSwitch("q)\\d .a"), ".a");
  assert.strictEqual(contextSwitch("q)q)\\d . / back"), ".");
  assert.strictEqual(contextAfter("q)\\d .a\nf:1"), ".a");
  // A slash with no blank before it is no comment: not a name.
  assert.strictEqual(contextSwitch("\\d .a/b"), undefined);
});

// Each of these switches the context on KDB-X, and was read as switching
// none: the cell, REPL entry or statement after it ran in the root.
test("system[\"d .ns\"], a switch beside other code on its line, and a name that starts with a digit switch the context (#2916)", () => {
  assert.strictEqual(contextSwitch('system["d .ns"]'), ".ns");
  assert.strictEqual(contextSwitch('system[ "d .ns" ] / the library\'s'), ".ns");
  assert.strictEqual(contextSwitch("\\d .1a"), ".1a");
  assert.strictEqual(contextSwitch("\\d .a._b / c"), ".a._b");
  assert.strictEqual(contextSwitch('system "d ._a"'), "._a");
  // Beside other code it is no switch alone, and leaves its context.
  for (const [statement, left] of [
    ['a:1;system "d .ns"', ".ns"],
    ['system "d .ns";a:1', ".ns"],
    ['r:system "d .ns" / kept', ".ns"],
    ['system "d .a";system["d .b"]', ".b"],
    ['system "d .a";system "d ."', "."],
    ['a:1;\n system "d .m"\n/ system "d .c"\n ;b:2', ".m"],
  ]) {
    assert.strictEqual(contextSwitch(statement), undefined, statement);
    assert.strictEqual(contextLeft(statement), left, statement);
  }
  // Not one that may not run, is computed, or is no code.
  for (const none of ['f:{system "d .x"}', 'if[c;system "d .x"]', 'system "d .x",y', 's:"system \\"d .x\\""', 'a:1 / system "d .x"', 'mysystem "d .x"', '`system "d .x"', 'system "d foo"', '\\echo system "d .x"']) {
    assert.strictEqual(contextLeft(none), undefined, none);
  }
  assert.strictEqual(contextLeft("\\d .a"), ".a");
  assert.strictEqual(contextAfter('a:1;system "d .ns"\nf:{x+1}'), ".ns");
  assert.strictEqual(contextAfter('system["d .nt"]\ng:{x+2}', ".ns"), ".nt");
  assert.strictEqual(contextAfter("\\d .1a\nf:1"), ".1a");
  // A definition under one is named in it.
  assert.deepStrictEqual(definitions('f:{x}\na:1;system "d .ns"\ng:{x}\nsystem["d .1a"]\nh:{x}\n').map((d) => d.name), ["f", ".ns.g", ".1a.h"]);
  // Behind `q)` prompts it switches as `\d` behind them does (#2785).
  assert.strictEqual(contextSwitch('q)system "d .ns"'), ".ns");
  assert.strictEqual(contextLeft('q)q)a:1;system["d .ns"]'), ".ns");
  assert.strictEqual(contextLeft('k)system "d .ns"'), undefined);
});

test("the lines above tell whether a line is commented out, or starts inside a string (#2910)", () => {
  const each = (lines) => lines.map((_, i) => lineContext(lines.slice(0, i + 1)));
  const code = { commented: false, quoted: false };
  const comment = { commented: true, quoted: false };
  const string = { commented: false, quoted: true };
  assert.deepStrictEqual(each(["a:1", "/", "x", "\\", "b:2", "\\", "c:3"]), [code, comment, comment, comment, code, comment, comment]);
  // A string runs on over the indented lines under it, blank lines too,
  // and no further than the statement.
  assert.deepStrictEqual(each(['s:"a', "", '  b', '  c";t:"d', '  e"', "  f", 'u:"g', "v:1"]), [code, code, string, string, string, code, code, code]);
  // A `/` and a no-break space is a line comment, which opens nothing.
  assert.deepStrictEqual(each(["/\u00a0", "a:1", "\\\f", "b:2"]), [code, code, code, code]);
});
