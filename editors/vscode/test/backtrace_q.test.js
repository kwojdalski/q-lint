// A query's backtrace from a real q, as the output shows it (#983): each
// frame of a function loaded from a file points at the line that failed, on
// KDB-X and PeachQ alike. Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { connect, skip } = require("./qserver.js");
const { RUN, readAnswer } = require("../out/query.js");
const { parseBacktrace, failedAt } = require("../out/backtrace.js");

const LIB = ["/ a library", "", "mid:{[a]", "  b:a+1;", "  c:.ns.inner b;", "  c*2}", "\\d .ns", "inner:{[p]", "  q:p+1;", "  q+`x}", "\\d .", ""].join("\n");

test("each frame of a query's backtrace points at the line that failed", { skip }, async (t) => {
  const { connection: c } = await connect(t, "\\l lib.q\n", { "lib.q": LIB });
  const answer = readAnswer(await c.call(RUN, ["mid 1"], [25, 200]));
  assert.strictEqual(answer.ok, false);
  const frames = parseBacktrace(answer.trace).filter((f) => f.file !== undefined);
  assert.deepStrictEqual(
    frames.map((f) => [path.basename(f.file), f.name]),
    [
      ["lib.q", ".ns.inner"],
      ["lib.q", "mid"],
    ],
    answer.trace,
  );
  assert.deepStrictEqual(failedAt(frames[0], LIB), { line: 9, character: 3 }, answer.trace);
  assert.deepStrictEqual(failedAt(frames[1], LIB), { line: 4, character: 4 }, answer.trace);
});

// q counts the ^ in bytes (#1982): the link is still on the token that
// failed when the line, or the file's path, holds text that is not ASCII.
const UNI = ['uni:{[a]', '  s:"ééé→";b:a+`x;', "  b}", 'one:{[a] "é😀",a+`x}', ""].join("\n");

test("a frame whose line holds text that is not ASCII points at the token that failed (#1982)", { skip }, async (t) => {
  const { connection: c } = await connect(t, "\\l libé.q\n", { "libé.q": UNI });
  for (const call of ["uni 1", "one 1"]) {
    const answer = readAnswer(await c.call(RUN, [call], [25, 200]));
    assert.strictEqual(answer.ok, false);
    const frame = parseBacktrace(answer.trace).find((f) => f.file !== undefined);
    assert.strictEqual(path.basename(frame.file), "libé.q", answer.trace);
    const at = failedAt(frame, UNI);
    assert.strictEqual(UNI.split("\n")[at.line].slice(at.character, at.character + 3), "+`x", `${call}: ${JSON.stringify(at)}\n${answer.trace}`);
  }
});
