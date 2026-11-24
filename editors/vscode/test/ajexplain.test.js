// The aj match explainer (#1050): the call found in code, the answer read,
// the explanation worded for a match, a key with no rows, a time before
// every row and right rows out of order - and, through the stand-in
// `vscode` and a fake q: off, the command refuses and nothing is sent; on,
// the match is re-run through the read-only guard and shown. The q side is
// ajexplain_q.test.js.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { setUp } = require("./fakeq.js");
const { EXPLAIN_AJ, explain, findAj, readMatch } = require("../out/ajexplain.js");
const { registerAjExplainer } = require("../out/ajexplainview.js");
const { PROCESS_TOOL_COMMANDS } = require("../out/processtools.js");
const pkg = require("../package.json");

test("the aj call is found, its arguments as written", () => {
  assert.deepStrictEqual(findAj("r:aj[`sym`time;trade;select from quote where sym in `a`b]"), {
    fn: "aj",
    columns: "`sym`time",
    left: "trade",
    right: "select from quote where sym in `a`b",
  });
  assert.deepStrictEqual(findAj('aj0[c;t;{x}[q;";"]]'), { fn: "aj0", columns: "c", left: "t", right: '{x}[q;";"]' });
  assert.strictEqual(findAj("taj[a;b;c]"), undefined);
  assert.strictEqual(findAj("aj[a;b]"), undefined);
  assert.strictEqual(findAj("lj[a;b;c]"), undefined);
});

const call = { fn: "aj", columns: "`sym`time", left: "trade", right: "quote" };
const match = (over) => ({ row: "`sym`time!(`a;09:02)", candidates: 2, missedKey: "", missedValue: "", matched: 1, matchedRow: "`sym`time`bid!(`a;09:01;11f)", earliest: "08:59", time: "09:02", sorted: true, timeColumn: "time", rightRows: 3, ...over });

test("the answer is read and the explanation worded for each outcome", () => {
  const raw = ["`sym`px!(`a;1f)", 2, "", "", 1, "row", "08:59", "09:02", true, "time", 3];
  assert.strictEqual(readMatch(raw).matched, 1);
  assert.strictEqual(readMatch(["r", 0, "sym", "`c", -1, [], [], "t", true, "time", 3]).missedKey, "sym");
  assert.throws(() => readMatch(["r"]), /a match/);
  assert.match(explain(call, 2, "rdb", match({})), /Matched row 1 of quote: `sym`time`bid!\(`a;09:01;11f\)[\s\S]*last of the 2 rows with the same keys whose time is at or before 09:02/);
  assert.match(explain(call, 3, "rdb", match({ candidates: 0, missedKey: "sym", missedValue: "`c", matched: -1 })), /none of the 3 rows of quote has sym = `c/);
  assert.match(explain(call, 4, "rdb", match({ matched: -1, time: "08:00" })), /earliest, at time = 08:59, is after this row's time = 08:00/);
  assert.match(explain(call, 2, "rdb", match({ sorted: false })), /not in time order/);
  // An empty right table has no row to be earliest and no key to miss (#1909).
  const empty = explain(call, 0, "rdb", match({ candidates: 0, matched: -1, matchedRow: "", earliest: "", rightRows: 0 }));
  assert.match(empty, /No match: quote has no rows\./);
  assert.ok(!/same keys|earliest|time = ,/.test(empty), empty);
  assert.ok(!/Warning/.test(explain(call, 2, "rdb", match({}))));
});

test("the switch is declared on, and the command only where it can run", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.query.ajExplainer.enable"].default, true);
  const entries = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === PROCESS_TOOL_COMMANDS.explainAj);
  assert.ok(entries.length === 2 && entries.every((m) => /config\.q-lint\.query\.ajExplainer\.enable/.test(m.when)));
});

const RAW = ["`sym`time`px!(`a;09:02:00.000;3f)", 2, "", "", 1, "`sym`time`bid!(`a;09:01:30.000;11f)", "08:59:00.000", "09:02:00.000", true, "time", 3];

test("off, nothing is sent; on, the match is re-run and shown; a write is held on a guarded process", async (t) => {
  const opened = [];
  vscode.window.showTextDocument = async (d) => void opened.push(d);
  const { q, live } = await setUp(t, { config: { "query.ajExplainer.enable": false }, answer: (m) => (Array.isArray(m) && m[0] === EXPLAIN_AJ ? RAW : null), register: registerAjExplainer });
  await live.connectTo("rdb");
  const before = q.sent.length;
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.explainAj)("aj[`sym`time;trade;quote]", 2), /The aj match explainer is turned off/);
  assert.strictEqual(q.sent.length, before);

  stub.config.user["query.ajExplainer.enable"] = true;
  stub.changeConfig("q-lint.query.ajExplainer.enable");
  const text = await stub.commands.get(PROCESS_TOOL_COMMANDS.explainAj)("x:aj[`sym`time;trade;quote]", 2);
  assert.deepStrictEqual(q.sent.slice(before), [[EXPLAIN_AJ, " `sym`time", " trade", " quote", 2]]);
  assert.match(text, /Matched row 1 of quote/);
  assert.strictEqual(opened.length, 1);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.explainAj)("select from trade", 0), /no aj\[columns;left;right\] call/);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.explainAj)("aj[`sym`time;trade;quote]", "x"), /whole number/);
  assert.strictEqual(q.sent.length, before + 1);
});

test("on a guarded process, a call whose arguments would change it is held", async (t) => {
  const { q, live } = await setUp(t, { tags: ["prod"], answer: (m) => (Array.isArray(m) && m[0] === EXPLAIN_AJ ? RAW : null), register: registerAjExplainer });
  await live.connectTo("rdb");
  const before = q.sent.length;
  stub.picks.push(undefined);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.explainAj)("aj[`sym`time;trade;q::quote]", 0), /not confirmed/);
  assert.strictEqual(q.sent.length, before);
});
