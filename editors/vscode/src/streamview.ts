// Stream Tickerplant Table (#915): a webview grid of a table's updates, kept
// to its last rows, over a connection of its own that subscribes with
// `.u.sub`. What is sent and how an update is read is `stream.ts`'s.
//
// Off by default (`q-lint.tickerplant.stream.enable`): a subscriber is a load
// on a tickerplant, and a slow one can grow its memory. Turned off, every
// stream closes and its connection with it, which the tickerplant sees as
// the subscriber gone.
import { randomBytes } from "node:crypto";
import { ProgressLocation, Uri, ViewColumn, commands, window, workspace, type ExtensionContext, type Webview, type WebviewPanel } from "vscode";
import { isProduction } from "./agent";
import { guardedBy, readGuard } from "./guard";
import type { Live, ProcessArg } from "./live";
import { decode } from "./qdecode";
import { directRefusal, type QConnection } from "./qclient";
import { directMode } from "./querycontrols";
import { RowWindow, STREAM_COMMANDS, SUBSCRIBE, TABLES, readStream, readUpdate } from "./stream";
import { iconsEscaped, plainMessage } from "./history";
import { shownError } from "./tunnel";

/// How often the grid is redrawn, at most.
const DRAW_MS = 200;

interface Stream {
  process: string;
  table: string;
  columns: string[];
  window: RowWindow;
  connection: QConnection;
  panel: WebviewPanel;
  paused: boolean;
  closed?: string;
}

export class TableStreams {
  private readonly streams = new Set<Stream>();

