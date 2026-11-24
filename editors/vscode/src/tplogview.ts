// The tickerplant log viewer (#1029) in the editor: **Open Tickerplant Log**
// starts a q of its own (`q-lint.terminal.qBinary`, in a new temporary
// directory, listening on the loopback only), has it read the log, and shows
// the messages in a panel: filtered by table and time of day, paged, each
// shown in full when picked and stepped through with Previous and Next, and
// a range of them replayed. `tplog.ts` has the q.
//
// The log and the replay stay in that q: nothing is sent to any process of
// yours, and the read-only guard has nothing to guard. A replay asks first,
// and can load a q file before it - the tickerplant's schema, its `upd` -
// into the same q. The q is stopped, and its directory removed, when the
// panel closes, when another log is opened, and when the feature is turned
// off (q-lint.tickerplantLog.enable).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Uri, ViewColumn, commands, window, workspace, type ExtensionContext, type Webview, type WebviewPanel } from "vscode";
import { DB_COMMANDS, dbOff, dbOn } from "./dbfeatures";
import { readTerminal } from "./liveconfig";
import { QConnection } from "./qclient";
import { mergeEnv } from "./qenv";
import { dotenvFor, layoutEnvFor } from "./qenvironment";
import { qBinaryFrom } from "./terminal";
import { TPLOG_INIT, rangeProblem, readReplayed, readTpLog, readTpPage, timeOfDay, type TpLog } from "./tplog";
import { plainMessage } from "./history";

const on = (): boolean => dbOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "tickerplantLog");

/// Messages a page lists.
export const TPLOG_PAGE = 200;

