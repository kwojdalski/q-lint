// Query modes: whether a result goes to the output or to the result panel,
// where `media/result.js` draws it as a grid or a chart.
//
// The panel is a webview that loads only the extension's own files, under a
// Content-Security-Policy that allows no inline code and no network: its
// scripts carry a fresh nonce, and its stylesheet comes from `media/`. The
// chart library is Chart.js 4.5.1 (MIT, chartjs.org), vendored whole as
// `media/vendor/chart.umd.min.js` with its licence beside it; what a chart
// draws is `media/chartspec.js`'s, which a notebook's charts share. The grid
// is this extension's. What the panel shows is computed here, by `grid.ts`, so
// the script only lays it out, sorts it by the ranks the process sent and
// filters it by the text each cell shows.
//
// The panel opens beside the editor, or - `q-lint.query.resultsLocation` set
// to `panel` - as the q Results view in the bottom panel (#889). Both are
// the same page: the same files, the same policy, the same messages. A view
// that is hidden and shown again reloads, keeps what its script saved with
// `setState`, and asks for the result again, as a panel does. Export to CSV
// writes the rows shown, after the filters and the sort, as Copy as CSV
// copies them.
//
// The last `q-lint.query.resultHistory` results are kept, and the page shows
// them as tabs: choosing one shows it again as it was drawn. Each result
// also keeps the previous run of the same code, so the page can mark what
// changed since (`resultdiff.ts`). A dictionary or a nested list comes with
// its tree (`grid.ts`'s `tree`), which the page opens level by level.
//
// A result can also be exported as Excel, Parquet, JSON, Markdown, q or HTML
// (`resultexport.ts`), pivoted, and charted as an area, a step line or
// candles, on two axes, and saved as PNG or SVG. With paging on, a result
// cut at gridLimit stays on the process (`grid.ts`'s `HELD`) and the grid
// asks for more of it as it scrolls. A cell's drill-down templates run a
// follow-up query with its value put in (`drilldown.ts`).
//
// A column header's menu offers the Data Wrangler and a cell's Edit Cell
// (`resulttools.ts`), which work from `current()`: the page only marks
// where each menu applies.
//
// Each result also keeps its look (`resultlook.ts`): conditional formats,
// data bars and sparklines, the column layout and a chart preset, set from
// a column's menu or the page, sent with the result, and kept for the
// result's saved query when it came from one (#1013-#1015, #1019). The
// page computes the correlation matrix (#1020), and a result can be sent to
// a q notebook or a Markdown report (#1021, `resultreport.ts`).
import { randomBytes } from "node:crypto";
import {
  commands,
  ConfigurationTarget,
  env,
  NotebookCellData,
  NotebookCellKind,
  NotebookEdit,
  WorkspaceEdit,
  StatusBarAlignment,
  Uri,
  ViewColumn,
  window,
  workspace,
  type ExtensionContext,
  type NotebookDocument,
  type NotebookEditor,
  type StatusBarItem,
  type Webview,
  type WebviewPanel,
  type WebviewView,
} from "vscode";
import {
  COMMANDS,
  QUERY_MODES,
  readLive,
  readResultView,
  RESULT_CONTEXT,
  RESULT_VIEW,
  RESULTS,
  type LiveSettings,
  type QueryMode,
  type ResultFeature,
  type ResultViewSettings,
  type ResultsLocation,
} from "./liveconfig";
import { appendPage, rowCount, toCsv, toGrid, type GridAnswer, type GridPage, type GridPayload } from "./grid";
import { diffGrids, type GridDiff } from "./resultdiff";
import { fillDrilldown, templatesFor } from "./drilldown";
import { EXPORT_FORMATS, exportResult, FORMAT_INFO, type ExportFormat } from "./resultexport";
import { plainSvg, PLOTS } from "./plots";
import {
  lookParts,
  parseLayout,
  parseLooks,
  parsePreset,
  parseRule,
  RULE_OPS,
  ruleValue,
  ruleValueProblem,
  SAVED_LOOKS_KEY,
  TEXT_OPS,
  withCellChart,
  withLook,
  withoutRules,
  withRule,
  type ChartPreset,
  type ColumnLayout,
  type FormatRule,
  type LookParts,
  type PaletteColour,
  type ResultLook,
  type RuleOp,
  type RuleStyle,
} from "./resultlook";
import { imagePath, linkTarget, resultMarkdown } from "./resultreport";
import { SAVED_QUERIES, SAVED_QUERIES_KEY, parseSaved } from "./savedqueries";
import { NOTEBOOK } from "./qnb";
import type { Grid } from "./grid";
import { iconsEscaped, plainMessage } from "./history";

/// `media/gridlook.js`'s helpers the column commands use, as the page does.
interface GridLookHelpers {
  isNumericList(grid: Grid, column: number): boolean;
  displayColumns(grid: Grid, layout: ColumnLayout | undefined): number[];
}
const GRID_LOOK = require("../media/gridlook.js") as GridLookHelpers;

/// What each rule comparison is called in its pick.
const OP_LABELS: Record<RuleOp, string> = {
  ">": "greater than",
  ">=": "at least",
  "<": "less than",
  "<=": "at most",
  "=": "equal to",
  "<>": "not equal to",
  top: "among the top N",
  bottom: "among the bottom N",
  contains: "containing the text",
};

/// The styles a rule can give, as its pick offers them.
const RULE_STYLES: { label: string; style: RuleStyle }[] = [
  ...(["red", "green", "blue", "orange", "yellow", "purple", "grey"] as PaletteColour[]).map((c) => ({ label: `${c[0].toUpperCase()}${c.slice(1)} background`, style: { background: c } })),
  ...(["red", "green", "blue", "orange", "purple"] as PaletteColour[]).map((c) => ({ label: `${c[0].toUpperCase()}${c.slice(1)} text`, style: { color: c } })),
  { label: "Bold", style: { bold: true } },
];

/// Where the report a result was last appended to is kept, for the next.
const LAST_REPORT_KEY = "q-lint.lastResultReport";

const MODE_ICONS: Record<QueryMode, string> = { console: "output", grid: "table", chart: "graph-line" };
const MODE_DETAILS: Record<QueryMode, string> = {
  console: "Every result in the q-lint: query output, as q formats it",
  grid: "Tables, dictionaries and lists in a sortable, filterable grid",
  chart: "Tables, dictionaries and lists as a line, bar, scatter or histogram chart",
};

/// What the panel last drew, as its script reported it: for tests, through
/// the API `activate` returns.
export interface Rendered {
  /// Where it was drawn: the editor-area panel, or the q Results view.
  location: ResultsLocation;
  view: "grid" | "chart" | "stats" | "tree" | "pivot";
  /// Rows shown after the filters, and rows the panel holds.
  rows: number;
  held: number;
  /// Rows the whole result had.
  total: number;
  columns: string[];
  /// The cells of the first row shown.
  first: string[];
  chart?: { kind: string; datasets: { label: string; points: number }[]; note?: string };
  /// The results the page offers as tabs, and the place of the one shown.
  history?: { count: number; index: number };
  /// What Compare with Previous Run marks, when it is on.
  diff?: { changed: number; added: number; removed: number; matchedBy: string };
  /// Cells the heatmap coloured, when it is on.
  heat?: number;
  /// The statistics view: one row per column.
  stats?: { name: string; count: number; nulls: number; distinct: number; min: string; max: string; mean: string }[];
  /// The tree view: the nodes drawn, and how many are open.
  tree?: { drawn: number; open: number; labels: string[] };
  /// The pivot view: its row and column values, and its first row's cells.
  pivot?: { rows: number; columns: string[]; first: string[]; note?: string };
  /// How the grid dressed its columns (#1012-#1015): the headers shown, in
  /// order, and the cells in view formatted, styled by a rule, drawn as a
  /// data bar or a sparkline; the columns frozen.
  dressed?: { headers: string[]; formatted: number; ruled: number; bars: number; sparks: number; frozen: number };
  /// The correlation view (#1020): its columns and matrix.
  corr?: { names: string[]; r: (number | null)[][] };
  /// Linked panes (#1018): their series, the zoom and the crosshair's reading.
  linked?: { panes: string[]; range?: { min: number; max: number } | null; readout?: { x: string; values: { label: string; text: string }[] } | null };
  /// The chart drawn, as a preset (#1019).
  preset?: ChartPreset;
}

/// What a page is asked to do by a command, once: `key` tells a request
/// from the same one sent again with the next result.
interface Control {
  key: string;
  action: "view" | "compare" | "image";
  view?: "stats" | "tree" | "pivot" | "corr";
  /// "image": the format to save the chart in.
  format?: "png" | "svg";
}

