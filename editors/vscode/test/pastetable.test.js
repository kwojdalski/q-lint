// Paste as q Table (#967) and the JSON conversion (#968): CSV and TSV read
// as a spreadsheet copies them, each column's type inferred, JSON written as
// `.j.k` reads it, and the three commands through the stand-in `vscode` -
// pasting at the selection, Copy Value as JSON going through runOnActive
// (so the read-only guard holds it), and each refusing, sending nothing,
// when its switch is off. The values against a real q are
// pastetable_q.test.js and jsonq_q.test.js.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const p = require("../out/pastetable.js");
const { jsonToQ, toJsonQuery } = require("../out/jsonq.js");
const { EVALUATE } = require("../out/query.js");
const pkg = require("../package.json");

test("CSV and TSV are read as a spreadsheet writes them", () => {
  assert.deepStrictEqual(p.readDelimited("a,b\r\n1,2\r\n"), { delimiter: ",", rows: [["a", "b"], ["1", "2"]] });
  assert.deepStrictEqual(p.readDelimited("a\tb\n1\t2").delimiter, "\t");
  assert.deepStrictEqual(p.readDelimited("a;b\n1,5;2").delimiter, ";");
  // The delimiter is counted outside quotes only, over the whole first record (#1100).
  assert.deepStrictEqual(p.readDelimited('"a;b;c",x\n1,2'), { delimiter: ",", rows: [["a;b;c", "x"], ["1", "2"]] });
  assert.deepStrictEqual(p.readDelimited('"a\n;;",x\n1,2').delimiter, ",");
  // Quotes hold the delimiter, a newline and a doubled quote.
  assert.deepStrictEqual(p.readDelimited('x,y\n"a,b","say ""hi""\nthere"\n').rows, [["x", "y"], ["a,b", 'say "hi"\nthere']]);
  // A byte order mark and blank lines are no data.
  assert.deepStrictEqual(p.readDelimited("﻿a,b\n\n1,2\n\n").rows, [["a", "b"], ["1", "2"]]);
  // In one column, a blank line between rows is an empty cell, and a quoted "" always is (#1404).
  assert.deepStrictEqual(p.readDelimited("a\n\n1\n\n").rows, [["a"], [""], ["1"]]);
  assert.deepStrictEqual(p.readDelimited('1\n""\n3').rows, [["1"], [""], ["3"]]);
  assert.strictEqual(p.pasteTable("v\n1\n\n3").code, "([] v:1 0N 3)");
});

// One spreadsheet column is copied with no tab in it, and its cells may hold
// commas: they were cut in two, and the header, one cell wide, read as a row
// (#1986).
test("a paste of one column is one column, commas in its cells or not (#1986)", () => {
  assert.deepStrictEqual(p.readDelimited("name\nSmith, John\nDoe, Jane").rows, [["name"], ["Smith, John"], ["Doe, Jane"]]);
  const names = p.pasteTable("name\nSmith, John\nDoe, Jane");
  assert.deepStrictEqual([names.code, names.names, names.kinds, names.rows, names.header], ['([] name:("Smith, John";"Doe, Jane"))', ["name"], ["string"], 2, true]);
  const grouped = p.pasteTable("v\n1,234\n5,678\n");
  assert.deepStrictEqual([grouped.code, grouped.names, grouped.rows, grouped.header], ['([] v:(`$"1,234";`$"5,678"))', ["v"], 2, true]);
  // No header: a later cell holds more commas than the first, so they are no columns.
  assert.deepStrictEqual(p.readDelimited("1 Main St, Springfield\n22 Oak Ave, Apt 4, Boston").rows, [["1 Main St, Springfield"], ["22 Oak Ave, Apt 4, Boston"]]);
  // Semicolons the same, and a quoted cell's are its text.
  assert.deepStrictEqual(p.readDelimited("note\nfirst; second\nthird").rows, [["note"], ["first; second"], ["third"]]);
  assert.deepStrictEqual(p.readDelimited('note\n"a, ""b"""\nc, d').rows, [["note"], ['a, "b"'], ["c, d"]]);
  // A blank line between its rows is still an empty cell (#1404).
  assert.deepStrictEqual(p.readDelimited("name\n\nSmith, John\n").rows, [["name"], [""], ["Smith, John"]]);
  // A tab in a later cell is its text, as it was: the first record says how cells are apart.
  assert.deepStrictEqual(p.readDelimited("note\nz\ntab\there"), { delimiter: "", rows: [["note"], ["z"], ["tab\there"]] });
  // A delimiter given is used, whatever the text holds.
  assert.deepStrictEqual(p.readDelimited("name\nSmith, John", ",").rows, [["name"], ["Smith", " John"]]);
});

