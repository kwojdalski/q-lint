// The process inspection and editor helpers (#1042-#1051), registered
// together: each its own module, each with its own switch
// (`processtools.ts`). What each registration returns is handed to tests
// through the extension's API.
import type { ExtensionContext } from "vscode";
import type { Live } from "./live";
import { registerTickerplantSubscribers } from "./tpsubsview";
import { registerSystemSettings } from "./syssettingsview";
import { registerFileBrowser } from "./remotefilesview";
import { registerFunctionDiff } from "./fndiffview";
import { registerFindInProcesses } from "./procsearchview";
import { registerInlineResults } from "./inlineresultview";
import { registerBenchmark } from "./benchmarkview";
import { registerJoinAssistant } from "./joinassistview";

export function registerProcessTools(context: ExtensionContext, live: Live) {
  return {
    tickerplantSubscribers: registerTickerplantSubscribers(context, live),
    systemSettings: registerSystemSettings(context, live),
    fileBrowser: registerFileBrowser(context, live),
    functionDiff: registerFunctionDiff(context, live),
    findInProcesses: registerFindInProcesses(context, live),
    inlineResults: registerInlineResults(context, live),
    benchmark: registerBenchmark(context, live),
    joinAssistant: registerJoinAssistant(context, live),
  };
}
