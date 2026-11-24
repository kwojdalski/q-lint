// The Data Wrangler (#961) and cell edits (#964), src/wrangle.ts: the q each
// writes, without q. datatools_q.test.js runs that q on a real process.
const test = require("node:test");
const assert = require("node:assert");
const w = require("../out/wrangle.js");
const { readable } = require("../out/qliteral.js");

const payload = (over = {}) => ({
  count: 2,
  keys: 0,
  names: ["sym", "px", "note", "e"],
  types: [11, 9, 0, 20],
  cells: [["a", "b"], ["1.5", ""], ['"x y"', ',"z"'], ["a", "b"]],
  raw: [[], [1.5, null], [], []],
  rank: [],
  ...over,
});

test("a wrangle starts only from a single expression (#961)", () => {
  assert.strictEqual(w.wrangleBase("select from trade where sym=`a"), undefined);
  assert.strictEqual(w.wrangleBase("trade"), undefined);
  assert.strictEqual(w.wrangleBase("select a:x from t"), undefined);
  assert.match(w.wrangleBase("a:1\nb:2"), /more than one statement/);
  assert.match(w.wrangleBase("t:select from trade"), /assigns a name/);
  assert.match(w.wrangleBase("t[`a]:1"), /assigns a name/);
  assert.match(w.wrangleBase("x+:1"), /assigns a name/);
  assert.match(w.wrangleBase("\\t select from t"), /system command/);
  assert.match(w.wrangleBase("select from t;"), /ends with ';'/);
  assert.match(w.wrangleBase("/ only a comment"), /empty/);
});

test("each step is written as q over the step before, and the steps as a script that assigns nothing (#961)", () => {
  assert.strictEqual(w.stepCode({ kind: "filter", column: "px", op: ">", value: "1" }, "t"), "select from t where px>1");
  assert.strictEqual(w.stepCode({ kind: "filter", column: "s", op: "like", value: '"AB*"' }, "t"), 'select from t where s like "AB*"');
  assert.strictEqual(w.stepCode({ kind: "filter", column: "s", op: "in", value: ",`a" }, "t"), "select from t where s in enlist `a");
  assert.strictEqual(w.stepCode({ kind: "filter", column: "s", op: "not null", value: "" }, "t"), "select from t where not null s");
  // q-sql splits a where clause at its commas: a value with one is one test (#1412).
  assert.strictEqual(w.stepCode({ kind: "filter", column: "s", op: "in", value: "`a,`b" }, "t"), "select from t where s in (`a,`b)");
  assert.strictEqual(w.stepCode({ kind: "filter", column: "px", op: "<", value: "10,20" }, "t"), "select from t where px<(10,20)");
  assert.strictEqual(w.stepCode({ kind: "sort", column: "px", descending: true }, "t"), "`px xdesc t");
  assert.strictEqual(w.stepCode({ kind: "rename", column: "px", to: "price" }, "t"), "(enlist[`px]!enlist `price) xcol t");
  assert.strictEqual(w.stepCode({ kind: "cast", column: "q", to: "f" }, "t"), 'update q:"f"$q from t');
  assert.strictEqual(w.stepCode({ kind: "cast", column: "q", to: "j", strings: true }, "t"), 'update q:"J"$q from t');
  assert.strictEqual(w.stepCode({ kind: "cast", column: "q", to: "s", strings: true }, "t"), "update q:`$q from t");
  assert.strictEqual(w.stepCode({ kind: "cast", column: "q", to: "*" }, "t"), "update q:string q from t");
  assert.strictEqual(w.stepCode({ kind: "drop", column: "note" }, "t"), "delete note from t");
  const steps = [
    { kind: "filter", column: "px", op: ">", value: "1" },
    { kind: "sort", column: "px", descending: false },
  ];
  assert.strictEqual(w.wrangleQuery("select from t", steps), "`px xasc (select from (select from t) where px>1)");
  assert.strictEqual(w.wrangleScript("t", steps, "rdb"), "/ Wrangled on rdb by q-lint: 2 steps\n{[]\n  w:t;\n  w:select from w where px>1;\n  w:`px xasc w;\n  w}[]\n");
  assert.deepStrictEqual(steps.map(w.stepText), ["keep rows where px > 1", "sort by px, ascending"]);
  // A base's comments are dropped before it is nested, so they eat no ")" or ";" (#1072).
  assert.strictEqual(w.wrangleBase("select from t / note"), undefined);
  assert.strictEqual(w.wrangleQuery("select from t / note", [steps[1]]), "`px xasc (select from t)");
  assert.strictEqual(w.wrangleQuery('select from t where s like "a /b" / note\n  / more', [steps[1]]), '`px xasc (select from t where s like "a /b")');
  assert.match(w.wrangleScript("select from t / note", steps, "rdb"), /\n  w:select from t;\n/);
  // A block comment, `/` to `\` alone on their lines, goes whole; so does what follows a `\` alone (#1280).
  assert.strictEqual(w.wrangleQuery("select from t\n/\n a note (\n;\n\\\n  where px>0", [steps[1]]), "`px xasc (select from t\n  where px>0)");
  assert.strictEqual(w.wrangleQuery("select from t\n\\\nexit 0", [steps[1]]), "`px xasc (select from t)");
  // Only a plain name can be a q-sql column.
  assert.strictEqual(w.columnProblem("px"), undefined);
  assert.match(w.columnProblem("a b"), /cannot be named in q-sql/);
  assert.match(w.columnProblem("count"), /reserved word/);
  assert.strictEqual(w.stringColumn(payload(), 2), true);
  assert.strictEqual(w.stringColumn(payload(), 0), false);
});

