// The Process Monitor (#932) and the HDB browser (#931): two views of the
// connected process, each read in one call (`monitor.ts`, `hdb.ts`) when
// it is shown, when a connection opens while it is shown, and on Refresh.
// Like the Process Explorer they share the one connection queries use, and
// never interrupt a query: a read that finds it busy waits a moment, and
// then leaves the view as it was. Each is created only while its setting
// (`insightconfig.ts`) is on, and disposed when it is turned off.
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
import { HDB, HDB_PARTITIONS, hdbTree, readHdb } from "./hdb";
import type { Live } from "./live";
import { INFO, MONITOR, monitorTree, readMonitorInterval, type InfoNode } from "./monitor";
import type { QConnection } from "./qclient";
import type { Process } from "./processes";
import { readInsight, turnedOff, type InsightFeature } from "./insightconfig";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// Run `use` on the active connection as `Live.borrow` does, waiting up to
/// `wait` ms for a query or another view's read to finish first. Undefined
/// when not connected, or still busy after that.
export async function borrowWhenFree<T>(
  live: Live,
  use: (connection: QConnection, process: Process) => Promise<T>,
  wait = 3000,
): Promise<{ value: T } | undefined> {
  for (let waited = 0; ; waited += 100) {
    const call = live.borrow(use);
    if (call !== undefined) {
      return { value: await call };
    }
    if (live.activeLabel() === undefined || waited >= wait) {
      return undefined;
    }
    await sleep(100);
  }
}

class InfoView implements TreeDataProvider<InfoNode> {
  private readonly changed = new EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: TreeView<InfoNode>;
  private kept: { process: string; nodes: InfoNode[] } | undefined;
  /// The read out, which a second refresh waits for.
  private reading: Promise<void> | undefined;
  private readonly disposables: { dispose(): unknown }[];

  constructor(
    id: string,
    private readonly live: Live,
    private readonly read: (connection: QConnection, process: Process) => Promise<InfoNode[]>,
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

  /// The tree as it stands, for the read-only API.
  rows(): InfoNode[] {
    return this.kept === undefined || this.kept.process !== this.live.activeLabel() ? [] : this.kept.nodes;
  }

  /// Read the process again, or wait for the read already out. `asked`: by
  /// Refresh, which says why when it could not.
  refresh(asked = false): Promise<void> {
    if (this.live.activeLabel() === undefined) {
      return Promise.resolve();
    }
    this.reading ??= this.readNow(asked).finally(() => (this.reading = undefined));
    return this.reading;
  }

  private async readNow(asked: boolean): Promise<void> {
    try {
      const got = await borrowWhenFree(this.live, async (connection, process) => ({ process: process.label, nodes: await this.read(connection, process) }));
      if (got === undefined) {
        if (asked && this.live.activeLabel() !== undefined) {
          void window.showInformationMessage(`q-lint: ${this.live.activeLabel()} is busy with a query; refresh again when it is done.`);
        }
        return;
      }
      this.kept = got.value;
      this.view.message = undefined;
    } catch (error) {
      this.kept = undefined;
      this.view.message = `Could not read ${this.live.activeLabel() ?? "the process"}: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.show();
    }
  }

  private show(): void {
    if (this.live.activeLabel() === undefined) {
      this.kept = undefined;
      this.view.message = undefined;
    }
    this.view.description = this.kept?.process;
    this.changed.fire();
  }

  getChildren(node?: InfoNode): InfoNode[] {
    return node === undefined ? this.rows() : (node.children ?? []);
  }

  getTreeItem(node: InfoNode): TreeItem {
    const item = new TreeItem(node.label, node.children?.length ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip ?? (node.description ? `${node.label}: ${node.description}` : undefined);
    if (node.icon !== undefined) {
      item.iconPath = new ThemeIcon(node.icon);
    }
    return item;
  }
}

/// One of the views, made while its setting is on and disposed when it is
/// turned off; its Refresh command refuses while it is off.
class Switched {
  view: InfoView | undefined;

  constructor(
    context: ExtensionContext,
    private readonly feature: InsightFeature,
    refresh: string,
    private readonly make: () => InfoView,
  ) {
    context.subscriptions.push(
      commands.registerCommand(refresh, () => (this.view === undefined ? void window.showInformationMessage(turnedOff(feature)) : this.view.refresh(true))),
      { dispose: () => this.view?.dispose() },
    );
    this.apply();
  }

  apply(): void {
    const configuration = workspace.getConfiguration("q-lint");
    const on = readInsight((key, fallback) => configuration.get(key, fallback))[this.feature];
    if (on && this.view === undefined) {
      this.view = this.make();
    } else if (!on && this.view !== undefined) {
      this.view.dispose();
      this.view = undefined;
    }
  }
}

/// The Process Monitor and the HDB browser, registered.
export function registerInfoViews(context: ExtensionContext, live: Live): { monitor: () => InfoNode[]; hdb: () => InfoNode[] } {
  const monitor = new Switched(
    context,
    "processMonitor",
    INFO.refreshMonitor,
    () => new InfoView(INFO.monitor, live, async (connection, process) => monitorTree(await connection.call(MONITOR, null), process.label)),
  );
  const hdb = new Switched(
    context,
    "hdbBrowser",
    INFO.refreshHdb,
    () => new InfoView(INFO.hdb, live, async (connection, process) => hdbTree(readHdb(await connection.call(HDB, HDB_PARTITIONS)), process.label)),
  );
  // The Monitor's own timer, running only while it is on and shown.
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearInterval(timer);
    const configuration = workspace.getConfiguration("q-lint");
    const seconds = readMonitorInterval((key, fallback) => configuration.get(key, fallback));
    timer = seconds === 0 || monitor.view === undefined ? undefined : setInterval(() => monitor.view?.view.visible && void monitor.view.refresh(), seconds * 1000);
  };
  arm();
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("q-lint.processMonitor") || event.affectsConfiguration("q-lint.hdbBrowser")) {
        monitor.apply();
        hdb.apply();
        arm();
      }
    }),
  );
  return { monitor: () => monitor.view?.rows() ?? [], hdb: () => hdb.view?.rows() ?? [] };
}
