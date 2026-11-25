// The result panel's views of one result (#919, #923, #924, #928): what
// changed since the previous run (src/resultdiff.ts), the column statistics
// and heatmap levels (media/result.js's helpers), and a value's tree as
// `GRID` sends it (src/grid.ts) and as unwrapped mode makes it
// (src/qformat.ts). Run after `tsc`.
const test = require("node:test");
const assert = require("node:assert");
const { readTree, toGrid, TREE_NODES } = require("../out/grid.js");
const { diffGrids, DIFF_CELLS } = require("../out/resultdiff.js");
const { treeOfQ, gridOfQ } = require("../out/qformat.js");
const panel = require("../media/result.js");

/// A grid of columns {name: [cells]}, the first `keys` of them keys, longs
/// unless `types` says otherwise.
function grid(columns, keys = 0, types = {}) {
  const names = Object.keys(columns);
  const type = (n) => types[n] ?? 7;
  return toGrid(
    {
      count: columns[names[0]].length,
      keys,
      names,
      types: names.map(type),
      cells: names.map((n) => columns[n].map(String)),
      raw: names.map((n) => ([5, 6, 7, 8, 9].includes(type(n)) ? columns[n].map((x) => (x === "" ? null : Number(x))) : [])),
      rank: names.map((n) => {
        const sorted = [...new Set(columns[n].map(String))].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0)));
        const place = new Map(sorted.map((x, i) => [x, i]));
        return columns[n].map((x) => place.get(String(x)));
      }),
    },
    -1,
  );
}

test("a diff by place marks changed cells with what they were, and rows past the old end as added", () => {
  const d = diffGrids(grid({ a: [1, 2, 3], b: [10, 20, 30] }), grid({ a: [1, 5, 3, 4], b: [10, 20, 31, 40] }));
  assert.strictEqual(d.matchedBy, "place");
  assert.deepStrictEqual(d.changes, [
    [0, 1, "2"],
    [1, 2, "30"],
  ]);
  assert.strictEqual(d.changed, 2);
  assert.deepStrictEqual(d.addedRows, [3]);
  assert.strictEqual(d.removed.count, 0);
  // Fewer rows: the old tail is removed, shown as it was.
  const shorter = diffGrids(grid({ a: [1, 2, 3] }), grid({ a: [1] }));
  assert.deepStrictEqual(shorter.removed, { columns: ["a"], rows: [["2"], ["3"]], count: 2 });
});

test("a row past the other run's cut at gridLimit is not compared: neither added nor removed (#1640)", () => {
  const cut = (columns, total, keys = 0) => ({ ...grid(columns, keys), total });
  const d = diffGrids(cut({ id: [1, 2], v: [10, 20] }, 4), grid({ id: [1, 2, 3, 4], v: [10, 20, 30, 40] }));
  assert.deepStrictEqual(d.addedRows, []);
  assert.strictEqual(d.changed, 0);
  assert.strictEqual(d.uncompared, 2);
  const back = diffGrids(grid({ id: [1, 2, 3, 4], v: [10, 20, 30, 40] }), cut({ id: [1, 2], v: [10, 20] }, 4));
  assert.strictEqual(back.removed.count, 0);
  assert.strictEqual(back.uncompared, 2);
  const keyed = diffGrids(cut({ id: [1, 2], v: [10, 20] }, 4, 1), grid({ id: [3, 1, 2, 4], v: [30, 10, 20, 40] }, 1));
  assert.deepStrictEqual(keyed.addedRows, []);
  assert.strictEqual(keyed.uncompared, 2);
  // Neither cut: added and removed as before.
  assert.strictEqual(diffGrids(grid({ a: [1] }), grid({ a: [1, 2] })).uncompared, 0);
});

test("a keyed result is matched by its key, so a row that moved is not a change", () => {
  const before = grid({ k: ["a", "b", "c"], v: [1, 2, 3] }, 1, { k: 11 });
  const after = grid({ k: ["c", "a", "d"], v: [3, 9, 4] }, 1, { k: 11 });
  const d = diffGrids(before, after);
  assert.strictEqual(d.matchedBy, "key");
  assert.deepStrictEqual(d.changes, [[1, 1, "1"]]);
  assert.deepStrictEqual(d.addedRows, [2]);
  assert.deepStrictEqual(d.removed.rows, [["b", "2"]]);
  // Keyed by other columns: by place.
  assert.strictEqual(diffGrids(grid({ j: ["a"], v: [1] }, 1, { j: 11 }), after).matchedBy, "place");
});