/// Rows the grid may hold after pages are added to it.
const MAX_PAGED_ROWS = 1000000;

/// How many results the previous run of each query is kept for.
const PREVIOUS_RUNS = 20;

interface Shown {
  process: string;
  code: string;
  millis: number;
  payload: GridPayload;
  view: "grid" | "chart";
  /// `q-lint.query.gridLimit` when it ran: what the panel says a cut
  /// result was cut at, though the setting has changed since.
  limit: number;
  /// Counts results, so the panel tells a new one from the same one sent
  /// again and keeps the view, sort and filters chosen for it. Prefixed by
  /// the session: a view's page keeps its state across a window reload,
  /// and must not take the next session's first result for its last.
  id: string;
  /// When it ran.
  at: number;
  /// The previous run of the same code, when there was one.
  before?: { payload: GridPayload; process: string; at: number };
  /// The process holds the rest of it, for the grid to page through.
  held?: boolean;
  /// The saved query it came from (#912), whose look it keeps.
  saved?: string;
  /// How it is dressed: rules, cell charts, layout, chart preset.
  look: ResultLook;
}

/// A query's code on one line, for a tab or a pick: its first line, cut.
function oneLine(code: string): string {
  const line = code.trim().split(/\r?\n/)[0] ?? "";
  const more = line.length > 60 || code.trim().includes("\n");
  return more ? `${line.slice(0, 57)}...` : line;
}

function settings(): LiveSettings {
  const configuration = workspace.getConfiguration("q-lint");
  return readLive((key, fallback) => configuration.get(key, fallback));
}

/// The page the result panel and the q Results view load: the extension's
/// own files, a fresh nonce on every script, nothing inline, no network.
/// The view's body is marked, to take the bottom panel's background.
function resultHtml(webview: Webview, media: Uri, location: ResultsLocation): string {
  const nonce = randomBytes(16).toString("base64");
  const file = (...path: string[]): string => webview.asWebviewUri(Uri.joinPath(media, ...path)).toString();
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${file("result.css")}">`,
    `<title>q-lint: result</title></head><body${location === "panel" ? ' data-location="panel"' : ""}>`,
    `<script nonce="${nonce}" src="${file("vendor", "chart.umd.min.js")}"></script>`,
    `<script nonce="${nonce}" src="${file("chartspec.js")}"></script>`,
    `<script nonce="${nonce}" src="${file("gridlook.js")}"></script>`,
    `<script nonce="${nonce}" src="${file("worldoutline.js")}"></script>`,
    `<script nonce="${nonce}" src="${file("chartmore.js")}"></script>`,
    `<script nonce="${nonce}" src="${file("result.js")}"></script>`,
    "</body></html>",
  ].join("\n");
}

/// What a page says to the extension.
interface PageMessage {
  type?: string;
  /// "select": the result chosen from the tabs.
  pick?: string;
  /// The result the page drew: rows are rows of it.
  id?: string;
  rows?: number[];
  rendered?: Omit<Rendered, "location">;
  /// "exportAs", "copyAs": the format, when the page chose one.
  format?: string;
  /// "image": the chart, as a PNG data URL or SVG text; "plotted": the
  /// chart drawn, as SVG, its kind in `format`.
  data?: string;
  /// "image": the command's request it answers, if any.
  key?: string;
  /// "drill": the cell, by column and row of the grid.
  column?: number;
  row?: number;
  /// "copyText": text to put on the clipboard.
  text?: string;
  /// "look": the layout the page changed.
  layout?: unknown;
  /// "chartPreset": the chart drawn.
  preset?: unknown;
}

/// What a webview's context menu passes its command: the cell's
/// `data-vscode-context`.
interface CellContext {
  column?: unknown;
  row?: unknown;
}

export class QueryModes {
  private panel: WebviewPanel | undefined;
  private view: WebviewView | undefined;
  private shown: Shown | undefined;
  private rendered: Rendered | undefined;
  /// The rows each page last showed, after its filters and sort, in order:
  /// the editor's panel and the q Results view can both be open.
  private readonly order: Partial<Record<ResultsLocation, number[]>> = {};
  private readonly status: StatusBarItem;
  private readonly media: Uri;
  private readonly session = randomBytes(6).toString("hex");
  private results = 0;
  /// The results kept, oldest first; `shown` is one of them.
  private history: Shown[] = [];
  /// The last run of each query's code, for the next run to compare with.
  private readonly previous = new Map<string, Shown>();
  private control: Control | undefined;
  private controls = 0;
  /// Fetches rows of a result the process holds; set by the live half.
  private pager: ((process: string, offset: number, count: number) => Promise<GridPage | string>) | undefined;
  /// Runs a drill-down query on a process; set by the live half.
  private runner: ((code: string, process: string) => Promise<void>) | undefined;
  /// A page fetch under way, so a second is not sent behind it.
  private paging = false;
  /// Save Result Chart's requests, by key, until the page sends each image:
  /// a second run does not strand the first (#1130).
  private readonly saving = new Map<string, { target?: Uri; resolve: () => void }>();
  /// Requests for the chart as an image to send somewhere (#1021), by key.
  private readonly images = new Map<string, (data: string | undefined) => void>();
  /// The saved query being run, whose result is the next of its code.
  private expecting: { name: string; code: string } | undefined;
  /// The look of each code's last result, for its next run.
  private readonly looks = new Map<string, ResultLook>();
  /// The chart each result last drew, as a preset, by id.
  private readonly presets = new Map<string, ChartPreset>();

