// The process explorer and live completion (#854): how the gathering call's
// answer becomes tree rows and completion items, and where a cursor sits in
// a qSQL statement. Run after `tsc`; qclient.test.js runs the call itself
// against a real q.
const test = require("node:test");
const assert = require("node:assert");
const {
  GATHER,
  columnsOf,
  explorerTree,
  fullName,
  inCode,
  liveCompletions,
  previewCode,
  qsqlTable,
  readExplorer,
  readGathered,
  typeName,
} = require("../out/explorer.js");

const row = (ns, name, kind, extra = {}) => ({
  ns,
  name,
  kind,
  type: kind === "table" ? 98 : kind === "function" ? 100 : -7,
  count: kind === "function" ? null : 1,
  cols: [],
  keys: [],
  params: [],
  partitioned: false,
  ...extra,
});

// What node-q makes of GATHER's answer: a table as an array of objects, a
// symbol list as an array of strings, a float null as null.
const RAW = {
  rows: [
    row(".", "trade", "table", { count: 6, cols: ["date", "sym", "px"], partitioned: true }),
    row(".", "kt", "table", { type: 99, count: 2, cols: ["k", "v"], keys: ["k"] }),
    row(".", "f", "function", { params: ["x", "y"] }),
    row(".", "p", "function", { type: 104 }),
    row(".", "v", "variable", { type: 9, count: 3 }),
    row(".", "s", "variable", { type: -11 }),
    row(".ns", "g", "function", { params: ["a"] }),
    row(".ns.sub", "z", "variable", { type: 10, count: 3 }),
    row(".q", "neg", "function"),
  ],
  spaces: [
    { ns: ".", total: 6 },
    { ns: ".ns.sub", total: 1 },
    { ns: ".ns", total: 3 },
    { ns: ".q", total: 1 },
  ],
  more: 2,
};

test("the gathering lambda keeps nothing on the process", () => {
  // No assignment to a global: `x::` would define one, and `set` would too.
  // `(::)`, the generic null, is not one.
  assert.ok(!/[\w\]]\s*::/.test(GATHER), GATHER);
  assert.ok(GATHER.includes("(::)"));
  assert.ok(!/\bset\b/.test(GATHER), GATHER);
  assert.ok(GATHER.startsWith("{[ex;lim]") && GATHER.endsWith("}"));
});

test("an answer is read, and anything else is refused", () => {
  const g = readGathered(RAW);
  assert.strictEqual(g.entries.length, 9);
  assert.deepStrictEqual(g.entries[0], RAW.rows[0]);
  assert.strictEqual(g.more, 2);
  // A row that is not one is skipped; a single symbol may come as a string.
  const odd = readGathered({ rows: [{ ns: ".", name: "a", kind: "other" }, { ns: ".", name: "b", kind: "table", cols: "c" }], spaces: [], more: null });
  assert.deepStrictEqual(odd.entries.map((e) => [e.name, e.cols, e.count]), [["b", ["c"], null]]);
  assert.strictEqual(odd.more, 0);
  assert.throws(() => readGathered(null), /something other than its names/);
  assert.throws(() => readGathered({ rows: 1 }), /something other than its names/);
});

test("names are as q code names them", () => {
  assert.strictEqual(fullName({ ns: ".", name: "t" }), "t");
  assert.strictEqual(fullName({ ns: ".ns.sub", name: "z" }), ".ns.sub.z");
});

test("type numbers are named as q names them", () => {
  assert.strictEqual(typeName(-7), "long");
  assert.strictEqual(typeName(9), "float list");
  assert.strictEqual(typeName(10), "string");
  assert.strictEqual(typeName(-10), "char");
  assert.strictEqual(typeName(0), "list");
  assert.strictEqual(typeName(20), "enumeration");
  assert.strictEqual(typeName(99), "dictionary");
  assert.strictEqual(typeName(104), "projection");
  assert.strictEqual(typeName(107), "derived function");
  assert.strictEqual(typeName(-3), "type -3");
});

test("the tree: namespaces sorted with the root first, then tables, functions and variables", () => {
  const tree = explorerTree(readGathered(RAW), ["q"]);
  assert.deepStrictEqual(
    tree.map((n) => [n.kind, n.label, n.description]),
    [
      ["namespace", ".", "root · 6 names"],
      ["namespace", ".ns", "3 names"],
      ["namespace", ".ns.sub", "1 name"],
      ["note", "2 more namespaces not read", undefined],
    ],
  );
  const [root, ns] = tree;
  assert.deepStrictEqual(root.children.map((g) => [g.label, g.description]), [["Tables", "2"], ["Functions", "2"], ["Variables", "2"]]);
  const [tables, functions, variables] = root.children;
  assert.deepStrictEqual(
    tables.children.map((t) => [t.label, t.description, t.name]),
    [
      ["trade", "6 rows (partitioned, counted by .Q.cn) · 3 columns", "trade"],
      ["kt", "2 rows · 2 columns", "kt"],
    ],
  );
  assert.deepStrictEqual(tables.children[1].children, [
    { kind: "column", label: "k", description: "key" },
    { kind: "column", label: "v" },
  ]);
  assert.deepStrictEqual(functions.children.map((f) => [f.label, f.description]), [["f", "[x;y]"], ["p", "projection"]]);
  // An atom's count says nothing, so it is not shown.
  assert.deepStrictEqual(variables.children.map((v) => [v.label, v.description]), [["v", "float list · 3 items"], ["s", "symbol"]]);
  // Shown fewer names than the namespace has: says so.
  assert.deepStrictEqual(ns.children.map((c) => [c.kind, c.label]), [["group", "Functions"], ["note", "2 more names not shown"]]);
  assert.strictEqual(ns.children[0].children[0].tooltip, ".ns.g[a]");
});

