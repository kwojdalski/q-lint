// The Compare Query panel (#907): `compare.ts`'s comparison, drawn by
// `media/compare.js` as one table, the first process's columns beside the
// second's, each pair of rows on one line and the cells that differ marked.
//
// As the result panel's, the page loads only the extension's own files,
// under a Content-Security-Policy that allows no inline code and no
// network, its script with a fresh nonce. Every cell is put in the page as
// text, never as markup.
import { randomBytes } from "node:crypto";
import { Uri, ViewColumn, window, type ExtensionContext, type Webview, type WebviewPanel } from "vscode";
import type { Comparison } from "./compare";

/// What the page drew, as its script reported it: for tests, through the API.
export interface RenderedComparison {
  processes: [string, string];
  /// Lined-up rows drawn, and cells marked as differing in them.
  rows: number;
  marked: number;
  summary: string;
}

function compareHtml(webview: Webview, media: Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const file = (name: string): string => webview.asWebviewUri(Uri.joinPath(media, name)).toString();
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${file("compare.css")}">`,
    "<title>q-lint: compare</title></head><body>",
    `<script nonce="${nonce}" src="${file("compare.js")}"></script>`,
    "</body></html>",
  ].join("\n");
}

export class CompareView {
  private panel: WebviewPanel | undefined;
  private shown: { comparison: Comparison; code: string; id: number } | undefined;
  private rendered: RenderedComparison | undefined;
  private count = 0;
  private readonly media: Uri;

  constructor(context: ExtensionContext) {
    this.media = Uri.joinPath(context.extensionUri, "media");
    context.subscriptions.push({ dispose: () => this.panel?.dispose() });
  }

  /// Close the panel: Compare Query was turned off (#1458).
  close(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  lastRendered(): RenderedComparison | undefined {
    return this.rendered;
  }

  /// Show `comparison` of `code`'s answers, opening the panel beside the
  /// editor if it is not open.
  show(comparison: Comparison, code: string): void {
    this.shown = { comparison, code, id: ++this.count };
    this.rendered = undefined;
    if (this.panel === undefined) {
      const panel = window.createWebviewPanel(
        "q-lint.compare",
        "q-lint: compare",
        { viewColumn: ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, localResourceRoots: [this.media] },
      );
      this.panel = panel;
      panel.webview.html = compareHtml(panel.webview, this.media);
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
      });
      panel.webview.onDidReceiveMessage((message: { type?: string; id?: number; rendered?: RenderedComparison }) => {
        if (message.type === "ready") {
          this.post();
        } else if (message.type === "rendered" && message.id === this.shown?.id && message.rendered !== undefined) {
          this.rendered = message.rendered;
        }
      });
    } else {
      this.panel.reveal(undefined, true);
    }
    this.panel.title = `q-lint: ${comparison.left.process} vs ${comparison.right.process}`;
    this.post();
  }

  /// Send what is shown; a page still loading drops it and asks once ready.
  private post(): void {
    if (this.shown !== undefined) {
      void this.panel?.webview.postMessage({ type: "compare", ...this.shown });
    }
  }
}