test("CSV text is still read by its commas or semicolons, short rows and quoted cells too (#1986)", () => {
  const rows = (text) => p.readDelimited(text);
  // Rows shorter than the header, and cells left empty.
  assert.deepStrictEqual(rows("a,b,c\n1,2\n3,4,5"), { delimiter: ",", rows: [["a", "b", "c"], ["1", "2"], ["3", "4", "5"]] });
  assert.deepStrictEqual(rows("a,b,c\n1,,\n,,\n"), { delimiter: ",", rows: [["a", "b", "c"], ["1", "", ""], ["", "", ""]] });
  // A quoted cell's commas and newline are no fields of their own.
  assert.deepStrictEqual(rows('name,note\r\n"Smith, John","a, b,\nc"\r\nDoe,x\r\n'), { delimiter: ",", rows: [["name", "note"], ["Smith, John", "a, b,\nc"], ["Doe", "x"]] });
  // A blank line first, or between records, is none.
  assert.deepStrictEqual(rows("\n\na,b\n\n1,2\n"), { delimiter: ",", rows: [["a", "b"], ["1", "2"]] });
  // Semicolons, with a decimal comma in the cells.
  assert.deepStrictEqual(rows("name;price\nx;1,5\ny;2,25"), { delimiter: ";", rows: [["name", "price"], ["x", "1,5"], ["y", "2,25"]] });
  // Both in the first record: the one it has more of, where the text is a table by it.
  assert.strictEqual(rows("a;b;c,d\n1;2;3,4").delimiter, ";");
  assert.strictEqual(rows("a;b,c\n1;2,3").delimiter, ",");
  assert.deepStrictEqual(rows("a;b;c,d\n1;2;3;4,5"), { delimiter: ",", rows: [["a;b;c", "d"], ["1;2;3;4", "5"]] });
  // One record, and a header alone.
  assert.deepStrictEqual(rows("1,2,3").rows, [["1", "2", "3"]]);
  assert.strictEqual(p.pasteTable("a,b\n1,2\n3,4").code, "([] a:1 3; b:2 4)");
  // A tab in the first record is the delimiter, as before, and commas beside it are text.
  assert.deepStrictEqual(rows("name\tcity\nSmith, John\tAustin, TX").rows, [["name", "city"], ["Smith, John", "Austin, TX"]]);
});

test("each column's type is the first that reads every cell, an empty cell its null", () => {
  assert.strictEqual(p.inferKind(["true", "FALSE"]), "boolean");
  assert.strictEqual(p.inferKind(["1", "", "-3"]), "long");
  assert.strictEqual(p.inferKind(["1", "2.5", "1e3"]), "float");
  assert.strictEqual(p.inferKind(["2024-01-02", "", "2024-02-29"]), "date");
  assert.strictEqual(p.inferKind(["2024-01-02", "2024.01.03"]), "date");
  // One separator throughout, as q's 0: reads it.
  assert.strictEqual(p.inferKind(["2024.01-02"]), "symbol");
  assert.strictEqual(p.inferKind(["2024-01-02 03:04:05", "2024-01-02T03:04:05.123456789"]), "timestamp");
  assert.strictEqual(p.inferKind(["09:30", "09:30:01.5"]), "time");
  assert.strictEqual(p.inferKind(["AAPL", "EUR/USD"]), "symbol");
  assert.strictEqual(p.inferKind(["Apple Inc", "x"]), "string");
  assert.strictEqual(p.cellLiteral("time", "09:30"), "09:30:00.000");
  assert.strictEqual(p.cellLiteral("long", "9223372036854775808"), undefined);
  assert.strictEqual(p.cellLiteral("float", "12345678901234567890"), "1.2345678901234567e19");
  assert.strictEqual(p.cellLiteral("float", "100"), "100f");
  assert.strictEqual(p.cellLiteral("symbol", "_y"), '`$"_y"');
  assert.strictEqual(p.cellLiteral("string", "x"), 'enlist "x"');
  assert.strictEqual(p.cellLiteral("string", "é"), '"é"');
});

