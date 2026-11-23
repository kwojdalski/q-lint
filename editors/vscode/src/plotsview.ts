// The q Plots view (#970), beside q Results in the bottom panel: every chart
// the result panel draws is kept (`plots.ts`), and the view shows one at a
// time with the query it came from, steps back and forward through them,
// and saves the one on show as SVG or PNG.
//
// The page is the extension's own script and stylesheet under a policy
// with no network and no inline code; a plot is drawn as an <img> of its
// SVG, which runs nothing. A PNG is the page's rendering of that SVG on a
// canvas. Nothing is sent to a process. With q-lint.results.plots.enable off
// the view is hidden and unregistered, the plots kept are dropped, the
// result panel keeps none, and the commands refuse.
import { randomBytes } from "node:crypto";
import {
  commands,
  Uri,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
  type Webview,
  type WebviewView,
} from "vscode";
import { readResultView } from "./liveconfig";
import { PLOT_COMMANDS, plotFileName, PLOTS, type Plot } from "./plots";

/// How long Save Plot waits for the page to draw a PNG.
const PNG_WAIT = 10_000;

const on = (): boolean => readResultView((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).enable.plots;

/// Whether the plots are on; says how to turn them on when not.
function allowed(): boolean {
  if (!on()) {
    void window.showInformationMessage("q-lint: the q Plots view is turned off. Set q-lint.results.plots.enable to true to turn it on.");
  }
  return on();
}

interface PageMessage {
  type?: string;
  by?: number;
  format?: string;
  key?: string;
  data?: string;
}

function plotsHtml(webview: Webview, media: Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const file = (name: string): string => webview.asWebviewUri(Uri.joinPath(media, name)).toString();
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src data:;">`,
    `<link rel="stylesheet" href="${file("plots.css")}">`,
    "<title>q Plots</title></head><body>",
    `<script nonce="${nonce}" src="${file("plots.js")}"></script>`,
    "</body></html>",
  ].join("\n");
}

export class PlotsView {
  private view: WebviewView | undefined;
  private provider: Disposable | undefined;
  private ready: (() => void)[] = [];
  /// The page's PNGs asked for, by key: a second does not strand the first (#1092).
  private readonly png = new Map<string, (data: string | undefined) => void>();
  private requests = 0;

  constructor(private readonly context: ExtensionContext) {
    context.subscriptions.push(
      commands.registerCommand(PLOT_COMMANDS.show, () => allowed() && commands.executeCommand(`${PLOT_COMMANDS.view}.focus`)),
      commands.registerCommand(PLOT_COMMANDS.previous, () => allowed() && PLOTS.move(-1) !== undefined),
      commands.registerCommand(PLOT_COMMANDS.next, () => allowed() && PLOTS.move(1) !== undefined),
      commands.registerCommand(PLOT_COMMANDS.remove, () => allowed() && (PLOTS.removeShown(), true)),
      commands.registerCommand(PLOT_COMMANDS.clear, () => allowed() && (PLOTS.clear(), true)),
      commands.registerCommand(PLOT_COMMANDS.save, (format?: string, target?: Uri) => (allowed() ? this.save(format, target) : undefined)),
      PLOTS.onChange(() => this.post()),
      workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.results.plots") && this.sync()),
      { dispose: () => this.provider?.dispose() },
    );
    this.sync();
  }

  /// Register the view while the plots are on; drop what was kept when off.
  private sync(): void {
    if (on() && this.provider === undefined) {
      this.provider = window.registerWebviewViewProvider(PLOT_COMMANDS.view, { resolveWebviewView: (view) => this.resolve(view) });
    } else if (!on() && this.provider !== undefined) {
      this.provider.dispose();
      this.provider = undefined;
      this.view = undefined;
      PLOTS.clear();
    }
  }

  /// Whether the view is registered, for tests.
  registered(): boolean {
    return this.provider !== undefined;
  }

