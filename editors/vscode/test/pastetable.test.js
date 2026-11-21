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
const pkg = require("../package.json");

test("CSV and TSV are read as a spreadsheet writes them", () => {
  assert.deepStrictEqual(p.readDelimited("a,b\r\n1,2\r\n"), { delimiter: ",", rows: [["a", "b"], ["1", "2"]] });
  assert.deepStrictEqual(p.readDelimited("a\tb\n1\t2").delimiter, "\t");
  assert.deepStrictEqual(p.readDelimited("a;b\n1,5;2").delimiter, ";");
  // Quotes hold the delimiter, a newline and a doubled quote.
  assert.deepStrictEqual(p.readDelimited('x,y\n"a,b","say ""hi""\nthere"\n').rows, [["x", "y"], ["a,b", 'say "hi"\nthere']]);
  // A byte order mark and blank lines are no data.
  assert.deepStrictEqual(p.readDelimited("﻿a\n\n1\n\n").rows, [["a"], ["1"]]);
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
  assert.strictEqual(toJsonQuery('t:([] a:1); "x"'), '.j.j value "t:([] a:1); \\"x\\""');
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
      return { process: "dev", value: await query({ call: async (expr) => (sent.push(expr), '[{"a":1},{"a":2}]') }) };
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
