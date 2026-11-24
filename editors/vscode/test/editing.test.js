// The language configuration q editors get at run time (#1161, #1162): the
// Enter rules' and the word pattern's matches on sample lines, and the
// registration each setting makes and takes back without a reload. And the
// answer to a comment toggle on a blank line (#1970).
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { OPENS, COMMENT, WORD, languageConfiguration, words, blankCommentFixes, withBlankCommentFixes } = require("../out/editing.js");
const { registerEditing } = require("../out/editingview.js");
const pkg = require("../package.json");

/// What Enter after `before` does under the rules: the first that matches.
const enter = (before) => languageConfiguration({ continuation: true, dotted: false }).onEnterRules.find((r) => r.beforeText.test(before))?.action;

test("a line that leaves a bracket open is followed by an indented one", () => {
  for (const line of [
    "f:{[x]",
    "f:{[x;y]",
    "f:{",
    "f:{[x] a:x+1;",
    "select from t where x in (1;2",
    "  r:g[x;",
    "a:{x}[1",
    "f:{ / doc",
    "f:{ / doc (and more)",
    ".ns.f:{[a;b] if[a;",
  ]) {
    assert.strictEqual(enter(line), "indent", line);
  }
});

test("a line whose brackets close, a comment and a trailing comment's bracket keep the indentation", () => {
  for (const line of [
    "f:{x}",
    "x:1",
    "  a:g[x];",
    "  x+1}",
    "f:{[x] x*2}",
    "x:1 / see (a",
    "  / note: f[",
    "/",
    "x:\"(\"",
    "",
  ]) {
    assert.notStrictEqual(enter(line), "indent", line);
  }
  assert.strictEqual(enter("  / note: f["), "none");
  assert.ok(COMMENT.test("/ a comment") && COMMENT.test("  / indented") && !COMMENT.test("x:1 / trailing"));
  assert.ok(!OPENS.test("f:{x}"));
});

test("a string or brackets nested and closed on the line leave an open one open (#1226)", () => {
  for (const line of [
    'f:{[x] -1 "start";',
    "f:{a[b[1]]",
    "f:{x:(1;(2;3));",
    'f:{-1 "(";',
    'f:{s:"a\\"b";',
    "f:{g[{x}[1];(2;[3])]",
    's:"a /b";f:{',
    's:"a \\" /b";f:{[x]',
  ]) {
    assert.strictEqual(enter(line), "indent", line);
  }
  for (const line of ['f:{[x] -1 "start"}', "f:{a[b[1]]}", "f:{x:(1;(2;3))}", 'x:"{"', 'x:"a\\"("']) {
    assert.notStrictEqual(enter(line), "indent", line);
  }
});

test("the patterns are linear: a long line is answered at once", () => {
  const line = `f:{${"a[b;c](d)".repeat(5000)}`;
  const start = Date.now();
  assert.strictEqual(enter(line), "indent");
  assert.strictEqual(enter(`${line}}`), undefined);
  assert.strictEqual(enter(`x:1 / ${"(".repeat(20000)}`), undefined);
  // An unclosed string after many brackets is read once per bracket.
  assert.strictEqual(enter(`x:"${'(\\"'.repeat(5000)}`), undefined);
  assert.ok(Date.now() - start < 1000, `${Date.now() - start} ms`);
});

test("a dotted name is one word, a number is one, and an operator splits them", () => {
  assert.deepStrictEqual(words(".ns.util.f[x]"), [".ns.util.f", "x"]);
  assert.deepStrictEqual(words("x.y"), ["x.y"]);
  assert.deepStrictEqual(words("x+.y"), ["x", ".y"]);
  assert.deepStrictEqual(words("a:1.5*x"), ["a", "1.5", "x"]);
  assert.deepStrictEqual(words("1e-3 0x1f 12i 2024.01.02 0Nj"), ["1e-3", "0x1f", "12i", "2024.01.02", "0Nj"]);
  assert.deepStrictEqual(words("f. .z.p,`sym.x"), ["f", ".z.p", "sym.x"]);
  assert.deepStrictEqual(words("a_b:c2.d_e"), ["a_b", "c2.d_e"]);
  assert.deepStrictEqual(words("{x+y}"), ["x", "y"]);
  // A temporal is one word through its colons and fraction.
  assert.deepStrictEqual(words("2024.01.02D10:00:00.000 0D00:00:01 10:30:00 12:00:00.123 2024.01.02T10:00"), [
    "2024.01.02D10:00:00.000",
    "0D00:00:01",
    "10:30:00",
    "12:00:00.123",
    "2024.01.02T10:00",
  ]);
  assert.deepStrictEqual(words("t:10:30;x:1 2"), ["t", "10:30", "x", "1", "2"]);
  // VS Code warns of a word pattern that matches an empty string.
  assert.ok(!WORD.test("") && !WORD.test(" +-*%"));
});

