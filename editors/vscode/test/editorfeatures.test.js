// The switches of the editor features that work with a q process or add to
// the editor's lists (#939, #940, #944, #945): each is declared, with the
// default `editorfeatures.ts` falls back to, and named in what a refusal says.
const test = require("node:test");
const assert = require("node:assert");
const { EDITOR_SETTINGS, editorFeatureOn, editorFeatureOff, asRange } = require("../out/editorfeatures.js");
const pkg = require("../package.json");

test("each switch is declared with its default, and anything but a boolean is that default", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  for (const [feature, { key, fallback }] of Object.entries(EDITOR_SETTINGS)) {
    const declared = props[`q-lint.${key}`];
    assert.ok(declared, `q-lint.${key} is declared`);
    assert.strictEqual(declared.type, "boolean");
    assert.strictEqual(declared.default, fallback, key);
    assert.strictEqual(editorFeatureOn((_k, d) => d, feature), fallback);
    assert.strictEqual(editorFeatureOn(() => !fallback, feature), !fallback);
    assert.strictEqual(editorFeatureOn(() => "yes", feature), fallback);
    assert.ok(editorFeatureOff(feature).includes(`Set q-lint.${key} to true`), feature);
  }
  // What sends to a process on its own is off unless asked for.
  assert.strictEqual(EDITOR_SETTINGS.liveValueHover.fallback, false);
  assert.strictEqual(EDITOR_SETTINGS.undefinedNames.fallback, false);
  assert.strictEqual(EDITOR_SETTINGS.testExplorer.fallback, true);
  assert.strictEqual(EDITOR_SETTINGS.idiomSnippets.fallback, true);
});

test("a range is read when it is one", () => {
  const r = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
  assert.deepStrictEqual(asRange(r), r);
  assert.strictEqual(asRange({ start: { line: 1 } }), undefined);
  assert.strictEqual(asRange(null), undefined);
  assert.strictEqual(asRange({ start: { line: -1, character: 0 }, end: { line: 0, character: 0 } }), undefined);
});
