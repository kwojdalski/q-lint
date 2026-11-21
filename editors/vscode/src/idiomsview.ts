// Offers the q idiom snippets (`idioms.ts`) in q editors' completion list
// while q-lint.idiomSnippets.enable is on. Off, the provider is disposed:
// the idioms leave the list, and the rest of completion stays.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CompletionItem,
  CompletionItemKind,
  MarkdownString,
  Range,
  SnippetString,
  languages,
  workspace,
  type Disposable,
  type ExtensionContext,
  type Position,
  type TextDocument,
} from "vscode";
import { editorFeatureOn } from "./editorfeatures";
import { preview, readIdioms, wordStart, type Idiom } from "./idioms";

const on = (): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "idiomSnippets");

/// Register the idioms' completion while q-lint.idiomSnippets.enable is on.
export function registerIdioms(context: ExtensionContext): { registered: () => boolean; items: (document: TextDocument, position: Position) => CompletionItem[] } {
  let idioms: Idiom[] | undefined;
  const load = (): Idiom[] => (idioms ??= readIdioms(readFileSync(join(context.extensionPath, "snippets", "idioms.json"), "utf8")));
  const items = (document: TextDocument, position: Position): CompletionItem[] => {
    if (!on()) {
      return [];
    }
    const start = wordStart(document.lineAt(position.line).text, position.character);
    const range = new Range(position.line, start, position.line, position.character);
    return load().map((idiom) => {
      const item = new CompletionItem({ label: idiom.prefix, description: idiom.name }, CompletionItemKind.Snippet);
      item.insertText = new SnippetString(idiom.body);
      item.range = range;
      item.detail = idiom.name;
      item.documentation = new MarkdownString().appendText(idiom.description).appendCodeblock(preview(idiom.body), "q");
      return item;
    });
  };
  let provider: Disposable | undefined;
  const sync = (): void => {
    if (on() && provider === undefined) {
      provider = languages.registerCompletionItemProvider({ language: "q" }, { provideCompletionItems: (d, p) => items(d, p) });
    } else if (!on() && provider !== undefined) {
      provider.dispose();
      provider = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.idiomSnippets") && sync()),
    { dispose: () => provider?.dispose() },
  );
  return { registered: () => provider !== undefined, items };
}
