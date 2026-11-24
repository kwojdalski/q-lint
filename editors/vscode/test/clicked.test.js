// The editor a command is for (#1523): a title-bar button hands in its
// editor's Uri without focusing that group. Run after `tsc`.
const test = require("node:test");
const assert = require("node:assert");
const { clickedEditor } = require("../out/clicked.js");

const uri = (s) => ({ scheme: "file", toString: () => s });
const editor = (s) => ({ document: { uri: uri(s) } });

// Two groups, b.q focused: the Run button in a.q's title bar ran b.q.
test("a Uri handed in names the editor showing it, not the active one", () => {
  const a = editor("file:///w/a.q");
  const b = editor("file:///w/b.q");
  assert.strictEqual(clickedEditor(uri("file:///w/a.q"), [a, b], b), a);
  assert.strictEqual(clickedEditor(uri("file:///w/b.q"), [a, b], b), b);
  // A keybinding hands in nothing, or its own arguments: the active editor.
  assert.strictEqual(clickedEditor(undefined, [a, b], b), b);
  assert.strictEqual(clickedEditor({ args: "-p 5001" }, [a, b], b), b);
  // The same file in both groups: the active one, where the cursor is.
  const a2 = editor("file:///w/a.q");
  assert.strictEqual(clickedEditor(uri("file:///w/a.q"), [a, a2], a2), a2);
  // Shown nowhere: the active editor, as before.
  assert.strictEqual(clickedEditor(uri("file:///w/c.q"), [a, b], b), b);
});
