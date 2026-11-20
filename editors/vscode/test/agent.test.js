// The language-model tool (#886): what an agent is given for each kind of
// answer, which process a label names, what the user is asked, and that
// package.json declares the tool, its command and its setting. Run after
// `tsc`; qclient.test.js runs the tool's query against a real q.
const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const {
  AGENT,
  ROW_LIMIT,
  confirmation,
  isProduction,
  jsonCell,
  knownLabels,
  notConnected,
  readAgent,
  resolveProcess,
  rowLabel,
  shape,
} = require("../out/agent.js");
const { needsRestart } = require("../out/settings.js");

const grid = (over) => ({
  count: 2,
  keys: 0,
  names: ["sym", "px"],
  types: [11, 9],
  cells: [["a", "b"], ["1.5", "2.5"]],
  raw: [[], [1.5, 2.5]],
  rank: [[], []],
  ...over,
});
const ok = (g, text = ["..."]) => ({ ok: true, type: 98, text, ...(g ? { grid: g } : {}) });

test("a table is its columns, types, row count and rows of values", () => {
  assert.deepStrictEqual(shape(ok(grid())), {
    columns: ["sym", "px"],
    types: ["symbol (s)", "float (f)"],
    rowCount: 2,
    data: [
      ["a", 1.5],
      ["b", 2.5],
    ],
  });
});

test("a result with more rows than were sent says it was cut", () => {
  const shaped = shape(ok(grid({ count: 5000 })));
  assert.strictEqual(shaped.rowCount, 5000);
  assert.strictEqual(shaped.data.length, 2);
  assert.strictEqual(shaped.truncated, true);
  assert.strictEqual(ROW_LIMIT, 200);
});

test("a keyed table says how many columns are keys", () => {
  assert.strictEqual(shape(ok(grid({ keys: 1 }))).keyColumns, 1);
  assert.ok(!("keyColumns" in shape(ok(grid()))));
});

test("any other value is the process's text, and an error its error and trace", () => {
  assert.deepStrictEqual(shape({ ok: true, type: -7, text: ["42"] }), { output: "42" });
  assert.deepStrictEqual(shape({ ok: true, type: 10, text: ["abc", "def"] }), { output: "abc\ndef" });
  // A tabular value the process could not cut is shown as its text too.
  assert.deepStrictEqual(shape({ ok: true, type: 98, text: ["t"], gridError: "nyi" }), { output: "t" });
  assert.deepStrictEqual(shape({ ok: false, error: "type", trace: "  [1] 1+`a\n\n" }), { error: "type", trace: "  [1] 1+`a" });
  assert.deepStrictEqual(shape({ ok: false, error: "type", trace: "" }), { error: "type" });
});

test("a cell survives JSON: exact numbers as numbers, the rest as q's text", () => {
  // Booleans, and whole numbers a double holds exactly.
  assert.strictEqual(jsonCell(1, "1", undefined), true);
  assert.strictEqual(jsonCell(1, "0", undefined), false);
  assert.strictEqual(jsonCell(7, "42", 42), 42);
  assert.strictEqual(jsonCell(6, "-3", -3), -3);
  // A long past 2^53 keeps its last digits as text.
  assert.strictEqual(jsonCell(7, "9007199254740993", 9007199254740992), "9007199254740993");
  // A float is the number the process sent, not its \P-cut text.
  assert.strictEqual(jsonCell(9, "3.141593", 3.14159265358979), 3.14159265358979);
  // A timestamp keeps its nanoseconds, a symbol and a guid are text.
  assert.strictEqual(jsonCell(12, "2026.11.20D10:11:12.123456789", 1), "2026.11.20D10:11:12.123456789");
  assert.strictEqual(jsonCell(11, "abc", undefined), "abc");
  // Nulls are null, infinities q's notation.
  assert.strictEqual(jsonCell(7, "", null), null);
  assert.strictEqual(jsonCell(12, "", null), null);
  assert.strictEqual(jsonCell(7, "0W", Infinity), "0W");
  assert.strictEqual(jsonCell(6, "2147483647", Infinity), "0W");
  assert.strictEqual(jsonCell(9, "-0w", -Infinity), "-0w");
  assert.strictEqual(jsonCell(14, "-0W", -Infinity), "-0W");
  for (const v of [jsonCell(7, "9007199254740993", 1), jsonCell(9, "x", 0.1)]) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(v)), v);
  }
});

test("a real is the number q wrote, not its float32 widened to a double", () => {
  // node-q decodes a real's four bytes to the double nearest them: 1.1e
  // arrives as 1.100000023841858, which is not what q holds or prints.
  assert.strictEqual(jsonCell(8, "1.1", Math.fround(1.1)), 1.1);
  assert.strictEqual(jsonCell(8, "0.3", Math.fround(0.30000001)), 0.3);
  assert.strictEqual(jsonCell(8, "2", 2), 2);
  assert.strictEqual(jsonCell(8, "3.402823e+38", Math.fround(3.4028234e38)), 3.4028235e38);
  // Every real comes back as itself.
  for (const x of [1.1, 0.1, 1 / 3, 123456.789, 1e-30, -7.25]) {
    const f = Math.fround(x);
    assert.strictEqual(Math.fround(jsonCell(8, "", f)), f, String(x));
  }
});

