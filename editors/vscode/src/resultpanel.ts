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
import { COMMANDS, QUERY_MODES, readLive, RESULTS, type LiveSettings, type QueryMode, type ResultsLocation } from "./liveconfig";
import { rowCount, toCsv, toGrid, type GridAnswer, type GridPayload } from "./grid";

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
  view: "grid" | "chart";
  /// Rows shown after the filters, and rows the panel holds.
  rows: number;
  held: number;
  /// Rows the whole result had.
  total: number;
  columns: string[];
  /// The cells of the first row shown.
  first: string[];
  chart?: { kind: string; datasets: { label: string; points: number }[]; note?: string };
}

interface Shown {
  process: string;
  code: string;
  millis: number;
  payload: GridPayload;
  view: "grid" | "chart";
  /// Counts results, so the panel tells a new one from the same one sent
  /// again and keeps the view, sort and filters chosen for it.
  id: number;
}

function settings(): LiveSettings {
  const configuration = workspace.getConfiguration("q-lint");
  return readLive((key, fallback) => configuration.get(key, fallback));
}

/// The page the result panel and the q Results view load: the extension's
/// own files, a fresh nonce on every script, nothing inline, no network.
function resultHtml(webview: Webview, media: Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const file = (...path: string[]): string => webview.asWebviewUri(Uri.joinPath(media, ...path)).toString();
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${file("result.css")}">`,
    "<title>q-lint: result</title></head><body>",
    `<script nonce="${nonce}" src="${file("vendor", "chart.umd.min.js")}"></script>`,
    `<script nonce="${nonce}" src="${file("chartspec.js")}"></script>`,
    `<script nonce="${nonce}" src="${file("result.js")}"></script>`,
    "</body></html>",
  ].join("\n");
}

/// What a page says to the extension.
interface PageMessage {
  type?: string;
  rows?: number[];
  rendered?: Omit<Rendered, "location">;
}

export class QueryModes {
  private panel: WebviewPanel | undefined;
  private view: WebviewView | undefined;
  private shown: Shown | undefined;
  private rendered: Rendered | undefined;
  /// The rows the page last showed, after its filters and sort, in order.
  private order: number[] | undefined;
  private readonly status: StatusBarItem;
  private readonly media: Uri;

  constructor(private readonly context: ExtensionContext) {
    this.media = Uri.joinPath(context.extensionUri, "media");
    this.status = window.createStatusBarItem("q-lint.queryMode", StatusBarAlignment.Left, 49);
    this.status.name = "q-lint: query mode";
    this.status.command = COMMANDS.switchMode;
    context.subscriptions.push(
      this.status,
      commands.registerCommand(COMMANDS.switchMode, (mode?: string) => this.switchMode(mode)),
      commands.registerCommand(RESULTS.exportCsv, (target?: Uri) => this.exportCsv(target, this.order)),
      window.registerWebviewViewProvider(RESULTS.view, { resolveWebviewView: (view) => this.resolveView(view) }),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.query")) {
          this.showStatus();
          // New decimals apply to what is on show.
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
    this.shown = {
      process: result.process,
      code: result.code,
      millis: result.millis,
      payload: answer.grid,
      view: live.mode,
      id: (this.shown?.id ?? 0) + 1,
    };
    this.order = undefined;
    if (live.resultsLocation === "panel") {
      void this.revealView();
    } else {
      this.revealPanel();
    }
    this.post();
    return true;
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
    panel.webview.html = resultHtml(panel.webview, this.media);
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
    if (editor !== undefined) {
      await window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, selection: editor.selection, preserveFocus: false });
    }
  }

  private resolveView(view: WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    view.webview.html = resultHtml(view.webview, this.media);
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.webview.onDidReceiveMessage((message: PageMessage) => this.receive("panel", view.webview, message));
  }

  private receive(location: ResultsLocation, webview: Webview, message: PageMessage): void {
    if (message.type === "ready") {
      // Also after the page was hidden and shown again, which reloads it.
      this.post(webview);
    } else if (message.type === "rendered" && message.rendered !== undefined) {
      // Both may be open, after the location changed: the API reports the
      // one results now go to.
      if (location === settings().resultsLocation) {
        this.rendered = { location, ...message.rendered };
        this.order = Array.isArray(message.rows) ? message.rows : undefined;
      }
    } else if (message.type === "copy" && this.shown !== undefined) {
      void this.copy(message.rows);
    } else if (message.type === "export" && this.shown !== undefined) {
      void this.exportCsv(undefined, message.rows);
    }
  }

  /// Send what is shown to `only`, or to every open page. A page still
  /// loading drops it, and asks again once it is ready.
  private post(only?: Webview): void {
    if (this.shown === undefined) {
      return;
    }
    const { process, code, millis, payload, view, id } = this.shown;
    const live = settings();
    const message = {
      type: "result",
      id,
      view,
      process,
      code,
      millis,
      limit: live.gridLimit,
      grid: toGrid(payload, live.gridDecimals),
    };
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
