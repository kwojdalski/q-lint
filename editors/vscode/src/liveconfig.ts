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

/// The q Results view (#889): the result panel docked in the bottom panel,
/// its container, and the commands on results and notebook row limits.
export const RESULTS = {
  container: "q-lint-results",
  view: "q-lint.results",
  exportCsv: "q-lint.exportResults",
  /// The q Results view's own Export: its rows, whatever resultsLocation says.
  exportViewCsv: "q-lint.exportResultsView",
  setRowLimit: "q-lint.setNotebookRowLimit",
} as const;

/// The result panel's own commands: its views, its history and its diff.
export const RESULT_VIEW = {
  statistics: "q-lint.showResultStatistics",
  tree: "q-lint.showResultTree",
  compare: "q-lint.compareResultWithPrevious",
  heatmap: "q-lint.toggleResultHeatmap",
  history: "q-lint.showResultFromHistory",
  exportAs: "q-lint.exportResultsAs",
  copyAs: "q-lint.copyResultsAs",
  loadMore: "q-lint.loadMoreResultRows",
  pivot: "q-lint.showResultPivot",
  saveChart: "q-lint.saveResultChart",
  drillDown: "q-lint.drillDownResultCell",
} as const;

/// Context keys the result panel sets, for its commands' `when` clauses.
export const RESULT_CONTEXT = {
  shown: "q-lint.result.shown",
  hasPrevious: "q-lint.result.hasPrevious",
  hasTree: "q-lint.result.hasTree",
  /// The process holds more of the result on show than the grid has.
  hasMore: "q-lint.result.hasMore",
} as const;

/// Where the result panel opens: beside the editor, or in the bottom panel.
export const RESULTS_LOCATIONS = ["editor", "panel"] as const;
export type ResultsLocation = (typeof RESULTS_LOCATIONS)[number];

/// Which rows of a table a notebook cell shows when it has more than its
/// row limit.
export const ROW_LIMIT_FROM = ["first", "last"] as const;
export type RowLimitFrom = (typeof ROW_LIMIT_FROM)[number];

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
  /// Where the result panel opens.
  resultsLocation: ResultsLocation;
}

/// A whole number from `get`, or `fallback` when it is not one or is below
/// `least`.
function whole(value: unknown, least: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= least ? value : fallback;
}

/// Whether `get` gave `true`: settings.json may hold any type, and a string
/// `"false"` is not true.
const yes = (value: unknown): boolean => value === true;

/// The query settings, read with `get` as `workspace.getConfiguration("q-lint")`
/// would. None of them reaches the language server, and none restarts it.
export function readLive(get: <T>(key: string, fallback: T) => T): LiveSettings {
  return {
    consoleSize: consoleSize(get<unknown>("output.consoleSize", "50 160")) ?? [50, 160],
    autoClear: yes(get<unknown>("output.autoClear", false)),
    includeQuery: yes(get<unknown>("output.includeQuery", false)),
    ignoreNullReturn: yes(get<unknown>("output.ignoreNullReturn", false)),
    mode: QUERY_MODES.find((m) => m === get("query.mode", "console")) ?? "console",
    gridLimit: whole(get("query.gridLimit", 10000), 1, 10000),
    gridDecimals: Math.min(whole(get("query.gridDecimals", -1), -1, -1), 20),
    resultsLocation: RESULTS_LOCATIONS.find((l) => l === get("query.resultsLocation", "editor")) ?? "editor",
  };
}

/// The result panel's features, each with its own `q-lint.results.<feature>.enable`.
export const RESULT_FEATURES = ["history", "diff", "statistics", "heatmap", "tree", "export", "paging", "pivot", "charts", "drilldown", "plots"] as const;
export type ResultFeature = (typeof RESULT_FEATURES)[number];

/// The features off unless turned on: paging keeps a result on the process
/// and asks it for rows as the grid scrolls.
const RESULT_FEATURES_OFF: ReadonlySet<ResultFeature> = new Set(["paging"]);

export interface ResultViewSettings {
  /// Results kept as tabs, 1 to 50; 1 while the history is off.
  history: number;
  /// Whether numeric columns are coloured by value: never while the
  /// heatmap is off.
  heatmap: boolean;
  /// Which of the panel's features are on.
  enable: Record<ResultFeature, boolean>;
  /// The drill-down queries a grid's cell offers.
  drilldown: DrilldownTemplate[];
}

