// Add Many Processes (#1032): a form to paste lines or CSV into, which
// shows what each line gives - a process, why not, or a duplicate - as it
// is typed, and adds the processes on Add. What is read is `bulkadd.ts`'s;
// the page holds no logic but sending its text and drawing the table it is
// sent, every value escaped there. Nothing is sent to any process.
import { randomBytes } from "node:crypto";
import { ViewColumn, commands, window, workspace, type ExtensionContext, type WebviewPanel } from "vscode";
import { ADMIN_COMMANDS, adminOff, readAdmin } from "./admin";
import { parseBulk, rowsHtml, toAdd } from "./bulkadd";
import type { Live } from "./live";
import { plainMessage } from "./history";

const on = (): boolean => readAdmin((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).bulkAdd;

/// The form's page: a text area and the table under it, under a policy
/// that runs only its own script.
export function bulkAddHtml(cspSource: string): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 12px; }
textarea { width: 100%; min-height: 10em; font-family: var(--vscode-editor-font-family); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
table { border-collapse: collapse; margin-top: 8px; width: 100%; }
th, td { text-align: left; padding: 2px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
tr.bad td { color: var(--vscode-errorForeground); }
tr.dup td { color: var(--vscode-descriptionForeground); }
button { margin-top: 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 12px; }
</style></head><body>
<p>One process a line, <code>host:port[:label[:tags]]</code>, or CSV with a header row naming <code>host</code>, <code>port</code> and any of <code>label</code>, <code>tags</code>, <code>user</code>, <code>tls</code>. No passwords: each is asked for on connect.</p>
<textarea id="text" spellcheck="false" placeholder="localhost:5010:rdb:dev&#10;tick.example.com:5000:tp:prod,torq"></textarea>
<div id="rows"></div>
<button id="add">Add</button>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const text = document.getElementById("text");
text.addEventListener("input", () => vscode.postMessage({ type: "check", text: text.value }));
document.getElementById("add").addEventListener("click", () => vscode.postMessage({ type: "add", text: text.value }));
window.addEventListener("message", (event) => { if (event.data.type === "rows") document.getElementById("rows").innerHTML = event.data.html; });
vscode.postMessage({ type: "check", text: "" });
</script></body></html>`;
}

export class BulkAdd {
  private panel: WebviewPanel | undefined;

  constructor(
    context: ExtensionContext,
    private readonly live: Pick<Live, "processes" | "saveProcesses">,
  ) {
    context.subscriptions.push(
      commands.registerCommand(ADMIN_COMMANDS.bulkAdd, (text?: string) => (typeof text === "string" ? this.add(text) : this.open())),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.processes.bulkAdd") && !on()) {
          this.panel?.dispose();
        }
      }),
      { dispose: () => this.panel?.dispose() },
    );
  }

  /// Open the form, or show it if it is open.
  open(): void {
    if (!on()) {
      void window.showInformationMessage(plainMessage(adminOff("bulkAdd")));
      return;
    }
    if (this.panel !== undefined) {
      this.panel.reveal();
      return;
    }
    const panel = window.createWebviewPanel("q-lint.addManyProcesses", "q-lint: Add Many Processes", ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    this.panel = panel;
    panel.webview.html = bulkAddHtml(panel.webview.cspSource);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    panel.webview.onDidReceiveMessage((message: { type?: string; text?: unknown }) => void this.handle(message));
  }

  /// What the page sent: its text to check, or to add.
  async handle(message: { type?: string; text?: unknown }): Promise<void> {
    const text = typeof message.text === "string" ? message.text : "";
    if (message.type === "check") {
      void this.panel?.webview.postMessage({ type: "rows", html: rowsHtml(parseBulk(text, this.live.processes())) });
    } else if (message.type === "add" && (await this.add(text)) > 0) {
      this.panel?.dispose();
    }
  }

  /// Add the processes `text` gives that are not duplicates; how many.
  async add(text: string): Promise<number> {
    if (!on()) {
      void window.showInformationMessage(plainMessage(adminOff("bulkAdd")));
      return 0;
    }
    // Read now: the list may have changed while the form was open.
    const now = this.live.processes();
    const rows = parseBulk(text, now);
    const adding = toAdd(rows);
    const skipped = rows.length - adding.length;
    if (adding.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: no process to add${skipped > 0 ? `: ${skipped} line(s) were duplicates or not processes` : ""}.`));
      return 0;
    }
    await this.live.saveProcesses([...now, ...adding]);
    void window.showInformationMessage(plainMessage(`q-lint: added ${adding.length} q process(es)${skipped > 0 ? `; skipped ${skipped} line(s)` : ""}.`));
    return adding.length;
  }
}
