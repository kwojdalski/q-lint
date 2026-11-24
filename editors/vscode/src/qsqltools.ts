// qSQL to functional form and back (#1052) and the qSQL explainer (#1053),
// in the palette. The language server does both: its two refactor.rewrite
// code actions rewrite the query or functional form at the cursor, and its
// hover over a query's lead word says the query in words. These commands
// ask it for the action at the cursor and apply it, and open those words
// beside the editor for the query the cursor is in. Off (q-lint.functionalForm.enable, q-lint.qsqlExplain.enable), the
// commands refuse and the setting goes to the server, which then offers no
// such action or words. Nothing here talks to a q process.
import { CodeActionKind, MarkdownString, Range, commands, window, workspace, type CodeAction, type ExtensionContext, type Hover, type Position } from "vscode";
import { LANGUAGE_COMMANDS, languageOff, languageOn, type LanguageFeature } from "./languagefeatures";
import { charKinds } from "./explorer";
import { plainMessage } from "./history";

/// The server's titles for its two rewrites (`src/lsp.rs`).
export const REWRITE_TITLES = {
  toFunctional: "Rewrite qSQL query in functional form",
  toQsql: "Rewrite functional form as qSQL",
} as const;

const on = (feature: LanguageFeature): boolean =>
  languageOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), feature);

/// Apply the server's rewrite titled `title` at the cursor; false when
/// there is none, with the reason the server gave where it gave one.
async function rewrite(direction: keyof typeof REWRITE_TITLES): Promise<boolean> {
  if (!on("functionalForm")) {
    void window.showInformationMessage(plainMessage(languageOff("functionalForm")));
    return false;
  }
  const editor = window.activeTextEditor;
  if (editor === undefined || editor.document.languageId !== "q") {
    void window.showInformationMessage("q-lint: the rewrite works in a q file; open one first.");
    return false;
  }
  const title = REWRITE_TITLES[direction];
  const at = editor.selection.active;
  const actions =
    (await commands.executeCommand<CodeAction[] | undefined>(
      "vscode.executeCodeActionProvider",
      editor.document.uri,
      new Range(at, at),
      CodeActionKind.RefactorRewrite.value,
    )) ?? [];
  const action = actions.find((a) => a.title === title);
  if (action?.edit === undefined) {
    const why = action?.disabled?.reason;
    const what = direction === "toFunctional" ? "a qSQL query" : "a functional form (?[t;c;b;a] or ![t;c;b;a])";
    void window.showInformationMessage(plainMessage(why !== undefined ? `q-lint: ${why}` : `q-lint: the cursor is not in ${what} the language server can rewrite.`));
    return false;
  }
  return workspace.applyEdit(action.edit);
}

/// Where the query or functional form around `offset` starts: the nearest
/// `select`, `exec`, `update` or `delete`, or `?[` / `![`, at or before it
/// in the same statement - which the server's hover explains. A word in a
/// string or a comment is no lead (#1466). Undefined when the statement
/// holds none.
export function leadBefore(text: string, offset: number): number | undefined {
  // The statement: back to a line that starts at column 0.
  let start = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  while (start > 0 && /^[ \t]/.test(text.slice(start))) {
    // At 1 the previous line is the empty one at 0: lastIndexOf would
    // clamp start - 2 to 0 and find the same newline again.
    start = start <= 1 ? 0 : text.lastIndexOf("\n", start - 2) + 1;
  }
  const end = Math.min(text.length, offset + 8);
  const lead = /(?<![A-Za-z0-9_.`])(select|exec|update|delete)(?![A-Za-z0-9_])|[?!](?=\[)/g;
  const kinds = charKinds(text.slice(start, end));
  let found: number | undefined;
  for (const m of text.slice(start, end).matchAll(lead)) {
    if (start + (m.index ?? 0) <= offset && kinds[m.index ?? 0] === "c") {
      found = start + (m.index ?? 0);
    }
  }
  return found;
}

/// The words of the server's hover at `position`, or undefined.
function words(hovers: Hover[] | undefined): string | undefined {
  for (const h of hovers ?? []) {
    for (const c of h.contents) {
      const value = typeof c === "string" ? c : c instanceof MarkdownString ? c.value : (c as { value?: string }).value;
      if (typeof value === "string" && value.includes("**In words.**")) {
        const at = value.lastIndexOf("The functional form of") >= 0 ? value.lastIndexOf("The functional form of") : value.indexOf("**In words.**");
        return value.slice(at);
      }
    }
  }
  return undefined;
}

export function registerQsqlTools(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand(LANGUAGE_COMMANDS.toFunctional, () => rewrite("toFunctional")),
    commands.registerCommand(LANGUAGE_COMMANDS.toQsql, () => rewrite("toQsql")),
    commands.registerCommand(LANGUAGE_COMMANDS.explainQsql, async () => {
      if (!on("qsqlExplain")) {
        void window.showInformationMessage(plainMessage(languageOff("qsqlExplain")));
        return false;
      }
      const editor = window.activeTextEditor;
      if (editor === undefined || editor.document.languageId !== "q") {
        void window.showInformationMessage("q-lint: Explain qSQL works in a q file; open one first.");
        return false;
      }
      const text = editor.document.getText();
      const lead = leadBefore(text, editor.document.offsetAt(editor.selection.active));
      if (lead === undefined) {
        void window.showInformationMessage("q-lint: the cursor is not in a qSQL query or a functional form.");
        return false;
      }
      const position: Position = editor.document.positionAt(lead);
      const said = words(await commands.executeCommand<Hover[]>("vscode.executeHoverProvider", editor.document.uri, position));
      if (said === undefined) {
        void window.showInformationMessage("q-lint: the language server has no words for this query (it may not be running).");
        return false;
      }
      const document = await workspace.openTextDocument({ language: "markdown", content: said });
      await window.showTextDocument(document, { preview: true, preserveFocus: true, viewColumn: -2 });
      return said;
    }),
  );
}