test("a cell edit is an update of the table, its rows found by the row's values, null-safe; enumerations by = (#964)", () => {
  const edit = w.editStatement(payload(), 1, 1, "t", "9.5");
  assert.deepStrictEqual(edit, {
    code: 'update px:(9.5) from `t where (sym=`b),(px~\\:(0n)),(note~\\:(enlist "z")),(e=`b)',
    matchedBy: ["sym", "px", "note", "e"],
  });
  // A general column takes a list as long as the rows found.
  assert.strictEqual(w.editStatement(payload(), 2, 0, ".ns.t", '"new"').code, 'update note:(count i)#enlist "new" from `.ns.t where (sym=`a),(px~\\:(1.5f)),(note~\\:("x y")),(e=`a)');
  // A keyed result is found by its keys alone.
  const keyed = w.editStatement(payload({ keys: 1 }), 1, 0, "kt", "2");
  assert.deepStrictEqual(keyed, { code: "update px:(2) from `kt where (sym=`a)", matchedBy: ["sym"] });
  assert.match(w.editStatement(payload(), 1, 0, "t", "  ").error, /no new value/);
  assert.match(w.editStatement(payload(), 1, 0, "not a name", "1").error, /not a table's name/);
  assert.match(w.editStatement(payload(), 9, 0, "t", "1").error, /not in the result/);
  assert.match(w.editStatement(payload({ names: ["a b", "px", "note", "e"] }), 1, 0, "t", "1").error, /cannot be named in q-sql/);
  const cut = payload({ cells: [["a", "b"], ["1.5", ""], [`"${"x".repeat(196)}...`, ',"z"'], ["a", "b"]] });
  assert.match(w.editStatement(cut, 1, 0, "t", "1").error, /cut at 200 characters/);
  assert.strictEqual(w.cellLiteral(payload(), 1, 1), "0n");
  // A one-character string starts as q reads it, and a row is found by a
  // symbol starting with _ written through `$ (the 0.29.0 literal bug).
  assert.strictEqual(w.cellLiteral(payload(), 2, 1), 'enlist "z"');
  assert.deepStrictEqual(w.editStatement(payload({ keys: 1, cells: [["_y", "b"], ["1.5", ""], ['"x y"', ',"z"'], ["a", "b"]] }), 1, 0, "kt", "2"), {
    code: 'update px:(2) from `kt where (sym=`$"_y")',
    matchedBy: ["sym"],
  });
  // A monadic , becomes enlist, outside strings only.
  assert.strictEqual(readable(',"a,(,b"'), 'enlist "a,(,b"');
  assert.strictEqual(readable("(,1;,`a)"), "(enlist 1;enlist `a)");
  assert.strictEqual(readable("1,2"), "1,2");
  assert.strictEqual(w.guessTable("trade"), "trade");
  assert.strictEqual(w.guessTable("select from .ns.trade where sym=`a"), ".ns.trade");
  assert.strictEqual(w.guessTable("select sum px by sym from trade"), "trade");
  assert.strictEqual(w.guessTable("1+1"), undefined);
});

test("an unwrapped grid's cell edit finds its row by a long past 2^53 exactly (#1276)", () => {
  const { gridOfQ } = require("../out/qformat.js");
  const grid = gridOfQ(
    {
      kind: "table",
      attr: 0,
      cols: ["id", "px"],
      data: [
        { kind: "vector", t: 7, attr: 0, v: [9007199254740993n, 9007199254740992n] },
        { kind: "vector", t: 9, attr: 0, v: [1, 2] },
      ],
    },
    100,
  );
  assert.strictEqual(w.editStatement(grid, 1, 0, "t", "99f").code, "update px:(99f) from `t where (id~\\:(9007199254740993)),(px~\\:(1f))");
});