  constructor(
    context: ExtensionContext,
    private readonly live: Live,
  ) {
    context.subscriptions.push(
      commands.registerCommand(STREAM_COMMANDS.start, (row?: ProcessArg, table?: string) => this.start(row, table)),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.tickerplant.stream") && !this.settings().enabled) {
          this.closeAll();
        }
      }),
      { dispose: () => this.closeAll() },
    );
  }

  /// What each stream shows, for tests and the e2e run.
  state(): { process: string; table: string; columns: string[]; rows: string[][]; total: number; closed?: string }[] {
    return [...this.streams].map((s) => ({
      process: s.process,
      table: s.table,
      columns: s.columns,
      rows: s.window.rows(),
      total: s.window.total,
      ...(s.closed !== undefined ? { closed: s.closed } : {}),
    }));
  }

  private settings(): ReturnType<typeof readStream> {
    const configuration = workspace.getConfiguration("q-lint");
    return readStream((key, fallback) => configuration.get(key, fallback));
  }

  private closeAll(): void {
    for (const stream of [...this.streams]) {
      stream.panel.dispose();
    }
  }

  /// Subscribe to `table` (or one the user picks) on the process `row`
  /// names (or one the user picks), and open its grid.
  private async start(row?: ProcessArg, table?: string): Promise<void> {
    const settings = this.settings();
    if (!settings.enabled) {
      void window.showInformationMessage(
        "q-lint: Streaming a tickerplant table is turned off. Set q-lint.tickerplant.stream.enable to true to turn it on.",
      );
      return;
    }
    const process = await this.live.pick(row, "Stream a table from which tickerplant?");
    if (process === undefined) {
      return;
    }
    // Subscribing sends q-lint's lambda: on a direct process, refused before
    // anything is asked or a connection opened (#2484).
    const direct = directMode(process, workspace.getConfiguration("q-lint").get<unknown>("query.unwrapped", false) === true);
    if (direct !== undefined) {
      void window.showErrorMessage(plainMessage(`q-lint: Stream Table: ${directRefusal(direct)}`));
      return;
    }
    // `.u.sub` adds q-lint to the tickerplant's subscribers: asked first on
    // production, and on a process the read-only guard (#918) guards.
    const guarded = guardedBy(process, readGuard((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)));
    if (isProduction(process) || guarded.length > 0) {
      const yes = "Subscribe";
      const sure = await window.showWarningMessage(
        plainMessage(`${process.label} is ${isProduction(process) ? "a production process" : "read-only guarded"} (tagged ${process.tags.join(", ")}). Subscribing adds q-lint as a subscriber there: the tickerplant sends it every update of the table while the grid is open. Subscribe?`),
        { modal: true },
        yes,
      );
      if (sure !== yes) {
        return;
      }
    }
    let connection: QConnection;
    try {
      // A notification, whose Cancel gives up a connect script that blocks (#2567).
      connection = await window.withProgress({ location: ProgressLocation.Notification, title: `q-lint: connecting to ${process.label} to stream`, cancellable: true }, (_progress, token) => {
        const cancel = new AbortController();
        token?.onCancellationRequested(() => cancel.abort());
        return this.live.openSeparate(process, undefined, cancel.signal);
      });
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not connect to ${process.label}: ${shownError(error)}`));
      return;
    }
    let columns: string[];
    let types: string | undefined;
    let early: Buffer[] | undefined = [];
    try {
      let name = typeof table === "string" ? table.trim().replace(/^`/, "") : undefined;
      if (name === undefined) {
        const listed = await connection.call(TABLES).catch(() => []);
        const tables = (Array.isArray(listed) ? listed : [listed]).filter((t): t is string => typeof t === "string" && t !== "");
        name =
          tables.length > 0
            ? (await window.showQuickPick(tables.map((t) => ({ label: iconsEscaped(t), table: t })), { title: `Stream which table of ${process.label}?` }))?.table
            : await window.showInputBox({ title: `Stream which table of ${process.label}?`, prompt: "The table's name, as .u.sub takes it." });
        name = name?.trim().replace(/^`/, "");
      }
      if (name === undefined || name === "") {
        await connection.close();
        return;
      }
      if (!/^[A-Za-z.][A-Za-z0-9_.]*$/.test(name)) {
        throw new Error(`"${name}" is not a table name`);
      }
      table = name;
      // Turned off while it asked or connected: nothing is subscribed (#1419).
      if (!this.settings().enabled) {
        await connection.close();
        return;
      }
      // Listened for before .u.sub is sent: an update in the same packet as
      // its answer is dispatched with it, before the answer is awaited.
      connection.whenAsync((message) => early?.push(message));
      const answer = await connection.call(SUBSCRIBE, `\`${name}`);
      const cols = Array.isArray(answer) ? answer[1] : undefined;
      columns = (Array.isArray(cols) ? cols : [cols]).filter((c): c is string => typeof c === "string");
      types = Array.isArray(answer) && typeof answer[2] === "string" ? answer[2] : undefined;
    } catch (error) {
      await connection.close();
      void window.showErrorMessage(plainMessage(`q-lint: could not subscribe to ${table ?? "the table"} on ${process.label}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    // Or while it subscribed: closing the connection unsubscribes.
    if (!this.settings().enabled) {
      await connection.close();
      return;
    }
    const taken = early;
    early = undefined;
    this.open(process.label, table, columns, connection, settings.rows, taken, types);
  }

  /// `early`: the updates that came before the grid, with .u.sub's answer.
  private open(label: string, table: string, columns: string[], connection: QConnection, limit: number, early: Buffer[], types?: string): void {
    const media = Uri.joinPath(this.live.extensionUri, "media");
    const panel = window.createWebviewPanel(
      "q-lint.stream",
      `q: ${table} on ${label}`,
      { viewColumn: ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true },
    );
    const stream: Stream = { process: label, table, columns, window: new RowWindow(limit), connection, panel, paused: false };
    this.streams.add(stream);
    panel.webview.html = streamHtml(panel.webview, media);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Closing the panel closes the connection, whose close handler would
    // draw again: nothing touches the webview once it is disposed (#1272).
    let disposed = false;
    // The rows received when the page last drew, -1 before it has: each
    // draw posts only the rows since, which the page adds above its own,
    // not every kept row to build again (#1861).
    let seen = -1;
    const draw = (): void => {
      // A draw now does what one waiting would.
      clearTimeout(timer);
      timer = undefined;
      if (!disposed && !stream.paused) {
        const { reset, rows } = stream.window.since(seen);
        seen = stream.window.total;
        void panel.webview.postMessage({
          type: "rows",
          process: label,
          table,
          columns,
          limit,
          reset,
          rows,
          kept: stream.window.rows().length,
          total: stream.window.total,
          at: new Date().toLocaleTimeString(),
          ...(stream.closed !== undefined ? { closed: stream.closed } : {}),
        });
      }
    };
    const later = (): void => {
      if (!disposed) {
        timer ??= setTimeout(draw, DRAW_MS);
      }
    };
    const update = (message: Buffer): void => {
      let rows: string[][] | undefined;
      try {
        rows = readUpdate(decode(message), table, columns, types);
      } catch {
        rows = undefined;
      }
      if (rows !== undefined && rows.length > 0) {
        stream.window.push(rows);
        later();
      }
    };
    early.forEach(update);
    connection.whenAsync(update);
    connection.whenClosed(() => {
      stream.closed ??= `the connection to ${label} closed`;
      // Said by itself, at once: a paused grid is sent no rows to say it
      // with, and would read as a stream merely held back (#1932).
      if (!disposed) {
        void panel.webview.postMessage({ type: "closed", closed: stream.closed });
      }
      later();
    });
    panel.webview.onDidReceiveMessage((message: { type?: string; paused?: unknown }) => {
      if (message.type === "ready") {
        // A page loaded again has no rows: it is sent them all.
        seen = -1;
        draw();
      } else if (message.type === "pause") {
        stream.paused = message.paused === true;
        draw();
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
      clearTimeout(timer);
      stream.closed ??= "closed";
      this.streams.delete(stream);
      // The tickerplant drops a subscriber whose handle closes.
      void connection.close();
    });
    draw();
  }
}

/// The stream page: the extension's own script and stylesheet, a fresh nonce,
/// nothing inline, no network.
function streamHtml(webview: Webview, media: Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const file = (name: string): string => webview.asWebviewUri(Uri.joinPath(media, name)).toString();
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${file("stream.css")}">`,
    "<title>q-lint: stream</title></head><body>",
    `<script nonce="${nonce}" src="${file("stream.js")}"></script>`,
    "</body></html>",
  ].join("\n");
}