function say(message: string): string {
  void window.showInformationMessage(plainMessage(message));
  return message;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/// A q started for one log, and the connection to it.
interface LocalQ {
  child: ChildProcess;
  dir: string;
  port: number;
  connection: QConnection;
  output: string;
}

/// Start a q listening on the loopback with `TPLOG_INIT` loaded, and
/// connect to it. Throws why it could not. The loopback is open to every
/// local user, and the q runs code as you: it takes only a password made
/// for this start (`.z.pw`), which is in its init file - in a directory
/// only you can read - and never shown or kept (#1574). q answers no
/// connection before the init file has run.
export async function startLocalQ(binary: string, env: Record<string, string>, timeoutMs = 15_000): Promise<LocalQ> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qlint-tplog-"));
  const init = path.join(dir, "qlint_tplog.q");
  const password = randomBytes(24).toString("hex");
  writeFileSync(init, `.z.pw:{[u;p] p~"${password}"};\n${TPLOG_INIT}\n`, { mode: 0o600 });
  const port = await freePort();
  const child = spawn(binary, [init, "-p", `127.0.0.1:${port}`], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const local = { child, dir, port, output: "" } as LocalQ;
  child.stdout?.on("data", (d) => (local.output = (local.output + String(d)).slice(-2000)));
  child.stderr?.on("data", (d) => (local.output = (local.output + String(d)).slice(-2000)));
  let failed: Error | undefined;
  child.once("error", (error) => (failed = error));
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (failed !== undefined || child.exitCode !== null) {
      stopLocalQ(local);
      throw new Error(`the local q did not start (${binary}): ${failed?.message ?? (local.output.trim() || `exit code ${child.exitCode}`)}`);
    }
    try {
      local.connection = await QConnection.open({ host: "127.0.0.1", port, user: "qlint", password }, 1000);
      return local;
    } catch {
      if (Date.now() > until) {
        stopLocalQ(local);
        throw new Error(`the local q did not listen within ${timeoutMs / 1000} s: ${local.output.trim()}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export function stopLocalQ(local: LocalQ): void {
  local.connection?.abort();
  const remove = (): void => {
    try {
      rmSync(local.dir, { recursive: true, force: true });
    } catch {
      // Left for the system's temporary directory to clear.
    }
  };
  // On Windows a q's directory cannot be removed while the q runs, and a
  // kill does not wait for it to exit: removed again once it has (#1287).
  if (local.child.pid !== undefined && local.child.exitCode === null && local.child.signalCode === null) local.child.once("exit", remove);
  if (local.child.exitCode === null) local.child.kill("SIGKILL");
  remove();
}

export class TickerplantLog {
  private panel: WebviewPanel | undefined;
  private local: LocalQ | undefined;
  private log: (TpLog & { file: string }) | undefined;
  /// Bumped by every stop: an open that started before one is superseded,
  /// and stops the q it started (#1074).
  private generation = 0;
  /// The page's calls to the local q, one after another: its connection
  /// takes one at a time, and a click during a page load waits (#1112).
  private calls: Promise<unknown> = Promise.resolve();
  /// What the page was last sent, for tests.
  posted: unknown[] = [];

  constructor(private readonly context: ExtensionContext) {
    context.subscriptions.push(
      commands.registerCommand(DB_COMMANDS.openTpLog, (file?: unknown) => this.open(file instanceof Uri ? file.fsPath : typeof file === "string" ? file : undefined)),
      workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.tickerplantLog") && !on() && this.close()),
      { dispose: () => this.close() },
    );
  }

  /// The local q's port while one runs, for tests and the page.
  get port(): number | undefined {
    return this.local?.port;
  }

  async open(given?: string): Promise<string> {
    if (!on()) return say(dbOff("tickerplantLog"));
    const file = given ?? (await window.showOpenDialog({ canSelectMany: false, title: "Open which tickerplant log?" }))?.[0]?.fsPath;
    if (file === undefined) return "cancelled";
    this.stop();
    const opening = this.generation;
    // The folder's q binary, as the folder it starts in (#1333).
    const folder = workspace.workspaceFolders?.[0]?.uri;
    const configuration = workspace.getConfiguration("q-lint", folder);
    const { qBinary } = readTerminal((key, fallback) => configuration.get(key, fallback));
    const binary = qBinaryFrom(qBinary, folder?.fsPath, os.homedir());
    if (binary === undefined) {
      return say(`q-lint: q-lint.terminal.qBinary ${qBinary} is relative, and there is no workspace folder to read it from.`);
    }
    let local: LocalQ | undefined;
    try {
      local = await startLocalQ(binary, mergeEnv(layoutEnvFor(binary, folder), await dotenvFor(folder)));
      if (opening !== this.generation) {
        stopLocalQ(local);
        return "superseded";
      }
      this.local = local;
      const read = readTpLog(await local.connection.call(".qlint.tp.load", file));
      // A stop since has stopped this q already.
      if (opening !== this.generation) return "superseded";
      this.log = { ...read, file };
    } catch (error) {
      if (opening !== this.generation) {
        if (local !== undefined) stopLocalQ(local);
        return "superseded";
      }
      this.stop();
      return say(`q-lint: could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!on()) {
      this.stop();
      return say(dbOff("tickerplantLog"));
    }
    this.show();
    return `${this.log.count} messages`;
  }

  private show(): void {
    const title = `Tickerplant log: ${path.basename(this.log!.file)}`;
    if (this.panel === undefined) {
      this.panel = window.createWebviewPanel("q-lint.tickerplantLog", title, ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [Uri.joinPath(this.context.extensionUri, "media")],
      });
      this.panel.webview.html = tplogHtml(this.panel.webview, Uri.joinPath(this.context.extensionUri, "media"));
      this.panel.webview.onDidReceiveMessage((m: unknown) => void this.received(m));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.stop();
      });
    } else {
      this.panel.title = title;
      this.panel.reveal();
      // The page lists the new log from its start, not the last one's (#1258).
      void this.received({ type: "ready" });
    }
  }

  private async post(m: unknown): Promise<void> {
    this.posted.push(m);
    await this.panel?.webview.postMessage(m);
  }

  /// `expression` on `local`, after the page's calls before it.
  private call(local: LocalQ, expression: string, ...args: unknown[]): Promise<unknown> {
    const run = this.calls.then(() => local.connection.call(expression, ...args));
    this.calls = run.catch(() => undefined);
    return run;
  }

  private stop(): void {
    this.generation++;
    if (this.local !== undefined) stopLocalQ(this.local);
    this.local = undefined;
    this.log = undefined;
  }

  close(): void {
    this.stop();
    this.panel?.dispose();
    this.panel = undefined;
  }

  /// Hand a message to the panel as its page would, for tests.
  receive(m: unknown): Promise<void> {
    return this.received(m);
  }

  private async received(m: unknown): Promise<void> {
    const msg = m as Record<string, unknown>;
    const local = this.local;
    if (local === undefined || this.log === undefined || !on()) return;
    try {
      switch (msg.type) {
        case "ready":
          await this.post({ type: "log", log: this.log, port: local.port });
          await this.page(local, "", "", "", 0);
          break;
        case "page":
          await this.page(local, String(msg.table ?? ""), String(msg.from ?? ""), String(msg.to ?? ""), Number(msg.offset ?? 0));
          break;
        case "show": {
          const index = Number(msg.index);
          if (!Number.isInteger(index) || index < 0 || index >= this.log.count) return;
          const lines = await this.call(local, ".qlint.tp.show", index, 200);
          await this.post({ type: "message", index, text: ([] as unknown[]).concat(lines).map(String).join("\n") });
          break;
        }
        case "schema": {
          const file = (await window.showOpenDialog({ canSelectMany: false, filters: { q: ["q", "k"] }, title: "Load which q file into the local q first?" }))?.[0];
          if (file === undefined || this.local !== local) return;
          // A name with a space in it cannot be `\l`ed even from its own
          // directory: a copy of it under a plain name in the local q's is.
          let [dir, name] = [path.dirname(file.fsPath), path.basename(file.fsPath)];
          if (/\s/.test(name)) {
            copyFileSync(file.fsPath, path.join(local.dir, "qlint_schema.q"));
            [dir, name] = [local.dir, "qlint_schema.q"];
          }
          await this.call(local, ".qlint.tp.schema", dir, name);
          await this.post({ type: "status", text: `Loaded ${path.basename(file.fsPath)} into the local q.` });
          break;
        }
        case "replay":
          await this.replay(Number(msg.from), Number(msg.to));
          break;
      }
    } catch (error) {
      await this.post({ type: "status", text: `Failed: ${error instanceof Error ? error.message : String(error)}`, failed: true });
    }
  }

  private async page(local: LocalQ, table: string, from: string, to: string, offset: number): Promise<void> {
    const t0 = timeOfDay(from);
    const t1 = timeOfDay(to);
    if (t0 === undefined || t1 === undefined) {
      await this.post({ type: "status", text: "A time of day is HH:MM, HH:MM:SS or HH:MM:SS.mmm.", failed: true });
      return;
    }
    const page = readTpPage(await this.call(local, ".qlint.tp.page", table, t0 ?? NaN, t1 ?? NaN, Math.max(0, offset), TPLOG_PAGE));
    await this.post({ type: "page", offset: Math.max(0, offset), size: TPLOG_PAGE, ...page });
  }

  /// Replay messages `from` to `to` into the local q, after asking.
  async replay(from: number, to: number, confirmed = false): Promise<string> {
    if (!on()) return say(dbOff("tickerplantLog"));
    const local = this.local;
    if (local === undefined || this.log === undefined) return say("q-lint: open a tickerplant log first.");
    const problem = rangeProblem(from, to, this.log.count);
    if (problem !== undefined) {
      await this.post({ type: "status", text: `Not replayed: ${problem}.`, failed: true });
      return problem;
    }
    if (!confirmed) {
      const yes = "Replay";
      const answer = await window.showWarningMessage(
        plainMessage(`Replay messages ${from} to ${to} into the local q on port ${local.port}?`),
        { modal: true, detail: "Each runs as -11! would run it, in the q q-lint started for this log; nothing is sent to your processes. Without a schema loaded first, a table is made from its first message." },
        yes,
      );
      if (answer !== yes) return "not replayed";
    }
    if (this.local !== local || !on()) return "not replayed";
    const r = readReplayed(await this.call(local, ".qlint.tp.replay", from, to));
    const text = `Replayed ${r.replayed} messages${r.failed ? `, ${r.failed} failed (${r.errors.join("; ")})` : ""}. The local q on port ${local.port} now holds ${r.tables.map((t) => `${t.name} ${t.rows.toLocaleString("en-US")} rows`).join(", ") || "no tables"}.`;
    await this.post({ type: "status", text, failed: r.failed > 0 });
    return text;
  }
}

function tplogHtml(webview: Webview, media: Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const file = (name: string): string => webview.asWebviewUri(Uri.joinPath(media, name)).toString();
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${file("tplog.css")}">`,
    "<title>q-lint: tickerplant log</title></head><body>",
    `<script nonce="${nonce}" src="${file("tplog.js")}"></script>`,
    "</body></html>",
  ].join("\n");
}
