// Toggle Parameter Cache (#892) as a VS Code command and a status bar item.
// What is inserted, where, and what is recognised again is `paramcache.ts`'s;
// this applies it to the editor and shows when the active file holds a
// cached lambda.
import { commands, Range, StatusBarAlignment, window, workspace, type ExtensionContext, type StatusBarItem } from "vscode";
import { PARAM_CACHE, cachedLambdas, cachedText, toggleAt } from "./paramcache";

export class ParameterCache {
  private readonly item: StatusBarItem;
  private count = 0;

  constructor(context: ExtensionContext) {
    // After the query flags (49.6), before the query mode (49).
    this.item = window.createStatusBarItem("q-lint.parameterCache", StatusBarAlignment.Left, 49.4);
    this.item.name = "q-lint: parameter cache";
    this.item.tooltip =
      "A lambda in this file caches its parameters: when it is called, it sets each one as a global, and keeps the call's arguments under .qlint.cache. Toggle Parameter Cache on the lambda removes it.";
    context.subscriptions.push(
      this.item,
      commands.registerCommand(PARAM_CACHE.toggle, () => this.toggle()),
      window.onDidChangeActiveTextEditor(() => this.refresh()),
      workspace.onDidChangeTextDocument((event) => {
        if (event.document === window.activeTextEditor?.document) {
          this.refresh();
        }
      }),
    );
    this.refresh();
  }

  /// How many lambdas in the active file are cached: what the status bar
  /// shows, for tests.
  cached(): number {
    return this.count;
  }

  private refresh(): void {
    const document = window.activeTextEditor?.document;
    // Only q is read: a markdown file quoting an instrumented lambda caches nothing.
    this.count = document === undefined || document.languageId !== "q" ? 0 : cachedLambdas(document.getText());
    const text = cachedText(this.count);
    if (text === undefined) {
      this.item.hide();
    } else {
      this.item.text = text;
      this.item.show();
    }
  }

  private async toggle(): Promise<void> {
    const editor = window.activeTextEditor;
    if (editor === undefined) {
      void window.showInformationMessage("q-lint: open a q file and put the cursor in a lambda.");
      return;
    }
    const document = editor.document;
    const toggle = toggleAt(document.getText(), document.offsetAt(editor.selection.active));
    if (toggle.kind === "refuse") {
      void window.showInformationMessage(toggle.message);
      return;
    }
    const applied = await editor.edit((edit) => {
      if (toggle.kind === "insert") {
        edit.insert(document.positionAt(toggle.offset), toggle.text);
      } else {
        edit.delete(new Range(document.positionAt(toggle.start), document.positionAt(toggle.end)));
      }
    });
    if (!applied) {
      void window.showWarningMessage("q-lint: the file changed while Toggle Parameter Cache ran; try again.");
    }
    this.refresh();
  }
}