const saved = [
  { label: "rdb", host: "h", port: 5011, tags: ["prod"] },
  { label: "hdb", host: "h", port: 5012, tags: [] },
];
const discovered = [
  {
    server: { label: "disc", url: "http://x" },
    state: { processes: [{ label: "gw", host: "g", port: 1, tags: [] }, { label: "rdb", host: "other", port: 2, tags: [] }], problems: [], loading: false, removed: false },
  },
];

test("a label names a saved process before a discovered one", () => {
  assert.strictEqual(resolveProcess("rdb", saved, discovered).process.host, "h");
  assert.strictEqual(resolveProcess("disc/rdb", saved, discovered).process.host, "other");
  // A discovered process by its bare label, when only one server lists it.
  assert.deepStrictEqual(resolveProcess("gw", saved, discovered).process, { label: "disc/gw", host: "g", port: 1, tags: [] });
  assert.deepStrictEqual(knownLabels(saved, discovered), ["rdb", "hdb", "disc/gw", "disc/rdb"]);
});

test("an unknown label, or no connection, is an error that lists the labels", () => {
  const { error } = resolveProcess("nope", saved, discovered);
  assert.strictEqual(error, 'No q process is labelled "nope". The labels are: rdb, hdb, disc/gw, disc/rdb.');
  assert.match(resolveProcess("nope", [], []).error, /No q process is saved/);
  assert.match(notConnected(saved, []), /^No q process is connected\. .*"process"\. The labels are: rdb, hdb\.$/);
});

test("Copy Label copies a row's label, a discovered process's qualified", () => {
  assert.strictEqual(rowLabel({ kind: "process", process: saved[0] }), "rdb");
  assert.strictEqual(rowLabel({ kind: "discovered", server: "disc", process: saved[1] }), "disc/hdb");
  assert.strictEqual(rowLabel({ kind: "tag", tag: "prod", processes: [] }), undefined);
  assert.strictEqual(rowLabel(undefined), undefined);
});

test("the confirmation names the process, shows the query, and warns of production", () => {
  const dev = confirmation("select from t", saved[1]);
  assert.strictEqual(dev.title, "Run a q query on hdb?");
  assert.strictEqual(dev.message, "An agent asks to run this query on **hdb** (h:5012), the active connection:\n\n```q\nselect from t\n```");
  assert.ok(!/production/i.test(dev.message));
  const prod = confirmation("delete from `t", saved[0], { connects: true, replaces: "hdb" });
  assert.match(prod.message, /^\*\*Warning: rdb is a production process\*\* \(tagged prod\)\. .*can change or delete data/);
  assert.match(prod.message, /connecting to it in place of hdb:/);
  assert.match(confirmation("1", saved[1], { connects: true }).message, /connecting to it first:/);
  // A query holding backticks is fenced by more of them.
  assert.match(confirmation("a:```x", saved[1]).message, /````q\na:```x\n````$/);
  assert.ok(isProduction({ label: "x", host: "h", port: 1, tags: ["eu", "PRD"] }));
  assert.ok(!isProduction({ label: "x", host: "h", port: 1, tags: ["uat"] }));
});

test("package.json declares the tool as the extension registers it", () => {
  const [tool, ...more] = pkg.contributes.languageModelTools;
  assert.strictEqual(more.length, 0);
  assert.strictEqual(tool.name, AGENT.tool);
  assert.strictEqual(tool.displayName, "Run q Query");
  assert.strictEqual(tool.toolReferenceName, "qQuery");
  assert.strictEqual(tool.canBeReferencedInPrompt, true);
  assert.deepStrictEqual(Object.keys(tool.inputSchema.properties), ["query", "process"]);
  assert.deepStrictEqual(tool.inputSchema.required, ["query"]);
  assert.match(tool.modelDescription, /active connection/);
  assert.match(tool.modelDescription, new RegExp(`first ${ROW_LIMIT} rows`));
  // Copy Label is on every saved and discovered process row.
  const menu = pkg.contributes.menus["view/item/context"].find((m) => m.command === AGENT.copyLabel);
  assert.match(menu.when, /view == q-lint\.processes/);
  const when = new RegExp(menu.when.match(/=~ \/(.*)\//)[1]);
  for (const item of ["process", "process.connected", "discovered", "discovered.connected"]) {
    assert.ok(when.test(item), item);
  }
  assert.ok(!when.test("discoveryServer"));
});

test("every agent setting is read, with the default package.json declares, and none restarts the server", () => {
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: agents");
  const read = new Map();
  const settings = readAgent((key, fallback) => {
    read.set(key, fallback);
    return fallback;
  });
  for (const [key, spec] of Object.entries(section.properties)) {
    const short = key.replace(/^q-lint\./, "");
    assert.ok(read.has(short), `${key} is declared but never read`);
    assert.deepStrictEqual(read.get(short), spec.default, key);
    assert.strictEqual(needsRestart((s) => key === s || key.startsWith(`${s}.`)), false, key);
  }
  assert.strictEqual(read.size, Object.keys(section.properties).length);
  assert.deepStrictEqual(settings, { queryTimeout: 30 });
  const set = (v) => readAgent((key, fallback) => (key === "agent.queryTimeout" ? v : fallback)).queryTimeout;
  assert.strictEqual(set(0), 0);
  assert.strictEqual(set(5), 5);
  assert.strictEqual(set(-1), 30);
  assert.strictEqual(set(1.5), 30);
});