test("nothing is added with both features off, and each adds only its own", () => {
  assert.strictEqual(languageConfiguration({ continuation: false, dotted: false }), undefined);
  assert.deepStrictEqual(Object.keys(languageConfiguration({ continuation: true, dotted: false })), ["onEnterRules"]);
  assert.deepStrictEqual(Object.keys(languageConfiguration({ continuation: false, dotted: true })), ["wordPattern"]);
});

test("the setting registers the rules for q, and turning it off takes them back without a reload", (t) => {
  stub.reset();
  const registered = [];
  const languages = vscode.languages;
  const indent = vscode.IndentAction;
  vscode.languages = {
    setLanguageConfiguration: (language, configuration) => {
      const entry = { language, configuration, disposed: false };
      registered.push(entry);
      return { dispose: () => (entry.disposed = true) };
    },
  };
  vscode.IndentAction = { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 };
  t.after(() => {
    vscode.languages = languages;
    vscode.IndentAction = indent;
  });
  const context = stub.newContext();
  const editing = registerEditing(context);
  assert.strictEqual(editing.registered(), true);
  const live = () => registered.filter((r) => !r.disposed);
  assert.strictEqual(live().length, 1);
  assert.strictEqual(live()[0].language, "q");
  assert.strictEqual(live()[0].configuration.wordPattern, WORD);
  assert.deepStrictEqual(
    live()[0].configuration.onEnterRules.map((r) => [r.beforeText, r.action.indentAction]),
    [
      [COMMENT, 0],
      [OPENS, 1],
    ],
  );
  // The word pattern alone, then nothing, then both again.
  stub.config.user["editor.continuationIndent.enable"] = false;
  stub.changeConfig("q-lint.editor.continuationIndent.enable");
  assert.strictEqual(live().length, 1);
  assert.deepStrictEqual(Object.keys(live()[0].configuration), ["wordPattern"]);
  stub.config.user["editor.dottedNames.enable"] = false;
  stub.changeConfig("q-lint.editor.dottedNames.enable");
  assert.strictEqual(editing.registered(), false);
  assert.strictEqual(live().length, 0);
  stub.config.user["editor.continuationIndent.enable"] = true;
  stub.config.user["editor.dottedNames.enable"] = true;
  stub.changeConfig("q-lint.editor.dottedNames.enable");
  assert.deepStrictEqual(Object.keys(live()[0].configuration).sort(), ["onEnterRules", "wordPattern"]);
  assert.strictEqual(live().length, 1);
  for (const d of context.subscriptions) d.dispose?.();
  assert.strictEqual(live().length, 0);
});

test("the switches are declared, on by default", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.editor.continuationIndent.enable"].default, true);
  assert.strictEqual(props["q-lint.editor.dottedNames.enable"].default, true);
  // The static file keeps no Enter rules or word pattern: they would apply
  // with the switches off.
  const config = require("../language-configuration.json");
  assert.strictEqual(config.onEnterRules, undefined);
  assert.strictEqual(config.indentationRules, undefined);
  assert.strictEqual(config.wordPattern, undefined);
});

/// Toggle Line Comment as VS Code's LineCommentCommand edits `text` with the
/// cursor on each of `lines`: the document after it and the event's changes.
/// A line that is all blanks takes `/ ` at its end when every line is one
/// (and is skipped otherwise); a line that starts with the token loses it
/// and the space after it.
function toggle(text, lines) {
  const all = text.split("\n");
  const blank = (l) => all[l].trim() === "";
  const picked = lines.every(blank) ? lines : lines.filter((l) => !blank(l));
  const remove = picked.every((l) => all[l].trimStart().startsWith("/"));
  const changes = [];
  for (const l of picked) {
    const at = lines.every(blank) ? all[l].length : all[l].length - all[l].trimStart().length;
    if (remove && !blank(l)) {
      const n = all[l][at + 1] === " " ? 2 : 1;
      all[l] = all[l].slice(0, at) + all[l].slice(at + n);
      changes.push({ line: l, endLine: l, character: at, rangeLength: n, text: "" });
    } else {
      all[l] = `${all[l].slice(0, at)}/ ${all[l].slice(at)}`;
      changes.push({ line: l, endLine: l, character: at, rangeLength: 0, text: "/ " });
    }
  }
  return { text: all.join("\n"), changes };
}

/// `text` after a toggle on `lines` and the answer to it.
function toggled(text, lines) {
  const after = toggle(text, lines);
  const fixes = blankCommentFixes(after.changes, (l) => after.text.split("\n")[l]);
  return { text: withBlankCommentFixes(after.text, fixes), fixes };
}