test("a paste is a ([] ...) literal: names from a header, vectors where q reads them", () => {
  const t = p.pasteTable("sym,px,qty,date,time,ok,name\nAAPL,1.5,100,2024-01-02,09:30:00,true,Apple Inc\nMSFT,,200,,09:31:00.5,FALSE,x\n");
  assert.strictEqual(
    t.code,
    '([] sym:`AAPL`MSFT; px:1.5 0n; qty:100 200; date:(2024.01.02;0Nd); time:09:30:00.000 09:31:00.500; ok:10b; name:("Apple Inc";enlist "x"))',
  );
  assert.deepStrictEqual([t.header, t.rows, t.dropped], [true, 2, 0]);
  // No header when the first row reads as its columns' type.
  assert.strictEqual(p.pasteTable("1,2\n3,4").code, "([] c1:1 3; c2:2 4)");
  // Names made q names, a reserved word given a _, a repeat numbered.
  assert.deepStrictEqual(p.pasteTable("count,x y,1a,x y\n1,2,3,4").names, ["count_", "x_y", "c1a", "x_y_1"]);
  // One row: enlist.
  assert.strictEqual(p.pasteTable("a,b\n1,x").code, "([] a:enlist 1; b:enlist `x)");
  assert.deepStrictEqual(p.pasteTable(""), { error: "the clipboard holds no rows." });
  const many = p.pasteTable(`a\n${"1\n".repeat(p.MAX_ROWS + 5)}`);
  assert.deepStrictEqual([many.rows, many.dropped], [p.MAX_ROWS, 5]);
  // A paste too large to spread into Math.max still keeps the first rows (#1403).
  const huge = p.pasteTable(`a,b\n${"1,2\n".repeat(300000)}`);
  assert.deepStrictEqual([huge.rows, huge.dropped], [p.MAX_ROWS, 300000 - p.MAX_ROWS]);
});

