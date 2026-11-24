// Data files in the grid (#962) and the CSV load wizard (#963),
// src/datafile.ts: a file's columns and types read from its first lines, and
// the q that loads it, without q. datatools_q.test.js runs that q.
const test = require("node:test");
const assert = require("node:assert");
const d = require("../out/datafile.js");

test("a data file's kind, delimiter and columns are read from its first lines, and each type guessed (#962, #963)", () => {
  assert.deepStrictEqual(d.dataKind("/a/t.CSV"), { kind: "csv", delimiter: "," });
  assert.deepStrictEqual(d.dataKind("t.tsv"), { kind: "csv", delimiter: "\t" });
  assert.deepStrictEqual(d.dataKind("t.json"), { kind: "json", delimiter: "" });
  assert.deepStrictEqual(d.dataKind("t.txt"), { kind: "csv", delimiter: "" });
  assert.strictEqual(d.dataKind("t.parquet"), undefined);
  assert.strictEqual(d.guessDelimiter("a;b;c"), ";");
  assert.strictEqual(d.guessDelimiter("a\tb"), "\t");
  assert.strictEqual(d.guessDelimiter("one"), ",");
  assert.deepStrictEqual(d.splitLine('a,"b, ""c""",d', ","), ["a", 'b, "c"', "d"]);
  assert.deepStrictEqual(d.splitLine("a,,", ","), ["a", "", ""]);
  const text = "\uFEFFsym,px,qty,d,ts,tm,note,id\nAAPL,1.5,10,2024-01-02,2024-01-02T10:00:00.123,10:00:00,\"hello, world\",1\nMSFT,2,,2024.01.03,2024-01-03 11:00:00,11:00:00.5,a long note here,99999999999999999999\n";
  const sample = d.sampleText(text);
  assert.deepStrictEqual(sample.names, ["sym", "px", "qty", "d", "ts", "tm", "note", "id"]);
  assert.deepStrictEqual(sample.types, ["S", "F", "J", "D", "P", "T", "*", "F"]);
  assert.strictEqual(sample.rows.length, 2);
  // A cut sample's last line is left out: it can be partial.
  assert.strictEqual(d.sampleText(text + "IBM,3", "", true).rows.length, 2);
  // A quoted field holding a newline is one field of one record (#1114).
  const quoted = d.sampleText('id,comment,qty\n1,"two\nlines",5\n2,ok,6');
  assert.deepStrictEqual(quoted.rows, [["1", "two\nlines", "5"], ["2", "ok", "6"]]);
  assert.deepStrictEqual(quoted.types, ["J", "*", "J"]);
  assert.strictEqual(d.guessType(["", " "]), "*");
  assert.strictEqual(d.guessType(["a b", "a b", "a b", "c d"]), "S");
});

test("a data file is loaded by its path, or from its text for a process elsewhere; the wizard's statement takes the types chosen (#962, #963)", () => {
  const sample = { types: ["S", "F", " "], delimiter: "," };
  assert.strictEqual(d.loadExpression("csv", "/data/t.csv", true, sample), '("SF ";enlist ",")0:`:/data/t.csv');
  assert.strictEqual(d.loadExpression("csv", "/my data/t.csv", true, sample), '("SF ";enlist ",")0:`$":/my data/t.csv"');
  assert.strictEqual(d.loadExpression("csv", "C:\\d\\t.csv", true, sample), '("SF ";enlist ",")0:`:C:/d/t.csv');
  assert.strictEqual(d.loadExpression("csv", "x", false, { types: ["S", "J"], delimiter: "\t" }, 'a\tb\n"x"\t1\n'), '("SJ";enlist "\\t")0:("a\\tb";"\\"x\\"\\t1")');
  assert.strictEqual(d.loadExpression("json", "/d/t.json", true, sample), ".j.k raze read0 `:/d/t.json");
  // A file that starts with a byte order mark is read by its lines, the
  // mark dropped: 0: would keep it in the first column's name (#1966).
  const marked = d.sampleText("\ufeffa,b\n1,2\n");
  assert.deepStrictEqual([marked.names, marked.types, marked.bom, d.sampleText("a,b\n1,2\n").bom], [["a", "b"], ["J", "J"], true, false]);
  assert.strictEqual(d.loadExpression("csv", "/d/t.csv", true, marked), '("JJ";enlist ",")0:{$["\\357\\273\\277"~3#first x;@[x;0;3_];x]}read0 `:/d/t.csv');
  assert.strictEqual(d.loadExpression("csv", "/d/t.csv", false, marked, "\ufeffa,b\n1,2\n"), '("JJ";enlist ",")0:("a,b";"1,2")');
  assert.strictEqual(d.fileSource("/d/t.csv", false), "`:/d/t.csv");
  assert.strictEqual(d.loadExpression("json", "x", false, sample, '[{"a":1},\n{"a":2}]'), '.j.k "[{\\"a\\":1}, {\\"a\\":2}]"');
  assert.strictEqual(d.linesLiteral("only\n"), 'enlist "only"');
  assert.strictEqual(d.tableName("/x/2024 trades-v2.csv"), "trades_v2");
  assert.strictEqual(d.tableName("/x/1.csv"), "t");
  // A reserved word or builtin cannot be assigned, so it gets a trailing _ (#1117).
  assert.strictEqual(d.tableName("/x/select.csv"), "select_");
  assert.strictEqual(d.tableName("/x/count.csv"), "count_");
  assert.strictEqual(d.tableName("/x/selection.csv"), "selection");
  assert.strictEqual(d.isLocalHost("LOCALHOST", "mac"), true);
  assert.strictEqual(d.isLocalHost("Mac", "mac"), true);
  assert.strictEqual(d.isLocalHost("db1", "mac"), false);
  // The launcher's loopback: any 127.x, 0.0.0.0 - 127.0.1.1 is Debian's hostname address (#1812).
  for (const host of ["127.0.1.1", "127.0.0.2", "0.0.0.0", "::1", ""]) {
    assert.strictEqual(d.isLocalHost(host, "mac"), true, host);
  }
  assert.strictEqual(d.isLocalHost("128.0.0.1", "mac"), false);
});
