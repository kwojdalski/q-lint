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
// A result can also be exported as Excel, Parquet, JSON, Markdown or q
// (`resultexport.ts`), pivoted, and charted as an area, a step line or
// candles, on two axes, and saved as PNG or SVG. With paging on, a result
// cut at gridLimit stays on the process (`grid.ts`'s `HELD`) and the grid
// asks for more of it as it scrolls. A cell's drill-down templates run a
// follow-up query with its value put in (`drilldown.ts`).
//
// A column header's menu offers the Data Wrangler and a cell's Edit Cell
// (`resulttools.ts`), which work from `current()`: the page only marks
// where each menu applies.
import { randomBytes } from "node:crypto";
import {
  commands,
  ConfigurationTarget,
  env,
  StatusBarAlignment,
  Uri,
  ViewColumn,
  window,
  workspace,
  type ExtensionContext,
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
}

/// What a page is asked to do by a command, once: `key` tells a request
/// from the same one sent again with the next result.
interface Control {
  key: string;
  action: "view" | "compare" | "image";
  view?: "stats" | "tree" | "pivot";
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
  /// "image": the chart, as a PNG data URL or SVG text.
  data?: string;
  /// "image": the command's request it answers, if any.
  key?: string;
  /// "drill": the cell, by column and row of the grid.
  column?: number;
  row?: number;
  /// "copyText": text to put on the clipboard.
  text?: string;
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
  /// Save Result Chart's request, until the page sends the image.
  private image: { key: string; target?: Uri; resolve: () => void } | undefined;

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
      void window.showWarningMessage(`q-lint: the result could not be shown as a ${live.mode}: '${answer.gridError}. It is in the output.`);
      return false;
    }
    if (answer.grid === undefined) {
      return false;
    }
    const features = this.viewSettings();
    const last = features.enable.diff ? this.previous.get(result.code) : undefined;
    const replaced = inPlace && this.shown?.code === result.code && this.shown.process === result.process ? this.shown : undefined;
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
    void window.showInformationMessage(`q-lint: this result panel feature is turned off. Turn it on with the setting q-lint.results.${feature}.enable.`);
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
          shown === undefined
            ? "q-lint: no result yet. Run a query in grid or chart mode first."
            : "q-lint: the process holds no more of the result on show. A result is held only when it was cut at q-lint.query.gridLimit, and only until the next grid query replaces it.",
        );
      }
      return;
    }
    if (this.paging) {
      return;
    }
    const have = shown.payload.cells[0]?.length ?? 0;
    if (have >= MAX_PAGED_ROWS) {
      void window.showInformationMessage(`q-lint: the grid holds ${MAX_PAGED_ROWS.toLocaleString("en-US")} rows, the most it pages to. Narrow the query to see the rest.`);
      return;
    }
    this.paging = true;
    try {
      const page = await this.pager(shown.process, have, Math.min(shown.limit, MAX_PAGED_ROWS - have));
      if (typeof page === "string") {
        shown.held = false;
        void window.showWarningMessage(`q-lint: could not fetch more rows from ${shown.process}: ${page}`);
      } else {
        shown.payload = appendPage(shown.payload, page);
        const now = shown.payload.cells[0]?.length ?? 0;
        shown.held = now < shown.payload.count && now > have;
      }
    } catch (error) {
      shown.held = false;
      void window.showWarningMessage(`q-lint: could not fetch more rows from ${shown.process}: ${error instanceof Error ? error.message : String(error)}`);
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
          label: oneLine(h.code),
          description: `${h.process} · ${new Date(h.at).toLocaleTimeString()}`,
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
    } else if (message.type === "rendered" && message.rendered !== undefined) {
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
    } else if (message.type === "image") {
      if (this.viewSettings().enable.charts) {
        void this.saveImage(message);
      }
    } else if (message.type === "drill") {
      if (this.enabled("drilldown")) {
        void this.drill(message.column, message.row);
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
      out = exportResult(chosen, shown.payload, settings().gridDecimals, this.rowsOf(rows));
      await workspace.fs.writeFile(to, out.data);
    } catch (error) {
      void window.showErrorMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const notes = out.notes.length > 0 ? ` Note: ${out.notes.join("; ")}.` : "";
    if (!(target instanceof Uri) || notes !== "") {
      void window.showInformationMessage(`q-lint: exported ${out.rows} row(s) as ${info.label} to ${to.fsPath}.${notes}`);
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
    const out = exportResult(chosen, shown.payload, settings().gridDecimals, this.rowsOf(rows));
    await env.clipboard.writeText(out.data.toString("utf8"));
    const notes = out.notes.length > 0 ? ` Note: ${out.notes.join("; ")}.` : "";
    void window.showInformationMessage(`q-lint: copied ${out.rows} row(s) as ${FORMAT_INFO[chosen].label}.${notes}`);
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
      this.image = { key: `${this.session}.${this.controls}`, target, resolve };
      // A page that never answers (closed) does not keep the command waiting.
      setTimeout(() => {
        if (this.image?.resolve === resolve) {
          this.image = undefined;
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
    const request = message.key !== undefined && this.image?.key === message.key ? this.image : undefined;
    if (request !== undefined) {
      this.image = undefined;
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
        void window.showErrorMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!(request?.target instanceof Uri)) {
        void window.showInformationMessage(`q-lint: saved the chart to ${to.fsPath}.`);
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
        `q-lint: no drill-down query for column ${name}. Add one to q-lint.results.drilldownTemplates, with {{value}} where the cell's value goes.`,
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
      void window.showWarningMessage(`q-lint: ${picked.label} cannot run: ${picked.filled.error}.`);
      return;
    }
    if (this.runner === undefined) {
      return;
    }
    await this.runner(picked.filled.code, shown.process);
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
      },
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
    void window.showInformationMessage(`q-lint: copied ${chosen.count} row(s) as CSV.`);
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
      void window.showErrorMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!(target instanceof Uri)) {
      void window.showInformationMessage(`q-lint: exported ${chosen.count} row(s) to ${to.fsPath}.`);
    }
  }
}
