// A pane of runs and their answers beside the editor: the Interactive
// Window that cells run into (#956), and with an input box the q REPL
// pane (#959). The page (`media/console.js`) draws every text with
// `textContent`, so nothing a process answers is read as HTML.
import { randomBytes } from "node:crypto";
import { Uri, ViewColumn, window, type Disposable, type ExtensionContext, type Webview, type WebviewPanel } from "vscode";

/// One run in the pane.
export interface ConsoleEntry {
  id: number;
  /// A cell's name, for a run from a cell.
  title?: string;
  code: string;
  process?: string;
  millis?: number;
  /// Undefined while it runs.
  ok?: boolean;
  lines: string[];
}

/// The most runs a pane keeps; older ones are dropped.
export const ENTRY_LIMIT = 200;

/// What the page sends: "ready" once loaded, "clear" from its button, and
/// whatever else the pane's owner handles (the REPL's input).
export interface PageMessage {
  type?: string;
  [key: string]: unknown;
}

function consoleHtml(webview: Webview, media: Uri, title: string, input: boolean): string {
  const nonce = randomBytes(16).toString("base64");
  const file = (...path: string[]): string => webview.asWebviewUri(Uri.joinPath(media, ...path)).toString();
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${file("console.css")}">`,
    `<title>${title.replace(/[<>&"]/g, "")}</title></head><body data-input="${input ? "yes" : "no"}">`,
    `<script nonce="${nonce}" src="${file("console.js")}"></script>`,
    "</body></html>",
  ].join("\n");
}

export class ConsolePanel {
  private panel: WebviewPanel | undefined;
  private list: ConsoleEntry[] = [];
  private next = 0;

  constructor(
    private readonly context: ExtensionContext,
    private readonly options: {
      viewType: string;
      title: string;
      input: boolean;
      /// A page message other than "ready" and "clear".
      onMessage?: (message: PageMessage) => void;
      /// Sent with the entries when the page loads: the REPL's history.
      initial?: () => Record<string, unknown>;
    },
  ) {
  }

  private get media(): Uri {
    return Uri.joinPath(this.context.extensionUri, "media");
  }

  /// The runs on show, oldest first.
  entries(): ConsoleEntry[] {
    return this.list.map((e) => ({ ...e, lines: [...e.lines] }));
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /// Open the pane beside the editor, or bring it forward, keeping the
  /// editor's focus unless `focus`.
  open(focus = false): void {
    if (this.panel !== undefined) {
      this.panel.reveal(undefined, !focus);
      return;
    }
    const panel = window.createWebviewPanel(
      this.options.viewType,
      this.options.title,
      { viewColumn: ViewColumn.Beside, preserveFocus: !focus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.media] },
    );
    this.panel = panel;
    panel.webview.html = consoleHtml(panel.webview, this.media, this.options.title, this.options.input);
    const listeners: Disposable[] = [
      panel.webview.onDidReceiveMessage((message: PageMessage) => {
        if (message?.type === "ready") {
          this.post({ type: "all", entries: this.list, ...(this.options.initial?.() ?? {}) });
        } else if (message?.type === "clear") {
          this.clear();
        } else {
          this.options.onMessage?.(message);
        }
      }),
    ];
    panel.onDidDispose(() => {
      for (const l of listeners) {
        l.dispose();
      }
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
  }

  /// Add a run, drawn as running until `update` gives its answer.
  add(entry: Omit<ConsoleEntry, "id" | "lines"> & { lines?: string[] }): number {
    const added: ConsoleEntry = { ...entry, id: ++this.next, lines: entry.lines ?? [] };
    this.list.push(added);
    if (this.list.length > ENTRY_LIMIT) {
      this.list = this.list.slice(-ENTRY_LIMIT);
    }
    this.post({ type: "add", entry: added });
    return added.id;
  }

  update(id: number, change: Partial<Omit<ConsoleEntry, "id">>): void {
    const entry = this.list.find((e) => e.id === id);
    if (entry === undefined) {
      return;
    }
    Object.assign(entry, change);
    this.post({ type: "update", entry });
  }

  /// Drop a run that was not run after all.
  remove(id: number): void {
    this.list = this.list.filter((e) => e.id !== id);
    this.post({ type: "remove", id });
  }

  clear(): void {
    this.list = [];
    this.post({ type: "clear" });
  }

  post(message: Record<string, unknown>): void {
    void this.panel?.webview.postMessage(message);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.list = [];
  }
}