test("a comment toggle on a blank line leaves no lone slash, and toggles back to blank (#1970)", () => {
  // What VS Code alone leaves: a line q reads as a block comment's opening.
  assert.strictEqual(toggle("a:1\n\nb:2", [1]).text, "a:1\n/ \nb:2");
  const once = toggled("a:1\n\nb:2", [1]);
  assert.strictEqual(once.text, "a:1\n/ .\nb:2");
  assert.deepStrictEqual(once.fixes, [{ line: 1, character: 2, kind: "mark" }]);
  assert.strictEqual(toggled(once.text, [1]).text, "a:1\n\nb:2");
  // Indented, and several blank lines at once.
  const some = toggled("f:{\n  \n\n  x}", [1, 2]);
  assert.strictEqual(some.text, "f:{\n  / .\n/ .\n  x}");
  assert.strictEqual(toggled(some.text, [1, 2]).text, "f:{\n  \n\n  x}");
});

test("only the toggle's own edit on a blank line is answered", () => {
  const fixes = (changes, text) => blankCommentFixes(changes, (l) => text.split("\n")[l]);
  const insert = (line, character, text) => ({ line, endLine: line, character, rangeLength: 0, text });
  // A line with code is commented as VS Code comments it, and uncommented.
  assert.strictEqual(toggled("a:1", [0]).text, "/ a:1");
  assert.strictEqual(toggled("/ a:1", [0]).text, "a:1");
  assert.strictEqual(toggled("a:1\n\nb:2", [0, 1, 2]).text, "/ a:1\n\n/ b:2");
  // A `/` typed on a blank line, and the space typed after it.
  assert.deepStrictEqual(fixes([insert(0, 0, "/")], "/"), []);
  assert.deepStrictEqual(fixes([insert(0, 1, " ")], "/ "), []);
  // `/ ` put before text, and a line that keeps other text.
  assert.deepStrictEqual(fixes([insert(0, 0, "/ ")], "/ a:1"), []);
  assert.deepStrictEqual(fixes([insert(0, 2, "/ ")], "a / "), []);
  // Two characters deleted from before something that is not a lone `.`.
  const cut = (line, character) => ({ line, endLine: line, character, rangeLength: 2, text: "" });
  assert.deepStrictEqual(fixes([cut(0, 0)], "a:1"), []);
  assert.deepStrictEqual(fixes([cut(0, 0)], ".z.p"), []);
  assert.deepStrictEqual(fixes([cut(0, 1)], "a."), []);
  assert.deepStrictEqual(fixes([{ line: 0, endLine: 0, character: 0, rangeLength: 1, text: "" }], "."), []);
  // An edit across lines moves the others' lines: nothing is answered.
  assert.deepStrictEqual(fixes([insert(0, 0, "x\n"), insert(2, 0, "/ ")], "x\n\n\n/ "), []);
  assert.deepStrictEqual(fixes([{ line: 0, endLine: 1, character: 0, rangeLength: 3, text: "" }, insert(2, 0, "/ ")], "\n/ "), []);
  // Two edits on one line are not a toggle.
  assert.deepStrictEqual(fixes([insert(0, 0, "/ "), insert(0, 0, " ")], " / "), []);
});

