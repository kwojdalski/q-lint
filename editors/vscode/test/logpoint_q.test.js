// Logpoints against a real q (#984): a function's calls are printed with 0N!
// and kept, it answers as before, and removing the logpoint puts back the
// very function it replaced - in its own context - with .qlint empty.
// Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { LOG_ADD, LOG_REMOVE, LOG_LIST, readLogpoints } = require("../out/logpoint.js");

const SRC = "\\d .fx\nmid:{[bid;ask] scale*(bid+ask)%2}\nscale:1f\n\\d .\nsq:{x*x}\nnow:{[] 42}\n";
const value = async (c, text) => (await c.evaluate(text)).value;

test("a logpoint logs each call and comes off leaving the function as it was", { skip }, async (t) => {
  const { connection: c, output } = await connect(t, SRC);
  const before = await value(c, "{.Q.s1 value each x}`.fx.mid`sq`now");
  for (const name of [".fx.mid", "sq", "now"]) {
    assert.strictEqual(await c.call(LOG_ADD, name), name);
  }
  // The wrapped functions answer as before; .fx.mid still reads .fx.scale.
  assert.strictEqual(Number(await value(c, ".fx.mid[1f;2f]")), 1.5);
  assert.strictEqual(Number(await value(c, "sq 3")), 9);
  assert.strictEqual(Number(await value(c, "now[]")), 42);
  // A second logpoint on one function is refused.
  await assert.rejects(c.call(LOG_ADD, "sq"), /it has a logpoint already/);
  await assert.rejects(c.call(LOG_ADD, ".fx.scale"), /not a lambda on the process/);
  const { names, hits } = readLogpoints(await c.call(LOG_LIST));
  assert.deepStrictEqual(names, [".fx.mid", "sq", "now"]);
  assert.deepStrictEqual(hits.map((h) => [h.name, h.args]), [
    [".fx.mid", "1 2f"],
    ["sq", ",3"],
    ["now", ",::"],
  ]);
  // Printed by the process.
  for (let i = 0; i < 20 && !/`sq/.test(output()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(output(), /`\.fx\.mid/);
  assert.match(output(), /`sq/);
  // Redefined meanwhile: left as it is.
  await value(c, "sq:{x*x*x}");
  assert.strictEqual(await c.call(LOG_REMOVE, "sq"), false);
  assert.strictEqual(await value(c, "last value sq"), "{x*x*x}");
  await value(c, "sq:{x*x}");
  assert.strictEqual(await c.call(LOG_REMOVE, ".fx.mid"), true);
  assert.strictEqual(await c.call(LOG_REMOVE, "now"), true);
  await assert.rejects(c.call(LOG_REMOVE, "now"), /it has no logpoint/);
  assert.strictEqual(await value(c, "{.Q.s1 value each x}`.fx.mid`sq`now"), before);
  assert.strictEqual(await value(c, "key[`.qlint]~enlist`"), true);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)), { names: [], hits: [] });
});

test("the last logpoint off leaves .qlint empty, and a root variable named qlint alone (#1871)", { skip }, async (t) => {
  const { connection: c } = await connect(t, SRC + "qlint:7\n.qlint.cache.p1:42\n");
  for (const name of ["sq", "now"]) await c.call(LOG_ADD, name);
  assert.strictEqual(await c.call(LOG_REMOVE, "sq"), true);
  // One logpoint is left: its state stays.
  assert.strictEqual(await value(c, "(key .qlint.log.orig)~enlist`now"), true);
  assert.strictEqual(await c.call(LOG_REMOVE, "now"), true);
  // What else q-lint keeps there is kept, and the user's own `qlint` too.
  assert.strictEqual(await value(c, "(key[`.qlint]~``cache)&(.qlint.cache.p1~42)&qlint~7"), true);
  // With nothing else there .qlint is empty: q cannot remove a context.
  await value(c, ".qlint:(enlist`cache)_.qlint");
  await c.call(LOG_ADD, "sq");
  assert.strictEqual(await c.call(LOG_REMOVE, "sq"), true);
  assert.strictEqual(await value(c, "(key[`.qlint]~enlist`)&qlint~7"), true);
});

test("a logpoint leaves its function callable where q refuses a global write: under reval the call is not kept, and still answers (#1894)", { skip }, async (t) => {
  const { connection: c } = await connect(t, SRC);
  const call = "reval(`sq;3)";
  assert.strictEqual(Number(await value(c, call)), 9);
  assert.strictEqual(await c.call(LOG_ADD, "sq"), "sq");
  // A gateway's read-only evaluation: the wrapper's own write is refused
  // ('noupdate), and that is not the caller's error.
  assert.strictEqual(Number(await value(c, call)), 9);
  assert.strictEqual(Number(await value(c, "reval(`.fx.mid;1f;2f)")), 1.5);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).hits, []);
  // Where it can write, the call is kept as before.
  assert.strictEqual(Number(await value(c, "sq 4")), 16);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).hits.map((h) => [h.name, h.args]), [["sq", ",4"]]);
  // What the function itself signals still reaches the caller.
  await assert.rejects(value(c, "sq`a"), /type/);
  assert.strictEqual(await c.call(LOG_REMOVE, "sq"), true);
  assert.strictEqual(await value(c, "key[`.qlint]~enlist`"), true);
});

// A typed or pattern parameter list: `(value f)1` is `0`1, no names to bind,
// and the wrapper built from it made every call fail with 'match (#2406).
test("a logpoint on a function with typed or pattern parameters leaves it answering as before (#2406)", { skip }, async (t) => {
  const { connection: c } = await connect(t, "f:{[x:`j;y:`j] x+y}\ng:{[(a;b)] a+b}\nk:{[(a;b);c] a+b+c}\n");
  for (const name of ["f", "g", "k"]) {
    assert.strictEqual(await c.call(LOG_ADD, name), name);
  }
  assert.strictEqual(Number(await value(c, "f[1;2]")), 3);
  assert.strictEqual(Number(await value(c, "g 1 2")), 3);
  assert.strictEqual(Number(await value(c, "k[1 2;3]")), 6);
  // The function's own check still applies.
  await assert.rejects(value(c, "f[1;2f]"), /type/);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).hits.map((h) => [h.name, h.args]), [
    ["f", "1 2"],
    ["g", ",1 2"],
    ["k", "(1 2;3)"],
    ["f", "(1;2f)"],
  ]);
  for (const name of ["f", "g", "k"]) {
    assert.strictEqual(await c.call(LOG_REMOVE, name), true);
  }
});
