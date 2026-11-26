// The join assistant (#1049): shapes read, the joins two tables allow
// written with their keys and sorts - and, through the stand-in `vscode`
// and a fake q: off, the command refuses and nothing is sent; on, the two
// shapes are read through the read-only guard and the join picked is
// written at the cursor, after the selection and never over it. The q side
// is joinassist_q.test.js, which also runs every expression written.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { setUp } = require("./fakeq.js");
const { TABLE_SHAPE, lastSelectedLine, operand, readShape, suggestJoins } = require("../out/joinassist.js");
const { registerJoinAssistant } = require("../out/joinassistview.js");
const { PROCESS_TOOL_COMMANDS } = require("../out/processtools.js");
const pkg = require("../package.json");

vscode.Position = class {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
};

const shape = (expression, columns, types, keys = [], attributes = columns.map(() => ""), where = "memory") => ({ expression, columns, types, attributes, keys, where });
const trade = shape("trade", ["sym", "time", "px"], "stf");
const quote = shape("quote", ["sym", "time", "bid"], "stf");
const ref = shape("ref", ["sym", "sector"], "ss", ["sym"]);

test("a shape is read, one column as atoms", () => {
  assert.deepStrictEqual(readShape([["sym", "px"], "sf", ["", ""], [], "memory"], "t"), shape("t", ["sym", "px"], "sf"));
  assert.deepStrictEqual(readShape(["sym", "s", "", ["sym"], "splayed"], "k").columns, ["sym"]);
  assert.throws(() => readShape([["a"], "sf", [""], [], "memory"], "t"), /shape/);
  assert.strictEqual(operand(" trade "), "trade");
  assert.strictEqual(operand("select from trade"), "(select from trade)");
});

test("a keyed right table gives lj and ij on its keys", () => {
  const s = suggestJoins(trade, ref);
  assert.deepStrictEqual(s.map((x) => [x.join, x.expression]), [
    ["lj", "trade lj ref"],
    ["ij", "trade ij ref"],
  ]);
});

test("shared columns that are not plain names are written as q reads them back (#1818)", () => {
  const left = shape("t", ["trade id", "_x", "px"], "ssf", [], ["", "", ""]);
  const right = shape("u", ["trade id", "_x", "qty"], "ssj", [], ["", "", ""]);
  const by = Object.fromEntries(suggestJoins(left, right).map((x) => [x.join, x]));
  assert.strictEqual(by.lj.expression, 't lj (`$"trade id";`$"_x") xkey u');
  assert.strictEqual(by.ij.expression, 't ij (`$"trade id";`$"_x") xkey u');
  const one = Object.fromEntries(suggestJoins(shape("t", ["_x", "px"], "sf", [], ["", ""]), shape("u", ["_x", "qty"], "sj", [], ["", ""])).map((x) => [x.join, x]));
  assert.strictEqual(one.lj.expression, 't lj (`$"_x") xkey u');
});

test("wj writes its time and value columns as q reads them back, a name with a space or a leading _ too (#1845)", () => {
  const l = shape("t", ["_s", "trade time", "px"], "stf");
  const wj = (r) => suggestJoins(l, r).find((x) => x.join === "wj").expression;
  assert.strictEqual(
    wj(shape("u", ["_s", "trade time", "bid x"], "stf")),
    '((cols t),(`$"bid x_max";`$"bid x_min")) xcol wj[-1000 0+\\:t[`$"trade time"];(`$"_s";`$"trade time");t;((`$"_s";`$"trade time") xasc u;(max;`$"bid x");(min;`$"bid x"))]',
  );
  assert.strictEqual(wj(shape("u", ["_s", "trade time", "name"], "sts")), 'wj[-1000 0+\\:t[`$"trade time"];(`$"_s";`$"trade time");t;((`$"_s";`$"trade time") xasc u;(count;`$"trade time"))]');
});