test("columns are matched by name: a new one is added, a missing one removed", () => {
  const d = diffGrids(grid({ a: [1, 2], gone: [5, 6] }), grid({ fresh: [7, 8], a: [1, 3] }));
  assert.deepStrictEqual(d.addedColumns, [0]);
  assert.deepStrictEqual(d.removedColumns, ["gone"]);
  assert.deepStrictEqual(d.changes, [[1, 1, "2"]]);
});

test("a diff lists at most DIFF_CELLS changes, and counts them all", () => {
  const n = DIFF_CELLS + 10;
  const d = diffGrids(grid({ a: Array.from({ length: n }, (_, i) => i) }), grid({ a: Array.from({ length: n }, (_, i) => i + 1) }));
  assert.strictEqual(d.changes.length, DIFF_CELLS);
  assert.strictEqual(d.changed, n);
});

test("column statistics over the rows shown: nulls, distinct, min and max by q's order, a numeric mean", () => {
  const g = grid({ s: ["b", "", "a", "b"], x: [4, "", 2, -1] }, 0, { s: 11, x: 7 });
  const [s, x] = panel.columnStats(g, [0, 1, 2, 3]);
  assert.deepStrictEqual(s, { name: "s", type: "symbol (s)", count: 4, nulls: 1, distinct: 3, min: "a", max: "b", mean: "" });
  assert.deepStrictEqual(x, { name: "x", type: "long (j)", count: 4, nulls: 1, distinct: 4, min: "-1", max: "4", mean: "1.66666666667" });
  // Only the rows shown: a filter applies.
  const [, only] = panel.columnStats(g, [0, 2]);
  assert.deepStrictEqual([only.count, only.nulls, only.min, only.max, only.mean], [2, 0, "2", "4", "3"]);
  // No row: nothing to say.
  const [none] = panel.columnStats(g, []);
  assert.deepStrictEqual([none.count, none.distinct, none.min, none.mean], [0, 0, "", ""]);
});

test("statistics: a null guid and a blank char are nulls, and a column q could not sort has no min or max", () => {
  const nullGuid = "00000000-0000-0000-0000-000000000000";
  const g = {
    columns: [
      { name: "g", type: 2, typeName: "guid (g)", numeric: false },
      { name: "c", type: 10, typeName: "char (c)", numeric: false },
      { name: "l", type: 0, typeName: "list", numeric: false },
    ],
    cells: [[nullGuid, "8c680a01-5a49-5aab-5a65-d4bfddb6a661"], [" ", "a"], ["1 2", "`a`b"]],
    rank: [[0, 1], [0, 1], null],
    values: [null, null, null],
    total: 2,
  };
  const [guid, char, list] = panel.columnStats(g, [0, 1]);
  assert.strictEqual(guid.nulls, 1);
  assert.strictEqual(char.nulls, 1);
  assert.deepStrictEqual([list.distinct, list.min, list.max], [2, "", ""]);
});

test("heatmap levels run from the least to the greatest, or about zero when a column has both signs", () => {
  assert.deepStrictEqual(panel.heatLevels([1, 3, null, 2]), [0, 1, null, 0.5]);
  assert.deepStrictEqual(panel.heatLevels([-2, 1, 4]), [-0.5, 0.25, 1]);
  // One value, or none: nothing to colour.
  assert.strictEqual(panel.heatLevels([5, 5, null]), null);
  assert.strictEqual(panel.heatLevels(null), null);
  // From the theme: blue up, red down.
  assert.match(panel.heatColour(1), /--vscode-charts-blue.* 56%/);
  assert.match(panel.heatColour(-0.5), /--vscode-charts-red.* 31%/);
});

test("a tree node as GRID sends it, and nothing that is not one", () => {
  const raw = ["", "", 99, 2, [["a", "1", -7, 1, []], ["b", "", 0, 3, [["0", "\"x\"", 10, 1, []]]]]];
  assert.deepStrictEqual(readTree(raw), {
    key: "",
    text: "",
    type: 99,
    count: 2,
    children: [
      { key: "a", text: "1", type: -7, count: 1, children: [] },
      { key: "b", text: "", type: 0, count: 3, children: [{ key: "0", text: '"x"', type: 10, count: 1, children: [] }] },
    ],
  });
  assert.strictEqual(readTree([]), undefined);
  assert.strictEqual(readTree(["", "", 0, 1, [["bad"]]]), undefined);
  // Nested past 64 levels: cut there, not dropped (#1654).
  let deep = ["", "1", -7, 1, []];
  for (let i = 0; i < 70; i++) deep = [String(i), "", 0, 1, [deep]];
  let node = readTree(deep);
  let levels = 0;
  while (node.children.length > 0) {
    node = node.children[0];
    levels++;
  }
  assert.strictEqual(levels, 64);
  assert.deepStrictEqual([node.count, node.text], [1, ""], "the cut node says it had a child not sent");
});

