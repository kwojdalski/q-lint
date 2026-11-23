// Organise loads (#990): the language server's code action of kind
// `source.organizeImports.q-lint` sorts, dedupes and groups each run of `\l`
// lines (`organise_loads` in the server). VS Code's own **Organize Imports**
// (Shift+Alt+O) and `editor.codeActionsOnSave` ask for it; this adds
// **q-lint: Organise Loads** to the palette, which asks the server for that
// action on the active q file and applies its edit. Off
// (q-lint.organiseLoads.enable), the command refuses and the setting goes to
// the server, which then offers no such action.
import { CodeActionKind, Range, commands, window, workspace, type CodeAction, type ExtensionContext } from "vscode";
import { TOOLING_COMMANDS, toolingOff, toolingOn } from "./toolingfeatures";
import { plainMessage } from "./history";

export const ORGANISE_LOADS = TOOLING_COMMANDS.organiseLoads;

export function registerOrganiseLoads(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand(ORGANISE_LOADS, async () => {
      if (!toolingOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "organiseLoads")) {
        void window.showInformationMessage(plainMessage(toolingOff("organiseLoads")));
        return false;
      }
      const editor = window.activeTextEditor;
      if (editor === undefined || editor.document.languageId !== "q") {
        void window.showInformationMessage("q-lint: Organise Loads works on a q file; open one first.");
        return false;
      }
      const kind = CodeActionKind.SourceOrganizeImports.append("q-lint");
      const actions =
        (await commands.executeCommand<CodeAction[] | undefined>("vscode.executeCodeActionProvider", editor.document.uri, new Range(0, 0, 0, 0), kind.value)) ?? [];
      const organise = actions.find((a) => a.kind !== undefined && kind.contains(a.kind) && a.edit !== undefined);
      if (organise?.edit === undefined) {
        void window.showInformationMessage("q-lint: the loads are organised already, or the language server is not running.");
        return false;
      }
      return workspace.applyEdit(organise.edit);
    }),
  );
}
