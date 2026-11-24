// Find in processes' q against a real process (#1046): every lambda of the
// root and of every namespace, nested ones too, is searched ignoring case;
// ss's wildcards are taken as written; variable names only when asked; q's
// own namespaces never; and the limit holds. Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { SEARCH, readFound } = require("../out/procsearch.js");

const SERVER = [
  ".lib.f:{[x]",
  "  y:x[1]?2;",
  "  Trade:select from trade;",
  "  y}",
  ".lib.sub.g:{trade}",
  "top:{count trade}",
  "tradeCount:5",
  ".lib.upd:{insert[`quote;x]}",
  ".lib.tradeVar:1",
  "",
].join("\n");

test("function definitions are searched everywhere but q's own, ignoring case", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER);
  const find = async (text, vars, limit = 100) => readFound(await connection.call(SEARCH, text, vars, limit));
  const found = await find("trade", false);
  assert.deepStrictEqual(found.hits.map((h) => [h.name, h.line, h.text]), [
    ["top", 1, "{count trade}"],
    [".lib.f", 3, "  Trade:select from trade;"],
    [".lib.sub.g", 1, "{trade}"],
  ]);
  assert.strictEqual(found.more, false);
  const withVars = await find("trade", true);
  assert.deepStrictEqual(withVars.hits.filter((h) => h.kind === "variable").map((h) => h.name), ["tradeCount", ".lib.tradeVar"]);
  // Wildcards are text.
  assert.deepStrictEqual((await find("x[1]?", false)).hits.map((h) => h.text), ["  y:x[1]?2;"]);
  assert.deepStrictEqual((await find("zzz", true)).hits, []);
  // A text starting with a backtick reaches q as a symbol, and is searched as text.
  assert.deepStrictEqual((await find("`quote", false)).hits.map((h) => h.name), [".lib.upd"]);
  // q's own namespaces are not searched: every brace found is in ours.
  assert.ok((await find("{", false)).hits.every((h) => !/^\.(q|Q|h|j|o|z)\./.test(h.name)));
  const two = await find("trade", true, 2);
  assert.strictEqual(two.hits.length, 2);
  assert.strictEqual(two.more, true);
  // Exactly the limit found, and nothing more: not "more" (#1689).
  const three = await find("trade", false, 3);
  assert.strictEqual(three.hits.length, 3);
  assert.strictEqual(three.more, false);
  const one = await find("trade", false, 1);
  assert.deepStrictEqual([one.hits.length, one.more], [1, true]);
  // Nothing was assigned.
  assert.deepStrictEqual(await connection.call("{[x] key `.}", 0), ["top", "tradeCount"]);
});

// A view has a lambda's type, 100h, and reading it by name evaluates it:
// it is neither searched as a function nor run (#1864).
test("a process with views is searched, and no view is evaluated (#1864)", { skip }, async (t) => {
  const { connection } = await connect(t, SERVER + "trade:([] a:1 2)\nspy::select from trade\nbad::1+`a\n");
  const pending = () => connection.call('{[x] string system"B"}', 0);
  assert.deepStrictEqual(await pending(), ["bad", "spy"]);
  // As many functions as the same process has without its views.
  const plain = readFound(await (await connect(t, SERVER)).connection.call(SEARCH, "trade", false, 100));
  for (const vars of [false, true]) {
    const found = readFound(await connection.call(SEARCH, "trade", vars, 100));
    assert.deepStrictEqual(found.hits.filter((h) => h.kind === "function").map((h) => h.name), ["top", ".lib.f", ".lib.sub.g"]);
    assert.strictEqual(found.scanned, plain.scanned);
  }
  assert.deepStrictEqual(await pending(), ["bad", "spy"]);
});
