// New Query for Process (#1002): an untitled q editor bound to the process
// picked, so what is run from it goes there, whatever is connected. The
// binding is the one Choose Connection for File makes, which for an
// untitled editor lasts as long as the editor. Nothing is sent to the
// process until a query is run from the editor, and connecting then is the
// query's own (the read-only guard and the production confirmation apply).
import { commands, window, workspace, type ExtensionContext } from "vscode";
import type { Live, ProcessArg } from "./live";
import { NEW_QUERY_COMMAND, NEW_QUERY_OFF, readNewQuery } from "./newquery";
import { CONTROL_COMMANDS } from "./querycontrols";

export class NewQuery {
  constructor(
    context: ExtensionContext,
    private readonly live: Pick<Live, "pick">,
  ) {
    context.subscriptions.push(commands.registerCommand(NEW_QUERY_COMMAND, (row?: ProcessArg) => this.open(row)));
  }

  /// Open the editor for `row`'s process, or one picked; the untitled
  /// editor it opened, for tests and the e2e run.
  async open(row?: ProcessArg): Promise<{ uri: unknown; label: string } | undefined> {
    const configuration = workspace.getConfiguration("q-lint");
    if (!readNewQuery((key, fallback) => configuration.get(key, fallback)).enabled) {
      void window.showInformationMessage(NEW_QUERY_OFF);
      return undefined;
    }
    const process = await this.live.pick(row, "New query for which q process?");
    if (process === undefined) {
      return undefined;
    }
    const document = await workspace.openTextDocument({ language: "q", content: "" });
    await window.showTextDocument(document);
    await commands.executeCommand(CONTROL_COMMANDS.chooseFileConnection, process.label, document.uri);
    return { uri: document.uri, label: process.label };
  }
}
