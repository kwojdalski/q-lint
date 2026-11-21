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
import { rowCount, toCsv, toGrid, type GridAnswer, type GridPayload } from "./grid";
import { diffGrids, type GridDiff } from "./resultdiff";

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
  view: "grid" | "chart" | "stats" | "tree";
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
}

/// What a page is asked to do by a command, once: `key` tells a request
/// from the same one sent again with the next result.
interface Control {
  key: string;
  action: "view" | "compare";
  view?: "stats" | "tree";
}

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

  /// Show a query's answer in the panel when the mode is grid or chart and
  /// the value was tabular. False when it belongs in the output instead.
  show(result: { process: string; code: string; millis: number; answer: GridAnswer }, live: LiveSettings): boolean {
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
    const shown: Shown = {
      process: result.process,
      code: result.code,
      millis: result.millis,
      payload: answer.grid,
      view: live.mode,
      limit: live.gridLimit,
      id: `${this.session}.${++this.results}`,
      at: Date.now(),
      ...(last !== undefined ? { before: { payload: last.payload, process: last.process, at: last.at } } : {}),
    };
    // Kept by code, most recent last, so the oldest is the one dropped.
    this.previous.delete(result.code);
    this.previous.set(result.code, shown);
    if (this.previous.size > PREVIOUS_RUNS) {
      this.previous.delete(this.previous.keys().next().value as string);
    }
    this.history.push(shown);
    this.shown = shown;
    this.applyFeatures(features);
    this.order.editor = undefined;
    this.order.panel = undefined;
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
    }
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
      features: { statistics: features.enable.statistics, heatmap: features.enable.heatmap },
      history: (features.enable.history ? this.history : [this.shown]).map((h) => ({ id: h.id, process: h.process, code: oneLine(h.code), at: h.at, rows: h.payload.count })),
      control: this.control,
    };
    void commands.executeCommand("setContext", RESULT_CONTEXT.shown, true);
    void commands.executeCommand("setContext", RESULT_CONTEXT.hasPrevious, before !== undefined);
    void commands.executeCommand("setContext", RESULT_CONTEXT.hasTree, tree !== undefined);
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
