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
async function cli(name, content, options = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-chartfile-"));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const said = [];
    const io = { out: (s) => said.push(s), err: (s) => said.push(s), stdin: () => "" };
    const out = path.join(dir, "out.svg");
    const code = await main([file, "-o", out, ...options], io);
    // What it drew, where a test asks for options: the others compare the whole answer.
    return { code, said: said.join(""), ...(options.length > 0 && fs.existsSync(out) ? { svg: fs.readFileSync(out, "utf8") } : {}) };
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

test("a tab-separated header with a comma in a name is read by its tabs, and a .tsv always (#2457)", () => {
  const g = gridFromCsv("date\tprice (EUR, net)\tqty\nmon\t1.5\t2\n");
  assert.deepStrictEqual(g.columns.map((c) => [c.name, c.numeric]), [["date", false], ["price (EUR, net)", true], ["qty", true]]);
  assert.deepStrictEqual(gridFromFile("a.tsv", "a,b\tc\n1,2\t3\n").columns.map((c) => c.name), ["a,b", "c"]);
  assert.deepStrictEqual(gridFromCsv("a,b\n1,2\n").columns.map((c) => c.name), ["a", "b"]);
});

test("a one-column CSV's empty lines are null cells, each at its own row (#2458)", () => {
  const g = gridFromCsv("\nlatency\n5\n\n\n7\n9\n");
  assert.deepStrictEqual(g.values[0], [5, null, null, 7, 9]);
  // Two columns: a blank line is no row.
  assert.deepStrictEqual(gridFromCsv("a,b\n1,2\n\n3,4\n").values, [[1, 3], [2, 4]]);
});

test("a JSON column of strings is text, however much they look like numbers (#2469)", () => {
  const g = gridFromJson('[{"day":"mon","zip":"02134","sales":5},{"day":"tue","zip":"10001","sales":null}]');
  assert.deepStrictEqual(g.columns.map((c) => [c.name, c.numeric]), [["day", false], ["zip", false], ["sales", true]]);
  assert.deepStrictEqual(gridFromJson('{"zip":["02134","10001"],"n":[1,2]}').columns.map((c) => c.numeric), [false, true]);
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

test("an infinity or a null as q's csv writes one is a gap in a numeric column, not a reason to read it as text (#3127)", async () => {
  // `:c1.csv 0: csv 0: ([] t:til 5; v:1 0w 3 -0w 0n; n:1 0W 3 -0W 0N)
  const q = gridFromCsv("t,v,n\n0,1,1\n1,0w,0W\n2,3,3\n3,-0w,-0W\n4,,\n");
  assert.deepStrictEqual(q.columns.map((c) => c.numeric), [true, true, true]);
  assert.deepStrictEqual(q.values[1], [1, null, 3, null, null]);
  assert.deepStrictEqual(q.values[2], [1, null, 3, null, null]);
  assert.deepStrictEqual(q.cells[1], ["1", "0w", "3", "-0w", ""], "the cells are the file's");
  assert.deepStrictEqual(gridFromCsv("a\n1\n0n\n0N\ninf\n-inf\nNaN\n").values[0], [1, null, null, null, null, null]);
  const said = await cli("c1.csv", "t,v\n0,1\n1,0w\n2,3\n3,-0w\n4,\n", ["--y", "v"]);
  assert.strictEqual(said.code, 0, said.said);
  assert.match(said.svg, />v<\/text>/);
  // A gap makes no column of words numeric, nor one of gaps alone.
  assert.strictEqual(gridFromCsv("a\n0w\nw\n").columns[0].numeric, false);
  assert.strictEqual(gridFromCsv("a\n0w\n0n\n").columns[0].numeric, false);
  assert.strictEqual(gridFromCsv("a\n1\n0wx\n").columns[0].numeric, false);
});

test("--y names a column whose name holds a comma, and still lists columns where no one column has that name (#3147)", async () => {
  const csv = 'sym,a b,"x,y",x,y\nA,1,2,3,4\nB,2,3,4,5\n';
  const whole = await cli("k4.csv", csv, ["--y", "x,y"]);
  assert.deepStrictEqual([whole.code, whole.said.replace(/ .*/s, "")], [0, "wrote"]);
  assert.match(whole.svg, />x,y<\/text>/);
  assert.doesNotMatch(whole.svg, />[xy]<\/text>/);
  const two = await cli("k5.csv", "sym,x,y\nA,3,4\nB,4,5\n", ["--y", "x,y"]);
  assert.strictEqual(two.code, 0);
  assert.match(two.svg, />x<\/text>[^]*>y<\/text>/);
  assert.match((await cli("k6.csv", csv, ["--y", "x,z"])).said, /chart: no column z: /);
});

test("a candlestick draws the four columns --y names as its open, high, low and close, and refuses another count (#3126)", async () => {
  const csv = "t,volume,vwap,o1,h1,l1,c1\n09:00,100,10,10,12,9,11\n09:01,200,11,11,13,10,12\n09:02,300,12,12,13,11,11\n";
  const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]);
  const drawn = texts(chartFromGrid(gridFromCsv(csv), { kind: "candlestick", y: ["o1", "h1", "l1", "c1"] }));
  const axis = drawn.slice(0, drawn.indexOf("09:00")).map(Number);
  assert.ok(Math.min(...axis) >= 8 && Math.max(...axis) <= 14, "the y axis spans the prices, not the volume: " + axis.join(" "));
  // In the order given: the close first is a candle of another colour.
  const fills = (y) => [...chartFromGrid(gridFromCsv(csv), { kind: "candlestick", y }).matchAll(/<rect x[^>]*fill="([^"]*)"/g)].map((m) => m[1]);
  assert.notDeepStrictEqual(fills(["o1", "h1", "l1", "c1"]), fills(["c1", "h1", "l1", "o1"]));
  assert.throws(() => chartFromGrid(gridFromCsv(csv), { kind: "candlestick", y: ["o1", "h1", "l1"] }), /a candlestick takes four columns, its open, high, low and close in that order: 3 given/);
  assert.throws(() => chartFromGrid(gridFromCsv(csv), { kind: "candlestick", y: ["o1", "h1", "l1", "cc"] }), /no column cc/);
  const said = await cli("k.csv", csv, ["--kind", "candlestick", "--y", "o1,h1"]);
  assert.strictEqual(said.code, 1);
  assert.match(said.said, /chart: a candlestick takes four columns/);
  // With no --y, found by itself as before.
  assert.doesNotThrow(() => chartFromGrid(gridFromCsv(csv), { kind: "candlestick" }));
});

test("a query's chart of more rows than it draws says how many it left out, on the chart and on stderr (#2456)", { skip: require("./qserver.js").skip }, async (t) => {
  const { connection, dir } = await require("./qserver.js").connect(t, "");
  const port = (await connection.evaluate('system"p"')).value;
  const out = path.join(dir, "big.svg");
  const said = { out: [], err: [] };
  const io = { out: (s) => said.out.push(s), err: (s) => said.err.push(s), stdin: () => "" };
  const code = await main(["--host", "127.0.0.1", "--port", String(port), "--query", "([] x:til 250000; y:til 250000)", "--kind", "line", "-o", out], io);
  assert.strictEqual(code, 0);
  assert.match(said.err.join(""), /250,000 rows: only the first 100,000 of 250,000 rows are drawn/);
  assert.match(fs.readFileSync(out, "utf8"), /the first 100,000 of 250,000 rows/);
});

test("a query's chart reads under reval: a write the guard misses is refused by q, and nothing changes (#2642)", { skip: require("./qserver.js").skip }, async (t) => {
  const { connection, dir } = await require("./qserver.js").connect(t, "t:([] x:1 2; y:3 4)");
  const port = (await connection.evaluate('system"p"')).value;
  const out = path.join(dir, "c.svg");
  const said = { out: [], err: [] };
  const io = { out: (s) => said.out.push(s), err: (s) => said.err.push(s), stdin: () => "" };
  const code = await main(["--host", "127.0.0.1", "--port", String(port), "--query", '(1-1)"zc:1";t', "-o", out], io);
  assert.notStrictEqual(code, 0);
  assert.match(said.err.join(""), /refused by its read-only evaluation/);
  assert.strictEqual((await connection.evaluate("`zc in key`.")).value, false);
  // A read still draws.
  assert.strictEqual(await main(["--host", "127.0.0.1", "--port", String(port), "--query", "t", "-o", out], io), 0);
});
