// Logpoints against a real q (#984): a function's calls are printed with 0N!
// and kept, it answers as before, and removing the logpoint puts back the
// very function it replaced - in its own context - with .qlint empty.
// Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { LOG_REMOVE, LOG_LIST, addLogpoint, readLogpoints } = require("../out/logpoint.js");

const SRC = "\\d .fx\nmid:{[bid;ask] scale*(bid+ask)%2}\nscale:1f\n\\d .\nsq:{x*x}\nnow:{[] 42}\n";
const value = async (c, text) => (await c.evaluate(text)).value;
/// Add Logpoint, as logpointview.ts sends it.
const add = (c, name) => addLogpoint((...sent) => c.call(...sent), name);

test("a logpoint logs each call and comes off leaving the function as it was", { skip }, async (t) => {
  const { connection: c, output } = await connect(t, SRC);
  const before = await value(c, "{.Q.s1 value each x}`.fx.mid`sq`now");
  for (const name of [".fx.mid", "sq", "now"]) {
    assert.strictEqual(await add(c, name), name);
  }
  // The functions answer as before; .fx.mid still reads .fx.scale.
  assert.strictEqual(Number(await value(c, ".fx.mid[1f;2f]")), 1.5);
  assert.strictEqual(Number(await value(c, "sq 3")), 9);
  assert.strictEqual(Number(await value(c, "now[]")), 42);
  // A second logpoint on one function is refused.
  await assert.rejects(add(c, "sq"), /it has a logpoint already/);
  await assert.rejects(add(c, ".fx.scale"), /not a lambda on the process/);
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

// Redefined, the logpoint is gone: it was still listed, and Add Logpoint
// refused the name (#2558).
test("a function redefined since its logpoint is listed with none, and takes a new one", { skip }, async (t) => {
  const { connection: c } = await connect(t, SRC);
  assert.strictEqual(await add(c, "sq"), "sq");
  await value(c, "sq:{x*x*x}");
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).names, []);
  assert.strictEqual(await add(c, "sq"), "sq");
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).names, ["sq"]);
  assert.strictEqual(Number(await value(c, "sq 2")), 8);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).hits.map((h) => [h.name, h.args]), [["sq", ",2"]]);
  await assert.rejects(add(c, "sq"), /it has a logpoint already/);
  assert.strictEqual(await c.call(LOG_REMOVE, "sq"), true);
  assert.strictEqual(await value(c, "last value sq"), "{x*x*x}");
});