test("an excluded namespace is left out with what is nested in it", () => {
  const labels = (excluded) => explorerTree(readGathered(RAW), excluded).filter((n) => n.kind === "namespace").map((n) => n.label);
  assert.deepStrictEqual(labels([]), [".", ".ns", ".ns.sub", ".q"]);
  assert.deepStrictEqual(labels(["ns", "q"]), ["."]);
  assert.deepStrictEqual(explorerTree({ entries: [], spaces: [], more: 0 }, []), []);
});

test("preview shows a table's first rows, reading a partitioned one by .Q.ind", () => {
  assert.strictEqual(previewCode({ kind: "table", name: "kt" }, 5), "5 sublist kt");
  assert.strictEqual(previewCode({ kind: "table", name: "trade", partitioned: true }, 3), ".Q.ind[trade;til 3&count trade]");
  assert.strictEqual(previewCode({ kind: "variable", name: ".ns.v" }, 5), ".ns.v");
  assert.strictEqual(previewCode({ kind: "function", name: "f" }, 5), undefined);
  assert.strictEqual(previewCode({ kind: "column" }, 5), undefined);
});

test("preview names a table or variable q cannot parse as a name by its symbol", () => {
  // `set` makes any symbol a name: unicode, a space, a quote.
  assert.strictEqual(previewCode({ kind: "variable", name: "café" }, 5), 'get`$"café"');
  assert.strictEqual(previewCode({ kind: "table", name: ".ns.été" }, 5), '5 sublist get`$".ns.été"');
  assert.strictEqual(
    previewCode({ kind: "table", name: 'a "b"\\c', partitioned: true }, 2),
    '.Q.ind[get`$"a \\"b\\"\\\\c";til 2&count get`$"a \\"b\\"\\\\c"]',
  );
  assert.strictEqual(previewCode({ kind: "variable", name: ".ns.sub.v_1" }, 5), ".ns.sub.v_1");
});

test("the explorer settings are read, and a preview limit that is not one is 5", () => {
  const from = (values) => readExplorer((key, fallback) => (key in values ? values[key] : fallback));
  assert.deepStrictEqual(from({}), { excludedNamespaces: ["q", "Q", "h", "j", "o", "s"], previewLimit: 5, autoRefresh: false });
  assert.deepStrictEqual(from({ "processExplorer.excludedNamespaces": [".z", " a ", "", "b c"] }).excludedNamespaces, ["z", "a"]);
  assert.deepStrictEqual(from({ "processExplorer.excludedNamespaces": "q" }).excludedNamespaces, []);
  for (const bad of [0, -1, 2.5, "5"]) {
    assert.strictEqual(from({ "processExplorer.previewLimit": bad }).previewLimit, 5, String(bad));
  }
  assert.strictEqual(from({ "processExplorer.previewLimit": 20 }).previewLimit, 20);
});

/// qsqlTable at the `|` in `code`.
const at = (code) => qsqlTable(code.replace("|", ""), code.indexOf("|"));

test("the table a qSQL statement reads, wherever the cursor is in it", () => {
  assert.strictEqual(at("select | from trade"), "trade");
  assert.strictEqual(at("select px from trade where |"), "trade");
  assert.strictEqual(at("exec |px from .ns.t"), ".ns.t");
  assert.strictEqual(at("update a:| from t"), "t");
  assert.strictEqual(at("delete | from t"), "t");
  assert.strictEqual(at("r:select max px by | from trade where date=last date"), "trade");
  // Over lines of one statement.
  assert.strictEqual(at("select\n  px,\n  | from trade"), "trade");
  // Brackets after the keyword do not end it.
  assert.strictEqual(at("select from t where a in (1;|)"), "t");
  // The nearest statement before the cursor.
  assert.strictEqual(at("select from t where x in exec y from u where |"), "u");
  // An astral character before the cursor is two UTF-16 units (#1372).
  assert.strictEqual(at('s:"\u{1F600}\u{1F600}\u{1F600}";select | from trade'), "trade");
  assert.strictEqual(at("/ note \u{1F600}\u{1F600}\nselect | from trade"), "trade");
});

