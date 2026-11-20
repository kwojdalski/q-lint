// The Process Explorer view and live completion (#854): the VS Code around
// `explorer.ts`. What the active process holds is read in one call - on
// connect, on Refresh, and after a query when auto refresh is on - and kept;
// the tree and completion both answer from what was kept, so typing never
// sends the process anything.
import {
  CompletionItem,
  CompletionItemKind,
  ConfigurationTarget,
  EventEmitter,
  languages,
  Range,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  commands,
  window,
  workspace,
  type ExtensionContext,
  type Position,
  type TextDocument,
  type TreeDataProvider,
  type TreeView,
} from "vscode";
import {
  EXPLORER,
  GATHER,
  LIMITS,
  explorerTree,
  liveCompletions,
  previewCode,
  qsqlTable,
  readExplorer,
  readGathered,
  type Completion,
  type Gathered,
  type Node,
} from "./explorer";
import type { Live } from "./live";
import { blockAt } from "./statements";

const ICONS: Record<Node["kind"], string> = {
  namespace: "symbol-namespace",
  group: "folder",
  table: "table",
  column: "symbol-field",
  function: "symbol-method",
  variable: "symbol-variable",
  note: "info",
};

const KINDS: Record<Completion["kind"], CompletionItemKind> = {
  table: CompletionItemKind.Struct,
  function: CompletionItemKind.Function,
  variable: CompletionItemKind.Variable,
  column: CompletionItemKind.Field,
};

const settings = () => {
  const configuration = workspace.getConfiguration("q-lint");
  return readExplorer((key, fallback) => configuration.get(key, fallback));
};

export class ProcessExplorer implements TreeDataProvider<Node> {
  private readonly changed = new EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: TreeView<Node>;
  /// What the active process held at the last refresh, and its label.
  private kept: { process: string; gathered: Gathered } | undefined;
  private problem: string | undefined;
  private refreshing = false;
  /// A refresh asked for while a query ran or another refresh was out,
  /// made once the connection is free.
  private owed = false;

  constructor(context: ExtensionContext, private readonly live: Live) {
    this.view = window.createTreeView(EXPLORER.view, { treeDataProvider: this });
    context.subscriptions.push(
      this.view,
      this.changed,
      commands.registerCommand(EXPLORER.refresh, () => this.refresh()),
      commands.registerCommand(EXPLORER.preview, (node?: Node) => this.preview(node)),
      commands.registerCommand(EXPLORER.toggleAutoRefresh, () =>
        workspace.getConfiguration("q-lint").update("processExplorer.autoRefresh", !settings().autoRefresh, ConfigurationTarget.Global),
      ),
      live.onDidChange((what) => {
        if (what === "connected") {
          void this.refresh();
        } else if (what === "disconnected") {
          this.kept = undefined;
          this.problem = undefined;
          this.show();
        } else if (this.owed || settings().autoRefresh) {
          void this.refresh();
        }
      }),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.processExplorer.excludedNamespaces")) {
          void this.refresh();
        } else if (event.affectsConfiguration("q-lint.processExplorer.autoRefresh")) {
          this.show();
        }
      }),
      // VS Code merges this provider's items with the language server's.
      languages.registerCompletionItemProvider({ language: "q" }, { provideCompletionItems: (d, p) => this.complete(d, p) }, "."),
    );
    this.show();
  }

  /// The tree as it stands, for the read-only API.
  rows(): Node[] {
    const kept = this.kept;
    return kept === undefined || kept.process !== this.live.activeLabel()
      ? []
      : explorerTree(kept.gathered, settings().excludedNamespaces);
  }

  /// Read the active process again.
  ///
  /// The explorer shares the one connection queries use, and q answers a
  /// handle's messages in order, so a second connection would only add a
  /// login on the process and still wait behind a long query. So the
  /// explorer never interrupts: while a query runs it skips, and owes a
  /// refresh that the query's end pays; and a query sent while the
  /// explorer's call is out waits for it (`Live.borrow`) rather than being
  /// refused. Neither ever shows the user an error for the other.
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.owed = true;
      return;
    }
    const { excludedNamespaces } = settings();
    const call = this.live.borrow(async (connection, process) => ({
      process: process.label,
      gathered: readGathered(await connection.call(GATHER, excludedNamespaces.join(" "), LIMITS)),
    }));
    if (call === undefined) {
      // Busy with a query, or not connected: `connected` will refresh.
      this.owed = this.live.activeLabel() !== undefined;
      return;
    }
    this.owed = false;
    this.refreshing = true;
    this.show();
    try {
      this.kept = await call;
      this.problem = undefined;
    } catch (error) {
      this.problem = error instanceof Error ? error.message : String(error);
    } finally {
      this.refreshing = false;
      this.show();
    }
    if (this.owed) {
      void this.refresh();
    }
  }

  private show(): void {
    const label = this.live.activeLabel();
    this.view.description = settings().autoRefresh ? "auto refresh" : undefined;
    // Not connected, the view is empty and its welcome content (package.json)
    // says so, with a link to connect.
    this.view.message =
      label === undefined
        ? undefined
        : this.problem !== undefined
          ? `Could not read ${label}: ${this.problem}`
          : this.refreshing && this.kept === undefined
            ? `Reading ${label}…`
            : undefined;
    if (label === undefined) {
      this.kept = undefined;
    }
    this.changed.fire();
  }

  private async preview(node?: Node): Promise<void> {
    const code = node === undefined ? undefined : previewCode(node, settings().previewLimit);
    if (code === undefined) {
      void window.showInformationMessage("q-lint: Preview shows a table or a variable of the Process Explorer.");
      return;
    }
    await this.live.run(code);
  }

  getChildren(node?: Node): Node[] {
    return node === undefined ? this.rows() : (node.children ?? []);
  }

  getTreeItem(node: Node): TreeItem {
    const open = node.kind === "namespace" && node.label === "." ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed;
    const item = new TreeItem(node.label, node.children?.length ? open : TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip;
    // A group (Tables, Functions, Variables) wears the icon of what it holds.
    const kind = node.kind === "group" && node.children?.length ? node.children[0].kind : node.kind;
    item.iconPath = new ThemeIcon(ICONS[kind]);
    item.contextValue = `explorer.${node.kind}`;
    return item;
  }

  private complete(document: TextDocument, position: Position): CompletionItem[] {
    const kept = this.kept;
    if (kept === undefined || this.live.activeLabel() !== kept.process) {
      return [];
    }
    const lines = document.getText().split(/\r?\n/);
    const block = blockAt(lines, position.line) ?? { start: position.line, end: position.line };
    const text = lines.slice(block.start, block.end + 1).join("\n");
    const offset = lines.slice(block.start, position.line).reduce((n, l) => n + l.length + 1, 0) + position.character;
    const table = qsqlTable(text, offset);
    // The word being typed, dots and all, so `.ns.f` replaces `.ns.` whole.
    const typed = /[.\w]*$/.exec(lines[position.line].slice(0, position.character))?.[0] ?? "";
    const range = new Range(position.line, position.character - typed.length, position.line, position.character);
    return liveCompletions(kept.gathered, kept.process, table).map((c) => {
      const item = new CompletionItem(c.label, KINDS[c.kind]);
      item.detail = c.detail;
      item.range = range;
      // A table's columns first, inside its statement.
      item.sortText = `${c.kind === "column" ? "0" : "1"}${c.label}`;
      return item;
    });
  }
}
