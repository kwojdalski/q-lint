// The offline error explainer (#1054): **q-lint: Explain q Error** says what
// a q error means, what usually causes it and - from the backtrace q sent
// with it - the operation that failed, from the catalogue in
// `errorexplain.ts`. It explains, in order: an error handed to it (a
// string), the selected text, the last query from the editor when it
// failed, or one typed in. A diagnostic in the Problems view whose message names a
// q error (`'type`, `'length`, ...) gets a Quick Fix that explains it.
// Nothing is sent anywhere. Off (q-lint.errorExplain.enable), the command
// refuses and the Quick Fix provider is disposed.
import { CodeAction, CodeActionKind, commands, languages, window, workspace, type Disposable, type ExtensionContext } from "vscode";
import { errorInMessage, explainError } from "./errorexplain";
import { LANGUAGE_COMMANDS, languageOff, languageOn } from "./languagefeatures";
import type { Live } from "./live";
import { plainMessage } from "./history";

const on = (): boolean => languageOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "errorExplain");

export function registerErrorExplainer(context: ExtensionContext, live: Pick<Live, "lastFailure" | "history">): { registered: () => boolean } {
  let provider: Disposable | undefined;
  const sync = (): void => {
    if (on() && provider === undefined) {
      provider = languages.registerCodeActionsProvider(
        { language: "q" },
        {
          provideCodeActions: (_document, _range, ctx) =>
            ctx.diagnostics.flatMap((d) => {
              const name = errorInMessage(typeof d.message === "string" ? d.message : "");
              if (name === undefined) {
                return [];
              }
              const action = new CodeAction(`Explain q error '${name}`, CodeActionKind.QuickFix);
              action.command = { command: LANGUAGE_COMMANDS.explainError, title: action.title, arguments: [name] };
              action.diagnostics = [d];
              return [action];
            }),
        },
        { providedCodeActionKinds: [CodeActionKind.QuickFix] },
      );
    } else if (!on() && provider !== undefined) {
      provider.dispose();
      provider = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    commands.registerCommand(LANGUAGE_COMMANDS.explainError, async (given?: unknown) => {
      if (!on()) {
        void window.showInformationMessage(plainMessage(languageOff("errorExplain")));
        return undefined;
      }
      let error: string | undefined;
      let trace: string | undefined;
      const editor = window.activeTextEditor;
      const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
      // The failure only while it is the last query run: one that answered
      // since has made it old news (#1231).
      const failure = live.lastFailure;
      const latest = live.history()[0];
      const current = failure !== undefined && latest?.outcome === "error" && latest.code === failure.code && latest.process === failure.process;
      if (typeof given === "string" && given.trim() !== "") {
        error = given;
      } else if (selected.trim() !== "") {
        error = selected;
      } else if (current) {
        ({ error, trace } = failure);
      } else {
        error = await window.showInputBox({ prompt: "The q error to explain", placeHolder: "'type" });
      }
      if (error === undefined || error.trim() === "") {
        return undefined;
      }
      const text = explainError(error, trace);
      const document = await workspace.openTextDocument({ language: "markdown", content: text });
      await window.showTextDocument(document, { preview: true, preserveFocus: true });
      return text;
    }),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.errorExplain") && sync()),
    { dispose: () => provider?.dispose() },
  );
  return { registered: () => provider !== undefined };
}
