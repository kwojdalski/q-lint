// The join assistant's q against a real process (#1049): a table's shape -
// columns, types, attributes, keys, where it lives - read without touching
// its rows, a query's too, and something that is no table refused; then
// every join suggested for those tables is run there, and each answers a
// table. Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { TABLES, TABLE_SHAPE, readShape, suggestJoins, tableExpression } = require("../out/joinassist.js");
const { asCode } = require("../out/processtools.js");

const SERVER = [
  "trade:([] sym:`a`b`a; time:09:00 09:01 09:02t; px:1 2 3f)",
  "quote:([] sym:`a`a`b; time:08:59 09:01:30 09:00:30t; bid:10 11 12f)",
  "ref:([sym:`a`b] sector:`x`y)",
  "gq:update `g#sym from `sym`time xasc quote",
  "",
].join("\n");

test("shapes are read, and every join suggested runs and answers a table", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER);
  assert.deepStrictEqual(await connection.call(TABLES, 0), ["gq", "quote", "ref", "trade"]);
  const shape = async (e) => readShape(await connection.call(TABLE_SHAPE, asCode(e)), e);
  const trade = await shape("trade");
  assert.deepStrictEqual(trade, { expression: "trade", columns: ["sym", "time", "px"], types: "stf", attributes: ["", "", ""], keys: [], where: "memory" });
  const ref = await shape("ref");
  assert.deepStrictEqual(ref.keys, ["sym"]);
  const gq = await shape("gq");
  assert.deepStrictEqual(gq.attributes, ["g", "", ""]);
  assert.deepStrictEqual((await shape("select from trade where sym=`a")).columns, ["sym", "time", "px"]);
  await assert.rejects(connection.call(TABLE_SHAPE, asCode("1 2 3")), /not a table/);

  const pairs = [
    [trade, await shape("quote")],
    [trade, ref],
    [trade, gq],
  ];
  let ran = 0;
  for (const [l, r] of pairs) {
    for (const s of suggestJoins(l, r)) {
      const isTable = await connection.call(`{[x] 98h=type 0!value x}`, asCode(s.expression));
      assert.strictEqual(isTable, true, s.expression);
      // No two columns of one name: wj's max and min are told apart (#1573).
      assert.strictEqual(await connection.call(`{[x] c~distinct c:cols value x}`, asCode(s.expression)), true, s.expression);
      ran++;
    }
  }
  assert.ok(ran >= 9, `${ran} joins run`);
});

// A picked name q would not parse is read by its symbol, in the joins too (#1572).
test("a picked table whose name has a space is read and joined", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER + '(`$"my trade") set trade;\n');
  const shape = async (e) => readShape(await connection.call(TABLE_SHAPE, asCode(e)), e);
  const mine = await shape(tableExpression("my trade"));
  assert.deepStrictEqual(mine.columns, ["sym", "time", "px"]);
  for (const s of suggestJoins(mine, await shape("ref"))) {
    assert.strictEqual(await connection.call(`{[x] 98h=type 0!value x}`, asCode(s.expression)), true, s.expression);
  }
});

// A view's name is not evaluated to see whether it is a table (#1865); a
// query over one is the user's own, and runs.
test("a view named as a table is refused, not evaluated (#1865)", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER + "spy::select from trade\nbad::1+`a\n");
  const pending = () => connection.call('{[x] string system"B"}', 0);
  for (const name of ["spy", "bad"]) {
    await assert.rejects(connection.call(TABLE_SHAPE, asCode(name)), /a view, not a table/);
  }
  assert.deepStrictEqual(await pending(), ["bad", "spy"]);
  assert.deepStrictEqual(readShape(await connection.call(TABLE_SHAPE, asCode("select from spy")), "q").columns, ["sym", "time", "px"]);
});

test("lj and ij on an unkeyed right table keep the left table's own time, joining only the right's own columns (#2408)", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER);
  const shape = async (e) => readShape(await connection.call(TABLE_SHAPE, asCode(e)), e);
  const joins = suggestJoins(await shape("trade"), await shape("quote"));
  for (const join of ["lj", "ij"]) {
    const s = joins.find((j) => j.join === join);
    assert.match(s.why, /replace trade's time/);
    const same = await connection.evaluate(`{r:value x;(cols[r]~\`sym\`time\`px\`bid)&(exec time from r)~exec time from trade where sym in quote\`sym}${JSON.stringify(s.expression)}`);
    assert.strictEqual(same.value, true, s.expression);
  }
});

// q joins no partitioned table on the left: lj and ij signalled 'splay,
// aj 'date. The left is written as one partition of it (#2539).
test("every join suggested with a partitioned table on the left runs", { skip }, async (t) => {
  const source = [
    'r:hsym`$"$DIR/hdb";',
    "{[r;d] .Q.dd[r;d,`trade`] set .Q.en[r] ([] sym:`a`b`a; time:09:00 09:01 09:02t; px:1 2 3f)}[r] each 2026.01.05 2026.01.06;",
    "\\l $DIR/hdb",
    "ks:([sym:`a`b] sector:`x`y)",
    "q2:([] sym:`a`a`b; date:3#2026.01.06; time:08:59 09:01:30 09:00:30t; bid:10 11 12f)",
    "",
  ].join("\n");
  const { connection } = await connect(t, source);
  const shape = async (e) => readShape(await connection.call(TABLE_SHAPE, asCode(e)), e);
  const trade = await shape("trade");
  assert.strictEqual(trade.where, "partitioned");
  let ran = 0;
  for (const right of [await shape("ks"), await shape("q2")]) {
    for (const s of suggestJoins(trade, right)) {
      const answer = await connection.call("{[x] r:@[{(1b;value x)};x;{(0b;x)}]; $[r 0;98h=type 0!r 1;r 1]}", asCode(s.expression));
      assert.strictEqual(answer, true, `${s.expression} => ${answer}`);
      assert.match(s.why, /trade is partitioned, which q joins only one partition of at a time/, s.join);
      ran++;
    }
  }
  assert.ok(ran >= 4, `${ran} joins run`);
});