/// A follow-up query a cell of the grid offers (#927): `{{value}}` in its
/// code is the cell's value as q, `{{column}}` its column's name as a
/// symbol, and `{{row.name}}` the value of column `name` in its row.
export interface DrilldownTemplate {
  label: string;
  query: string;
  /// The columns it is offered for; every column when empty.
  columns: string[];
}

/// `q-lint.results.drilldownTemplates`, dropping an item that is not a
/// template: settings.json can hold anything.
export function readDrilldown(value: unknown): DrilldownTemplate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): DrilldownTemplate[] => {
    const t = item as Record<string, unknown> | null;
    if (t === null || typeof t !== "object" || typeof t.query !== "string" || t.query.trim() === "") {
      return [];
    }
    const columns = Array.isArray(t.columns) ? t.columns.filter((c): c is string => typeof c === "string") : [];
    return [{ label: typeof t.label === "string" && t.label.trim() !== "" ? t.label : t.query, query: t.query, columns }];
  });
}

/// The result view's own settings, read with `get` as `readLive` reads the
/// query ones. Every feature is on unless its setting is `false`, but for
/// those in RESULT_FEATURES_OFF, off unless it is `true`.
export function readResultView(get: <T>(key: string, fallback: T) => T): ResultViewSettings {
  const on = (f: ResultFeature): boolean => {
    const value = get<unknown>(`results.${f}.enable`, !RESULT_FEATURES_OFF.has(f));
    return RESULT_FEATURES_OFF.has(f) ? value === true : value !== false;
  };
  const enable = Object.fromEntries(RESULT_FEATURES.map((f) => [f, on(f)])) as Record<
    ResultFeature,
    boolean
  >;
  const n = get<unknown>("query.resultHistory", 10);
  return {
    history: !enable.history ? 1 : typeof n === "number" && Number.isInteger(n) ? Math.max(1, Math.min(50, n)) : 10,
    heatmap: enable.heatmap && get<unknown>("query.gridHeatmap", false) === true,
    enable,
    drilldown: readDrilldown(get<unknown>("results.drilldownTemplates", [])),
  };
}

export interface TerminalSettings {
  qBinary: string;
  envPath: string;
}

/// The terminal settings, read as `readLive` reads the query ones. Each is
/// read when a terminal starts, so a change applies to the next one.
export function readTerminal(get: <T>(key: string, fallback: T) => T): TerminalSettings {
  // A hand-written `null` or number in settings.json is no setting.
  const text = (key: string, fallback: string): string => {
    const value = get<unknown>(key, fallback);
    return typeof value === "string" ? value.trim() : "";
  };
  const qBinary = text("terminal.qBinary", "q");
  return {
    qBinary: qBinary === "" ? "q" : qBinary,
    envPath: text("terminal.envPath", ""),
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

export interface NotebookSettings {
  /// The most rows a `@grid` or `@chart` cell is sent; 0: every row.
  rowLimit: number;
  /// Whether those are the table's first rows or its last.
  rowLimitFrom: RowLimitFrom;
}

/// The notebook settings, read as `readLive` reads the query ones. Each is
/// read when a cell runs.
export function readNotebook(get: <T>(key: string, fallback: T) => T): NotebookSettings {
  return {
    rowLimit: whole(get("notebook.rowLimit", 1000), 0, 1000),
    rowLimitFrom: ROW_LIMIT_FROM.find((f) => f === get("notebook.rowLimitFrom", "first")) ?? "first",
  };
}

/// The row count a cell's lambda takes with `sublist`: the first `rowLimit`
/// rows, the last as a negative count, and every row as an infinite one
/// (`0w`, which the process makes `0W`).
export function rowsArgument(settings: NotebookSettings): number {
  const n = settings.rowLimit === 0 ? Infinity : settings.rowLimit;
  return settings.rowLimitFrom === "last" ? -n : n;
}

/// The row limits **Set Notebook Row Limit** offers; 0 is every row.
export const ROW_LIMIT_CHOICES = [10, 100, 1000, 10000, 100000, 0] as const;

/// A row limit as the quick pick and the settings describe it.
export function rowLimitLabel(limit: number): string {
  return limit === 0 ? "All rows" : `${limit.toLocaleString("en")} rows`;
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
