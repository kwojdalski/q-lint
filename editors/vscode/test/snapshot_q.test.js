// A snapshot's result against a real q (#981): printed at the fixed console,
// so `\c` does not change it, and the same on KDB-X and PeachQ. Needs
// QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { readAnswer } = require("../out/query.js");
const { SNAPSHOT_RUN, sameResult, formatSnapshot, parseSnapshot } = require("../out/snapshot.js");
const { statements } = require("../out/statements.js");

test("a query's snapshot is its printed result, whatever \\c is", { skip }, async (t) => {
  const { connection: c } = await connect(t, "t:([] a:1 2 3; b:`x`y`z)\n\\c 12 20\n");
  const query = "select from t where a>1";
  const answer = readAnswer(await c.call(SNAPSHOT_RUN, statements(query)));
  assert.strictEqual(answer.ok, true);
  const result = answer.text.join("\n");
  assert.ok(sameResult(result, "a b\n---\n2 y\n3 z"), JSON.stringify(result));
  // Recorded and read back, it compares the same; a change does not.
  const file = parseSnapshot(formatSnapshot({ query, result }));
  await c.evaluate("t:([] a:1 2 4; b:`x`y`z)");
  const again = readAnswer(await c.call(SNAPSHOT_RUN, statements(file.query)));
  assert.strictEqual(sameResult(again.text.join("\n"), file.result), false);
  // A long list is printed whole, not cut at \c.
  const long = readAnswer(await c.call(SNAPSHOT_RUN, ["til 300"]));
  assert.match(long.text.join("\n"), /299$/);
  // \c is put back, after an error too.
  const failed = readAnswer(await c.call(SNAPSHOT_RUN, ["1+`a"]));
  assert.deepStrictEqual([failed.ok, failed.error], [false, "type"]);
  assert.deepStrictEqual((await c.evaluate("system \"c\"")).value.map(Number), [12, 20]);
});

// Printed at 2000 by 2000, a longer or wider result is cut, and a change
// past the cut left the snapshot passing (#2454).
test("a result longer or wider than a snapshot holds is said to be cut; one that fits is not (#2454)", { skip }, async (t) => {
  const { snapshotCut } = require("../out/snapshot.js");
  const { connection: c } = await connect(t, "");
  const cut = async (query) => snapshotCut(readAnswer(await c.call(SNAPSHOT_RUN, [query])).text);
  assert.match(await cut("([] a:til 3000)"), /longer than the 2000 lines/);
  assert.match(await cut("3000#\"x\""), /wider than the 2000 characters/);
  assert.match(await cut("([] s:enlist 2500#\"x\")"), /wider/);
  for (const fits of ["([] a:til 1998)", "1997#\"x\"", "til 300", "([] a:1 2)"]) {
    assert.strictEqual(await cut(fits), undefined, fits);
  }
});
