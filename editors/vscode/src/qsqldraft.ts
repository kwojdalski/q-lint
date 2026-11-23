// English to qSQL (#953): Draft qSQL from a Description asks a language
// model, through `vscode.lm`, for a query that does what the user describes,
// given the connected process's tables, and shows the draft in a new q
// editor for review. Nothing runs unless the user says so: the draft's
// notification offers Run, which runs the editor's text as it then stands -
// edited or not - as Query from the editor would run it, and Insert at
// Cursor, which puts it into the editor the command started from. The VS
// Code around `assist.ts`; turned off (`q-lint.chat.englishToQsql.enable`)
// the command is hidden and refuses, and asks neither model nor process.
import {
  LanguageModelChatMessage,
  ProgressLocation,
  ViewColumn,
  commands,
  lm,
  window,
  workspace,
  type CancellationToken,
  type ExtensionContext,
  type LanguageModelChat,
  type TextDocument,
  type TextEditor,
} from "vscode";
import { QSQL_COMMANDS, draftCode, draftDocument, extractCode, qsqlPrompt, tablesOf, type TableSummary } from "./assist";
import { assistOff, readAssist } from "./assistconfig";
import { GATHER, LIMITS, readExplorer, readGathered } from "./explorer";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { plainMessage } from "./history";

const RUN = "Run";
const INSERT = "Insert at Cursor";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/// What one draft came to, for tests.
export interface Drafted {
  document: TextDocument;
  code: string;
  picked?: string;
}

/// The tables of the connected process, by the explorer's lambda; none
/// when nothing is connected or it stays busy.
async function tablesOfProcess(live: Live): Promise<TableSummary[]> {
  if (live.activeLabel() === undefined) {
    return [];
  }
  try {
    const got = await borrowWhenFree(live, async (connection) => {
      const configuration = workspace.getConfiguration("q-lint");
      const { excludedNamespaces } = readExplorer((key, fallback) => configuration.get(key, fallback));
      return tablesOf(readGathered(await connection.call(GATHER, excludedNamespaces.join(" "), LIMITS))).tables;
    });
    return got?.value ?? [];
  } catch {
    return [];
  }
}

/// The text of `model`'s answer to `prompt`.
async function ask(model: LanguageModelChat, prompt: string, token: CancellationToken): Promise<string> {
  const response = await model.sendRequest([LanguageModelChatMessage.User(prompt)], {}, token);
  let text = "";
  for await (const part of response.text) {
    text += part;
  }
  return text;
}

export async function draftQsql(live: Live, given?: string): Promise<Drafted | undefined> {
  const configuration = workspace.getConfiguration("q-lint");
  if (!readAssist((key, fallback) => configuration.get(key, fallback)).qsql) {
    void window.showInformationMessage(plainMessage(assistOff("qsql")));
    return undefined;
  }
  const from: TextEditor | undefined = window.activeTextEditor?.document.languageId === "q" ? window.activeTextEditor : undefined;
  const description =
    typeof given === "string" && given.trim() !== ""
      ? given
      : await window.showInputBox({
          title: "q-lint: Draft qSQL from a Description",
          prompt: "Describe the query in words. A language model drafts it for you to review; nothing runs.",
          placeHolder: "the last price of each sym in trade today",
        });
  if (description === undefined || description.trim() === "") {
    return undefined;
  }
  const models = typeof lm?.selectChatModels === "function" ? await lm.selectChatModels() : [];
  const model = models[0];
  if (model === undefined) {
    void window.showInformationMessage("q-lint: no language model is available. Sign in to an extension that provides one, such as GitHub Copilot.");
    return undefined;
  }
  const process = live.activeLabel();
  let code: string;
  try {
    code = await window.withProgress(
      { location: ProgressLocation.Notification, title: `q-lint: drafting qSQL with ${model.name}`, cancellable: true },
      async (_progress, token) => {
        const tables = await tablesOfProcess(live);
        return extractCode(await ask(model, qsqlPrompt(description, tables, process), token));
      },
    );
  } catch (error) {
    void window.showErrorMessage(plainMessage(`q-lint: the language model could not draft a query: ${message(error)}`));
    return undefined;
  }
  if (code === "") {
    void window.showInformationMessage("q-lint: the language model drafted no query.");
    return undefined;
  }
  const document = await workspace.openTextDocument({ language: "q", content: draftDocument(description, model.name, code) });
  await window.showTextDocument(document, { viewColumn: ViewColumn.Beside, preview: false });
  const buttons = from === undefined ? [RUN] : [RUN, INSERT];
  const picked = await window.showInformationMessage(
    `q-lint: drafted a query in a new editor. Review it, or edit it: nothing has run.`,
    ...buttons,
  );
  // The draft as it stands when the button is pressed: the user may have edited it.
  const now = draftCode(document.getText());
  if (picked === RUN && now !== "") {
    await live.queryCode(now, document.uri);
  } else if (picked === INSERT && from !== undefined && now !== "") {
    await from.edit((edit) => edit.replace(from.selection, now));
  }
  return { document, code, ...(picked !== undefined ? { picked } : {}) };
}

export function registerQsqlDraft(context: ExtensionContext, live: Live): void {
  context.subscriptions.push(commands.registerCommand(QSQL_COMMANDS.draft, (description?: string) => draftQsql(live, description)));
}
