// Run Query Asynchronously (#1037): the editor's selection, or the
// statement at the cursor, sent as an async message whose result comes
// back through the connection's async listener and opens in the result
// panel when it is ready - while the connection stays free for other
// queries. Sent through `Live.runOnActive`, so the read-only guard reads it
// first. A status bar item counts the results still to come; Show Pending
// Async Queries lists them, and forgets one whose result is no longer
// wanted. q cannot cancel a query it is running, so forgetting only drops
// the result when it comes. A connection that closes takes its pending
// results with it, and says so.
import { StatusBarAlignment, commands, window, workspace, type Disposable, type ExtensionContext, type StatusBarItem } from "vscode";
import { ADMIN_COMMANDS, adminOff, readAdmin } from "./admin";
import { ASYNC, readAsyncMessage, textPayload } from "./asyncquery";
import { elapsedText } from "./progress";
import type { Live } from "./live";
import { readLive } from "./liveconfig";
import { statements } from "./statements";
import { iconsEscaped, plainMessage } from "./history";
import { DirectRefused, directRefusal } from "./qclient";

const on = (): boolean => readAdmin((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).asyncQuery;

interface Pending {
  id: number;
  process: string;
  code: string;
  started: number;
}

export class AsyncQueries {
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  private listeners: Disposable[] = [];
  private item: StatusBarItem | undefined;
  /// What results arrived, newest last, for tests and the e2e run.
  private readonly arrived: { process: string; code: string; ok: boolean; rows?: number }[] = [];

  constructor(
    context: ExtensionContext,
    private readonly live: Pick<Live, "runOnActive" | "onAsyncMessage" | "onDidChange" | "showGrid" | "record" | "codeFromEditor"> & Partial<Pick<Live, "activeDirect" | "gatewayRefusal">>,
  ) {
    context.subscriptions.push(
      commands.registerCommand(ADMIN_COMMANDS.runAsync, (code?: string) => this.run(code)),
      commands.registerCommand(ADMIN_COMMANDS.pendingAsync, () => this.showPending()),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.query.async")) {
          this.sync();
        }
      }),
      { dispose: () => this.stop() },
    );
    this.sync();
  }

  state(): { pending: { process: string; code: string }[]; arrived: { process: string; code: string; ok: boolean; rows?: number }[] } {
    return { pending: [...this.pending.values()].map(({ process, code }) => ({ process, code })), arrived: [...this.arrived] };
  }

  private sync(): void {
    if (!on()) {
      this.stop();
      return;
    }
    if (this.listeners.length === 0) {
      this.listeners = [
        this.live.onAsyncMessage((message) => void this.arrive(message)),
        this.live.onDidChange((what) => {
          if (what === "disconnected" && this.pending.size > 0) {
            void window.showWarningMessage(plainMessage(`q-lint: the connection closed; ${this.pending.size} asynchronous result(s) will not arrive.`));
            this.pending.clear();
            this.showCount();
          }
        }),
      ];
    }
  }

  /// Turned off: listen no more, and forget what was pending.
  private stop(): void {
    for (const l of this.listeners) {
      l.dispose();
    }
    this.listeners = [];
    this.pending.clear();
    this.item?.dispose();
    this.item = undefined;
  }

  /// Send `code` (given, or the editor's) as an async query on the active
  /// connection. The id it was sent under, or undefined when nothing was.
  async run(given?: string): Promise<number | undefined> {
    if (!on()) {
      void window.showInformationMessage(plainMessage(adminOff("asyncQuery")));
      return undefined;
    }
    const code = typeof given === "string" ? given : await this.live.codeFromEditor();
    if (code === undefined) {
      return undefined;
    }
    const cut = statements(code);
    if (cut.length === 0) {
      void window.showInformationMessage("q-lint: nothing to run: it is blank or a comment.");
      return undefined;
    }
    // The answer comes back from q-lint's lambda, which a direct process is
    // never sent (#2470): refused before the guard asks. A process connected
    // to for this run is refused by the connection, before it sends.
    const direct = this.live.activeDirect?.();
    if (direct !== undefined) {
      void window.showErrorMessage(plainMessage(`q-lint: Run Query Asynchronously: ${directRefusal(direct)}`));
      return undefined;
    }
    // On a TorQ gateway it would run on the gateway itself (#2357).
    const refused = this.live.gatewayRefusal?.("Run Query Asynchronously", code);
    if (refused !== undefined) {
      void window.showErrorMessage(plainMessage(refused));
      return undefined;
    }
    const configuration = workspace.getConfiguration("q-lint");
    const { consoleSize, gridLimit } = readLive((key, fallback) => configuration.get(key, fallback));
    const id = this.next++;
    let sent: { process: string; value: number | undefined } | undefined;
    try {
      sent = await this.live.runOnActive(code, async (connection) => {
        // Turned off at the pick or the guard: nothing is sent (#1454).
        if (!on()) {
          return undefined;
        }
        connection.sendAsync(ASYNC, id, cut, consoleSize, Number.isFinite(gridLimit) ? gridLimit : 0);
        return id;
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      void window.showErrorMessage(plainMessage(`q-lint: ${error instanceof DirectRefused ? `Run Query Asynchronously: ${why}` : why}`));
      return undefined;
    }
    if (sent === undefined) {
      return undefined;
    }
    if (sent.value === undefined) {
      void window.showInformationMessage(plainMessage(adminOff("asyncQuery")));
      return undefined;
    }
    this.pending.set(id, { id, process: sent.process, code, started: Date.now() });
    this.showCount();
    void window.showInformationMessage(plainMessage(`q-lint: sent to ${sent.process} asynchronously; the result opens when it is ready.`));
    return id;
  }

  private async arrive(message: Buffer): Promise<void> {
    const read = readAsyncMessage(message);
    const p = read === undefined ? undefined : this.pending.get(read.id);
    if (read === undefined || p === undefined) {
      return;
    }
    this.pending.delete(read.id);
    this.showCount();
    const millis = Date.now() - p.started;
    const { answer } = read;
    if (answer.ok) {
      const grid = answer.grid ?? textPayload(answer.text);
      this.live.showGrid(p.process, p.code, grid, millis);
      this.arrived.push({ process: p.process, code: p.code, ok: true, rows: grid.count });
    } else {
      this.arrived.push({ process: p.process, code: p.code, ok: false });
      void window.showWarningMessage(plainMessage(`q-lint: the asynchronous query on ${p.process} failed: '${answer.error}`));
    }
    await this.live.record({
      process: p.process,
      code: p.code,
      at: new Date(p.started).toISOString(),
      millis,
      outcome: answer.ok ? "ok" : "error",
      ...(answer.ok ? {} : { error: answer.error }),
    });
  }

  private showCount(): void {
    if (this.pending.size === 0) {
      this.item?.hide();
      return;
    }
    this.item ??= window.createStatusBarItem("q-lint.asyncQueries", StatusBarAlignment.Left, 48);
    this.item.name = "q-lint: asynchronous queries";
    this.item.text = `$(watch) ${this.pending.size} async`;
    this.item.tooltip = `${this.pending.size} asynchronous quer${this.pending.size === 1 ? "y" : "ies"} still to answer. Click to list them.`;
    this.item.command = ADMIN_COMMANDS.pendingAsync;
    this.item.show();
  }

  /// List the queries still to answer; the one picked can be forgotten.
  async showPending(): Promise<void> {
    if (!on()) {
      void window.showInformationMessage(plainMessage(adminOff("asyncQuery")));
      return;
    }
    if (this.pending.size === 0) {
      void window.showInformationMessage("q-lint: no asynchronous query is waiting for its result.");
      return;
    }
    const picked = await window.showQuickPick(
      [...this.pending.values()].map((p) => {
        // Its first line of code, not a blank one the selection began with
        // (#1933); by code point, never inside a surrogate pair (#1473).
        const line = Array.from(p.code.trim().split(/\r?\n/)[0].trimEnd()).slice(0, 80).join("");
        return {
          line,
          label: iconsEscaped(line),
          description: iconsEscaped(`${p.process}, ${elapsedText(Date.now() - p.started)}`),
          id: p.id,
        };
      }),
      { title: "Asynchronous queries waiting for their result: pick one to forget it" },
    );
    if (picked === undefined) {
      return;
    }
    const forget = "Forget Result";
    if ((await window.showInformationMessage(plainMessage(`Forget the result of "${picked.line}"? q runs it to the end anyway: q cannot cancel a running query.`), { modal: true }, forget)) === forget) {
      this.pending.delete(picked.id);
      this.showCount();
    }
  }
}
