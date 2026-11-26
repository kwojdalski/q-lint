// The aj match explainer's q against a real process (#1050): for each row
// of a left table, the right row it explains is the one aj itself matched -
// or none, with the key that has no rows or the earliest time after the
// row's - and right rows out of time order are flagged. Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { EXPLAIN_AJ, explain: worded, readMatch } = require("../out/ajexplain.js");
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
  // An empty right table, with keys and without: no rows, no key missed (#1909).
  for (const columns of ["`sym`time", "`time"]) {
    const none = readMatch(await connection.call(EXPLAIN_AJ, asCode(columns), asCode("trade"), asCode("0#quote"), 0));
    assert.deepStrictEqual([none.rightRows, none.candidates, none.missedKey, none.matched, none.earliest], [0, 0, "", -1, ""]);
    assert.match(worded({ fn: "aj", columns, left: "trade", right: "0#quote" }, 0, "p", none), /No match: 0#quote has no rows\./);
  }
  await assert.rejects(connection.call(EXPLAIN_AJ, asCode("`sym`time"), asCode("trade"), asCode("quote"), 9), /no row 9 in the left table, which has 5 rows/);
  await assert.rejects(connection.call(EXPLAIN_AJ, asCode("`sym`tm"), asCode("trade"), asCode("quote"), 0), /the left table has no column tm/);
});

// `0!` of a symbol unkeys the global it names in place: an explanation of
// aj[`sym`time;trade;`kq] left the user's keyed table unkeyed, and explained
// a match for a call q's own aj refuses with 'type (#2981).
test("a table written as its name is refused as aj refuses it, and the table it names is left keyed (#2981)", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER + "kq:`sym`time xkey quote\n");
  const keys = async () => await connection.call("{[x] string keys`kq}", 0);
  assert.deepStrictEqual(await keys(), ["sym", "time"]);
  // q's own aj refuses the name (and unkeys what it names on the way, so it is asked of a copy).
  await assert.rejects(connection.call("{[x] `kq2 set kq; aj[`sym`time;trade;`kq2]}", 0), /type/);
  await assert.rejects(connection.call(EXPLAIN_AJ, asCode("`sym`time"), asCode("trade"), asCode("`kq"), 0), /the right table is the symbol `kq: aj takes a table, not the name of one/);
  await assert.rejects(connection.call(EXPLAIN_AJ, asCode("`sym`time"), asCode("`trade"), asCode("quote"), 0), /the left table is the symbol `trade/);
  assert.deepStrictEqual(await keys(), ["sym", "time"]);
  // The keyed table itself is explained as aj joins it.
  const m = readMatch(await connection.call(EXPLAIN_AJ, asCode("`sym`time"), asCode("trade"), asCode("kq"), 0));
  assert.strictEqual(m.matched, 0);
  assert.deepStrictEqual(await keys(), ["sym", "time"]);
});
