// The aj match explainer (#1050): **q-lint: Explain aj Match** finds the
// `aj` (or `aj0`) call in the selection, or the statement at the cursor,
// asks for a row of its left table, and re-runs the match for that row on
// the connected process (`ajexplain.ts`): which right row it matched, or
// why none did. The explanation opens in a `q-lint-aj:` document, which VS
// Code never lets one type into.
//
// The call's arguments are the user's expressions, so the lambda goes
// through `Live.runOnActive` with the call as the code the read-only guard
// reads. Off (q-lint.query.ajExplainer.enable), the command refuses and
// nothing is sent.
import { EventEmitter, Uri, commands, window, workspace, type ExtensionContext, type TextDocumentContentProvider } from "vscode";
import { EXPLAIN_AJ, explain, explainGuardCode, findAj, readMatch } from "./ajexplain";
import type { Live } from "./live";
import { PROCESS_TOOL_COMMANDS, asCode, toolOff, toolOn } from "./processtools";
import { plainMessage } from "./history";

export const AJ_SCHEME = "q-lint-aj";

const on = (): boolean => toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "ajExplainer");

function say(text: string): string {
  void window.showInformationMessage(plainMessage(text));
  return text;
}

export function registerAjExplainer(context: ExtensionContext, live: Live): { explainRow: (code?: string, row?: string) => Promise<string> } {
  const documents = new Map<string, string>();
  const changed = new EventEmitter<Uri>();
  const provider: TextDocumentContentProvider = {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => documents.get(uri.toString()) ?? "/ not explained; run Explain aj Match again.\n",
  };
  let count = 0;

  const explainRow = async (given?: string, givenRow?: string): Promise<string> => {
    if (!on()) {
      return say(toolOff("ajExplainer"));
    }
    const code = given ?? (await live.codeFromEditor(false));
    if (code === undefined) {
      return "nothing to explain";
    }
    const call = findAj(code);
    if (call === undefined) {
      return say("q-lint: there is no aj[columns;left;right] call in the selection or the statement at the cursor.");
    }
    const rowText =
      givenRow ??
      (await window.showInputBox({
        title: `Explain ${call.fn}: which row of ${call.left}?`,
        prompt: "The row's index in the left table, from 0.",
        value: "0",
        validateInput: (v) => (/^\s*\d+\s*$/.test(v) ? undefined : "A row index: a whole number from 0."),
      }));
    if (rowText === undefined) {
      return "no row";
    }
    if (!/^\s*\d+\s*$/.test(rowText)) {
      return say("q-lint: a row index is a whole number from 0.");
    }
    const index = Number(rowText.trim());
    let text: string;
    try {
      const ran = await live.runOnActive(explainGuardCode(call), (connection) => connection.call(EXPLAIN_AJ, asCode(call.columns), asCode(call.left), asCode(call.right), index));
      if (ran === undefined) {
        return "nothing was run";
      }
      text = explain(call, index, ran.process, readMatch(ran.value));
    } catch (error) {
      return say(`q-lint: could not explain the match: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!on()) {
      return say(toolOff("ajExplainer"));
    }
    const uri = Uri.from({ scheme: AJ_SCHEME, path: `/aj match ${++count}.q` });
    documents.set(uri.toString(), text);
    changed.fire(uri);
    await window.showTextDocument(await workspace.openTextDocument(uri), { preview: true });
    return text;
  };
  context.subscriptions.push(
    changed,
    workspace.registerTextDocumentContentProvider(AJ_SCHEME, provider),
    workspace.onDidCloseTextDocument((d) => void (d.uri.scheme === AJ_SCHEME && documents.delete(d.uri.toString()))),
    commands.registerCommand(PROCESS_TOOL_COMMANDS.explainAj, (code?: unknown, row?: unknown) =>
      explainRow(typeof code === "string" ? code : undefined, typeof row === "string" || typeof row === "number" ? String(row) : undefined),
    ),
  );
  return { explainRow };
}
