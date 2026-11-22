// The process inspection and editor helpers (#1042-#1051), registered
// together: each its own module, each with its own switch
// (`processtools.ts`). What each registration returns is handed to tests
// through the extension's API.
import type { ExtensionContext } from "vscode";
import type { Live } from "./live";
import { registerTickerplantSubscribers } from "./tpsubsview";
import { registerSystemSettings } from "./syssettingsview";

export function registerProcessTools(context: ExtensionContext, live: Live) {
  return {
    tickerplantSubscribers: registerTickerplantSubscribers(context, live),
    systemSettings: registerSystemSettings(context, live),
  };
}
