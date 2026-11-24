// What the schema and lint tools answer (#951), what @q asks the model
// (#952) and how a qSQL draft is built and read back (#953): no q, no
// model. assist_q.test.js holds the q side against a real process.
const test = require("node:test");
const assert = require("node:assert");
const {
  namesIn,
  codeOffset,
  cut,
  readDescribed,
  tablesOf,
  schemaOf,
  metaType,
  readLint,
  lintArgs,
  explainPrompt,
  errorPrompt,
  qsqlPrompt,
  extractCode,
  draftDocument,
  draftCode,
} = require("../out/assist.js");
const { charKinds } = require("../out/explorer.js");

test("the names an expression uses: code only, not q's common words, at most 20", () => {
  const e = 'select from trade where sym=`AAPL, px>.cfg.lim / f\nfoo["bar"] + f each x';
  assert.deepStrictEqual(namesIn(e, charKinds(e)), ["trade", "sym", "px", ".cfg.lim", "foo", "f", "x"]);
  const many = Array.from({ length: 30 }, (_, i) => `v${i}`).join("+");
  assert.strictEqual(namesIn(many, charKinds(many)).length, 20);
});

test("what DESCRIBE answered, one name or many", () => {
  assert.deepStrictEqual(readDescribed({ name: "f", kind: "lambda", type: 100, count: null, text: "{x}" }), [
    { name: "f", kind: "lambda", type: 100, count: null, text: "{x}" },
  ]);
  const two = readDescribed({ name: ["t", "n"], kind: ["table", "weird"], type: [98, 0], count: [null, null], text: ["a b", ""] });
  assert.deepStrictEqual(two.map((d) => d.kind), ["table", "missing"]);
  assert.deepStrictEqual(readDescribed({ name: "v", kind: "view", type: 0, count: null, text: "" }).map((d) => d.kind), ["view"]);
  assert.throws(() => readDescribed([]), /something other/);
});

test("the tables GATHER read, and one table's schema", () => {
  const gathered = {
    entries: [
      { ns: ".", name: "trade", kind: "table", type: 98, count: 9, cols: ["date", "sym", "px"], keys: [], params: [], partitioned: true },
      { ns: ".ref", name: "k", kind: "table", type: 99, count: 2, cols: ["id", "v"], keys: ["id"], params: [], partitioned: false, allCols: 80 },
      { ns: ".", name: "f", kind: "function", type: 100, count: null, cols: [], keys: [], params: ["x"], partitioned: false },
    ],
    spaces: [],
    more: 0,
  };
  assert.deepStrictEqual(tablesOf(gathered), {
    tables: [
      { name: "trade", kind: "partitioned", rows: 9, columns: ["date", "sym", "px"] },
      { name: ".ref.k", kind: "keyed", rows: 2, keys: ["id"], columns: ["id", "v"], columnCount: 80 },
    ],
    more: 0,
  });
  const info = { kind: "keyed", rows: 2, bytes: 10, partitions: null, keys: ["id"], ncols: 3, columns: [{ name: "id", type: "j", fkey: "", attr: "u" }, { name: "s", type: "S", fkey: "ref", attr: "" }] };
  assert.deepStrictEqual(schemaOf("k", info), {
    name: "k",
    kind: "keyed",
    rows: 2,
    keys: ["id"],
    columns: [{ name: "id", type: "long", attribute: "unique" }, { name: "s", type: "symbol lists", foreignKey: "ref" }],
    columnCount: 3,
  });
  assert.strictEqual(metaType(""), "mixed list");
});

test("qlinter's JSON findings, and the arguments that lint standard input", () => {
  const out = '[{"path":"snippet.q","line":1,"rule":"reserved-parameter","detail":"Builtin parameter name(s)","why":"Builtin name used as a parameter","severity":"error","column":3,"code":"QF001"}]';
  assert.deepStrictEqual(readLint(out), [{ line: 1, column: 3, code: "QF001", rule: "reserved-parameter", severity: "error", message: "Builtin parameter name(s) - Builtin name used as a parameter" }]);
  assert.deepStrictEqual(readLint(""), []);
  assert.throws(() => readLint("{}"), /list of findings/);
  assert.deepStrictEqual(lintArgs("a.q"), ["--format", "json", "--color", "never", "--stdin-filename", "a.q"]);
});

