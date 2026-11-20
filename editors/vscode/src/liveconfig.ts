// The names the live half registers, and the settings it reads, free of any
// `vscode` import so a test can hold them against `package.json`: a command
// declared and never registered is a palette entry that fails when chosen,
// and a setting declared and never read is one someone sets and believes.
import { consoleSize, tagColours } from "./processes";

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
  runInTerminal: "q-lint.runInTerminal",
  sendLine: "q-lint.sendCurrentLineToTerminal",
  sendSelection: "q-lint.sendSelectionToTerminal",
  sendBlock: "q-lint.sendBlockToTerminal",
  switchMode: "q-lint.switchQueryMode",
} as const;

/// The discovery server commands (#874), registered by `DiscoveryServers`.
export const DISCOVERY_COMMANDS = {
  add: "q-lint.addDiscoveryServer",
  edit: "q-lint.editDiscoveryServer",
  remove: "q-lint.deleteDiscoveryServer",
  reload: "q-lint.reloadDiscoveryServer",
  download: "q-lint.downloadDiscoveredProcesses",
  forget: "q-lint.removeDiscoveredProcesses",
} as const;

/// Where a query's result is shown: the output, or the result panel as a
/// grid or a chart.
export const QUERY_MODES = ["console", "grid", "chart"] as const;
export type QueryMode = (typeof QUERY_MODES)[number];

/// Set while a q process is connected.
export const CONNECTED = "q-lint.connected";

export interface LiveSettings {
  consoleSize: [number, number];
  autoClear: boolean;
  includeQuery: boolean;
  ignoreNullReturn: boolean;
  mode: QueryMode;
  /// The most rows a grid or chart is sent.
  gridLimit: number;
  /// Decimal places a float or real is shown to in the grid; negative: as
  /// the process writes it (`\P`).
  gridDecimals: number;
}

/// A whole number from `get`, or `fallback` when it is not one or is below
/// `least`.
function whole(value: unknown, least: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= least ? value : fallback;
}

/// The query settings, read with `get` as `workspace.getConfiguration("q-lint")`
/// would. None of them reaches the language server, and none restarts it.
export function readLive(get: <T>(key: string, fallback: T) => T): LiveSettings {
  return {
    consoleSize: consoleSize(get("output.consoleSize", "50 160")) ?? [50, 160],
    autoClear: get("output.autoClear", false),
    includeQuery: get("output.includeQuery", false),
    ignoreNullReturn: get("output.ignoreNullReturn", false),
    mode: QUERY_MODES.find((m) => m === get("query.mode", "console")) ?? "console",
    gridLimit: whole(get("query.gridLimit", 10000), 1, 10000),
    gridDecimals: Math.min(whole(get("query.gridDecimals", -1), -1, -1), 20),
  };
}

export interface TerminalSettings {
  qBinary: string;
  envPath: string;
}

/// The terminal settings, read as `readLive` reads the query ones. Each is
/// read when a terminal starts, so a change applies to the next one.
export function readTerminal(get: <T>(key: string, fallback: T) => T): TerminalSettings {
  const qBinary = get("terminal.qBinary", "q").trim();
  return {
    qBinary: qBinary === "" ? "q" : qBinary,
    envPath: get("terminal.envPath", "").trim(),
  };
}

export interface DiscoverySettings {
  /// Minutes between fetches of every discovery server; 0: only on Reload.
  refreshInterval: number;
}

/// The discovery settings, read as `readLive` reads the query ones. The
/// interval is at most a day, since a longer one overflows a timer.
export function readDiscovery(get: <T>(key: string, fallback: T) => T): DiscoverySettings {
  return { refreshInterval: Math.min(whole(get("discovery.refreshInterval", 30), 0, 30), 1440) };
}

export interface ProcessSettings {
  /// Tag to ThemeColor id, over the built-in prod, uat and dev colours.
  tagColors: Record<string, string>;
}

/// The Processes view's settings, read as `readLive` reads the query ones.
/// A change recolours the view at once.
export function readProcessSettings(get: <T>(key: string, fallback: T) => T): ProcessSettings {
  return { tagColors: tagColours(get<unknown>("processes.tagColors", {})) };
}