test("a hit keeps 300 characters of its arguments, not the process's \\c width (#2547)", { skip }, async (t) => {
  const { connection: c } = await connect(t, SRC + "two:{[a;b] b}\n");
  await add(c, "two");
  assert.strictEqual(await value(c, "two[til 100;`abc]"), "abc");
  const [hit] = readLogpoints(await c.call(LOG_LIST)).hits;
  assert.ok(hit.args.length > 79, hit.args);
  assert.match(hit.args, /^\(0 1 2 .* 98 99;`abc\)$/);
  assert.strictEqual(await c.call(LOG_REMOVE, "two"), true);
});

test("the last logpoint off leaves .qlint empty, and a root variable named qlint alone (#1871)", { skip }, async (t) => {
  const { connection: c } = await connect(t, SRC + "qlint:7\n.qlint.cache.p1:42\n");
  for (const name of ["sq", "now"]) await add(c, name);
  assert.strictEqual(await c.call(LOG_REMOVE, "sq"), true);
  // One logpoint is left: its state stays.
  assert.strictEqual(await value(c, "(key .qlint.log.saved)~enlist`now"), true);
  assert.strictEqual(await c.call(LOG_REMOVE, "now"), true);
  // What else q-lint keeps there is kept, and the user's own `qlint` too.
  assert.strictEqual(await value(c, "(key[`.qlint]~``cache)&(.qlint.cache.p1~42)&qlint~7"), true);
  // With nothing else there .qlint is empty: q cannot remove a context.
  await value(c, ".qlint:(enlist`cache)_.qlint");
  await add(c, "sq");
  assert.strictEqual(await c.call(LOG_REMOVE, "sq"), true);
  assert.strictEqual(await value(c, "(key[`.qlint]~enlist`)&qlint~7"), true);
});

test("a logpoint leaves its function callable where q refuses a global write: under reval the call is not kept, and still answers (#1894)", { skip }, async (t) => {
  const { connection: c } = await connect(t, SRC);
  const call = "reval(`sq;3)";
  assert.strictEqual(Number(await value(c, call)), 9);
  assert.strictEqual(await add(c, "sq"), "sq");
  // A gateway's read-only evaluation: the logpoint's own write is refused
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
// and a wrapper built from it made every call fail with 'match (#2406).
test("a logpoint on a function with typed or pattern parameters leaves it answering as before (#2406)", { skip }, async (t) => {
  const { connection: c } = await connect(t, "f:{[x:`j;y:`j] x+y}\ng:{[(a;b)] a+b}\nk:{[(a;b);c] a+b+c}\n");
  for (const name of ["f", "g", "k"]) {
    assert.strictEqual(await add(c, name), name);
  }
  assert.strictEqual(Number(await value(c, "f[1;2]")), 3);
  assert.strictEqual(Number(await value(c, "g 1 2")), 3);
  assert.strictEqual(Number(await value(c, "k[1 2;3]")), 6);
  // The function's own check still applies: the call never starts, and is not logged.
  await assert.rejects(value(c, "f[1;2f]"), /type/);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).hits.map((h) => [h.name, h.args]), [
    ["f", "1 2"],
    ["g", ",1 2"],
    ["k", "(1 2;3)"],
  ]);
  for (const name of ["f", "g", "k"]) {
    assert.strictEqual(await c.call(LOG_REMOVE, name), true);
  }
});

// The logpoint was a wrapper that called the function: two frames of q's
// stack for each call, so a recursion q runs at depth 1199 failed with
// 'stack once it had a logpoint (#2979).
test("a logpoint adds no depth to a recursion: one 1500 deep still runs, each call logged (#2979)", { skip }, async (t) => {
  const { connection: c } = await connect(t, ".ns.r:{$[x=0;0;1+.ns.r x-1]}\n.ns.fact:{$[x<2;1;x*.z.s x-1]}\n");
  assert.strictEqual(Number(await value(c, ".ns.r 1500")), 1500);
  assert.strictEqual(await add(c, ".ns.r"), ".ns.r");
  assert.strictEqual(Number(await value(c, ".ns.r 1500")), 1500);
  const hits = readLogpoints(await c.call(LOG_LIST)).hits;
  assert.strictEqual(hits.length, 1000);
  assert.deepStrictEqual([hits[0], hits[999]].map((h) => [h.name, h.args]), [[".ns.r", ",999"], [".ns.r", ",0"]]);
  assert.strictEqual(await c.call(LOG_REMOVE, ".ns.r"), true);
  assert.strictEqual(await value(c, "last value .ns.r"), "{$[x=0;0;1+.ns.r x-1]}");
  // A call the function makes of itself through .z.s is a call of it too.
  assert.strictEqual(await add(c, ".ns.fact"), ".ns.fact");
  assert.strictEqual(Number(await value(c, ".ns.fact 4")), 24);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).hits.map((h) => h.args), [",4", ",3", ",2", ",1"]);
  assert.strictEqual(await c.call(LOG_REMOVE, ".ns.fact"), true);
});

// A reference taken while the logpoint was on held the wrapper, which read
// `.qlint.log.*` by name: with the last logpoint removed every call through
// it failed with '.qlint.log.text (#2974).
test("a reference taken to a function with a logpoint keeps answering once the logpoint is removed (#2974)", { skip }, async (t) => {
  const { connection: c } = await connect(t, ".ns.tick:{[x] x+1}\nsq:{x*x}\n");
  assert.strictEqual(await add(c, ".ns.tick"), ".ns.tick");
  assert.strictEqual(Number(await value(c, "handler:.ns.tick; handler 1")), 2);
  assert.strictEqual(await c.call(LOG_REMOVE, ".ns.tick"), true);
  assert.strictEqual(await value(c, "key[`.qlint]~enlist`"), true);
  // The handler holds the text with the logging in it: it answers, unlogged.
  assert.strictEqual(Number(await value(c, "handler 5")), 6);
  assert.strictEqual(Number(await value(c, ".ns.tick 5")), 6);
  // And stays unlogged while another function has a logpoint.
  assert.strictEqual(await add(c, "sq"), "sq");
  assert.strictEqual(Number(await value(c, "handler 7")), 8);
  assert.strictEqual(Number(await value(c, "sq 3")), 9);
  assert.deepStrictEqual(readLogpoints(await c.call(LOG_LIST)).hits.map((h) => [h.name, h.args]), [["sq", ",3"]]);
  assert.strictEqual(await c.call(LOG_REMOVE, "sq"), true);
  assert.strictEqual(Number(await value(c, "handler 9")), 10);
});
