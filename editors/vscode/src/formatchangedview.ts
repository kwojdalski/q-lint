// Formatting only the changed lines on save (#989): before a q file is saved,
// the lines it changed against git `HEAD` (`changedlines.ts`) go to the
// language server's `q-lint/formatChangedLines`, and the safe fixes it makes
// for the findings on those lines are applied as part of the save. Outside a
// git repository the save goes ahead unchanged. Off unless
// q-lint.formatChangedLines.enable asks for it, since it edits a file on its
// own at every save; off, nothing listens. The setting also goes to the
// server, which answers the request only with it on.
//
// VS Code gives a save's edits a few seconds; git and the server answer well
// within that, and an edit that comes too late is dropped by VS Code, not
// applied to a file already saved.
import { Range, TextEdit, commands, window, workspace, type ExtensionContext, type TextDocument } from "vscode";
import { changedLines, committedText, runGit, type Git } from "./changedlines";
import type { Server } from "./editorfeatures";
import { TOOLING_COMMANDS, toolingOff, toolingOn } from "./toolingfeatures";

export const FORMAT_CHANGED = "q-lint/formatChangedLines";
export const FORMAT_CHANGED_NOW = TOOLING_COMMANDS.formatChangedLines;

const on = (): boolean => toolingOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "formatChangedLines");

const isQFile = (document: TextDocument): boolean => document.languageId === "q" && document.uri.scheme === "file" && /\.q$/i.test(document.uri.fsPath);

/// The edits for `document` as it is now: none outside git, with nothing
/// changed, or without a server.
export async function changedLineEdits(document: TextDocument, server: Server | undefined, git: Git = runGit): Promise<TextEdit[]> {
  if (server === undefined || !isQFile(document)) {
    return [];
  }
  const committed = await committedText(document.uri.fsPath, git);
  if (committed === undefined) {
    return [];
  }
  const lines = changedLines(committed, document.getText());
  if (lines.length === 0) {
    return [];
  }
  const answer = await server.sendRequest(FORMAT_CHANGED, { textDocument: { uri: document.uri.toString() }, lines });
  if (!Array.isArray(answer)) {
    return [];
  }
  return answer.flatMap((e: { range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }; newText?: unknown }) => {
    const r = e?.range;
    const n = (v: unknown): v is number => typeof v === "number" && v >= 0;
    if (!r || !n(r.start?.line) || !n(r.start?.character) || !n(r.end?.line) || !n(r.end?.character) || typeof e.newText !== "string") {
      return [];
    }
    return [new TextEdit(new Range(r.start.line, r.start.character, r.end.line, r.end.character), e.newText)];
  });
}

export function registerFormatChanged(
  context: ExtensionContext,
  server: () => Server | undefined,
): { registered: () => boolean; edits: (document: TextDocument) => Promise<TextEdit[]> } {
  let listener: { dispose(): unknown } | undefined;
  const sync = (): void => {
    if (on() && listener === undefined) {
      listener = workspace.onWillSaveTextDocument((event) => {
        // Git reads the repository's own configuration, which can name
        // programs for it to run: not in a workspace that is not trusted.
        if (isQFile(event.document) && workspace.isTrusted !== false) {
          event.waitUntil(changedLineEdits(event.document, server()).catch(() => []));
        }
      });
    } else if (!on() && listener !== undefined) {
      listener.dispose();
      listener = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    // The same edits without saving, for a person who wants to see them.
    commands.registerCommand(FORMAT_CHANGED_NOW, async () => {
      if (!on()) {
        void window.showInformationMessage(toolingOff("formatChangedLines"));
        return [];
      }
      const editor = window.activeTextEditor;
      if (editor === undefined || !isQFile(editor.document)) {
        void window.showInformationMessage("q-lint: Format Changed Lines formats a saved .q file; open one first.");
        return [];
      }
      if (workspace.isTrusted === false) {
        void window.showInformationMessage("q-lint: Format Changed Lines asks git which lines changed, which is not done in a workspace that is not trusted.");
        return [];
      }
      if ((await committedText(editor.document.uri.fsPath)) === undefined) {
        void window.showInformationMessage("q-lint: this file is not in a git repository, so no line of it counts as changed.");
        return [];
      }
      const edits = await changedLineEdits(editor.document, server());
      if (edits.length > 0) {
        await editor.edit((builder) => edits.forEach((e) => builder.replace(e.range, e.newText)));
      }
      return edits;
    }),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.formatChangedLines") && sync()),
    { dispose: () => listener?.dispose() },
  );
  return { registered: () => listener !== undefined, edits: (document) => changedLineEdits(document, server()) };
}