test("the listener marks the blank comment in the active q editor and selects the mark", async (t) => {
  stub.reset();
  const listeners = [];
  const saved = { on: vscode.workspace.onDidChangeTextDocument, editor: vscode.window.activeTextEditor, Selection: vscode.Selection, Position: vscode.Position, Range: vscode.Range };
  vscode.workspace.onDidChangeTextDocument = (listener) => {
    listeners.push(listener);
    return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) };
  };
  vscode.Position = class { constructor(line, character) { Object.assign(this, { line, character }); } };
  vscode.Range = class { constructor(l1, c1, l2, c2) { Object.assign(this, { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } }); } };
  vscode.Selection = class { constructor(l1, c1, l2, c2) { Object.assign(this, { anchor: { line: l1, character: c1 }, active: { line: l2, character: c2 }, start: { line: l1, character: c1 }, end: { line: l2, character: c2 } }); } };
  t.after(() => {
    vscode.workspace.onDidChangeTextDocument = saved.on;
    vscode.window.activeTextEditor = saved.editor;
    Object.assign(vscode, { Selection: saved.Selection, Position: saved.Position, Range: saved.Range });
  });
  /// An editor on `text` in `languageId`, its cursor at `line`,`character`.
  const open = (text, languageId, line, character) => {
    const lines = text.split("\n");
    const editor = {
      document: { languageId, lineAt: (l) => ({ text: lines[l] }) },
      selections: [new vscode.Selection(line, character, line, character)],
      edits: [],
      options: undefined,
      edit: async (build, options) => {
        editor.options = options;
        build({
          insert: (at, text) => {
            editor.edits.push(["insert", at.line, at.character, text]);
            lines[at.line] = lines[at.line].slice(0, at.character) + text + lines[at.line].slice(at.character);
          },
          delete: (range) => {
            editor.edits.push(["delete", range.start.line, range.start.character, range.end.character]);
            lines[range.start.line] = lines[range.start.line].slice(0, range.start.character) + lines[range.start.line].slice(range.end.character);
          },
        });
        return true;
      },
      text: () => lines.join("\n"),
    };
    vscode.window.activeTextEditor = editor;
    return editor;
  };
  const change = (line, character, rangeLength, text) => ({ range: { start: { line, character }, end: { line, character: character + rangeLength } }, rangeLength, text });
  const fire = async (editor, contentChanges, reason) => {
    for (const l of [...listeners]) l({ document: editor.document, contentChanges, reason });
    await new Promise((r) => setImmediate(r));
  };
  const context = stub.newContext();
  const editing = registerEditing(context);
  assert.strictEqual(editing.answersBlankComment(), true);
  assert.strictEqual(listeners.length, 1);

  // The toggle wrote `/ ` on line 1 and left the cursor after it.
  let editor = open("a:1\n/ \nb:2", "q", 1, 2);
  await fire(editor, [change(1, 0, 0, "/ ")]);
  assert.strictEqual(editor.text(), "a:1\n/ .\nb:2");
  // One undo takes back the toggle and its answer.
  assert.deepStrictEqual(editor.options, { undoStopBefore: false, undoStopAfter: false });
  assert.deepStrictEqual(editor.selections.map((s) => [s.anchor, s.active]), [[{ line: 1, character: 2 }, { line: 1, character: 3 }]]);
  // The same with the cursor carried past the `.` by its insertion; a
  // selection over the lines, as a toggle of several blank ones has, stays.
  editor = open("/ ", "q", 0, 3);
  await fire(editor, [change(0, 0, 0, "/ ")]);
  assert.deepStrictEqual(editor.selections.map((s) => [s.anchor, s.active]), [[{ line: 0, character: 2 }, { line: 0, character: 3 }]]);
  editor = open("/ \n/ ", "q", 0, 0);
  editor.selections = [new vscode.Selection(0, 0, 1, 2)];
  await fire(editor, [change(0, 0, 0, "/ "), change(1, 0, 0, "/ ")]);
  assert.strictEqual(editor.text(), "/ .\n/ .");
  assert.deepStrictEqual(editor.selections.map((s) => [s.anchor, s.active]), [[{ line: 0, character: 0 }, { line: 1, character: 2 }]]);
  // Toggled back, VS Code leaves the `.`; it is taken away.
  editor = open("a:1\n.\nb:2", "k", 1, 0);
  await fire(editor, [change(1, 0, 2, "")]);
  assert.strictEqual(editor.text(), "a:1\n\nb:2");
  assert.deepStrictEqual(editor.selections.map((s) => [s.anchor, s.active]), [[{ line: 1, character: 0 }, { line: 1, character: 0 }]]);
  // An undo or redo of the toggle, another language, and a document that is
  // not the active editor's are left alone.
  editor = open("/ ", "q", 0, 2);
  await fire(editor, [change(0, 0, 0, "/ ")], 1);
  assert.deepStrictEqual(editor.edits, []);
  editor = open("/ ", "quke", 0, 2);
  await fire(editor, [change(0, 0, 0, "/ ")]);
  assert.deepStrictEqual(editor.edits, []);
  editor = open("/ ", "q", 0, 2);
  for (const l of [...listeners]) l({ document: { languageId: "q", lineAt: () => ({ text: "/ " }) }, contentChanges: [change(0, 0, 0, "/ ")], reason: undefined });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(editor.edits, []);

  // Off, nothing listens; on again, it does, without a reload.
  stub.config.user["editor.blankLineComment.enable"] = false;
  stub.changeConfig("q-lint.editor.blankLineComment.enable");
  assert.strictEqual(editing.answersBlankComment(), false);
  assert.strictEqual(listeners.length, 0);
  stub.config.user["editor.blankLineComment.enable"] = true;
  stub.changeConfig("q-lint.editor.blankLineComment.enable");
  assert.strictEqual(listeners.length, 1);
  for (const d of context.subscriptions) d.dispose?.();
  assert.strictEqual(listeners.length, 0);
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.editor.blankLineComment.enable"].default, true);
});
