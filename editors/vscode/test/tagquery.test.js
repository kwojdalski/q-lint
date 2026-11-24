// Query a Tag (#906) as data: which processes carry a tag, and how their
// answers become one table. Run after `tsc`; queryacross_vscode.test.js
// drives the command and queries_q.test.js real q processes.
const test = require("node:test");
const assert = require("node:assert");
const { allTags, mergeOutcomes, readTagQuery, tagged } = require("../out/tagquery.js");

const p = (label, tags) => ({ label, host: "h", port: 1, tags });
const discovered = [{ server: { label: "srv", url: "u" }, state: { processes: [p("gw", ["EU"]), p("x", [])], problems: [], loading: false } }];

test("the setting is on by default, and only false turns it off", () => {
  assert.deepStrictEqual(readTagQuery((k, f) => f), { enabled: true });
  assert.deepStrictEqual(readTagQuery((k, f) => (k === "query.tagQuery.enable" ? false : f)), { enabled: false });
  assert.deepStrictEqual(readTagQuery((k, f) => (k === "query.tagQuery.enable" ? "false" : f)), { enabled: true });
});

test("a tag names saved and discovered processes, ignoring case; discovered ones qualified", () => {
  const saved = [p("rdb", ["eu", "prod"]), p("hdb", ["us"]), p("rdb2", [" Eu "])];
  assert.deepStrictEqual(tagged(saved, discovered, "eu").map((x) => [x.label, x.server]), [["rdb", undefined], ["rdb2", undefined], ["srv/gw", "srv"]]);
  assert.deepStrictEqual(tagged(saved, discovered, "none"), []);
  assert.deepStrictEqual(allTags(saved, discovered), [
    { tag: "eu", count: 3 },
    { tag: "prod", count: 1 },
    { tag: "us", count: 1 },
  ]);
});

/// A grid payload of columns `{name: [type, cells, raw]}`.
function grid(columns, keys = 0) {
  const names = Object.keys(columns);
  const cells = names.map((n) => columns[n][1]);
  return {
    count: cells[0].length,
    keys,
    names,
    types: names.map((n) => columns[n][0]),
    cells,
    raw: names.map((n) => columns[n][2] ?? []),
    rank: names.map(() => []),
  };
}
const ok = (g, text = []) => ({ ok: true, type: 98, text, ...(g ? { grid: g } : {}) });

test("tables become one, under the union of their columns, a process column first", () => {
  const merged = mergeOutcomes([
    { process: "a", answer: ok(grid({ sym: [11, ["x", "y"]], px: [9, ["2", "1"], [2, 1]] })) },
    { process: "b", answer: ok(grid({ sym: [11, ["z"]], qty: [7, ["5"], [5]] })) },
  ]);
  assert.deepStrictEqual(merged.names, ["process", "sym", "px", "qty"]);
  assert.deepStrictEqual(merged.types, [11, 11, 9, 7]);
  assert.deepStrictEqual(merged.cells, [
    ["a", "a", "b"],
    ["x", "y", "z"],
    ["2", "1", ""],
    ["", "", "5"],
  ]);
  // Raw numbers stay where every row has one (a missing cell is a null).
  assert.deepStrictEqual(merged.raw, [[], [], [2, 1, null], [null, null, 5]]);
  // Ranked over all the rows: nulls first, then by number, else by text.
  assert.deepStrictEqual(merged.rank, [[0, 0, 1], [0, 1, 2], [2, 1, 0], [0, 0, 1]]);
  assert.strictEqual(merged.count, 3);
  assert.strictEqual(merged.keys, 1);
});

test("a value that is not tabular, an error and an unreachable process are rows of their own", () => {
  const merged = mergeOutcomes([
    { process: "a", answer: ok(undefined, ["42"]) },
    { process: "b", answer: { ok: false, error: "type", trace: "" } },
    { process: "c", error: "could not connect" },
    { process: "d", answer: ok(grid({ v: [7, ["1"], [1]] })) },
  ]);
  assert.deepStrictEqual(merged.names, ["process", "v", "result", "error"]);
  assert.deepStrictEqual(merged.cells, [
    ["a", "b", "c", "d"],
    ["", "", "", "1"],
    ["42", "", "", ""],
    ["", "'type", "could not connect", ""],
  ]);
  assert.deepStrictEqual(merged.types, [11, 7, 10, 10]);
  assert.strictEqual(merged.count, 4);
});

test("a column typed differently by two processes is a list shown as written; keys shared alike are kept", () => {
  const merged = mergeOutcomes([
    { process: "a", answer: ok(grid({ k: [11, ["x"]], v: [7, ["1"], [1]] }, 1)) },
    { process: "b", answer: ok(grid({ k: [11, ["y"]], v: [9, ["1.5"], [1.5]] }, 1)) },
  ]);
  assert.deepStrictEqual(merged.types, [11, 11, 0]);
  assert.deepStrictEqual(merged.raw[2], []);
  assert.strictEqual(merged.keys, 2);
  // Keyed differently: only the process column is a key.
  const mixed = mergeOutcomes([
    { process: "a", answer: ok(grid({ k: [11, ["x"]], v: [7, ["1"]] }, 1)) },
    { process: "b", answer: ok(grid({ k: [11, ["y"]], v: [7, ["2"]] })) },
  ]);
  assert.strictEqual(mixed.keys, 1);
});

test("a table's own process, result or error column keeps its name; q-lint's gives way", () => {
  const merged = mergeOutcomes([
    { process: "a", answer: ok(grid({ process: [11, ["own"]], error: [10, ["e"]] })) },
    { process: "b", error: "down" },
  ]);
  assert.deepStrictEqual(merged.names, ["process_", "process", "error", "error_"]);
  assert.deepStrictEqual(merged.cells[0], ["a", "b"]);
  assert.deepStrictEqual(merged.cells[3], ["", "down"]);
});

test("the count is the rows each whole result had, not only those sent", () => {
  const big = grid({ v: [7, ["1", "2"], [1, 2]] });
  big.count = 50000;
  assert.strictEqual(mergeOutcomes([{ process: "a", answer: ok(big) }, { process: "b", error: "x" }]).count, 50001);
});

test("a one-character string ranks by its text, not its leading comma (#1126)", () => {
  const merged = mergeOutcomes([
    { process: "a", answer: ok(grid({ s: [0, ['"ab"', '"zz"']] })) },
    { process: "b", answer: ok(grid({ s: [0, [',"b"']] })) },
  ]);
  assert.deepStrictEqual(merged.rank[1], [0, 2, 1]);
});

test("timestamps and longs nanoseconds apart rank apart, exactly (#1127)", () => {
  const merged = mergeOutcomes([
    { process: "a", answer: ok(grid({ t: [12, ["2026.01.01D00:00:00.000000050"], ["820540800000000050"]] })) },
    { process: "b", answer: ok(grid({ t: [12, ["2026.01.01D00:00:00.000000000"], ["820540800000000000"]] })) },
  ]);
  assert.deepStrictEqual(merged.rank[1], [1, 0]);
});

test("Query a Tag ranks text in code point order, as q sorts it: an emoji after U+FF21 (#1747)", () => {
  const syms = ["\u{1F600}", "Ａ", "b"];
  const merged = mergeOutcomes([{ process: "p", answer: ok({ count: 3, keys: 0, names: ["s"], types: [11], cells: [syms], raw: [[]], rank: [[2, 1, 0]] }) }]);
  assert.deepStrictEqual(merged.rank[merged.names.indexOf("s")], [2, 1, 0]);
});
