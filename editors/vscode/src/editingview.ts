// Applies `editing.ts`'s language configuration to q editors while
// q-lint.editor.continuationIndent.enable or q-lint.editor.dottedNames.enable
// is on. VS Code reads `language-configuration.json` once, so what a setting
// turns on and off is registered here instead, and registered again when
// either changes: off, the registration is disposed and VS Code's own Enter
// and word selection are back, without a reload.
//
// q-lint.editor.blankLineComment.enable (#1970) is a listener rather than
// configuration, registered and disposed the same way: it answers a comment
// toggle on a blank line, which would otherwise leave a lone `/`.
import { IndentAction, languages, Position, Range, Selection, window, workspace, type Disposable, type ExtensionContext, type TextDocumentChangeEvent } from "vscode";
import { blankCommentFixes, languageConfiguration } from "./editing";
import { editorFeatureOn } from "./editorfeatures";

const get = <T>(key: string, fallback: T): T => workspace.getConfiguration("q-lint").get(key, fallback);

/// The languages q's script reader loads, where a lone `/` opens a block
/// comment. A quke file shares their comment token and is not q's to read.
const SCRIPTS = ["q", "k"];

/// Answer a comment toggle on a blank line of the active editor: `/ ` becomes
/// `/ .`, and the `.` the toggle back leaves is taken away. The edit joins
/// the toggle's undo step, and an undo or redo is not answered.
function onBlankComment(event: TextDocumentChangeEvent): void {
  const editor = window.activeTextEditor;
  const document = event.document;
  if (event.reason !== undefined || editor === undefined || editor.document !== document || !SCRIPTS.includes(document.languageId)) {
    return;
  }
  const fixes = blankCommentFixes(
    event.contentChanges.map((c) => ({ line: c.range.start.line, endLine: c.range.end.line, character: c.range.start.character, rangeLength: c.rangeLength, text: c.text })),
    (line) => document.lineAt(line).text,
  );
  if (fixes.length === 0) {
    return;
  }
  // Refused when the document has changed again since: what was typed stands.
  void editor
    .edit(
      (edit) => {
        for (const { line, character, kind } of fixes) {
          if (kind === "mark") {
            edit.insert(new Position(line, character), ".");
          } else {
            edit.delete(new Range(line, character, line, character + 1));
          }
        }
      },
      { undoStopBefore: false, undoStopAfter: false },
    )
    .then((applied) => {
      if (!applied) {
        return;
      }
      // A cursor left after the `/ ` is there to write the comment: it takes
      // the `.` as its selection, so what is typed next replaces it. Before
      // or after the `.`, wherever the insertion left it.
      const marked = fixes.filter((f) => f.kind === "mark");
      editor.selections = editor.selections.map((s) => {
        const mark = marked.find((f) => f.line === s.start.line && f.line === s.end.line && s.start.character >= f.character && s.end.character <= f.character + 1);
        return mark === undefined ? s : new Selection(mark.line, mark.character, mark.line, mark.character + 1);
      });
    });
}

export function registerEditing(context: ExtensionContext): { registered: () => boolean; answersBlankComment: () => boolean } {
  let registration: Disposable | undefined;
  let blankComment: Disposable | undefined;
  const syncBlankComment = (): void => {
    blankComment?.dispose();
    blankComment = editorFeatureOn(get, "blankLineComment") ? workspace.onDidChangeTextDocument(onBlankComment) : undefined;
  };
  const sync = (): void => {
    registration?.dispose();
    registration = undefined;
    const added = languageConfiguration({ continuation: editorFeatureOn(get, "continuationIndent"), dotted: editorFeatureOn(get, "dottedNames") });
    if (added === undefined) {
      return;
    }
    registration = languages.setLanguageConfiguration("q", {
      ...(added.wordPattern !== undefined ? { wordPattern: added.wordPattern } : {}),
      ...(added.onEnterRules !== undefined
        ? {
            onEnterRules: added.onEnterRules.map(({ beforeText, action }) => ({
              beforeText,
              action: { indentAction: action === "indent" ? IndentAction.Indent : IndentAction.None },
            })),
          }
        : {}),
    });
  };
  sync();
  syncBlankComment();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(
      (event) => (event.affectsConfiguration("q-lint.editor.continuationIndent") || event.affectsConfiguration("q-lint.editor.dottedNames")) && sync(),
    ),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.editor.blankLineComment") && syncBlankComment()),
    { dispose: () => registration?.dispose() },
    { dispose: () => blankComment?.dispose() },
  );
  return { registered: () => registration !== undefined, answersBlankComment: () => blankComment !== undefined };
}
