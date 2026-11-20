// The names the live half registers, and the settings it reads, free of any
// `vscode` import so a test can hold them against `package.json`: a command
// declared and never registered is a palette entry that fails when chosen,
// and a setting declared and never read is one someone sets and believes.
import { consoleSize } from "./processes";

export const VIEWS = {
  container: "q-lint",
  processes: "q-lint.processes",
  history: "q-lint.queryHistory",
} as const;

export const COMMANDS = {
  add: "q-lint.addProcess",
  edit: "q-lint.editProcess",
  remove: "q-lint.deleteProcess",
  connect: "q-lint.connectProcess",
  disconnect: "q-lint.disconnectProcess",
  tag: "q-lint.tagProcess",
  importList: "q-lint.importProcesses",
  exportList: "q-lint.exportProcesses",
  refresh: "q-lint.refreshProcesses",
  insertLabel: "q-lint.insertActiveConnectionLabel",
  queryLine: "q-lint.queryCurrentLine",
  querySelection: "q-lint.querySelection",
  queryBlock: "q-lint.queryBlock",
  abort: "q-lint.abortQuery",
  rerun: "q-lint.rerunQuery",
  clearHistory: "q-lint.clearQueryHistory",
} as const;

/// Set while a q process is connected.
export const CONNECTED = "q-lint.connected";

export interface LiveSettings {
  consoleSize: [number, number];
  autoClear: boolean;
  includeQuery: boolean;
  ignoreNullReturn: boolean;
}

/// The query settings, read with `get` as `workspace.getConfiguration("q-lint")`
/// would. None of them reaches the language server, and none restarts it.
export function readLive(get: <T>(key: string, fallback: T) => T): LiveSettings {
  return {
    consoleSize: consoleSize(get("output.consoleSize", "50 160")) ?? [50, 160],
    autoClear: get("output.autoClear", false),
    includeQuery: get("output.includeQuery", false),
    ignoreNullReturn: get("output.ignoreNullReturn", false),
  };
}
