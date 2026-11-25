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
  // q prints a file as it was loaded: Lib\Util.q for c:\proj\lib\util.q.
  // The same where the disk says the two spellings are one file (#2107).
  const insensitive = (p) => (p.toLowerCase().startsWith("c:\\proj\\") ? p.toLowerCase() : undefined);
  assert.strictEqual(bestSuffixMatch("Lib\\Util.q", ["c:\\proj\\lib\\util.q"], insensitive), "c:\\proj\\lib\\util.q");
  assert.strictEqual(bestSuffixMatch("Lib\\Util.q", ["c:\\proj\\other\\util.q", "c:\\proj\\lib\\util.q"], insensitive), "c:\\proj\\lib\\util.q");
  // Where it tells case apart, or without asking it, they are two files.
  const sensitive = (p) => (["/ws/lib/util.q"].includes(p) ? p : undefined);
  assert.strictEqual(bestSuffixMatch("Lib/Util.q", ["/ws/lib/util.q"], sensitive), undefined);
  assert.strictEqual(bestSuffixMatch("Lib\\Util.q", ["c:\\proj\\lib\\util.q"]), undefined);
  // A segment matched exactly beats one matched only by case.
  assert.strictEqual(bestSuffixMatch("src/Util.q", ["/ws/src/Util.q", "/ws/SRC/util.q"], insensitive), "/ws/src/Util.q");
  assert.deepStrictEqual(headerLink("  [5]  /w/lib2.q:5: mid:"), { start: 7, length: 11, file: "/w/lib2.q", line: 5 });
  assert.strictEqual(headerLink("  [3]  (.Q.trp)"), undefined);
  assert.strictEqual(headerLink("x:1"), undefined);
});

test("a blank line inside a printed function stays in its frame, so the ^ is found (#1124)", () => {
  // q keeps a lambda's blank lines when it prints it.
  const file = ["mid:{[a]", "  b:a+1;", "", "  c:b+`x;", "  d}", ""].join("\n");
  const text = ["  [4]  /w/lib.q:1: mid:{[a]", "  b:a+1;", "", "  c:b+`x;", "     ^", "", "  d}", "  [3]  /w/trp.q:2: {mid 1}", "                   ^", "", "q)"].join("\n");
  const [mid, call] = parseBacktrace(text);
  assert.deepStrictEqual(mid.code, ["mid:{[a]", "  b:a+1;", "", "  c:b+`x;", "", "  d}"]);
  assert.deepStrictEqual(mid.failed, { index: 3, column: 5 });
  assert.deepStrictEqual(failedAt(mid, file), { line: 3, character: 5 });
  // A blank line before a header, a prompt or nothing still ends a frame.
  assert.deepStrictEqual(call.code, ["{mid 1}"]);
  assert.deepStrictEqual(parseBacktrace("  [2]  (.Q.trp)\n\n  x\n").map((f) => f.code), [["(.Q.trp)", "", "  x"]]);
  assert.deepStrictEqual(parseBacktrace("  [2]  (.Q.trp)\n\nq)  x\n").map((f) => f.code), [["(.Q.trp)"]]);
  assert.deepStrictEqual(parseBacktrace("  [2]  (.Q.trp)\n\nnext\n").map((f) => f.code), [["(.Q.trp)"]]);
});

// q writes the ^ after as many spaces as there are BYTES before the token
// that failed - of the header's path and of the code - and an editor
// counts characters. Each frame is as KDB-X 5.0 printed it (#1982).
test("the ^ is read as bytes of the line above it, so text that is not ASCII does not move the column (#1982)", () => {
  const frame = (lines) => parseBacktrace(lines.join("\n"))[0];
  const plus = (f) => f.code[f.failed.index].slice(f.failed.column, f.failed.column + 1);
  // A later line of the function: two bytes an é, three the arrow.
  const later = frame(["  [8]  /w/lib.q:2: uni:{[a]", '  s:"ééé→";b:a+`x;', `${" ".repeat(19)}^`, "  b}"]);
  assert.deepStrictEqual(later.failed, { index: 1, column: 14 });
  assert.strictEqual(plus(later), "+");
  assert.deepStrictEqual(failedAt(later, 'uni:{[a]\n  s:"ééé→";b:a+`x;\n  b}\n'), { line: 1, character: 14 });
  // The header's own line.
  const header = frame(['  [8]  /w/lib.q:15: one:{[a] "é",a+`x}', `${" ".repeat(35)}^`]);
  assert.deepStrictEqual(header.failed, { index: 0, column: 14 });
  assert.strictEqual(plus(header), "+");
  // A character outside the basic plane is four bytes, and two of a line's units.
  const emoji = frame(['  [8]  /w/lib.q:17: emoji:{[a] "😀",a+`x}', `${" ".repeat(39)}^`]);
  assert.deepStrictEqual(emoji.failed, { index: 0, column: 17 });
  assert.strictEqual(plus(emoji), "+");
  // The path's bytes are counted too.
  const path = frame(['  [8]  /w/dé/libé.q:1: pone:{[a] "é",a+`x}', `${" ".repeat(41)}^`]);
  assert.deepStrictEqual([path.file, path.failed], ["/w/dé/libé.q", { index: 0, column: 15 }]);
  assert.strictEqual(plus(path), "+");
  // A frame with no file.
  const bare = frame(['  [8]  {[a] "é",a+`y}', `${" ".repeat(18)}^`]);
  assert.deepStrictEqual(bare.failed, { index: 0, column: 10 });
  assert.strictEqual(plus(bare), "+");
  // A tab is one byte and one character: the ^ line carries it.
  const tabbed = frame(["  [8]  /w/lib.q:5: tabbed:{[a]", "\tb:a+1;\tc:b+`x;", "       \t   ^", "\tc}"]);
  assert.deepStrictEqual(tabbed.failed, { index: 1, column: 11 });
  assert.strictEqual(plus(tabbed), "+");
  // A ^ past the end of the line above it is that far past it.
  assert.deepStrictEqual(frame(["  [8]  /w/lib.q:2: f:{[a]", "  é", "      ^"]).failed, { index: 1, column: 5 });
});

