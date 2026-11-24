// The language configuration q editors get at run time (#1161, #1162): the
// Enter rules' and the word pattern's matches on sample lines, and the
// registration each setting makes and takes back without a reload.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { OPENS, COMMENT, WORD, languageConfiguration, words } = require("../out/editing.js");
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
