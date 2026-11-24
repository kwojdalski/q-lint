// The system settings view's q against a real process (#1043): every
// setting is read; an edit sets one and answers it as it now reads; a
// setting the view does not edit, or a value with anything but digits,
// signs, 0N and spaces, is refused there before `system` sees it. Needs
// QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { READ_SETTINGS, SET_SETTING, readSettings, memoryText } = require("../out/syssettings.js");

test("every setting is read, and an edit sets one", { skip }, async (t) => {
  const { connection } = await connect(t, "a:1\n");
  const values = readSettings(await connection.call(READ_SETTINGS, 0));
  assert.deepStrictEqual([...values.keys()], [..."csPTgozw"]);
  assert.match(values.get("c"), /^\d+ (\d+|0N)$/);
  assert.strictEqual(values.get("P"), "7");
  assert.strictEqual(values.get("o"), "0N");
  assert.match(memoryText(values.get("w")), /^used /);
  assert.strictEqual(await connection.call(SET_SETTING, "P", "10"), "10");
  assert.strictEqual(await connection.call(SET_SETTING, "c", "30 100"), "30 100");
  assert.strictEqual(await connection.call(SET_SETTING, "o", "-5"), "-5");
  assert.strictEqual(await connection.call(SET_SETTING, "T", "3"), "3");
  assert.strictEqual(readSettings(await connection.call(READ_SETTINGS, 0)).get("P"), "10");
});

test("a setting it does not edit, or a value it does not send, is refused", { skip }, async (t) => {
  const { connection } = await connect(t, "a:1\n");
  await assert.rejects(connection.call(SET_SETTING, "w", "100"), /not a setting this view edits/);
  await assert.rejects(connection.call(SET_SETTING, "l", "x.q"), /not a setting this view edits/);
  // \s among them (#1916): KDB-X takes it "from handle 0 only", so the
  // view's own refusal is what is said, and `system` never sees it.
  await assert.rejects(connection.call(SET_SETTING, "s", "0"), /not a setting this view edits/);
  await assert.rejects(connection.call(SET_SETTING, "P", "1;exit 0"), /not a value this view sends/);
  assert.strictEqual(await connection.call("{[x] \"f\"$a}", 0), 1);
});
