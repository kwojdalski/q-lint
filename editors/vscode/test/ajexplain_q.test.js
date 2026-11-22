// The aj match explainer's q against a real process (#1050): for each row
// of a left table, the right row it explains is the one aj itself matched -
// or none, with the key that has no rows or the earliest time after the
// row's - and right rows out of time order are flagged. Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { EXPLAIN_AJ, readMatch } = require("../out/ajexplain.js");
const { asCode } = require("../out/processtools.js");

const SERVER = [
  "trade:([] sym:`a`b`a`c`a; time:09:00 09:01 09:02 09:03 08:00t; px:1 2 3 4 5f)",
  "quote:`sym`time xasc ([] sym:`a`a`b; time:08:59 09:01:30 09:00:30t; bid:10 11 12f)",
  "uq:([] sym:`a`a; time:09:01:30 08:59t; bid:11 10f)",
  "",
].join("\n");

test("each row's explained match is the row aj matched", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER);
  const explain = async (i, right = "quote") => readMatch(await connection.call(EXPLAIN_AJ, asCode("`sym`time"), asCode("trade"), asCode(right), i));
  // aj's own answer: the bid each row got, null where none.
  const bids = await connection.call("{[x] aj[`sym`time;trade;quote]`bid}", 0);
  const quoteBids = await connection.call("{[x] quote`bid}", 0);
  for (let i = 0; i < 5; i++) {
    const m = await explain(i);
    if (m.matched < 0) {
      assert.ok(Number.isNaN(bids[i]) || bids[i] === null, `row ${i}`);
    } else {
      assert.strictEqual(quoteBids[m.matched], bids[i], `row ${i}`);
    }
  }
  const c = await explain(3);
  assert.deepStrictEqual([c.candidates, c.missedKey, c.missedValue, c.matched], [0, "sym", "`c", -1]);
  const early = await explain(4);
  assert.deepStrictEqual([early.candidates, early.matched, early.earliest, early.time], [2, -1, "08:59:00.000", "08:00:00.000"]);
  assert.strictEqual(early.sorted, true);
  assert.strictEqual((await explain(2, "uq")).sorted, false);
  await assert.rejects(connection.call(EXPLAIN_AJ, asCode("`sym`time"), asCode("trade"), asCode("quote"), 9), /no row 9 in the left table, which has 5 rows/);
  await assert.rejects(connection.call(EXPLAIN_AJ, asCode("`sym`tm"), asCode("trade"), asCode("quote"), 0), /the left table has no column tm/);
});
