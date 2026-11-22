// A small tree view for the process tools (#1042-#1046): rows read from a
// process, with children given or loaded when expanded. Created while its
// feature's setting is on and disposed when it is turned off, so a view
// turned off holds nothing and reads nothing.
import {
  EventEmitter,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  commands,
  window,
  workspace,
  type Command,
  type ExtensionContext,
  type TreeDataProvider,
  type TreeView,
} from "vscode";
import { toolOn, type ProcessTool } from "./processtools";

export interface ToolNode {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  contextValue?: string;
  command?: Command;
  children?: ToolNode[];
  /// Children read when the row is first expanded.
  load?: () => Promise<ToolNode[]>;
  /// Anything the commands on the row need.
  data?: unknown;
}

class Provider implements TreeDataProvider<ToolNode> {
  readonly changed = new EventEmitter<ToolNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  roots: ToolNode[] = [];

  getChildren(node?: ToolNode): ToolNode[] | Promise<ToolNode[]> {
    if (node === undefined) {
      return this.roots;
    }
    if (node.children === undefined && node.load !== undefined) {
      return node.load().then(
        (children) => (node.children = children),
        (error: unknown) => [{ label: `could not read: ${error instanceof Error ? error.message : String(error)}`, icon: "warning" }],
      );
    }
    return node.children ?? [];
  }

  getTreeItem(node: ToolNode): TreeItem {
    const item = new TreeItem(
      node.label,
      node.children !== undefined && node.children.length > 0
        ? TreeItemCollapsibleState.Expanded
        : node.load !== undefined
          ? TreeItemCollapsibleState.Collapsed
          : TreeItemCollapsibleState.None,
    );
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = node.contextValue;
    item.command = node.command;
    if (node.icon !== undefined) {
      item.iconPath = new ThemeIcon(node.icon);
    }
    return item;
  }
}

/// A tree view `id`, there while `feature` is on.
export class ToolTree {
  private provider: Provider | undefined;
  private view: TreeView<ToolNode> | undefined;
  private message: string | undefined;

  constructor(
    context: ExtensionContext,
    private readonly id: string,
    private readonly feature: ProcessTool,
  ) {
    context.subscriptions.push(
      workspace.onDidChangeConfiguration(() => this.sync()),
      { dispose: () => this.close() },
    );
    this.sync();
  }

  get open(): boolean {
    return this.view !== undefined;
  }

  /// The rows shown, for tests.
  get roots(): ToolNode[] {
    return this.provider?.roots ?? [];
  }

  get shownMessage(): string | undefined {
    return this.message;
  }

  /// Show `roots`, and `message` above them (or none). Empty and without
  /// a message, the view shows its welcome (package.json's viewsWelcome).
  show(roots: ToolNode[], message?: string): void {
    if (this.provider === undefined || this.view === undefined) {
      return;
    }
    this.provider.roots = roots;
    this.message = message;
    this.view.message = message;
    this.provider.changed.fire(undefined);
  }

  /// Bring the view into sight.
  async reveal(): Promise<void> {
    if (this.view !== undefined) {
      await Promise.resolve(commands.executeCommand(`${this.id}.focus`)).catch(() => undefined);
    }
  }

  private on(): boolean {
    const configuration = workspace.getConfiguration("q-lint");
    return toolOn((key, fallback) => configuration.get(key, fallback), this.feature);
  }

  private sync(): void {
    const on = this.on();
    if (on && this.view === undefined) {
      this.provider = new Provider();
      this.view = window.createTreeView(this.id, { treeDataProvider: this.provider });
    } else if (!on && this.view !== undefined) {
      this.close();
    }
  }

  private close(): void {
    this.view?.dispose();
    this.provider?.changed.dispose();
    this.view = undefined;
    this.provider = undefined;
    this.message = undefined;
  }
}
