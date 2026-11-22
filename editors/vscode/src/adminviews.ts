// The Connected Clients (#1040) and Timers (#1041) views of the connected
// process. Each is read in one call - a fixed read-only lambda, borrowed
// as the Process Explorer borrows the connection (`borrowWhenFree`), so a
// query is never interrupted - when shown, when a connection opens while it
// is shown, on Refresh, and after a change. A change - closing a handle,
// turning a TorQ timer job on or off, setting `\t` - is sent through
// `Live.runOnActive`, so the read-only guard reads it; closing a handle,
// which the guard's reading does not take for a write, is refused outright
// on a guarded process, and asked about on any other. Each view is created
// only while its switch is on, and disposed when it is turned off.
import {
  EventEmitter,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  commands,
  window,
  workspace,
  type ExtensionContext,
  type TreeDataProvider,
  type TreeView,
} from "vscode";
import { ADMIN_COMMANDS, ADMIN_VIEWS, adminOff, readAdmin, type AdminFeature } from "./admin";
import { CLIENTS, clientDescription, closeCode, readClients } from "./clients";
import { guardedBy, readGuard } from "./guard";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { readLive } from "./liveconfig";
import type { Process } from "./processes";
import type { QConnection } from "./qclient";
import { statements } from "./statements";
import { TIMERS, intervalCode, intervalProblem, readTimers, toggleCode } from "./timers";

/// A row of either view: what it shows, and what its commands act on.
export interface AdminNode {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  contextValue?: string;
  handle?: number;
  job?: { id: number; active: boolean };
  interval?: number;
}

type Live_ = Pick<Live, "activeLabel" | "activeProcess" | "borrow" | "onDidChange" | "runOnActive">;

class AdminView implements TreeDataProvider<AdminNode> {
  private readonly changed = new EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: TreeView<AdminNode>;
  private kept: { process: string; nodes: AdminNode[]; message?: string } | undefined;
  private reading: Promise<void> | undefined;
  private readonly disposables: { dispose(): unknown }[];

