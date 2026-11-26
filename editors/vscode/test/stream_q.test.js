// What a tickerplant's one-row update is on the wire, read by `readUpdate`
// (#1921): q makes a list of atoms of one type a simple list, so a row of
// two floats, two symbols, two chars or one column's one value is not the
// general list a row of mixed atoms is. Needs a q binary, so it runs only
// when QLINT_TEST_Q names one.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { decode } = require("../out/qdecode.js");
const { readUpdate } = require("../out/stream.js");

test("a one-row update is read whatever its atoms' types", { skip }, async (t) => {
  const { connection: c } = await connect(t, "");
  const rows = async (data, columns) => readUpdate(decode((await c.evaluate(`(\`upd;\`px;${data})`)).message), "px", columns);
  assert.deepStrictEqual(await rows("(`a;2.5)", ["sym", "bid"]), [["a", "2.5"]]);
  assert.deepStrictEqual(await rows("(1.5;2.5)", ["bid", "ask"]), [["1.5", "2.5"]]);
  assert.deepStrictEqual(await rows("(`a;`b)", ["sym", "src"]), [["a", "b"]]);
  assert.deepStrictEqual(await rows('("B";"x")', ["side", "flag"]), [["B", "x"]]);
  assert.deepStrictEqual(await rows("enlist 1.5", ["bid"]), [["1.5"]]);
  assert.deepStrictEqual(await rows("(2026.01.02D03:04:05.000000006;2026.01.02D03:04:05.000000007)", ["time", "sent"]), [["2026.01.02D03:04:05.000000006", "2026.01.02D03:04:05.000000007"]]);
  // And what q's own insert takes as that one row.
  assert.strictEqual((await c.evaluate("t:([]a:`float$();b:`float$()); `t insert 1.5 2.5; 1=count t")).value, true);
  assert.strictEqual((await c.evaluate('@[{`t insert x};1.5 2.5 3.5;{x}]')).value, "length");
});

// A TorQ STP has no .u.t, publishes from pubsub.q's .stpps.t, and its .u.sub
// answers a table it does not publish with (x;reason), as pubsub.q does
// (#2586).
test("a TorQ STP's pick list is the tables it publishes, and its refusal is shown", { skip }, async (t) => {
  const { TABLES, SUBSCRIBE } = require("../out/stream.js");
  const { connection: c } = await connect(
    t,
    [
      "trade:([]time:`timespan$();sym:`$();px:`float$());",
      "currlog:([tbl:`$()]logname:`$();handle:`int$());",
      ".stpps.t:enlist`trade;",
      '.u.sub:{[x;y] if[not x in .stpps.t;:(x;"Table ",string[x]," not in list of stp pub/sub tables")];(x;0#value x)};',
      "",
    ].join("\n"),
  );
  assert.deepStrictEqual([].concat(await c.call(TABLES)), ["trade"]);
  assert.deepStrictEqual(await c.call(SUBSCRIBE, "`trade"), ["trade", ["time", "sym", "px"], "nsf"]);
  await assert.rejects(c.call(SUBSCRIBE, "`currlog"), /Table currlog not in list of stp pub\/sub tables/);
});