test("JSON is written as .j.k reads it", () => {
  const q = (s) => jsonToQ(s).code;
  assert.strictEqual(q('{"a":1,"b":"x"}'), "(`a`b)!(1f;enlist \"x\")");
  assert.strictEqual(q("[1,2,null]"), "1 2 0n");
  assert.strictEqual(q("[1,2]"), "1 2f");
  assert.strictEqual(q("[true,false]"), "10b");
  assert.strictEqual(q('[{"a":1,"b":"x"},{"a":2,"b":"yy"}]'), '([] a:1 2f; b:(enlist "x";"yy"))');
  assert.strictEqual(q('[{"count":1}]'), "flip (enlist `count)!enlist enlist 1f");
  assert.strictEqual(q('[{"a":1},{"b":2}]'), "((enlist `a)!enlist 1f;(enlist `b)!enlist 2f)");
  assert.strictEqual(q("{}"), "(`symbol$())!()");
  assert.strictEqual(q("[]"), "()");
  assert.strictEqual(q('{"a b":[]}'), '(enlist `$"a b")!enlist ()');
  assert.strictEqual(q("1e400"), "0w");
  assert.match(jsonToQ("{oops").error, /^the clipboard holds no JSON/);
  // Keys in the text's order, integer-like ones too, as .j.k keeps them (#1075).
  assert.strictEqual(q('{"sym":"a","2024":1,"1":2}'), '(`sym`2024`1)!(enlist "a";1f;2f)');
  assert.strictEqual(q('[{"b":1,"1":2},{"1":3,"b":4}]'), "((`b`1)!1 2f;(`1`b)!3 4f)");
  // A repeated key kept each time, in its place, as KDB-X's .j.k keeps it (#2185).
  assert.strictEqual(q('{"a":1,"b":2,"a":3}'), "(`a`b`a)!1 2 3f");
  assert.strictEqual(q('{"a":1,"a":2}'), "(`a`a)!1 2f");
  assert.strictEqual(q('[{"a":1,"a":2},{"a":3,"a":4}]'), "flip (`a`a)!(1 3f;2 4f)");
  assert.strictEqual(q('[{"a":1,"b":2},{"a":3,"a":4}]'), "((`a`b)!1 2f;(`a`a)!3 4f)");
  // A whole number past a long is capped at 2^63, as .j.k caps it; one with
  // a fraction or an exponent is the double nearest.
  assert.strictEqual(q("123456789012345678901234567890"), "9.223372036854776e18");
  assert.strictEqual(q("[-123456789012345678901234567890,1]"), "-9.223372036854776e18 1");
  assert.strictEqual(q("1e30"), "1e30");
  assert.strictEqual(q("1234567890123456789012.5"), q("1.2345678901234568e21"));
  assert.strictEqual(q('{"__proto__":1}'), '(enlist `$"__proto__")!enlist 1f');
  assert.strictEqual(toJsonQuery('t:([] a:1); "x"'), '.j.j value "t:([] a:1); \\"x\\""');
  // The statements of a selection, each run as Run Selection runs it: a
  // newline is a blank to value, so bb:1 over 2 3 would be bb:1 2 3 (#1969).
  assert.strictEqual(toJsonQuery("bb:1\n2 3"), '.j.j last value each ("bb:1";"2 3")');
  assert.strictEqual(toJsonQuery("ff:{[u]\n u+1}\nx\n"), '.j.j last value each ("ff:{[u]\\n u+1}";enlist "x")');
  assert.strictEqual(toJsonQuery("/ a note\n1+1 / and another\n"), '.j.j value "1+1 / and another"');
  assert.deepStrictEqual([toJsonQuery("t\n"), toJsonQuery("")], ['.j.j value "t"', '.j.j value ""']);
});

test("the switches are declared, on by default, and hide the commands when off", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.pasteTable.enable"].default, true);
  assert.strictEqual(props["q-lint.jsonConversion.enable"].default, true);
  const when = (command) => pkg.contributes.menus.commandPalette.find((m) => m.command === command).when;
  assert.strictEqual(when(p.PASTE.table), "config.q-lint.pasteTable.enable");
  assert.strictEqual(when(p.PASTE.json), "config.q-lint.jsonConversion.enable");
  assert.strictEqual(when(p.PASTE.copyJson), "config.q-lint.jsonConversion.enable");
});

function fakeEditor(text) {
  const editor = {
    text,
    selections: [{ start: text.length, end: text.length }],
    edit: async (f) => {
      f({ replace: (s, code) => (editor.text = editor.text.slice(0, s.start) + code + editor.text.slice(s.end)) });
      return true;
    },
  };
  return editor;
}

