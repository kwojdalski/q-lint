// The connection and process-admin features (#1032-#1041), registered
// together so the extension's activation names them once. Each is its own
// file and its own switch (`admin.ts`).
import type { ExtensionContext } from "vscode";
import { BulkAdd } from "./bulkaddview";
import { CredentialCommands } from "./credentialview";
import { ImportOther } from "./importotherview";
import type { Launcher } from "./launcherview";
import type { Live } from "./live";

export function registerProcessAdmin(context: ExtensionContext, live: Live, launcher: Launcher): { bulkAdd: BulkAdd; importOther: ImportOther; credentials: CredentialCommands } {
  void launcher;
  const bulkAdd = new BulkAdd(context, live);
  const importOther = new ImportOther(context, live);
  const credentials = new CredentialCommands(context, live);
  return { bulkAdd, importOther, credentials };
}