test("the explain and error prompts carry what the server and the process said", () => {
  const p = explainPrompt(
    {
      expression: "f 3#t",
      process: "dev",
      hovers: [{ name: "f", text: "f[x] doubles" }],
      diagnostics: ["line 1: QF001 bad"],
      described: [
        { name: "f", kind: "lambda", type: 100, count: null, text: "{x*2}" },
        { name: "t", kind: "table", type: 98, count: null, text: "a b" },
        { name: "z", kind: "missing", type: 0, count: null, text: "" },
      ],
    },
    "",
  );
  assert.match(p, /right to left/);
  assert.match(p, /```q\nf 3#t\n```/);
  assert.match(p, /- line 1: QF001 bad/);
  assert.match(p, /- `f`: f\[x\] doubles/);
  assert.match(p, /On the connected q process dev:\n- `f`: a function defined on the process as:\n```q\n\{x\*2\}\n```/);
  assert.match(p, /- `t`: a table table with columns a b/);
  assert.match(p, /- `z`: not defined on the process/);
  assert.match(explainPrompt({ expression: "1+1", hovers: [], diagnostics: [], described: [] }, ""), /No q process is connected/);
  const e = errorPrompt({ error: "'type", code: "1+`a", process: "dev", described: [] }, "why?");
  assert.match(e, /Explain this q error and how to fix it: `'type`/);
  assert.match(e, /run on dev:\n```q\n1\+`a\n```/);
  assert.match(e, /The user asks: why\?/);
});

test("the qSQL prompt names the tables, and the draft round-trips", () => {
  const tables = [{ name: "trade", kind: "partitioned", rows: 9, columns: ["date", "sym", "px"] }, { name: "k", kind: "keyed", rows: null, keys: ["id"], columns: ["id"], columnCount: 3 }];
  const p = qsqlPrompt("last px by sym", tables, "hdb");
  assert.match(p, /single ```q block/);
  assert.match(p, /- trade \(partitioned, 9 rows\): date, sym, px/);
  assert.match(p, /- k \(keyed\): id, and 2 more/);
  assert.match(p, /Write a query for: last px by sym$/);
  assert.match(qsqlPrompt("x", [], undefined), /No q process is connected/);
  assert.strictEqual(extractCode("Here:\n```q\nselect last px by sym from trade\n```\nDone."), "select last px by sym from trade");
  assert.strictEqual(extractCode("select from t"), "select from t");
  assert.strictEqual(extractCode("```\nexec 1 from t\n```"), "exec 1 from t");
  // #1627: a one-line block, and backticks inside the code.
  assert.strictEqual(extractCode("```q select from trade```"), "select from trade");
  assert.strictEqual(extractCode("```select from trade```"), "select from trade");
  assert.strictEqual(extractCode("```q\nselect from t where sym in ```a\n```"), "select from t where sym in ```a");
  assert.strictEqual(extractCode("```q\nselect from t where sym in ```a`b\n```\nThat filters."), "select from t where sym in ```a`b");
  // #1913: a reply cut before its closing fence, a closing fence with text
  // after it on its line, and a ~~~ fence all lose their fence lines.
  assert.strictEqual(extractCode("```q\nselect from t"), "select from t");
  assert.strictEqual(extractCode("Here:\n```q\nselect from t\n  where a>1"), "select from t\n  where a>1");
  assert.strictEqual(extractCode("```q\nselect from t\n``` done"), "select from t");
  assert.strictEqual(extractCode("~~~q\nselect from t\n~~~"), "select from t");
  assert.strictEqual(extractCode("~~~\nselect from t where a~b\n~~~ done"), "select from t where a~b");
  assert.strictEqual(extractCode("~~~q\nselect from t"), "select from t");
  assert.strictEqual(extractCode("```q\r\nselect from t\r\n```\r\n"), "select from t");
  // A line of symbols is still code, not a fence.
  assert.strictEqual(extractCode("```q\nselect from t where sym in\n ```a`b\n```"), "select from t where sym in\n ```a`b");
  assert.strictEqual(extractCode("select from t where sym in\n ```a`b"), "select from t where sym in\n ```a`b");
  const doc = draftDocument("last px\nby sym", "Fake", "select last px by sym from trade");
  assert.match(doc, /^\/ Drafted by Fake from: last px by sym\n\/ Review it: nothing has run\./);
  assert.strictEqual(draftCode(doc), "select last px by sym from trade");
});

test("codeOffset finds a name written as code, past a comment or string (#1631)", () => {
  for (const [text, at] of [["/ uses vwap\nvwap[t]", 12], ['"vwap";vwap 1', 7], ["vwap", 0], ['"vwap"', -1], ["avwap", -1]]) {
    assert.strictEqual(codeOffset(text, charKinds(text), "vwap"), at, text);
  }
  assert.strictEqual(codeOffset("x.f;.ns.f 1", charKinds("x.f;.ns.f 1"), ".ns.f"), 4);
  // Nor is a name found at the head of a dotted one, which namesIn reads
  // as another name (#1912): the hover of a.b is not a's.
  for (const [text, name, at] of [["a.b+a", "a", 4], ["x.y:1;x", "x", 6], ["t.c+t", "t", 4], ["a.b", "a", -1], ["a.b+a", "a.b", 0], ["x.a+a", "a", 4], ["a.1+a", "a", 0]]) {
    assert.strictEqual(codeOffset(text, charKinds(text), name), at, `${name} in ${text}`);
  }
  assert.deepStrictEqual(namesIn("a.b+a", charKinds("a.b+a")), ["a.b", "a"]);
});

test("a prompt's cut never splits a surrogate pair (#1622)", () => {
  const text = "a".repeat(3999) + "\u{1F600} tail";
  const out = cut(text);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), JSON.stringify(out.slice(3990, 4010)));
  assert.match(out, /^a{3999}\n\.\.\. \(7 more characters\)$/);
  assert.strictEqual(cut("abc"), "abc");
  assert.ok(explainPrompt({ expression: text, hovers: [], diagnostics: [], described: [] }, "").isWellFormed?.() ?? true);
});