  constructor(private readonly context: ExtensionContext) {
    this.media = Uri.joinPath(context.extensionUri, "media");
    this.status = window.createStatusBarItem("q-lint.queryMode", StatusBarAlignment.Left, 49);
    this.status.name = "q-lint: query mode";
    this.status.command = COMMANDS.switchMode;
    context.subscriptions.push(
      this.status,
      commands.registerCommand(COMMANDS.switchMode, (mode?: string) => this.switchMode(mode)),
      commands.registerCommand(RESULTS.exportCsv, (target?: Uri) => this.exportCsv(target, this.order[settings().resultsLocation])),
      commands.registerCommand(RESULTS.exportViewCsv, (target?: Uri) => this.exportCsv(target, this.order.panel)),
      commands.registerCommand(RESULT_VIEW.statistics, () => this.enabled("statistics") && this.ask({ action: "view", view: "stats" })),
      commands.registerCommand(RESULT_VIEW.tree, () => this.enabled("tree") && this.ask({ action: "view", view: "tree" })),
      commands.registerCommand(RESULT_VIEW.compare, () => this.enabled("diff") && this.ask({ action: "compare" })),
      commands.registerCommand(RESULT_VIEW.heatmap, () => this.enabled("heatmap") && this.toggleHeatmap()),
      commands.registerCommand(RESULT_VIEW.history, (id?: string) => this.enabled("history") && this.pickFromHistory(id)),
      commands.registerCommand(RESULT_VIEW.exportAs, (format?: string, target?: Uri) => this.enabled("export") && this.exportAs(format, target, this.order[settings().resultsLocation])),
      commands.registerCommand(RESULT_VIEW.copyAs, (format?: string) => this.enabled("export") && this.copyAs(format, this.order[settings().resultsLocation])),
      commands.registerCommand(RESULT_VIEW.loadMore, () => this.enabled("paging") && this.loadMore(true)),
      commands.registerCommand(RESULT_VIEW.pivot, () => this.enabled("pivot") && this.ask({ action: "view", view: "pivot" })),
      commands.registerCommand(RESULT_VIEW.saveChart, (format?: string, target?: Uri) => this.enabled("charts") && this.saveChart(format, target)),
      commands.registerCommand(RESULT_VIEW.drillDown, (cell?: CellContext) => this.enabled("drilldown") && this.drill(cell?.column, cell?.row)),
      commands.registerCommand(RESULT_VIEW.addFormat, (cell?: CellContext | string, rule?: unknown) => this.enabled("conditionalFormats") && this.addFormat(cell, rule)),
      commands.registerCommand(RESULT_VIEW.clearFormats, (cell?: CellContext | string) => this.enabled("conditionalFormats") && this.clearFormats(cell)),
      commands.registerCommand(RESULT_VIEW.toggleBar, (cell?: CellContext | string) => this.enabled("cellCharts") && this.toggleCellChart(cell, "bar")),
      commands.registerCommand(RESULT_VIEW.toggleSpark, (cell?: CellContext | string) => this.enabled("cellCharts") && this.toggleCellChart(cell, "spark")),
      commands.registerCommand(RESULT_VIEW.hideColumn, (cell?: CellContext | string) => this.enabled("columnLayout") && this.hideColumn(cell)),
      commands.registerCommand(RESULT_VIEW.showColumns, () => this.enabled("columnLayout") && this.changeLayout((l) => ({ ...l, hidden: [] }))),
      commands.registerCommand(RESULT_VIEW.freezeColumns, (cell?: CellContext | string) => this.enabled("columnLayout") && this.freezeColumns(cell)),
      commands.registerCommand(RESULT_VIEW.unfreezeColumns, () => this.enabled("columnLayout") && this.changeLayout((l) => ({ ...l, frozen: 0 }))),
      commands.registerCommand(RESULT_VIEW.resetLayout, () => this.enabled("columnLayout") && this.changeLayout(() => undefined)),
      commands.registerCommand(RESULT_VIEW.saveChartPreset, (preset?: unknown) => this.enabled("chartPresets") && this.saveChartPreset(preset)),
      commands.registerCommand(RESULT_VIEW.forgetChartPreset, () => this.enabled("chartPresets") && this.forgetChartPreset()),
      commands.registerCommand(RESULT_VIEW.correlation, () => this.enabled("correlation") && this.showCorrelation()),
      commands.registerCommand(RESULT_VIEW.toNotebook, (withChart?: boolean, notebook?: Uri) => this.enabled("sendResult") && this.toNotebook(this.order[settings().resultsLocation], withChart, notebook)),
      commands.registerCommand(RESULT_VIEW.toReport, (target?: Uri, withChart?: boolean) => this.enabled("sendResult") && this.toReport(this.order[settings().resultsLocation], target, withChart)),
      window.registerWebviewViewProvider(RESULTS.view, { resolveWebviewView: (view) => this.resolveView(view) }),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.query")) {
          this.showStatus();
        }
        // New decimals apply to what is on show, and so does the heatmap.
        // Nothing else does, and a result sent again is drawn afresh, its
        // grid back at the top.
        // A result feature turned off is gone from the page at once, and
        // what it kept is dropped.
        const features = event.affectsConfiguration("q-lint.results") || event.affectsConfiguration("q-lint.query.resultHistory");
        if (features) {
          this.applyFeatures();
        }
        if (features || event.affectsConfiguration("q-lint.query.gridDecimals") || event.affectsConfiguration("q-lint.query.gridHeatmap")) {
          this.post();
        }
      }),
      { dispose: () => this.panel?.dispose() },
    );
    this.showStatus();
    this.status.show();
  }

  /// What the panel last drew, or undefined before it drew anything.
  lastRendered(): Rendered | undefined {
    return this.rendered;
  }

  /// The result on show, with the process and code it came from: what the
  /// Data Wrangler (#961) and a cell edit (#964) work from.
  current(): { process: string; code: string; payload: GridPayload } | undefined {
    const shown = this.shown;
    return shown === undefined ? undefined : { process: shown.process, code: shown.code, payload: shown.payload };
  }

  /// Where the live half fetches pages of a held result from.
  setPager(pager: (process: string, offset: number, count: number) => Promise<GridPage | string>): void {
    this.pager = pager;
  }

  /// Where the live half runs a drill-down query.
  setRunner(runner: (code: string, process: string) => Promise<void>): void {
    this.runner = runner;
  }

  /// Whether a grid query should leave a cut result on the process for
  /// paging: only while paging is on, and never on a production process.
  wantsHold(production: boolean): boolean {
    return this.viewSettings().enable.paging && !production;
  }

  /// Show a query's answer in the panel when the mode is grid or chart and
  /// the value was tabular. False when it belongs in the output instead.
  /// `held`: it was asked for with `wantsHold`, so the process holds a
  /// result cut at the limit.
  /// `inPlace`, for a watched query's next run (#914): when the result on
  /// show is of the same code and process, it is replaced under its id, so
  /// the page keeps its view, sort, filters and scroll, and no tab is added.
  show(result: { process: string; code: string; millis: number; answer: GridAnswer; held?: boolean }, live: LiveSettings, inPlace = false): boolean {
    const { answer } = result;
    if (live.mode === "console" || !answer.ok) {
      return false;
    }
    if (answer.gridError !== undefined) {
      void window.showWarningMessage(plainMessage(`q-lint: the result could not be shown as a ${live.mode}: '${answer.gridError}. It is in the output.`));
      return false;
    }
    if (answer.grid === undefined) {
      return false;
    }
    const features = this.viewSettings();
    const last = features.enable.diff ? this.previous.get(result.code) : undefined;
    const replaced = inPlace && this.shown?.code === result.code && this.shown.process === result.process ? this.shown : undefined;
    // A saved query's result keeps its look; any other starts from the
    // last run of its code.
    const saved = replaced?.saved ?? (this.expecting !== undefined && result.code.includes(this.expecting.code) ? this.expecting.name : undefined);
    const look = replaced?.look ?? (saved !== undefined ? this.savedLooks()[saved] : undefined) ?? this.looks.get(result.code) ?? {};
    const shown: Shown = {
      process: result.process,
      code: result.code,
      millis: result.millis,
      payload: answer.grid,
      view: replaced?.view ?? live.mode,
      limit: live.gridLimit,
      id: replaced?.id ?? `${this.session}.${++this.results}`,
      at: Date.now(),
      ...(last !== undefined ? { before: { payload: last.payload, process: last.process, at: last.at } } : {}),
      ...(saved !== undefined ? { saved } : {}),
      look,
    };
    if (result.held === true) {
      // The process holds one result: this one replaced any before it.
      for (const h of this.history) {
        if (h.process === result.process) {
          h.held = false;
        }
      }
      shown.held = answer.grid.count > (answer.grid.cells[0]?.length ?? 0);
    }
    // Kept by code, most recent last, so the oldest is the one dropped.
    this.previous.delete(result.code);
    this.previous.set(result.code, shown);
    if (this.previous.size > PREVIOUS_RUNS) {
      this.previous.delete(this.previous.keys().next().value as string);
    }
    const at = replaced === undefined ? -1 : this.history.indexOf(replaced);
    if (at >= 0) {
      this.history[at] = shown;
    } else {
      this.history.push(shown);
    }
    this.shown = shown;
    this.applyFeatures(features);
    if (replaced === undefined) {
      this.order.editor = undefined;
      this.order.panel = undefined;
    }
    if (replaced !== undefined && (this.panel !== undefined || this.view !== undefined)) {
      // Drawn again where it is, without taking the editor's place.
      this.post();
      return true;
    }
    if (live.resultsLocation === "panel") {
      void this.revealView();
    } else {
      this.revealPanel();
    }
    this.post();
    return true;
  }

  private viewSettings(): ResultViewSettings {
    const configuration = workspace.getConfiguration("q-lint");
    return readResultView((key, fallback) => configuration.get(key, fallback));
  }

  /// Whether the result view should ask the process for a value's tree.
  wantsTree(): boolean {
    return this.viewSettings().enable.tree;
  }

  /// Whether `feature` is on; when it is not, say so and how to turn it on.
  private enabled(feature: ResultFeature): boolean {
    if (this.viewSettings().enable[feature]) {
      return true;
    }
    void window.showInformationMessage(plainMessage(`q-lint: this result panel feature is turned off. Turn it on with the setting q-lint.results.${feature}.enable.`));
    return false;
  }

  /// Keep only what the features on need: the history to its length, and
  /// no previous runs while the diff is off.
  private applyFeatures(features = this.viewSettings()): void {
    this.history = this.history.slice(-features.history);
    if (this.shown !== undefined && !this.history.includes(this.shown)) {
      this.history.push(this.shown);
      this.history = this.history.slice(-features.history);
    }
    if (!features.enable.diff) {
      this.previous.clear();
    }
  }

  /// Whether the grid can ask the process for more of the result on show.
  private canPage(): boolean {
    const shown = this.shown;
    return shown !== undefined && shown.held === true && this.viewSettings().enable.paging && this.pager !== undefined;
  }

  /// Ask the process for the next page of the result on show, and add it
  /// to the grid. `asked`: from the command, which says why it cannot.
  private async loadMore(asked: boolean): Promise<void> {
    const shown = this.shown;
    if (shown === undefined || !this.canPage() || this.pager === undefined) {
      if (asked) {
        void window.showInformationMessage(
          plainMessage(shown === undefined
            ? "q-lint: no result yet. Run a query in grid or chart mode first."
            : "q-lint: the process holds no more of the result on show. A result is held only when it was cut at q-lint.query.gridLimit, and only until the next grid query replaces it."),
        );
      }
      return;
    }
    if (this.paging) {
      return;
    }
    const have = shown.payload.cells[0]?.length ?? 0;
    if (have >= MAX_PAGED_ROWS) {
      void window.showInformationMessage(plainMessage(`q-lint: the grid holds ${MAX_PAGED_ROWS.toLocaleString("en-US")} rows, the most it pages to. Narrow the query to see the rest.`));
      return;
    }
    this.paging = true;
    try {
      const page = await this.pager(shown.process, have, Math.min(shown.limit, MAX_PAGED_ROWS - have));
      if (typeof page === "string") {
        shown.held = false;
        void window.showWarningMessage(plainMessage(`q-lint: could not fetch more rows from ${shown.process}: ${page}`));
      } else {
        shown.payload = appendPage(shown.payload, page);
        const now = shown.payload.cells[0]?.length ?? 0;
        shown.held = now < shown.payload.count && now > have;
      }
    } catch (error) {
      shown.held = false;
      void window.showWarningMessage(plainMessage(`q-lint: could not fetch more rows from ${shown.process}: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      this.paging = false;
    }
    if (shown === this.shown) {
      this.post();
    }
  }

  /// Show a result kept in the history again, as it was drawn.
  private select(id: string | undefined): boolean {
    const chosen = this.history.find((h) => h.id === id);
    if (chosen === undefined) {
      return false;
    }
    if (chosen !== this.shown) {
      this.shown = chosen;
      this.order.editor = undefined;
      this.order.panel = undefined;
    }
    this.post();
    return true;
  }

  /// Show the result whose id is `id`, or one picked from the history.
  private async pickFromHistory(id?: string): Promise<void> {
    if (this.history.length === 0) {
      void window.showInformationMessage("q-lint: no result yet. Run a query in grid or chart mode first.");
      return;
    }
    let chosen = typeof id === "string" ? id : undefined;
    if (chosen === undefined) {
      const picked = await window.showQuickPick(
        [...this.history].reverse().map((h) => ({
          label: iconsEscaped(oneLine(h.code)),
          description: iconsEscaped(`${h.process} · ${new Date(h.at).toLocaleTimeString()}`),
          detail: `${h.payload.count.toLocaleString("en-US")} row(s)${h === this.shown ? " · on show" : ""}`,
          id: h.id,
        })),
        { title: "q-lint: show a result from the history" },
      );
      chosen = picked?.id;
    }
    if (chosen !== undefined && this.select(chosen)) {
      this.reveal();
    }
  }

  /// Ask the pages to show a view or to compare, once.
  private ask(control: Omit<Control, "key">): void {
    if (this.shown === undefined) {
      void window.showInformationMessage("q-lint: no result yet. Run a query in grid or chart mode first.");
      return;
    }
    if (control.action === "view" && control.view === "tree" && this.shown.payload.tree === undefined) {
      void window.showInformationMessage("q-lint: the result on show is not a dictionary or a nested list, so it has no tree.");
      return;
    }
    if (control.action === "compare" && this.shown.before === undefined) {
      void window.showInformationMessage("q-lint: this query has not been run before in this window, so there is nothing to compare with.");
      return;
    }
    this.control = { key: `${this.session}.${++this.controls}`, ...control };
    this.reveal();
    this.post();
  }

  private async toggleHeatmap(): Promise<void> {
    const configuration = workspace.getConfiguration("q-lint");
    const where = configuration.inspect("query.gridHeatmap");
    const target = where?.workspaceValue !== undefined ? ConfigurationTarget.Workspace : ConfigurationTarget.Global;
    await configuration.update("query.gridHeatmap", !this.viewSettings().heatmap, target);
  }

  private reveal(): void {
    if (settings().resultsLocation === "panel") {
      void this.revealView();
    } else {
      this.revealPanel();
    }
  }

  private async switchMode(mode?: string): Promise<void> {
    let chosen = QUERY_MODES.find((m) => m === mode);
    if (chosen === undefined) {
      const current = settings().mode;
      const picked = await window.showQuickPick(
        QUERY_MODES.map((m) => ({
          label: `$(${MODE_ICONS[m]}) ${m[0].toUpperCase()}${m.slice(1)}`,
          description: m === current ? "current" : undefined,
          detail: MODE_DETAILS[m],
          mode: m,
        })),
        { title: "q-lint: query mode" },
      );
      chosen = picked?.mode;
    }
    if (chosen === undefined) {
      return;
    }
    // Set where it is set already, so a workspace's choice is not shadowed.
    const configuration = workspace.getConfiguration("q-lint");
    const where = configuration.inspect("query.mode");
    const target = where?.workspaceValue !== undefined ? ConfigurationTarget.Workspace : ConfigurationTarget.Global;
    await configuration.update("query.mode", chosen, target);
    this.showStatus();
  }

  private showStatus(): void {
    const mode = settings().mode;
    this.status.text = `$(${MODE_ICONS[mode]}) ${mode}`;
    this.status.tooltip = `q-lint query mode: ${mode}. Click to switch.`;
  }

  private revealPanel(): void {
    if (this.panel !== undefined) {
      this.panel.reveal(undefined, true);
      return;
    }
    const panel = window.createWebviewPanel(
      "q-lint.result",
      "q-lint: result",
      { viewColumn: ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [this.media] },
    );
    this.panel = panel;
    panel.webview.html = resultHtml(panel.webview, this.media, "editor");
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    panel.webview.onDidReceiveMessage((message: PageMessage) => this.receive("editor", panel.webview, message));
  }

  /// Show the q Results view without taking focus from the editor. The
  /// first time, only its focus command opens it, and it resolves then.
  private async revealView(): Promise<void> {
    if (this.view !== undefined) {
      this.view.show(true);
      return;
    }
    const editor = window.activeTextEditor;
    await commands.executeCommand(`${RESULTS.view}.focus`);
    // No selection: one given would replace every cursor, and scroll to it.
    if (editor !== undefined) {
      await window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
    }
  }

  private resolveView(view: WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    view.webview.html = resultHtml(view.webview, this.media, "panel");
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.webview.onDidReceiveMessage((message: PageMessage) => this.receive("panel", view.webview, message));
  }

  private receive(location: ResultsLocation, webview: Webview, message: PageMessage): void {
    // What a page says of a result no longer on show - sent before the
    // next one reached it - would apply its rows to the next one's.
    const current = this.shown !== undefined && message.id === this.shown.id;
    if (message.type === "ready") {
      // Also after the page was hidden and shown again, which reloads it.
      this.post(webview);
    } else if (message.type === "select") {
      // A tab: any result kept, not only the one on show.
      this.select(message.pick);
    } else if (message.type === "heatmap") {
      if (this.enabled("heatmap")) {
        void this.toggleHeatmap();
      }
    } else if (!current) {
      return;
    } else if (message.type === "look") {
      // A layout the page changed: a column moved or resized (#1015).
      const layout = parseLayout(message.layout);
      if (this.viewSettings().enable.columnLayout && layout !== undefined && this.shown !== undefined) {
        this.shown.look = { ...this.shown.look, layout };
        void this.keepLook(this.shown);
      }
    } else if (message.type === "chartPreset") {
      const preset = parsePreset(message.preset);
      if (this.enabled("chartPresets") && preset !== undefined && this.shown !== undefined) {
        this.presets.set(this.shown.id, preset);
        void this.saveChartPreset();
      }
    } else if (message.type === "send") {
      if (this.enabled("sendResult")) {
        void this.sendPicked(message.rows);
      }
    } else if (message.type === "rendered" && message.rendered !== undefined) {
      const preset = parsePreset(message.rendered.preset);
      if (preset !== undefined && this.shown !== undefined) {
        this.presets.set(this.shown.id, preset);
      }
      // Both may be open, after the location changed: the API reports the
      // one results now go to.
      if (location === settings().resultsLocation) {
        this.rendered = { location, ...message.rendered };
      }
      this.order[location] = Array.isArray(message.rows) ? message.rows : undefined;
    } else if (message.type === "copy") {
      void this.copy(message.rows);
    } else if (message.type === "export") {
      void this.exportCsv(undefined, message.rows);
    } else if (message.type === "exportAs") {
      if (this.enabled("export")) {
        void this.exportAs(message.format, undefined, message.rows);
      }
    } else if (message.type === "copyAs") {
      if (this.enabled("export")) {
        void this.copyAs(message.format, message.rows);
      }
    } else if (message.type === "copyText" && typeof message.text === "string") {
      void env.clipboard.writeText(message.text);
    } else if (message.type === "more") {
      void this.loadMore(false);
    } else if (message.type === "image" && message.key !== undefined && this.images.has(message.key)) {
      // A chart asked for to send to a notebook or a report.
      const resolve = this.images.get(message.key);
      this.images.delete(message.key);
      resolve?.(typeof message.data === "string" && message.data !== "" ? message.data : undefined);
    } else if (message.type === "image") {
      if (this.viewSettings().enable.charts) {
        void this.saveImage(message);
      }
    } else if (message.type === "drill") {
      if (this.enabled("drilldown")) {
        void this.drill(message.column, message.row);
      }
    } else if (message.type === "plotted") {
      // Every chart drawn goes to the q Plots view (#970), from the page
      // results go to: with both open, each would draw it.
      if (this.viewSettings().enable.plots && location === settings().resultsLocation && typeof message.format === "string" && plainSvg(message.data) && this.shown !== undefined) {
        PLOTS.add({ key: `${this.shown.id}/${message.format}`, process: this.shown.process, code: this.shown.code, kind: message.format, svg: message.data, at: Date.now() });
      }
    }
  }

  /// The format `format` names, or one the user picks of `formats`.
  private async pickFormat(format: string | undefined, formats: readonly ExportFormat[], title: string): Promise<ExportFormat | undefined> {
    const named = formats.find((f) => f === format);
    if (named !== undefined) {
      return named;
    }
    const picked = await window.showQuickPick(
      formats.map((f) => ({ label: FORMAT_INFO[f].label, description: `.${FORMAT_INFO[f].extension}`, detail: FORMAT_INFO[f].detail, format: f })),
      { title },
    );
    return picked?.format;
  }

  /// The rows of the result on show to write: `rows` when they are rows
  /// of it, and otherwise all of them.
  private rowsOf(rows: number[] | undefined): number[] | undefined {
    const held = this.shown?.payload.cells[0]?.length ?? 0;
    return Array.isArray(rows) ? rows.filter((r) => Number.isInteger(r) && r >= 0 && r < held) : undefined;
  }

  /// The conditional formats an export of `shown` keeps: none while they
  /// are off (#1013).
  private rulesOf(shown: Shown): FormatRule[] {
    return this.viewSettings().enable.conditionalFormats ? (shown.look.rules ?? []) : [];
  }

  /// Write the rows shown in `format` (or one picked) to `target`, or to a
  /// file the user picks.
  private async exportAs(format: string | undefined, target: Uri | undefined, rows: number[] | undefined): Promise<void> {
    const shown = this.shown;
    if (shown === undefined) {
      void window.showInformationMessage("q-lint: no result to export. Run a query in grid or chart mode first.");
      return;
    }
    const chosen = await this.pickFormat(format, EXPORT_FORMATS, "q-lint: export the result as");
    if (chosen === undefined) {
      return;
    }
    const info = FORMAT_INFO[chosen];
    const folder = workspace.workspaceFolders?.[0]?.uri;
    const to =
      target instanceof Uri
        ? target
        : await window.showSaveDialog({
            title: `Export the result as ${info.label}`,
            defaultUri: folder === undefined ? undefined : Uri.joinPath(folder, `result.${info.extension}`),
            filters: { [info.label]: [info.extension] },
          });
    if (to === undefined) {
      return;
    }
    let out;
    try {
      out = exportResult(chosen, shown.payload, settings().gridDecimals, this.rowsOf(rows), this.rulesOf(shown));
      await workspace.fs.writeFile(to, out.data);
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const notes = out.notes.length > 0 ? ` Note: ${out.notes.join("; ")}.` : "";
    if (!(target instanceof Uri) || notes !== "") {
      void window.showInformationMessage(plainMessage(`q-lint: exported ${out.rows} row(s) as ${info.label} to ${to.fsPath}.${notes}`));
    }
  }

  /// Copy the rows shown as JSON, Markdown or q (or a format picked).
  private async copyAs(format: string | undefined, rows: number[] | undefined): Promise<void> {
    const shown = this.shown;
    if (shown === undefined) {
      void window.showInformationMessage("q-lint: no result to copy. Run a query in grid or chart mode first.");
      return;
    }
    const chosen = await this.pickFormat(format, EXPORT_FORMATS.filter((f) => FORMAT_INFO[f].text), "q-lint: copy the result as");
    if (chosen === undefined) {
      return;
    }
    const out = exportResult(chosen, shown.payload, settings().gridDecimals, this.rowsOf(rows), this.rulesOf(shown));
    await env.clipboard.writeText(out.data.toString("utf8"));
    const notes = out.notes.length > 0 ? ` Note: ${out.notes.join("; ")}.` : "";
    void window.showInformationMessage(plainMessage(`q-lint: copied ${out.rows} row(s) as ${FORMAT_INFO[chosen].label}.${notes}`));
  }

  /// Ask the page for the chart as `format` (or one picked), and save it
  /// to `target` or a file the user picks once it arrives.
  private async saveChart(format: string | undefined, target: Uri | undefined): Promise<void> {
    let chosen: "png" | "svg" | undefined = format === "png" || format === "svg" ? format : undefined;
    if (chosen === undefined && this.shown !== undefined) {
      const picked = await window.showQuickPick(
        [
          { label: "PNG", detail: "The chart as drawn, on the editor's background", format: "png" as const },
          { label: "SVG", detail: "The chart as vector graphics, for a document or a slide", format: "svg" as const },
        ],
        { title: "q-lint: save the chart as" },
      );
      chosen = picked?.format;
      if (chosen === undefined) {
        return;
      }
    }
    const before = this.controls;
    await new Promise<void>((resolve) => {
      this.ask({ action: "image", format: chosen ?? "png" });
      if (this.controls === before) {
        // Refused: there is no chart to save.
        resolve();
        return;
      }
      const key = `${this.session}.${this.controls}`;
      this.saving.set(key, { target, resolve });
      // A page that never answers (closed) does not keep the command waiting.
      setTimeout(() => {
        if (this.saving.get(key)?.resolve === resolve) {
          this.saving.delete(key);
          resolve();
        }
      }, 10000);
    });
  }

  /// Save the chart a page sent: to the target Save Result Chart was given,
  /// or to a file the user picks.
  private async saveImage(message: PageMessage): Promise<void> {
    const format = message.format === "svg" ? "svg" : message.format === "png" ? "png" : undefined;
    const data = message.data ?? "";
    const prefix = "data:image/png;base64,";
    const bytes =
      format === "png" && data.startsWith(prefix)
        ? Buffer.from(data.slice(prefix.length), "base64")
        : format === "svg" && data.startsWith("<svg")
          ? Buffer.from(data, "utf8")
          : undefined;
    const request = message.key !== undefined ? this.saving.get(message.key) : undefined;
    if (request !== undefined && message.key !== undefined) {
      this.saving.delete(message.key);
    }
    try {
      if (format === undefined || bytes === undefined) {
        if (request !== undefined) {
          void window.showInformationMessage("q-lint: the result on show draws no chart, so there is nothing to save. Its Chart view says why.");
        }
        return;
      }
      const folder = workspace.workspaceFolders?.[0]?.uri;
      const to =
        request?.target instanceof Uri
          ? request.target
          : await window.showSaveDialog({
              title: `Save the chart as ${format.toUpperCase()}`,
              defaultUri: folder === undefined ? undefined : Uri.joinPath(folder, `chart.${format}`),
              filters: { [format.toUpperCase()]: [format] },
            });
      if (to === undefined) {
        return;
      }
      try {
        await workspace.fs.writeFile(to, bytes);
      } catch (error) {
        void window.showErrorMessage(plainMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (!(request?.target instanceof Uri)) {
        void window.showInformationMessage(plainMessage(`q-lint: saved the chart to ${to.fsPath}.`));
      }
    } finally {
      request?.resolve();
    }
  }

  /// Offer the drill-down templates for the cell at `column`, `row` of the
  /// result on show, and run the one picked on the process it came from.
  private async drill(column: unknown, row: unknown): Promise<void> {
    const shown = this.shown;
    if (shown === undefined || typeof column !== "number" || typeof row !== "number") {
      void window.showInformationMessage("q-lint: double-click a cell of the result grid, or right-click it, to drill down from it.");
      return;
    }
    const name = shown.payload.names[column];
    if (name === undefined) {
      return;
    }
    const templates = templatesFor(this.viewSettings().drilldown, name);
    if (templates.length === 0) {
      const open = await window.showInformationMessage(
        plainMessage(`q-lint: no drill-down query for column ${name}. Add one to q-lint.results.drilldownTemplates, with {{value}} where the cell's value goes.`),
        "Open Settings",
      );
      if (open === "Open Settings") {
        void commands.executeCommand("workbench.action.openSettings", "q-lint.results.drilldownTemplates");
      }
      return;
    }
    const items = templates.map((t) => {
      const filled = fillDrilldown(t.query, shown.payload, column, row);
      return { label: t.label, detail: "code" in filled ? filled.code : `Cannot run: ${filled.error}`, filled };
    });
    const picked = await window.showQuickPick(items, { title: `q-lint: drill down from ${name} on ${shown.process}`, matchOnDetail: true });
    if (picked === undefined) {
      return;
    }
    if ("error" in picked.filled) {
      void window.showWarningMessage(plainMessage(`q-lint: ${picked.label} cannot run: ${picked.filled.error}.`));
      return;
    }
    if (this.runner === undefined) {
      return;
    }
    await this.runner(picked.filled.code, shown.process);
  }

  /// While the saved query `name` runs as `code`, its result is taken for
  /// that query's (#1015, #1019); undefined when it is done.
  expectSaved(name: string | undefined, code?: string): void {
    this.expecting = name === undefined || code === undefined ? undefined : { name, code };
  }

  /// The looks the saved queries keep.
  private savedLooks(): Record<string, ResultLook> {
    return parseLooks(this.context.workspaceState.get<unknown>(SAVED_LOOKS_KEY, {}));
  }

  /// Which parts of a look the features on keep.
  private lookOn(features = this.viewSettings()): LookParts {
    return { rules: features.enable.conditionalFormats, cellCharts: features.enable.cellCharts, layout: features.enable.columnLayout, chart: features.enable.chartPresets };
  }

  /// Keep `shown`'s look for its code's next run and, when it came from a
  /// saved query, for that query: the parts whose feature is on as they
  /// are now, the others as kept before. `chart`: the chart preset to keep
  /// with the query, null to forget it; as kept when undefined.
  private async keepLook(shown: Shown, chart?: ChartPreset | null): Promise<void> {
    this.looks.delete(shown.code);
    this.looks.set(shown.code, shown.look);
    if (this.looks.size > PREVIOUS_RUNS) {
      this.looks.delete(this.looks.keys().next().value as string);
    }
    if (shown.saved === undefined) {
      return;
    }
    const on = this.lookOn();
    const looks = this.savedLooks();
    const before = looks[shown.saved] ?? {};
    const kept: ResultLook = {
      ...lookParts(before, { rules: !on.rules, cellCharts: !on.cellCharts, layout: !on.layout, chart: chart === undefined }),
      ...lookParts(shown.look, { ...on, chart: false }),
      ...(chart ? { chart } : {}),
    };
    await this.context.workspaceState.update(SAVED_LOOKS_KEY, withLook(looks, shown.saved, kept));
  }

  /// The result on show, its grid, and the column a column command names:
  /// by place (the header's menu) or by name, or one the user picks of
  /// those `fits` accepts.
  private async columnOf(cell: CellContext | string | undefined, title: string, fits: (grid: Grid, c: number) => boolean = () => true): Promise<{ shown: Shown; grid: Grid; column: number } | undefined> {
    const shown = this.shown;
    if (shown === undefined) {
      void window.showInformationMessage("q-lint: no result yet. Run a query in grid or chart mode first.");
      return undefined;
    }
    const grid = toGrid(shown.payload, settings().gridDecimals);
    let column = typeof cell === "string" ? grid.columns.findIndex((c) => c.name === cell) : typeof cell?.column === "number" ? cell.column : undefined;
    if (column === undefined) {
      const items = grid.columns.map((c, i) => ({ label: c.name, description: c.typeName, column: i })).filter((item) => fits(grid, item.column));
      if (items.length === 0) {
        void window.showInformationMessage("q-lint: no column of the result on show fits.");
        return undefined;
      }
      column = (await window.showQuickPick(items, { title }))?.column;
      if (column === undefined) {
        return undefined;
      }
    }
    if (column < 0 || column >= grid.columns.length || !fits(grid, column)) {
      void window.showInformationMessage("q-lint: that column of the result on show does not fit.");
      return undefined;
    }
    return { shown, grid, column };
  }

  /// Change the look of the result on show, keep it, and draw it again.
  private async relook(shown: Shown, look: ResultLook): Promise<void> {
    shown.look = look;
    await this.keepLook(shown);
    if (shown === this.shown) {
      this.post();
    }
  }

  /// Add a conditional format to a column (#1013): the rule given, or one
  /// built from picks - the comparison, the value, the style.
  private async addFormat(cell: CellContext | string | undefined, given: unknown): Promise<void> {
    const at = await this.columnOf(cell, "Add a conditional format to which column?");
    if (at === undefined) {
      return;
    }
    const column = at.grid.columns[at.column];
    const numeric = column.numeric;
    let rule: FormatRule | undefined = given !== null && typeof given === "object" ? parseRule({ ...(given as object), column: column.name }) : undefined;
    if (rule !== undefined && !numeric && !TEXT_OPS.includes(rule.op)) {
      rule = undefined;
    }
    if (rule === undefined) {
      if (given !== undefined) {
        void window.showWarningMessage(plainMessage(`q-lint: that is not a rule ${column.name} can take.`));
        return;
      }
      const op = await window.showQuickPick(
        (numeric ? RULE_OPS : TEXT_OPS).map((o) => ({ label: o === "top" || o === "bottom" ? o : o === "contains" ? "contains" : o, description: OP_LABELS[o], op: o })),
        { title: `Conditional format on ${column.name}: when the value is` },
      );
      if (op === undefined) {
        return;
      }
      const text = await window.showInputBox({
        title: `Conditional format on ${column.name}: ${OP_LABELS[op.op]}`,
        prompt: op.op === "top" || op.op === "bottom" ? "How many values" : numeric && op.op !== "contains" ? "A number" : "The text, as the cell shows it",
        validateInput: (v) => ruleValueProblem(op.op, v, numeric),
      });
      if (text === undefined) {
        return;
      }
      const style = await window.showQuickPick(RULE_STYLES, { title: `Conditional format on ${column.name}: style` });
      if (style === undefined) {
        return;
      }
      rule = { column: column.name, op: op.op, value: ruleValue(op.op, text, numeric), style: style.style };
    }
    await this.relook(at.shown, withRule(at.shown.look, rule));
  }

  /// Drop a column's conditional formats.
  private async clearFormats(cell: CellContext | string | undefined): Promise<void> {
    const shown = this.shown;
    const ruled = (grid: Grid, c: number): boolean => (shown?.look.rules ?? []).some((r) => r.column === grid.columns[c].name);
    const at = await this.columnOf(cell, "Clear the conditional formats of which column?", ruled);
    if (at !== undefined) {
      await this.relook(at.shown, withoutRules(at.shown.look, at.grid.columns[at.column].name));
    }
  }

  /// Draw a numeric column as data bars, or not; draw a column of numeric
  /// lists as sparklines (as it is by default), or as text (#1014).
  private async toggleCellChart(cell: CellContext | string | undefined, chart: "bar" | "spark"): Promise<void> {
    const fits = chart === "bar" ? (grid: Grid, c: number) => grid.columns[c].numeric : (grid: Grid, c: number) => GRID_LOOK.isNumericList(grid, c);
    const at = await this.columnOf(cell, chart === "bar" ? "Toggle data bars on which numeric column?" : "Toggle sparklines on which column of numeric lists?", fits);
    if (at === undefined) {
      return;
    }
    const name = at.grid.columns[at.column].name;
    const now = at.shown.look.cellCharts?.[name];
    const next = chart === "bar" ? (now === "bar" ? undefined : "bar") : now === "text" ? undefined : "text";
    await this.relook(at.shown, withCellChart(at.shown.look, name, next));
  }

  /// Change the column layout of the result on show (#1015); undefined
  /// drops it.
  private async changeLayout(change: (layout: ColumnLayout) => ColumnLayout | undefined): Promise<void> {
    const shown = this.shown;
    if (shown === undefined) {
      void window.showInformationMessage("q-lint: no result yet. Run a query in grid or chart mode first.");
      return;
    }
    const next = change(shown.look.layout ?? { order: [], hidden: [], widths: {}, frozen: 0 });
    const look = { ...shown.look };
    if (next === undefined) {
      delete look.layout;
    } else {
      look.layout = next;
    }
    await this.relook(shown, look);
  }

  private async hideColumn(cell: CellContext | string | undefined): Promise<void> {
    const at = await this.columnOf(cell, "Hide which column?");
    if (at === undefined) {
      return;
    }
    const layout = at.shown.look.layout ?? { order: [], hidden: [], widths: {}, frozen: 0 };
    if (GRID_LOOK.displayColumns(at.grid, layout).length <= 1) {
      void window.showInformationMessage("q-lint: the grid shows one column; it is not hidden.");
      return;
    }
    const name = at.grid.columns[at.column].name;
    await this.changeLayout((l) => ({ ...l, hidden: l.hidden.includes(name) ? l.hidden : [...l.hidden, name] }));
  }

  /// Freeze the columns drawn up to and with this one.
  private async freezeColumns(cell: CellContext | string | undefined): Promise<void> {
    const at = await this.columnOf(cell, "Freeze the columns up to which?");
    if (at === undefined) {
      return;
    }
    const place = GRID_LOOK.displayColumns(at.grid, at.shown.look.layout).indexOf(at.column);
    if (place >= 0) {
      await this.changeLayout((l) => ({ ...l, frozen: place + 1 }));
    }
  }

  /// Keep the chart the page drew - or `given`, a preset as a keybinding
  /// passes it - with the saved query the result came from (#1019); a
  /// result of no saved query is offered Save Query first.
  private async saveChartPreset(given?: unknown): Promise<void> {
    const shown = this.shown;
    if (shown === undefined) {
      void window.showInformationMessage("q-lint: no result yet. Run a query in grid or chart mode first.");
      return;
    }
    const preset = (given !== undefined ? parsePreset(given) : undefined) ?? this.presets.get(shown.id);
    if (preset === undefined) {
      void window.showInformationMessage("q-lint: draw the result's chart first: open its Chart view, then save it with the query.");
      return;
    }
    if (shown.saved === undefined) {
      const save = "Save Query...";
      if ((await window.showInformationMessage("q-lint: the result is not from a saved query. Save its query to Saved Queries, with this chart?", save)) !== save) {
        return;
      }
      const names = (): string[] => parseSaved(this.context.workspaceState.get<unknown>(SAVED_QUERIES_KEY, [])).map((q) => q.name);
      const before = names();
      await commands.executeCommand(SAVED_QUERIES.save, { code: shown.code });
      const added = names().find((n) => !before.includes(n));
      if (added === undefined) {
        return;
      }
      shown.saved = added;
    }
    shown.look = { ...shown.look, chart: preset };
    await this.keepLook(shown, preset);
    void window.showInformationMessage(plainMessage(`q-lint: the chart is kept with the saved query "${shown.saved}": running it draws this chart again.`));
  }

  private async forgetChartPreset(): Promise<void> {
    const shown = this.shown;
    if (shown?.saved === undefined || this.savedLooks()[shown.saved]?.chart === undefined) {
      void window.showInformationMessage("q-lint: the result on show has no chart kept with a saved query.");
      return;
    }
    const look = { ...shown.look };
    delete look.chart;
    shown.look = look;
    await this.keepLook(shown, null);
    void window.showInformationMessage(plainMessage(`q-lint: forgot the chart kept with "${shown.saved}".`));
  }

  private showCorrelation(): void {
    const shown = this.shown;
    if (shown !== undefined && toGrid(shown.payload, -1).columns.filter((c) => c.numeric && !c.key).length < 2) {
      void window.showInformationMessage("q-lint: the result on show has fewer than two numeric columns, so there is nothing to correlate.");
      return;
    }
    this.ask({ action: "view", view: "corr" });
  }

  /// Ask the page for the chart as `format`: a PNG data URL or SVG text,
  /// or undefined when it draws none or does not answer.
  private chartImage(format: "png" | "svg"): Promise<string | undefined> {
    return new Promise((resolve) => {
      const before = this.controls;
      this.ask({ action: "image", format });
      if (this.controls === before) {
        resolve(undefined);
        return;
      }
      const key = `${this.session}.${this.controls}`;
      this.images.set(key, resolve);
      setTimeout(() => {
        if (this.images.delete(key)) {
          resolve(undefined);
        }
      }, 10000);
    });
  }

  /// Whether to send the chart too: `withChart` when given, or picked.
  private async askChart(withChart: boolean | undefined, where: string): Promise<boolean | undefined> {
    if (typeof withChart === "boolean") {
      return withChart;
    }
    const picked = await window.showQuickPick(
      [
        { label: "Table", detail: "The rows shown, as a Markdown table, under the query", chart: false },
        { label: "Table and chart", detail: "The table, and the chart as the Chart view draws it, as an image", chart: true },
      ],
      { title: `q-lint: send the result to ${where}` },
    );
    return picked?.chart;
  }

  /// The page's Send to...: a notebook or a report, picked.
  private async sendPicked(rows: number[] | undefined): Promise<void> {
    const picked = await window.showQuickPick(
      [
        { label: "q Notebook", detail: "Insert the result as a Markdown cell into an open q notebook", to: "notebook" as const },
        { label: "Markdown Report...", detail: "Append the result to a Markdown file you pick", to: "report" as const },
      ],
      { title: "q-lint: send the result to" },
    );
    if (picked?.to === "notebook") {
      await this.toNotebook(rows, undefined, undefined);
    } else if (picked?.to === "report") {
      await this.toReport(rows, undefined, undefined);
    }
  }

  /// Insert the result on show into a q notebook as a Markdown cell
  /// (#1021): after the selected cell of the q notebook in view (one picked
  /// when several are), or at the end of the one given or open.
  private async toNotebook(rows: number[] | undefined, withChart: boolean | undefined, given: Uri | undefined): Promise<void> {
    const shown = this.shown;
    if (shown === undefined) {
      void window.showInformationMessage("q-lint: no result to send. Run a query in grid or chart mode first.");
      return;
    }
    const editors = window.visibleNotebookEditors.filter((e) => e.notebook.notebookType === NOTEBOOK.type);
    const documents = workspace.notebookDocuments.filter((n) => n.notebookType === NOTEBOOK.type);
    let editor = given === undefined && editors.length === 1 ? editors[0] : undefined;
    let notebook = given !== undefined ? documents.find((n) => n.uri.toString() === given.toString()) : editor?.notebook;
    if (notebook === undefined && given === undefined) {
      const choices: { label: string; description: string; editor: NotebookEditor | undefined; notebook: NotebookDocument }[] =
        editors.length > 1
          ? editors.map((e) => ({ label: e.notebook.uri.path.replace(/^.*\//, ""), description: e.notebook.uri.fsPath, editor: e, notebook: e.notebook }))
          : documents.map((n) => ({ label: n.uri.path.replace(/^.*\//, ""), description: n.uri.fsPath, editor: undefined, notebook: n }));
      const picked = choices.length === 1 ? choices[0] : choices.length > 1 ? await window.showQuickPick(choices, { title: "q-lint: insert the result into which q notebook?" }) : undefined;
      if (choices.length === 0) {
        void window.showInformationMessage("q-lint: open a q notebook (.qnb) to send the result to.");
        return;
      }
      editor = picked?.editor;
      notebook = picked?.notebook;
    }
    if (notebook === undefined) {
      if (given !== undefined) {
        void window.showInformationMessage(plainMessage(`q-lint: ${given.fsPath} is not an open q notebook.`));
      }
      return;
    }
    const chart = await this.askChart(withChart, "the notebook");
    if (chart === undefined) {
      return;
    }
    const image = chart ? await this.chartImage("png") : undefined;
    const text = resultMarkdown({ process: shown.process, code: shown.code, at: shown.at, payload: shown.payload, rows: this.rowsOf(rows), decimals: settings().gridDecimals }, image !== undefined && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) ? image : undefined);
    const at = editor !== undefined && editor.selections.length > 0 ? Math.min(editor.selections[editor.selections.length - 1].end, notebook.cellCount) : notebook.cellCount;
    const edit = new WorkspaceEdit();
    edit.set(notebook.uri, [NotebookEdit.insertCells(at, [new NotebookCellData(NotebookCellKind.Markup, text.text.replace(/\n+$/, "\n"), "markdown")])]);
    if (!(await workspace.applyEdit(edit))) {
      void window.showErrorMessage(plainMessage(`q-lint: could not insert the result into ${notebook.uri.fsPath}.`));
      return;
    }
    const lost = chart && image === undefined ? " The chart was left out: the result draws none." : "";
    void window.showInformationMessage(plainMessage(`q-lint: inserted ${text.rows} row(s) into ${notebook.uri.path.replace(/^.*\//, "")} as cell ${at + 1}.${lost}`));
  }

  /// Append the result on show to a Markdown report (#1021): `target`, or
  /// the last report, a file picked, or a new one. It says what it will
  /// write and asks first; the report's text is kept and the result added
  /// after it, and the chart goes to a new file beside it, never over one.
  private async toReport(rows: number[] | undefined, target: Uri | undefined, withChart: boolean | undefined): Promise<void> {
    const shown = this.shown;
    if (shown === undefined) {
      void window.showInformationMessage("q-lint: no result to send. Run a query in grid or chart mode first.");
      return;
    }
    let to = target instanceof Uri ? target : undefined;
    if (to === undefined) {
      const last = this.context.workspaceState.get<string>(LAST_REPORT_KEY);
      const folder = workspace.workspaceFolders?.[0]?.uri;
      const picked = await window.showQuickPick(
        [
          ...(typeof last === "string" ? [{ label: `Append to ${Uri.parse(last).path.replace(/^.*\//, "")}`, detail: Uri.parse(last).fsPath, how: "last" as const }] : []),
          { label: "Choose a Markdown File...", detail: "Append to a report that exists", how: "open" as const },
          { label: "New Report File...", detail: "Start a report", how: "new" as const },
        ],
        { title: "q-lint: append the result to which report?" },
      );
      if (picked === undefined) {
        return;
      }
      if (picked.how === "last" && typeof last === "string") {
        to = Uri.parse(last);
      } else if (picked.how === "open") {
        to = (await window.showOpenDialog({ title: "Append the result to", canSelectMany: false, filters: { Markdown: ["md", "markdown"] }, defaultUri: folder }))?.[0];
      } else {
        to = await window.showSaveDialog({ title: "New report", filters: { Markdown: ["md"] }, defaultUri: folder === undefined ? undefined : Uri.joinPath(folder, "report.md") });
      }
      if (to === undefined) {
        return;
      }
    }
    const chart = await this.askChart(withChart, "the report");
    if (chart === undefined) {
      return;
    }
    let existing: Uint8Array | undefined;
    try {
      existing = await workspace.fs.readFile(to);
    } catch {
      existing = undefined;
    }
    const svg = chart ? await this.chartImage("svg") : undefined;
    const folder = Uri.joinPath(to, "..");
    let relative: string | undefined;
    if (svg !== undefined && svg.startsWith("<svg")) {
      const base = to.path.replace(/^.*\//, "").replace(/\.[^.]*$/, "") || "report";
      let names: string[] = [];
      try {
        names = (await workspace.fs.readDirectory(Uri.joinPath(folder, `${base}-images`))).map(([name]) => `${base}-images/${name}`);
      } catch {
        names = [];
      }
      relative = imagePath(to.path, Date.now(), (r) => names.includes(r));
    }
    const text = resultMarkdown({ process: shown.process, code: shown.code, at: shown.at, payload: shown.payload, rows: this.rowsOf(rows), decimals: settings().gridDecimals }, relative === undefined ? undefined : linkTarget(relative));
    const before = existing === undefined ? "" : Buffer.from(existing).toString("utf8");
    const gap = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const name = to.path.replace(/^.*\//, "");
    const lines = text.text.split("\n");
    const preview = lines.slice(0, 14).join("\n") + (lines.length > 14 ? `\n... ${lines.length - 14} more line(s)` : "");
    const go = existing === undefined ? "Create" : "Append";
    const asked = await window.showWarningMessage(
      plainMessage(existing === undefined ? `Create ${name} with the result?` : `Append the result to ${name}?`),
      {
        modal: true,
        detail: `${existing === undefined ? "A new file" : "Added after its last line; nothing in it is changed"}: ${text.rows} row(s) from ${shown.process}${relative !== undefined ? `, and the chart as a new file, ${relative}` : ""}.\n\n${preview}`,
      },
      go,
    );
    if (asked !== go) {
      return;
    }
    try {
      if (relative !== undefined && svg !== undefined) {
        const image = Uri.joinPath(folder, ...relative.split("/"));
        await workspace.fs.createDirectory(Uri.joinPath(image, ".."));
        await workspace.fs.writeFile(image, Buffer.from(svg, "utf8"));
      }
      await workspace.fs.writeFile(to, Buffer.from(before + gap + text.text, "utf8"));
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    await this.context.workspaceState.update(LAST_REPORT_KEY, to.toString());
    const lost = chart && relative === undefined ? " The chart was left out: the result draws none." : "";
    void window.showInformationMessage(plainMessage(`q-lint: ${existing === undefined ? "wrote" : "appended"} ${text.rows} row(s) to ${to.fsPath}.${lost}`));
  }

  /// Send what is shown to `only`, or to every open page. A page still
  /// loading drops it, and asks again once it is ready.
  private post(only?: Webview): void {
    if (this.shown === undefined) {
      return;
    }
    const { process, code, millis, payload, view, limit, id } = this.shown;
    const live = settings();
    const features = this.viewSettings();
    const before = features.enable.diff ? this.shown.before : undefined;
    const tree = features.enable.tree ? payload.tree : undefined;
    const grid = toGrid(payload, live.gridDecimals);
    let diff: (GridDiff & { process: string; at: number }) | undefined;
    if (before !== undefined) {
      diff = { process: before.process, at: before.at, ...diffGrids(toGrid(before.payload, live.gridDecimals), grid) };
    }
    const message = {
      type: "result",
      id,
      view,
      process,
      code,
      millis,
      limit,
      grid,
      tree,
      diff,
      heatmap: features.heatmap,
      features: {
        statistics: features.enable.statistics,
        heatmap: features.enable.heatmap,
        export: features.enable.export,
        pivot: features.enable.pivot,
        charts: features.enable.charts,
        drilldown: features.enable.drilldown,
        wrangler: features.enable.wrangler,
        editCells: features.enable.editCells,
        plots: features.enable.plots,
        columnFormats: features.enable.columnFormats,
        conditionalFormats: features.enable.conditionalFormats,
        cellCharts: features.enable.cellCharts,
        columnLayout: features.enable.columnLayout,
        depthChart: features.enable.depthChart,
        mapChart: features.enable.mapChart,
        linkedCharts: features.enable.linkedCharts,
        chartPresets: features.enable.chartPresets,
        correlation: features.enable.correlation,
        sendResult: features.enable.sendResult,
        accessibleGrid: features.enable.accessibleGrid,
        announce: features.enable.announce,
      },
      // The look of the features on, and the saved query it came from.
      look: lookParts(this.shown.look, this.lookOn(features)),
      saved: this.shown.saved,
      // Whether the grid can ask for more rows as it scrolls.
      more: this.canPage(),
      history: (features.enable.history ? this.history : [this.shown]).map((h) => ({ id: h.id, process: h.process, code: oneLine(h.code), at: h.at, rows: h.payload.count })),
      control: this.control,
    };
    void commands.executeCommand("setContext", RESULT_CONTEXT.shown, true);
    void commands.executeCommand("setContext", RESULT_CONTEXT.hasPrevious, before !== undefined);
    void commands.executeCommand("setContext", RESULT_CONTEXT.hasTree, tree !== undefined);
    void commands.executeCommand("setContext", RESULT_CONTEXT.hasMore, this.canPage());
    const pages = only !== undefined ? [only] : [this.panel?.webview, this.view?.webview];
    for (const page of pages) {
      void page?.postMessage(message);
    }
  }

  /// The grid on show and the rows of it to write: `rows` when they are
  /// rows of it, and otherwise all of them.
  private chosen(rows: number[] | undefined): { csv: string; count: number } | undefined {
    if (this.shown === undefined) {
      return undefined;
    }
    const grid = toGrid(this.shown.payload, settings().gridDecimals);
    const order = Array.isArray(rows) ? rows.filter((r) => Number.isInteger(r) && r >= 0 && r < rowCount(grid)) : undefined;
    return { csv: toCsv(grid, order), count: order?.length ?? rowCount(grid) };
  }

  private async copy(rows: number[] | undefined): Promise<void> {
    const chosen = this.chosen(rows);
    if (chosen === undefined) {
      return;
    }
    await env.clipboard.writeText(chosen.csv);
    void window.showInformationMessage(plainMessage(`q-lint: copied ${chosen.count} row(s) as CSV.`));
  }

  /// Write the rows shown as CSV to `target`, or to a file the user picks.
  private async exportCsv(target: Uri | undefined, rows: number[] | undefined): Promise<void> {
    const chosen = this.chosen(rows);
    if (chosen === undefined) {
      void window.showInformationMessage("q-lint: no result to export. Run a query in grid or chart mode first.");
      return;
    }
    const folder = workspace.workspaceFolders?.[0]?.uri;
    const to =
      target instanceof Uri
        ? target
        : await window.showSaveDialog({
            title: "Export the result as CSV",
            defaultUri: folder === undefined ? undefined : Uri.joinPath(folder, "result.csv"),
            filters: { CSV: ["csv"] },
          });
    if (to === undefined) {
      return;
    }
    try {
      await workspace.fs.writeFile(to, Buffer.from(chosen.csv, "utf8"));
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!(target instanceof Uri)) {
      void window.showInformationMessage(plainMessage(`q-lint: exported ${chosen.count} row(s) to ${to.fsPath}.`));
    }
  }
}
