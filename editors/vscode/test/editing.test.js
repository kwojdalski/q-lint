// The language configuration q editors get at run time (#1161): the Enter
// rules' patterns on sample lines, and the registration a setting makes and
// takes back without a reload.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { OPENS, COMMENT, languageConfiguration } = require("../out/editing.js");
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

test("the patterns are linear: a long line is answered at once", () => {
  const line = `f:{${"a[b;c](d)".repeat(5000)}`;
  const start = Date.now();
  assert.strictEqual(enter(line), "indent");
  assert.strictEqual(enter(`${line}}`), undefined);
  assert.strictEqual(enter(`x:1 / ${"(".repeat(20000)}`), undefined);
  assert.ok(Date.now() - start < 1000, `${Date.now() - start} ms`);
});

test("nothing is added with the feature off", () => {
  assert.strictEqual(languageConfiguration({ continuation: false, dotted: false }), undefined);
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
  assert.deepStrictEqual(
    live()[0].configuration.onEnterRules.map((r) => [r.beforeText, r.action.indentAction]),
    [
      [COMMENT, 0],
      [OPENS, 1],
    ],
  );
  stub.config.user["editor.continuationIndent.enable"] = false;
  stub.changeConfig("q-lint.editor.continuationIndent.enable");
  assert.strictEqual(editing.registered(), false);
  assert.strictEqual(live().length, 0);
  stub.config.user["editor.continuationIndent.enable"] = true;
  stub.changeConfig("q-lint.editor.continuationIndent.enable");
  assert.strictEqual(live().length, 1);
  for (const d of context.subscriptions) d.dispose?.();
  assert.strictEqual(live().length, 0);
});

test("the switch is declared, on by default", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.editor.continuationIndent.enable"].default, true);
  // The static file keeps no Enter rules: they would apply with the switch off.
  const config = require("../language-configuration.json");
  assert.strictEqual(config.onEnterRules, undefined);
  assert.strictEqual(config.indentationRules, undefined);
});
