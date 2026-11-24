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
