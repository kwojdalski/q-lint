// The connection and process-admin features (#1032-#1041), registered
// together so the extension's activation names them once. Each is its own
// file and its own switch (`admin.ts`).
import type { ExtensionContext } from "vscode";
import { AsyncQueries } from "./asyncqueryview";
import { BulkAdd } from "./bulkaddview";
import { CredentialCommands } from "./credentialview";
import { EnvironmentColour } from "./envcolourview";
import { ImportOther } from "./importotherview";
import type { Launcher } from "./launcherview";
import type { Live } from "./live";
import { ProcessTimeouts } from "./timeoutview";

export function registerProcessAdmin(context: ExtensionContext, live: Live, launcher: Launcher): { bulkAdd: BulkAdd; importOther: ImportOther; credentials: CredentialCommands; environmentColour: EnvironmentColour; timeouts: ProcessTimeouts; asyncQueries: AsyncQueries } {
  const bulkAdd = new BulkAdd(context, live);
  const importOther = new ImportOther(context, live);
  const credentials = new CredentialCommands(context, live);
  const environmentColour = new EnvironmentColour(context, live);
  const timeouts = new ProcessTimeouts(context, live, launcher);
  const asyncQueries = new AsyncQueries(context, live);
  return { bulkAdd, importOther, credentials, environmentColour, timeouts, asyncQueries };
}
