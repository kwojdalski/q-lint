// Charts from a file (`chartfile.ts`, `chartcli.ts`): the edges of reading
// a CSV or JSON table into a grid. The main path is in dbtools.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gridFromCsv, gridFromJson, gridFromFile, chartFromGrid } = require("../out/chartfile.js");
const { main } = require("../out/chartcli.js");

/// Run the chart command line on `content` saved as `name`: its exit code and what it said.
async function cli(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-chartfile-"));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const said = [];
    const io = { out: (s) => said.push(s), err: (s) => said.push(s), stdin: () => "" };
    const code = await main([file, "-o", path.join(dir, "out.svg")], io);
    return { code, said: said.join("") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a CSV holding only an empty quoted field has no header row, and says so (#1939)", async () => {
  for (const text of ['""', '""\n', '\n""\n\n', '﻿""\r\n']) {
    assert.throws(() => gridFromCsv(text), { name: "Error", message: "the file has no header row" }, JSON.stringify(text));
  }
  assert.deepStrictEqual(await cli("q.csv", '""\n'), { code: 1, said: "chart: the file has no header row\n" });
  // A quoted name is a header, with no rows under it.
  assert.deepStrictEqual(gridFromCsv('"a"\n').columns.map((c) => c.name), ["a"]);
});

test("a JSON file that starts with a UTF-8 byte order mark is read as a CSV with one is (#1940)", async () => {
  const rows = '﻿[{"t":1,"v":2},{"t":2,"v":4}]';
  assert.deepStrictEqual(gridFromJson(rows).values, [[1, 2], [2, 4]]);
  assert.deepStrictEqual(gridFromFile("a.JSON", '﻿{"t":[1,2],"v":[2,4]}').values, [[1, 2], [2, 4]]);
  assert.match((await cli("bom.json", rows)).said, /^wrote .*out\.svg\n$/);
  assert.match((await cli("bom.csv", "﻿t,v\n1,2\n2,4\n")).said, /^wrote .*out\.svg\n$/);
  // Only at the start: elsewhere it is not JSON, as before.
  assert.throws(() => gridFromJson('[﻿{"t":1}]'), SyntaxError);
});

test("a JSON table's columns keep the text's order, integer-like names too, so the first is the x axis (#2449)", () => {
  const names = (g) => g.columns.map((c) => c.name);
  assert.deepStrictEqual(names(gridFromJson('[{"year":"y1","2024":1,"2025":2},{"year":"y2","2024":3,"2025":4}]')), ["year", "2024", "2025"]);
  assert.deepStrictEqual(names(gridFromJson('{"region":["EU","US"],"2024":[1,3],"2025":[2,4]}')), ["region", "2024", "2025"]);
  assert.deepStrictEqual(gridFromJson('{"region":["EU","US"],"2024":[1,3]}').cells[0], ["EU", "US"]);
});

test("JSON columns of unequal length keep every value: the short ones are padded with empty cells (#1941)", () => {
  const short = gridFromJson('{"t":[1],"b":[5,6,7]}');
  assert.strictEqual(short.total, 3);
  assert.deepStrictEqual(short.cells, [["1", "", ""], ["5", "6", "7"]]);
  assert.deepStrictEqual(short.values, [[1, null, null], [5, 6, 7]]);
  // Whichever column is the short one, by key order.
  const other = gridFromJson('{"b":[5,6,7],"t":[1]}');
  assert.deepStrictEqual([other.total, other.cells], [3, [["5", "6", "7"], ["1", "", ""]]]);
  // Every value of the long column is drawn: a bar each.
  const bars = (grid) => (chartFromGrid(grid, { kind: "bar", x: "t" }).match(/<rect /g) ?? []).length;
  assert.strictEqual(bars(short) - bars(gridFromJson('{"t":[1],"b":[5]}')), 2);
  assert.strictEqual(gridFromJson('{"t":[],"b":[]}').total, 0);
});

test("a column of hex, binary or octal ids is text, not the numbers JavaScript reads them as (#1954)", () => {
  const ids = gridFromCsv("id,v\n0x1F,1\n0x20,2\n0b11,3\n0o17,4\n");
  assert.deepStrictEqual(ids.columns.map((c) => c.numeric), [false, true]);
  assert.deepStrictEqual(ids.values, [null, [1, 2, 3, 4]]);
  assert.deepStrictEqual(ids.cells[0], ["0x1F", "0x20", "0b11", "0o17"]);
  // One such cell among numbers makes the column text, as any other word does.
  assert.deepStrictEqual(gridFromCsv("a\n1\n0x10\n").columns[0].numeric, false);
  // Every way of writing a decimal number is one still, blanks around it or not.
  const decimal = gridFromCsv("a\n1\n-2.5\n+3\n.5\n4.\n1e3\n2.5E-1\n 7 \n\n");
  assert.strictEqual(decimal.columns[0].numeric, true);
  assert.deepStrictEqual(decimal.values[0].filter((v) => v !== null), [1, -2.5, 3, 0.5, 4, 1000, 0.25, 7]);
  for (const word of ["Infinity", "1e", "e5", ".", "1.2.3", "--1", "1 2"]) {
    assert.strictEqual(gridFromCsv(`a\n1\n${word}\n`).columns[0].numeric, false, word);
  }
});
