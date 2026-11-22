// The benchmark's q against a real process (#1048): each expression timed
// by `\ts:N`, K times, its milliseconds and bytes answered; an expression
// that fails stops the benchmark with q's error. Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { BENCHMARK, readTimings, summarise } = require("../out/benchmark.js");
const { asCode } = require("../out/processtools.js");

test("each expression is timed K times by \\ts:N", { skip }, async (t) => {
  const { connection } = await connect(t, "a:til 100000\n");
  const exprs = ["sum a", "sum `float$a"];
  const timings = readTimings(await connection.call(BENCHMARK, exprs.map(asCode), 50, 3), exprs);
  assert.deepStrictEqual(timings.map((x) => [x.times.length, x.spaces.length]), [
    [3, 3],
    [3, 3],
  ]);
  assert.ok(timings.every((x) => x.times.every((ms) => ms >= 0) && x.spaces.every((b) => b > 0)));
  // A one-character expression, and one starting with a backtick, go as code.
  const [one, syms] = readTimings(await connection.call(BENCHMARK, ["a", "`a`b"].map(asCode), 1, 1), ["a", "`a`b"]);
  assert.strictEqual(one.times.length, 1);
  assert.strictEqual(syms.spaces.length, 1);
  assert.strictEqual(summarise([one], 1)[0].ratio, 1);
  await assert.rejects(connection.call(BENCHMARK, [asCode("1+`a")], 1, 1), /type/);
});