// q prints a frame's header as the name the function has - whole, `.ns.name`
// - a colon and the lambda's own text. The file's line is what was typed:
// the name bare under `\d .ns`, indented, spaced, or one of two on the line.
// The column is the lambda's in the file, not in what q printed (#1983).
test("a frame's header line is placed by its lambda's text in the file, not by the name q prints (#1983)", () => {
  const FILE = [
    "\\d .bt",
    "inner:{[a] a+`x}",
    "\\d .",
    "spaced : {[a] a+`x}",
    "if[1b;",
    "  inif:{[a] a+`x}];",
    "two:{[a] a+`x};  three:{[a] a-`x}",
    "d:`a`b!({[a] a+`x};{[a] a*`x})",
    "\\d .deep",
    "er.leaf2:{[a] a+`x}",
    "\\d .",
    "same:{[a] a+`x}; twin:{[a] a+`x}",
    "(`u`v)!({[a] a+`x};{[a] a+`x})",
    "lead:{[a] b:a+`x;",
    "  b}",
    "",
  ].join("\n");
  const lines = FILE.split("\n");
  // As q prints it: the ^ under `token` of `code`, the header of line `n`.
  const at = (n, code, token) => {
    const head = `  [8]  /w/lib.q:${n}: `;
    const frame = parseBacktrace(`${head}${code}\n${" ".repeat(head.length + code.indexOf(token))}^\n`)[0];
    const found = failedAt(frame, FILE);
    return [found.line + 1, found.character, (lines[found.line] ?? "").slice(found.character, found.character + token.length)];
  };
  assert.deepStrictEqual(at(2, ".bt.inner:{[a] a+`x}", "+`x"), [2, 12, "+`x"]);
  assert.deepStrictEqual(at(4, "spaced:{[a] a+`x}", "+`x"), [4, 15, "+`x"]);
  assert.deepStrictEqual(at(6, "inif:{[a] a+`x}", "+`x"), [6, 13, "+`x"]);
  assert.deepStrictEqual(at(7, "two:{[a] a+`x}", "+`x"), [7, 10, "+`x"]);
  assert.deepStrictEqual(at(7, "three:{[a] a-`x}", "-`x"), [7, 29, "-`x"]);
  assert.deepStrictEqual(at(8, "{[a] a*`x}", "*`x"), [8, 25, "*`x"]);
  assert.deepStrictEqual(at(10, ".deep.er.leaf2:{[a] a+`x}", "+`x"), [10, 15, "+`x"]);
  assert.deepStrictEqual(at(14, ".bt.lead:{[a] b:a+`x;", "+`x"), [14, 13, "+`x"]);
  // Two lambdas of one text on a line: the name says which.
  assert.deepStrictEqual(at(12, "twin:{[a] a+`x}", "+`x"), [12, 28, "+`x"]);
  assert.deepStrictEqual(at(12, "same:{[a] a+`x}", "+`x"), [12, 11, "+`x"]);
  // With no name to say which, or a line that no longer holds the lambda,
  // the line is all that is known.
  assert.deepStrictEqual(at(13, "{[a] a+`x}", "+`x").slice(0, 2), [13, 0]);
  assert.deepStrictEqual(at(1, ".bt.inner:{[a] a+`x}", "+`x").slice(0, 2), [1, 0]);
  assert.deepStrictEqual(at(99, ".bt.inner:{[a] a+`x}", "+`x").slice(0, 2), [99, 0]);
  // Unread, the column is still the one q printed.
  const head = "  [8]  /w/lib.q:2: ";
  assert.deepStrictEqual(failedAt(parseBacktrace(`${head}.bt.inner:{[a] a+\`x}\n${" ".repeat(head.length + 16)}^\n`)[0]), { line: 1, character: 16 });
});
