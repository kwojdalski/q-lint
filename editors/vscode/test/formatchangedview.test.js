// Format changed lines on save (#1607): a delayed auto-save, while typing,
// rewrites nothing, as VS Code's own formatOnSave does not.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { registerFormatChanged } = require("../out/formatchangedview.js");

test("a delayed auto-save formats nothing; a save the user makes, or a focus change, does (#1607)", (t) => {
  stub.reset();
  const listeners = [];
  vscode.workspace.onWillSaveTextDocument = (l) => (listeners.push(l), { dispose: () => listeners.splice(listeners.indexOf(l), 1) });
  vscode.TextDocumentSaveReason = { Manual: 1, AfterDelay: 2, FocusOut: 3 };
  stub.config.user["formatChangedLines.enable"] = true;
  const context = stub.newContext();
  registerFormatChanged(context, () => undefined);
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  const document = { languageId: "q", uri: vscode.Uri.file("/ws/a.q"), getText: () => "a:1\n" };
  const waited = [];
  for (const reason of [2, 1, 3]) {
    listeners[0]({ document, reason, waitUntil: (p) => waited.push([reason, p]) });
  }
  assert.deepStrictEqual(waited.map(([reason]) => reason), [1, 3]);
});