test("the pastes write at the selection; Copy Value as JSON asks the process through runOnActive", async () => {
  stub.reset();
  let clipboard = "a,b\n1,x\n";
  vscode.env = { clipboard: { readText: async () => clipboard, writeText: async (s) => void (clipboard = s) } };
  const sent = [];
  const live = {
    codeFromEditor: async () => "([] a:1 2)",
    runOnActive: async (code, query) => {
      sent.push(code);
      return { process: "dev", value: await query({ guarded: async (lambda) => (sent.push(lambda(EVALUATE)), '[{"a":1},{"a":2}]') }) };
    },
  };
  const { registerPaste } = require("../out/pasteview.js");
  const context = stub.newContext();
  registerPaste(context, live);
  vscode.window.activeTextEditor = fakeEditor("t:");
  assert.strictEqual(await stub.commands.get(p.PASTE.table)(), "([] a:enlist 1; b:enlist `x)");
  assert.strictEqual(vscode.window.activeTextEditor.text, "t:([] a:enlist 1; b:enlist `x)");
  assert.match(stub.messages.at(-1)[1], /pasted 1 row under a header: a long, b symbol\./);
  clipboard = '{"k":[1,2]}';
  vscode.window.activeTextEditor = fakeEditor("d:");
  assert.strictEqual(await stub.commands.get(p.PASTE.json)(), "(enlist `k)!enlist 1 2f");
  assert.strictEqual(vscode.window.activeTextEditor.text, "d:(enlist `k)!enlist 1 2f");
  assert.strictEqual(await stub.commands.get(p.PASTE.copyJson)(), '[{"a":1},{"a":2}]');
  assert.deepStrictEqual(sent, ["([] a:1 2)", '.j.j value "([] a:1 2)"']);
  assert.strictEqual(clipboard, '[{"a":1},{"a":2}]');
  // Two statements: the guard is shown the text as selected, the process each statement (#1969).
  await stub.commands.get(p.PASTE.copyJson)("bb:1\n2 3");
  assert.deepStrictEqual(sent.slice(2), ["bb:1\n2 3", '.j.j last value each ("bb:1";"2 3")']);
  // A guard that declines: runOnActive throws, nothing is copied.
  live.runOnActive = async () => {
    throw new Error("Not run: changing the read-only process dev was not confirmed.");
  };
  clipboard = "before";
  assert.strictEqual(await stub.commands.get(p.PASTE.copyJson)("a:1"), undefined);
  assert.strictEqual(clipboard, "before");
  assert.match(stub.messages.at(-1)[1], /Copy Value as JSON failed: Not run/);
  // Off: each refuses, writes nothing and sends nothing.
  stub.config.user["pasteTable.enable"] = false;
  stub.config.user["jsonConversion.enable"] = false;
  live.runOnActive = async (code) => (sent.push(code), undefined);
  sent.length = 0;
  clipboard = "a\n1";
  vscode.window.activeTextEditor = fakeEditor("");
  assert.strictEqual(await stub.commands.get(p.PASTE.table)(), undefined);
  assert.strictEqual(await stub.commands.get(p.PASTE.json)('{"a":1}'), undefined);
  assert.strictEqual(await stub.commands.get(p.PASTE.copyJson)("1+1"), undefined);
  assert.strictEqual(vscode.window.activeTextEditor.text, "");
  assert.deepStrictEqual(sent, []);
  const said = stub.messages.slice(-3).map(([, m]) => m);
  assert.match(said[0], /Pasting spreadsheet data as a q table is turned off\. Set q-lint\.pasteTable\.enable to true/);
  assert.match(said[1], /JSON and q conversion is turned off\. Set q-lint\.jsonConversion\.enable to true/);
  for (const d of context.subscriptions) d.dispose?.();
  vscode.window.activeTextEditor = undefined;
});

test("negative zero keeps its sign in a q literal: 1%-0f is -0w (#1493)", () => {
  const { atomLiteral, numberText } = require("../out/qliteral.js");
  assert.strictEqual(numberText(-0), "-0");
  assert.strictEqual(numberText(0), "0");
  assert.strictEqual(p.floatText(-0), "-0f");
  assert.strictEqual(atomLiteral(9, "-0", -0).literal, "-0f");
  assert.strictEqual(atomLiteral(8, "-0", -0).literal, "-0e");
  // KDB-X: .j.k "[-0.0,1]" is -0 1f.
  assert.strictEqual(jsonToQ("[-0.0, 1]").code, "-0 1f");
});
