// Query modes: whether a result goes to the output or to the result panel,
// where `media/result.js` draws it as a grid or a chart.
//
// The panel is a webview that loads only the extension's own files, under a
// Content-Security-Policy that allows no inline code and no network: its two
// scripts carry a fresh nonce, and its stylesheet comes from `media/`. The
// chart library is Chart.js 4.5.1 (MIT, chartjs.org), vendored whole as
// `media/vendor/chart.umd.min.js` with its licence beside it. The grid is
// this extension's. What the panel shows is computed here, by `grid.ts`, so
// the script only lays it out, sorts it by the ranks the process sent and
// filters it by the text each cell shows.
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
  type WebviewPanel,
} from "vscode";
import { COMMANDS, QUERY_MODES, readLive, type LiveSettings, type QueryMode } from "./liveconfig";
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

export class QueryModes {
  private panel: WebviewPanel | undefined;
  private shown: Shown | undefined;
  private rendered: Rendered | undefined;
  private readonly status: StatusBarItem;

  constructor(private readonly context: ExtensionContext) {
    this.status = window.createStatusBarItem("q-lint.queryMode", StatusBarAlignment.Left, 49);
    this.status.name = "q-lint: query mode";
    this.status.command = COMMANDS.switchMode;
    context.subscriptions.push(
      this.status,
      commands.registerCommand(COMMANDS.switchMode, (mode?: string) => this.switchMode(mode)),
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
    this.reveal();
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

  private reveal(): void {
    if (this.panel !== undefined) {
      this.panel.reveal(undefined, true);
      return;
    }
    const media = Uri.joinPath(this.context.extensionUri, "media");
    const panel = window.createWebviewPanel(
      "q-lint.result",
      "q-lint: result",
      { viewColumn: ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [media] },
    );
    this.panel = panel;
    const webview = panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const file = (...path: string[]): string => webview.asWebviewUri(Uri.joinPath(media, ...path)).toString();
    webview.html = [
      "<!DOCTYPE html>",
      '<html lang="en"><head><meta charset="UTF-8">',
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">`,
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `<link rel="stylesheet" href="${file("result.css")}">`,
      "<title>q-lint: result</title></head><body>",
      `<script nonce="${nonce}" src="${file("vendor", "chart.umd.min.js")}"></script>`,
      `<script nonce="${nonce}" src="${file("result.js")}"></script>`,
      "</body></html>",
    ].join("\n");
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    webview.onDidReceiveMessage((message: { type?: string; rows?: number[]; rendered?: Rendered }) => {
      if (message.type === "ready") {
        // Also after the panel was hidden and shown again, which reloads it.
        this.post();
      } else if (message.type === "rendered" && message.rendered !== undefined) {
        this.rendered = message.rendered;
      } else if (message.type === "copy" && this.shown !== undefined) {
        void this.copy(message.rows);
      }
    });
  }

  /// Send the panel what it shows. A panel still loading drops it, and asks
  /// again once it is ready.
  private post(): void {
    if (this.panel === undefined || this.shown === undefined) {
      return;
    }
    const { process, code, millis, payload, view, id } = this.shown;
    const live = settings();
    void this.panel.webview.postMessage({
      type: "result",
      id,
      view,
      process,
      code,
      millis,
      limit: live.gridLimit,
      grid: toGrid(payload, live.gridDecimals),
    });
  }

  private async copy(rows: number[] | undefined): Promise<void> {
    if (this.shown === undefined) {
      return;
    }
    const grid = toGrid(this.shown.payload, settings().gridDecimals);
    const order = Array.isArray(rows) ? rows.filter((r) => Number.isInteger(r) && r >= 0 && r < rowCount(grid)) : undefined;
    await env.clipboard.writeText(toCsv(grid, order));
    void window.showInformationMessage(`q-lint: copied ${order?.length ?? rowCount(grid)} row(s) as CSV.`);
  }
}