test("a shared time column gives aj and wj, sorted unless the right table already is", () => {
  const s = suggestJoins(trade, quote);
  const by = Object.fromEntries(s.map((x) => [x.join, x]));
  assert.strictEqual(by.aj.expression, "aj[`sym`time;trade;`sym`time xasc quote]");
  assert.match(by.aj.why, /binary search/);
  assert.strictEqual(by.wj.expression, "((cols trade),`bid_max`bid_min) xcol wj[-1000 0+\\:trade`time;`sym`time;trade;(`sym`time xasc quote;(max;`bid);(min;`bid))]");
  assert.strictEqual(by.uj.expression, "trade uj quote");
  // Grouped on sym, it is not sorted again.
  const grouped = shape("quote", ["sym", "time", "bid"], "stf", [], ["g", "", ""]);
  assert.strictEqual(Object.fromEntries(suggestJoins(trade, grouped).map((x) => [x.join, x])).aj.expression, "aj[`sym`time;trade;quote]");
  // But no attribute orders time within each sym: the why says it is taken
  // as already so, and how to sort it when not (#1435).
  for (const attribute of ["g", "p", "s"]) {
    const aj = suggestJoins(trade, shape("quote", ["sym", "time", "bid"], "stf", [], [attribute, "", ""])).find((x) => x.join === "aj");
    assert.match(aj.why, new RegExp(`\`${attribute}# on sym does not order time: this takes quote to be in time order within each sym already, as a tickerplant's table is; if it is not, use \`sym\`time xasc quote`), attribute);
  }
  // A partitioned right table is told to pick a date.
  const hdb = shape("quote", ["date", "sym", "time", "bid"], "dstf", [], ["", "p", "", ""], "partitioned");
  assert.match(suggestJoins(trade, hdb).find((x) => x.join === "aj").why, /partitioned: select one date first/);
  // Timestamps get a window in nanoseconds.
  const tp = shape("t", ["sym", "time", "px"], "spf");
  const qp = shape("q", ["sym", "time", "bid"], "spf");
  assert.match(suggestJoins(tp, qp).find((x) => x.join === "wj").expression, / xcol wj\[-1000000000 0\+\\:t`time;/);
  // Nothing in common: nothing to suggest.
  assert.deepStrictEqual(suggestJoins(shape("a", ["x"], "j"), shape("b", ["y"], "f")), []);
});

test("the switch is declared on, and the command only where it can run", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.query.joinAssistant.enable"].default, true);
  const entries = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === PROCESS_TOOL_COMMANDS.joinAssistant);
  assert.ok(entries.length === 2 && entries.every((m) => /config\.q-lint\.query\.joinAssistant\.enable/.test(m.when)));
});

const answer = (m) => {
  if (!Array.isArray(m) || m[0] !== TABLE_SHAPE) return null;
  return m[1] === " trade" ? [["sym", "time", "px"], "stf", ["", "", ""], [], "memory"] : [["sym", "sector"], "ss", ["", ""], ["sym"], "memory"];
};

test("off, nothing is sent; on, the shapes are read and the join written after the selection", async (t) => {
  const { q, live } = await setUp(t, { config: { "query.joinAssistant.enable": false }, answer, register: registerJoinAssistant });
  await live.connectTo("rdb");
  const before = q.sent.length;
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.joinAssistant)("trade", "ref", "lj"), /The join assistant is turned off/);
  assert.strictEqual(q.sent.length, before);

  stub.config.user["query.joinAssistant.enable"] = true;
  stub.changeConfig("q-lint.query.joinAssistant.enable");
  const inserted = [];
  vscode.window.activeTextEditor = {
    document: { languageId: "q", uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ range: { end: { character: 9 } } }) },
    selection: { isEmpty: false, start: { line: 2, character: 0 }, end: { line: 4, character: 3 } },
    edit: async (f) => f({ insert: (at, text) => inserted.push([at, text]), replace: () => assert.fail("never over the selection") }),
  };
  t.after(() => (vscode.window.activeTextEditor = undefined));
  const suggestions = await stub.commands.get(PROCESS_TOOL_COMMANDS.joinAssistant)("trade", "ref", "lj");
  assert.deepStrictEqual(suggestions.map((s) => s.join), ["lj", "ij"]);
  assert.deepStrictEqual(q.sent.slice(before), [
    [TABLE_SHAPE, " trade"],
    [TABLE_SHAPE, " ref"],
  ]);
  assert.strictEqual(inserted.length, 1);
  assert.strictEqual(inserted[0][1], "\ntrade lj ref");
  assert.deepStrictEqual([inserted[0][0].line, inserted[0][0].character], [4, 9]);

  // A whole line selected ends at the next line's column 0: the join goes
  // after the line selected, not into the function the next one opens (#1920).
  const lines = ["t:select from trade", "r:{[x]", " x+1}"];
  vscode.window.activeTextEditor.document.lineAt = (i) => ({ range: { end: { character: lines[i].length } } });
  vscode.window.activeTextEditor.selection = { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
  await stub.commands.get(PROCESS_TOOL_COMMANDS.joinAssistant)("trade", "ref", "lj");
  assert.deepStrictEqual([inserted[1][0].line, inserted[1][0].character, inserted[1][1]], [0, 19, "\ntrade lj ref"]);
});

test("the last line a selection has text on", () => {
  const sel = (sl, sc, el, ec) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
  assert.strictEqual(lastSelectedLine(sel(0, 0, 1, 0)), 0);
  assert.strictEqual(lastSelectedLine(sel(2, 3, 5, 0)), 4);
  assert.strictEqual(lastSelectedLine(sel(2, 3, 5, 1)), 5);
  assert.strictEqual(lastSelectedLine(sel(2, 0, 2, 4)), 2);
  // Nothing selected is the line it is on.
  assert.strictEqual(lastSelectedLine(sel(3, 0, 3, 0)), 3);
});

test("on a guarded process a query that would change it is held", async (t) => {
  const { q, live } = await setUp(t, { tags: ["prod"], answer, register: registerJoinAssistant });
  await live.connectTo("rdb");
  const before = q.sent.length;
  stub.picks.push(undefined);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.joinAssistant)("trade", "x:ref", "lj"), /not confirmed/);
  assert.strictEqual(q.sent.length, before);
});

test("the guard reads the expressions of a join's tables as TABLE_SHAPE values them, whole (#2033)", () => {
  const { shapeGuardCode } = require("../out/joinassist.js");
  const { writes } = require("../out/guard.js");
  assert.deepStrictEqual(writes(shapeGuardCode(["(1;\n/\nj2:9)", "trade"])), ["assigns j2"]);
  assert.deepStrictEqual(writes(shapeGuardCode(["trade", "quote"])), []);
});

test("on a guarded process the shapes are read under reval, so a write the guard missed is refused (#2640)", async (t) => {
  const { tableShapeLambda } = require("../out/joinassist.js");
  const { EVALUATE_READ_ONLY } = require("../out/query.js");
  const READ_ONLY = tableShapeLambda(EVALUATE_READ_ONLY);
  const guardedAnswer = (m) => (m === "`reval in key`.q" ? true : Array.isArray(m) && m[0] === READ_ONLY ? answer([TABLE_SHAPE, m[1]]) : null);
  const { q, live } = await setUp(t, { tags: ["prod"], answer: guardedAnswer, register: registerJoinAssistant });
  await live.connectTo("rdb");
  const before = q.sent.length;
  const suggestions = await stub.commands.get(PROCESS_TOOL_COMMANDS.joinAssistant)("trade", "ref", "lj");
  assert.deepStrictEqual(suggestions.map((s) => s.join), ["lj", "ij"]);
  assert.deepStrictEqual(
    q.sent.slice(before).filter((m) => Array.isArray(m)),
    [
      [READ_ONLY, " trade"],
      [READ_ONLY, " ref"],
    ],
  );
});