test("no table outside a qSQL statement", () => {
  assert.strictEqual(at("a:1+|"), undefined);
  assert.strictEqual(at("select | where x"), undefined);
  assert.strictEqual(at("a:select from t; b:|"), undefined);
  // A name that only contains a keyword is not one.
  assert.strictEqual(at("selection:1; | from t"), undefined);
  assert.strictEqual(at(".my.select | from t"), undefined);
});

test("a keyword or a ; in a string, symbol or comment is not read as one", () => {
  // A symbol or a string that spells a keyword is no statement of its own.
  assert.strictEqual(at("select from t where action=`delete, |"), "t");
  assert.strictEqual(at('select from t where s like "update*", |'), "t");
  assert.strictEqual(at("select from t / delete the rest\n  where |"), "t");
  // A `;` in a string does not end the statement.
  assert.strictEqual(at('select from t where s like "a;b", |'), "t");
  // A statement in a string is no statement.
  assert.strictEqual(at('show "select a from t",|'), undefined);
});

test("the table is read from the cursor's own statement, not the next one", () => {
  assert.strictEqual(at("x:select a|; y:select from u"), undefined);
  assert.strictEqual(at("x:select a| from t; y:select from u"), "t");
});

// A statement in brackets ends at its closing bracket: past it, the cursor
// was offered the inner statement's columns, not its own.
test("a qSQL statement in brackets ends at its closing bracket", () => {
  assert.strictEqual(at("select from t where s in (exec s from u), |"), "t");
  assert.strictEqual(at("select from t where s in (exec s from u|)"), "u");
  assert.strictEqual(at("f[select from t]+|"), undefined);
});

test("the cursor is typing code outside strings and comments", () => {
  const code = (text) => inCode(text.replace("|", ""), text.indexOf("|"));
  assert.strictEqual(code("a:tr|"), true);
  assert.strictEqual(code('a:"tr|"'), false);
  assert.strictEqual(code('a:"tr"|'), true);
  assert.strictEqual(code('a:"a\\"tr|"'), false);
  assert.strictEqual(code("a:1 / tr|"), false);
  assert.strictEqual(code("/ tr|"), false);
  assert.strictEqual(code("a:1/tr|"), true);
  // A symbol is code: it can name a table.
  assert.strictEqual(code("`tr|"), true);
});

test("completion offers every name, and the table's columns in its statement", () => {
  const g = readGathered(RAW);
  assert.deepStrictEqual(columnsOf(g, "kt"), ["k", "v"]);
  assert.strictEqual(columnsOf(g, "nope"), undefined);
  assert.strictEqual(columnsOf(g, ".ns.g"), undefined);
  const items = liveCompletions(g, "rdb");
  assert.deepStrictEqual(
    items.map((i) => i.label),
    ["trade", "kt", "f", "p", "v", "s", ".ns.g", ".ns.sub.z", ".q.neg"],
  );
  assert.deepStrictEqual(items.find((i) => i.label === "f"), { label: "f", kind: "function", detail: "[x;y] (rdb)" });
  assert.deepStrictEqual(items.find((i) => i.label === "trade").detail, "table, 6 rows (rdb)");
  const inSelect = liveCompletions(g, "rdb", "trade");
  assert.deepStrictEqual(inSelect.slice(0, 3), [
    { label: "date", kind: "column", detail: "column of trade (rdb)" },
    { label: "sym", kind: "column", detail: "column of trade (rdb)" },
    { label: "px", kind: "column", detail: "column of trade (rdb)" },
  ]);
  assert.strictEqual(inSelect.length, items.length + 3);
  // A table the process does not have adds nothing.
  assert.strictEqual(liveCompletions(g, "rdb", "nope").length, items.length);
});

// A view has a lambda's type, and `value` of it gives its parse tree where
// a lambda has its parameters: the row read `[;;func,t,func,a,1,false,;null]`.
test("a view is shown as a view, not as a lambda with its parse tree for parameters (#1354)", () => {
  const raw = { rows: [row(".", "vw", "function", { view: true }), row(".", "f", "function", { params: ["x"], view: false })], spaces: [{ ns: ".", total: 2 }], more: 0 };
  const g = readGathered(raw);
  assert.deepStrictEqual(g.entries.map((e) => [e.name, e.view, e.params]), [["vw", true, []], ["f", undefined, ["x"]]]);
  const functions = explorerTree(g, []).find((n) => n.label === ".").children.find((c) => c.label === "Functions").children;
  assert.deepStrictEqual(functions.map((n) => [n.label, n.description, n.tooltip]), [["vw", "view", "vw: view"], ["f", "[x]", "f[x]"]]);
  assert.deepStrictEqual(liveCompletions(g, "rdb").map((c) => [c.label, c.detail]), [["vw", "view (rdb)"], ["f", "[x] (rdb)"]]);
  // The process is asked which it is, and gives parameters only when they are names.
  assert.ok(GATHER.includes("`partitioned`ncols`view!"), GATHER);
  assert.ok(GATHER.includes("$[11h=type p:(value x)1;p;`$()]"), GATHER);
});
