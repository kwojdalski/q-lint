// Clickable q backtraces (#983): the frames of backtraces captured from
// KDB-X 5.0 and PeachQ 0.92 - `.Q.trp` output over IPC and a console under
// `\e 1` - and the line each points at. The view is backtraceview.test.js;
// backtrace_q.test.js reads a fresh one from a real q.
const test = require("node:test");
const assert = require("node:assert");
const { parseBacktrace, failedAt, bestSuffixMatch, headerLink } = require("../out/backtrace.js");

const LIB = ["/ comment line 1", "", "mid:{[a]", "  b:a+1;", "  c:b+`x;", "  d:c*2;", "  d}", "one:{x+`y}", ""].join("\n");

// `.Q.sbt` of `.Q.trp[{mid 1};::;...]`, KDB-X 5.0 2026.07.23.
const KDBX = [
  "  [5]  /w/lib2.q:5: mid:",
  "  b:a+1;",
  "  c:b+`x;",
  "     ^",
  "  d:c*2;",
  "  [4]  /w/trp2.q:2: {mid 1}",
  "                    ^",
  "  [3]  (.Q.trp)",
  "",
  "  [2]  /w/trp2.q:2: r:.Q.trp[{mid 1};::;{(x;.Q.sbt y;y)}];",
  "                     ^",
  "",
].join("\n");

// The same from PeachQ 0.92.
const PEACHQ = [
  "  [4]  /w/lib2.q:3: mid:{[a]",
  "  b:a+1;",
  "  c:b+`x;",
  "     ^",
  "  d:c*2;",
  "  d}",
  "  [3]  /w/trp2.q:2: {mid 1}",
  "                    ^",
  "  [2]  (.Q.trp)",
  "",
].join("\n");

// A console under `\e 1`, KDB-X and PeachQ, after `one 2`.
const CONSOLE_KDBX = ["q)one 2", "'type", "  [1]  /w/lib2.q:8: one:{x+`y}", "                        ^", "q))"].join("\n");
const CONSOLE_PEACHQ = ["q)mid 1", "'type", "  [1]  /w/lib2.q:3: mid:{[a]", "  b:a+1;", "  c:b+`x;", "     ^", "  d:c*2;", "  d}", "q))b", "2"].join("\n");

test("KDB-X's frames: the line is the one that failed", () => {
  const frames = parseBacktrace(KDBX);
  assert.deepStrictEqual(frames.map((f) => [f.index, f.file, f.line, f.name]), [
    [5, "/w/lib2.q", 5, "mid"],
    [4, "/w/trp2.q", 2, undefined],
    [3, undefined, undefined, undefined],
    [2, "/w/trp2.q", 2, "r"],
  ]);
  assert.deepStrictEqual(frames[0].failed, { index: 2, column: 5 });
  assert.deepStrictEqual(frames[0].span, { start: 7, end: 18 });
  assert.strictEqual(KDBX.split("\n")[0].slice(7, 18), "/w/lib2.q:5");
  assert.deepStrictEqual(failedAt(frames[0], LIB), { line: 4, character: 5 });
  // Unread, the header's line is still the right one.
  assert.deepStrictEqual(failedAt(frames[0]), { line: 4, character: 0 });
  // A one-line frame: the column is past the header's `file:line: `.
  assert.deepStrictEqual(frames[1].failed, { index: 0, column: 0 });
});

test("PeachQ's frames: the line is where the function starts, plus the lines to the caret", () => {
  const frames = parseBacktrace(PEACHQ);
  assert.deepStrictEqual(frames.map((f) => [f.index, f.file, f.line, f.name]), [
    [4, "/w/lib2.q", 3, "mid"],
    [3, "/w/trp2.q", 2, undefined],
    [2, undefined, undefined, undefined],
  ]);
  assert.deepStrictEqual(frames[0].code, ["mid:{[a]", "  b:a+1;", "  c:b+`x;", "  d:c*2;", "  d}"]);
  assert.deepStrictEqual(failedAt(frames[0], LIB), { line: 4, character: 5 });
  // Unread, the function's first line.
  assert.deepStrictEqual(failedAt(frames[0]), { line: 2, character: 0 });
});

test("a console's frames under \\e, on both", () => {
  const k = parseBacktrace(CONSOLE_KDBX);
  assert.deepStrictEqual(k.map((f) => [f.file, f.line, f.name]), [["/w/lib2.q", 8, "one"]]);
  assert.deepStrictEqual(failedAt(k[0], LIB), { line: 7, character: 4 });
  const p = parseBacktrace(CONSOLE_PEACHQ);
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual(p[0].code, ["mid:{[a]", "  b:a+1;", "  c:b+`x;", "  d:c*2;", "  d}"], "the prompt ends the frame");
  assert.deepStrictEqual(failedAt(p[0], LIB), { line: 4, character: 5 });
  // A frame defined over IPC has no file, but has a name.
  assert.deepStrictEqual(parseBacktrace("  [4]  m:{x+`a}\n           ^").map((f) => [f.file, f.name, f.failed]), [[undefined, "m", { index: 0, column: 4 }]]);
  // Not a backtrace.
  assert.deepStrictEqual(parseBacktrace("a b\n---\n1 2"), []);
});

test("a path from another machine is matched by its trailing segments; a terminal line links its header", () => {
  assert.strictEqual(bestSuffixMatch("/srv/app/src/lib.q", ["/ws/other/lib.q", "/ws/src/lib.q", "/ws/x.q"]), "/ws/src/lib.q");
  assert.strictEqual(bestSuffixMatch("C:\\app\\src\\lib.q", ["/ws/src/lib.q"]), "/ws/src/lib.q");
  assert.strictEqual(bestSuffixMatch("/srv/none.q", ["/ws/src/lib.q"]), undefined);
  assert.deepStrictEqual(headerLink("  [5]  /w/lib2.q:5: mid:"), { start: 7, length: 11, file: "/w/lib2.q", line: 5 });
  assert.strictEqual(headerLink("  [3]  (.Q.trp)"), undefined);
  assert.strictEqual(headerLink("x:1"), undefined);
});