  private resolve(view: WebviewView): void {
    this.view = view;
    const media = Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = plotsHtml(view.webview, media);
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.webview.onDidReceiveMessage((message: PageMessage) => this.receive(message));
  }

  private receive(message: PageMessage): void {
    if (message.type === "ready") {
      this.post();
      const waiting = this.ready;
      this.ready = [];
      waiting.forEach((w) => w());
    } else if (message.type === "move" && typeof message.by === "number") {
      PLOTS.move(message.by);
    } else if (message.type === "remove") {
      PLOTS.removeShown();
    } else if (message.type === "clear") {
      PLOTS.clear();
    } else if (message.type === "save") {
      void this.save(message.format, undefined);
    } else if (message.type === "png" && typeof message.key === "string" && this.png.has(message.key)) {
      const resolve = this.png.get(message.key);
      this.png.delete(message.key);
      resolve?.(typeof message.data === "string" && message.data.startsWith("data:image/png;base64,") ? message.data : undefined);
    }
  }

  private post(): void {
    const plot = PLOTS.shown();
    void this.view?.webview.postMessage({
      type: "plots",
      count: PLOTS.list().length,
      index: PLOTS.current,
      plot: plot === undefined ? undefined : { svg: plot.svg, process: plot.process, code: plot.code, kind: plot.kind, at: plot.at },
    });
  }

  /// The page's PNG of the plot on show, the view opened first if need be.
  private async pngOf(): Promise<string | undefined> {
    if (this.view === undefined) {
      const shown = new Promise<void>((resolve) => this.ready.push(resolve));
      await commands.executeCommand(`${PLOT_COMMANDS.view}.focus`);
      await Promise.race([shown, new Promise((resolve) => setTimeout(resolve, PNG_WAIT))]);
    }
    if (this.view === undefined) {
      return undefined;
    }
    const key = `png-${++this.requests}`;
    const answer = new Promise<string | undefined>((resolve) => {
      this.png.set(key, resolve);
      setTimeout(() => this.png.delete(key) && resolve(undefined), PNG_WAIT);
    });
    void this.view.webview.postMessage({ type: "png", key });
    return answer;
  }

  /// Save the plot on show as `format` (or one picked) to `target` (or a
  /// file chosen). The path written, or undefined.
  private async save(format: string | undefined, target: Uri | undefined): Promise<string | undefined> {
    const plot: Plot | undefined = PLOTS.shown();
    if (plot === undefined) {
      void window.showInformationMessage("q-lint: there is no plot to save. Draw a chart in the result panel first.");
      return undefined;
    }
    const chosen =
      format === "svg" || format === "png"
        ? format
        : (
            await window.showQuickPick(
              [
                { label: "SVG", detail: "Vector graphics, as drawn", format: "svg" as const },
                { label: "PNG", detail: "An image of the plot", format: "png" as const },
              ],
              { title: "q-lint: save the plot as" },
            )
          )?.format;
    if (chosen === undefined) {
      return undefined;
    }
    let bytes: Uint8Array;
    if (chosen === "svg") {
      bytes = Buffer.from(plot.svg, "utf8");
    } else {
      const data = await this.pngOf();
      if (data === undefined) {
        void window.showInformationMessage("q-lint: the q Plots view did not draw the PNG; open it and save again.");
        return undefined;
      }
      bytes = Buffer.from(data.slice("data:image/png;base64,".length), "base64");
    }
    const folder = workspace.workspaceFolders?.[0]?.uri;
    const to =
      target ??
      (await window.showSaveDialog({
        title: `Save the plot as ${chosen.toUpperCase()}`,
        defaultUri: folder === undefined ? undefined : Uri.joinPath(folder, plotFileName(plot, chosen)),
        filters: { [chosen.toUpperCase()]: [chosen] },
      }));
    if (to === undefined) {
      return undefined;
    }
    await workspace.fs.writeFile(to, bytes);
    void window.showInformationMessage(`q-lint: saved the plot to ${to.fsPath}.`);
    return to.fsPath;
  }
}