test("a tree node says what it holds, and opens when it has children or had some not sent", () => {
  const node = (type, count, text = "", children = []) => ({ key: "k", text, type, count, children });
  assert.strictEqual(panel.treeText(node(0, 3)), "list of 3");
  assert.strictEqual(panel.treeText(node(99, 1200)), "dictionary of 1,200");
  assert.strictEqual(panel.treeText(node(98, 1)), "table of 1 row");
  assert.strictEqual(panel.treeText(node(7, 4)), "long list of 4");
  assert.strictEqual(panel.treeText(node(10, 2, '"ab"')), '"ab"');
  assert.strictEqual(panel.treeText(node(-7, 1, "42")), "42");
  assert.strictEqual(panel.treeOpens(node(0, 3, "", [node(-7, 1, "1")])), true);
  // Cut by the budget: it opens, to say what was not sent.
  assert.strictEqual(panel.treeOpens(node(7, 100)), true);
  assert.strictEqual(panel.treeOpens(node(10, 2, '"ab"')), false);
  assert.strictEqual(panel.treeOpens(node(98, 5)), false);
});

test("unwrapped mode makes the tree GRID would: entries and items as children, the budget shared out", () => {
  const atom = (t, v) => ({ kind: "atom", t, v });
  const longs = (v) => ({ kind: "vector", t: 7, attr: 0, v });
  const syms = (v) => ({ kind: "vector", t: 11, attr: 0, v });
  const dict = { kind: "dict", sorted: false, k: syms(["a", "b"]), v: { kind: "list", attr: 0, v: [atom(-7, 1), { kind: "chars", attr: 0, v: Buffer.from("xy") }] } };
  const tree = treeOfQ(dict);
  assert.deepStrictEqual(
    tree.children.map((c) => [c.key, c.text, c.type, c.count]),
    [
      ["a", "1", -7, 1],
      ["b", '"xy"', 10, 2],
    ],
  );
  assert.strictEqual(gridOfQ(dict, 10).tree.type, 99);
  // A table has no tree; a list of 10000 lists is cut to TREE_NODES nodes.
  const wide = { kind: "list", attr: 0, v: Array.from({ length: 10000 }, () => longs([1, 2, 3])) };
  const nodes = (t) => 1 + t.children.reduce((n, c) => n + nodes(c), 0);
  assert.strictEqual(nodes(treeOfQ(wide)), TREE_NODES);
  assert.strictEqual(gridOfQ({ kind: "table", attr: 0, cols: ["a"], data: [longs([1])] }, 10).tree, undefined);
  // Narrow and deep: every level opened.
  const deep = treeOfQ({ kind: "list", attr: 0, v: [longs([1, 2]), syms(["p"])] });
  assert.deepStrictEqual(deep.children[0].children.map((c) => c.text), ["1", "2"]);
  assert.deepStrictEqual(deep.children[1].children.map((c) => c.text), ["`p"]);
});

test("a diff of a key repeated on many rows matches them in order in linear time (#1860)", () => {
  const { diffGrids } = require("../out/resultdiff.js");
  const mk = (rows) => ({ columns: [{ name: "s", key: true }, { name: "v", key: false }], cells: [Array.from({ length: rows }, (_, i) => "k" + (i % 10)), Array.from({ length: rows }, (_, i) => String(i))], total: rows });
  // Best of three: one garbage collection or a busy machine during a single
  // run made 400k look five times 200k with the code unchanged.
  const time = (rows) => {
    const a = mk(rows);
    const b = mk(rows);
    return Math.min(
      ...[0, 1, 2].map(() => {
        const t = process.hrtime.bigint();
        diffGrids(a, b);
        return Number(process.hrtime.bigint() - t) / 1e6;
      }),
    );
  };
  time(50_000);
  const small = time(200_000);
  const big = time(400_000);
  // Shifting per row was four times the cost per doubling: 304 ms, then 1163 ms.
  assert.ok(big < Math.max(small, 20) * 3, `${small} ms at 200k, ${big} ms at 400k`);
  // Two rows with one key are still matched in their order.
  const before = { columns: [{ name: "s", key: true }, { name: "v", key: false }], cells: [["a", "a", "b"], ["1", "2", "3"]], total: 3 };
  const after = { columns: [{ name: "s", key: true }, { name: "v", key: false }], cells: [["a", "b", "a", "a"], ["1", "3", "9", "4"]], total: 4 };
  // The second a is matched to the second a (2 to 9); the third is new.
  const d = diffGrids(before, after);
  assert.deepStrictEqual(d.changes, [[1, 2, "2"]]);
  assert.deepStrictEqual(d.addedRows, [3]);
  assert.strictEqual(d.removed.count, 0);
});
