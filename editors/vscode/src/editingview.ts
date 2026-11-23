// Applies `editing.ts`'s language configuration to q editors while
// q-lint.editor.continuationIndent.enable is on. VS Code reads
// `language-configuration.json` once, so what a setting turns on and off is
// registered here instead, and registered again when it changes: off, the
// registration is disposed and VS Code's own Enter is back, without a reload.
import { IndentAction, languages, workspace, type Disposable, type ExtensionContext } from "vscode";
import { languageConfiguration } from "./editing";
import { editorFeatureOn } from "./editorfeatures";

const get = <T>(key: string, fallback: T): T => workspace.getConfiguration("q-lint").get(key, fallback);

export function registerEditing(context: ExtensionContext): { registered: () => boolean } {
  let registration: Disposable | undefined;
  const sync = (): void => {
    registration?.dispose();
    registration = undefined;
    const added = languageConfiguration({ continuation: editorFeatureOn(get, "continuationIndent") });
    if (added === undefined) {
      return;
    }
    registration = languages.setLanguageConfiguration("q", {
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
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(
      (event) => event.affectsConfiguration("q-lint.editor.continuationIndent") && sync(),
    ),
    { dispose: () => registration?.dispose() },
  );
  return { registered: () => registration !== undefined };
}