  constructor(
    id: string,
    private readonly live: Live_,
    private readonly read: (connection: QConnection, process: Process) => Promise<{ nodes: AdminNode[]; message?: string }>,
  ) {
    this.view = window.createTreeView(id, { treeDataProvider: this });
    this.disposables = [
      this.view,
      this.changed,
      this.view.onDidChangeVisibility(() => {
        if (this.view.visible && this.kept?.process !== live.activeLabel()) {
          void this.refresh();
        }
      }),
      live.onDidChange((what) => {
        if (what === "disconnected") {
          this.kept = undefined;
          this.show();
        } else if (what === "connected" && this.view.visible) {
          void this.refresh();
        }
      }),
    ];
    this.show();
    if (this.view.visible) {
      void this.refresh();
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  rows(): AdminNode[] {
    return this.kept === undefined || this.kept.process !== this.live.activeLabel() ? [] : this.kept.nodes;
  }

  refresh(asked = false): Promise<void> {
    if (this.live.activeLabel() === undefined) {
      if (asked) {
        void window.showInformationMessage("q-lint: connect to a q process first.");
      }
      return Promise.resolve();
    }
    this.reading ??= this.readNow(asked).finally(() => (this.reading = undefined));
    return this.reading;
  }

  private async readNow(asked: boolean): Promise<void> {
    try {
      const got = await borrowWhenFree(this.live as Live, async (connection, process) => ({ process: process.label, ...(await this.read(connection, process)) }));
      if (got === undefined) {
        if (asked && this.live.activeLabel() !== undefined) {
          void window.showInformationMessage(`q-lint: ${this.live.activeLabel()} is busy with a query; refresh again when it is done.`);
        }
        return;
      }
      this.kept = got.value;
    } catch (error) {
      this.kept = { process: this.live.activeLabel() ?? "", nodes: [], message: `Could not read ${this.live.activeLabel() ?? "the process"}: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      this.show();
    }
  }

  private show(): void {
    if (this.live.activeLabel() === undefined) {
      this.kept = undefined;
    }
    this.view.message = this.kept?.message;
    this.view.description = this.kept?.process;
    this.changed.fire();
  }

  getChildren(node?: AdminNode): AdminNode[] {
    return node === undefined ? this.rows() : [];
  }

  getTreeItem(node: AdminNode): TreeItem {
    const item = new TreeItem(node.label, TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip ?? (node.description ? `${node.label}: ${node.description}` : node.label);
    item.contextValue = node.contextValue;
    if (node.icon !== undefined) {
      item.iconPath = new ThemeIcon(node.icon);
    }
    return item;
  }
}

/// A view made while its switch is on and disposed when it is turned off.
class Switched {
  view: AdminView | undefined;

  constructor(
    private readonly feature: AdminFeature,
    private readonly make: () => AdminView,
  ) {
    this.apply();
  }

  on(): boolean {
    return readAdmin((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback))[this.feature];
  }

  apply(): void {
    if (this.on() && this.view === undefined) {
      this.view = this.make();
    } else if (!this.on() && this.view !== undefined) {
      this.view.dispose();
      this.view = undefined;
    }
  }

  /// The view, or undefined having said the feature is off.
  live(): AdminView | undefined {
    if (this.view === undefined) {
      void window.showInformationMessage(adminOff(this.feature));
    }
    return this.view;
  }
}

async function readClientNodes(connection: QConnection): Promise<{ nodes: AdminNode[]; message?: string }> {
  const { rows, tracked } = readClients(await connection.call(CLIENTS, null));
  return {
    nodes: rows.map((row) => ({
      label: `handle ${row.handle}`,
      description: clientDescription(row),
      icon: row.self ? "plug" : "person",
      contextValue: row.self ? "clientSelf" : "client",
      handle: row.handle,
    })),
    ...(rows.length === 0 ? { message: "No open handles." } : !tracked ? { message: "q keeps no address or user for another client's handle; TorQ's .clients records them." } : {}),
  };
}

async function readTimerNodes(connection: QConnection): Promise<{ nodes: AdminNode[] }> {
  const state = readTimers(await connection.call(TIMERS, null));
  return {
    nodes: [
      {
        label: "q timer (\\t)",
        description: state.interval > 0 ? `every ${state.interval} ms${state.ts === "" ? ", no .z.ts" : ""}` : "off",
        tooltip: state.ts === "" ? "No .z.ts is set." : `.z.ts: ${state.ts}`,
        icon: state.interval > 0 ? "clock" : "circle-slash",
        contextValue: "qTimer",
        interval: state.interval,
      },
      ...state.jobs.map((job) => ({
        label: job.description !== "" ? job.description : job.func,
        description: `${job.active ? "" : "off · "}every ${job.period} · next ${job.nextrun}`,
        tooltip: [`TorQ timer ${job.id}${job.active ? "" : " (off)"}`, `runs ${job.func}`, `every ${job.period}`, `next ${job.nextrun}`, `last ${job.lastrun}`].join("\n"),
        icon: job.active ? "play-circle" : "debug-pause",
        contextValue: job.active ? "torqTimerOn" : "torqTimerOff",
        job: { id: job.id, active: job.active },
      })),
    ],
  };
}

export function registerAdminViews(context: ExtensionContext, live: Live_): { clients: () => AdminNode[]; timers: () => AdminNode[] } {
  const clients = new Switched("clientsView", () => new AdminView(ADMIN_VIEWS.clients, live, readClientNodes));
  const timers = new Switched("timerView", () => new AdminView(ADMIN_VIEWS.timers, live, readTimerNodes));

  /// Send `code` through the guard; whether it ran without a q error.
  const change = async (code: string, what: string): Promise<boolean> => {
    const { consoleSize } = readLive((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback));
    try {
      const ran = await live.runOnActive(code, (connection) => connection.query(statements(code), consoleSize));
      if (ran === undefined) {
        return false;
      }
      if (!ran.value.ok) {
        void window.showErrorMessage(`q-lint: could not ${what} on ${ran.process}: '${ran.value.error}`);
        return false;
      }
      return true;
    } catch (error) {
      void window.showInformationMessage(`q-lint: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const closeClient = async (node?: AdminNode): Promise<boolean> => {
    const view = clients.live();
    const process = live.activeProcess();
    if (view === undefined || process === undefined || node?.handle === undefined) {
      return false;
    }
    if (node.contextValue === "clientSelf") {
      void window.showInformationMessage("q-lint: that is this extension's own connection: Disconnect closes it.");
      return false;
    }
    const guarded = guardedBy(process, readGuard((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)));
    if (guarded.length > 0) {
      void window.showWarningMessage(
        `q-lint: ${process.label} is read-only (tagged ${guarded.join(", ")}): its clients' handles are not closed from here. q-lint.processes.readOnlyGuard.tags names the tags it guards.`,
      );
      return false;
    }
    const yes = "Close Handle";
    if ((await window.showWarningMessage(`Close handle ${node.handle} on ${process.label}? The client it belongs to is disconnected.`, { modal: true }, yes)) !== yes) {
      return false;
    }
    const done = await change(closeCode(node.handle), `close handle ${node.handle}`);
    await view.refresh();
    return done;
  };

  const toggleTimer = async (node?: AdminNode): Promise<boolean> => {
    const view = timers.live();
    if (view === undefined || node?.job === undefined) {
      return false;
    }
    const done = await change(toggleCode(node.job.id, !node.job.active), `${node.job.active ? "turn off" : "turn on"} timer ${node.job.id}`);
    await view.refresh();
    return done;
  };

  const setInterval_ = async (node?: AdminNode, given?: number): Promise<boolean> => {
    const view = timers.live();
    if (view === undefined || live.activeLabel() === undefined) {
      if (view !== undefined) {
        void window.showInformationMessage("q-lint: connect to a q process first.");
      }
      return false;
    }
    let ms = given;
    if (typeof ms !== "number") {
      const text = await window.showInputBox({
        title: `\\t on ${live.activeLabel()}`,
        value: node?.interval !== undefined ? String(node.interval) : "",
        prompt: "Milliseconds between .z.ts calls; 0 turns the timer off. Sent as system \"t N\", through the read-only guard.",
        validateInput: intervalProblem,
      });
      if (text === undefined) {
        return false;
      }
      ms = Number(text.trim());
    }
    const done = await change(intervalCode(ms), "set the timer");
    await view.refresh();
    return done;
  };

  context.subscriptions.push(
    commands.registerCommand(ADMIN_COMMANDS.refreshClients, () => clients.live()?.refresh(true)),
    commands.registerCommand(ADMIN_COMMANDS.closeClient, (node?: AdminNode) => closeClient(node)),
    commands.registerCommand(ADMIN_COMMANDS.refreshTimers, () => timers.live()?.refresh(true)),
    commands.registerCommand(ADMIN_COMMANDS.toggleTimer, (node?: AdminNode) => toggleTimer(node)),
    commands.registerCommand(ADMIN_COMMANDS.setTimerInterval, (node?: AdminNode, ms?: number) => setInterval_(node, ms)),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("q-lint.connectedClients") || event.affectsConfiguration("q-lint.timers")) {
        clients.apply();
        timers.apply();
      }
    }),
    { dispose: () => (clients.view?.dispose(), timers.view?.dispose()) },
  );
  return { clients: () => clients.view?.rows() ?? [], timers: () => timers.view?.rows() ?? [] };
}
