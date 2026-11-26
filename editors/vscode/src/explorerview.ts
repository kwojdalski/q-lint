// The Process Explorer view and live completion (#854): the VS Code around
// `explorer.ts`. What the active process holds is read in one call - on
// connect, on Refresh, and after a query when auto refresh is on - and kept;
// the tree and completion both answer from what was kept, so typing never
// sends the process anything. A process evaluated directly (#2470) is read
// on Refresh only, one plain request per part.
//
// A table's hover (#930) - its row's tooltip, and a hover on its name in a
// q editor - asks the process for its details (`tableinfo.ts`) when first
// shown, and keeps them until the next refresh. Each has its own setting
// (`insightconfig.ts`); the editor's is off unless asked for, and its
// provider is registered only while it is on.
import {
  CompletionItem,
  CompletionItemKind,
  ConfigurationTarget,
  EventEmitter,
  Hover,
  MarkdownString,
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
  gatherDirect,
  inCode,
  liveCompletions,
  previewCode,
  qName,
  qsqlTable,
  readExplorer,
  readGathered,
  tableNamed,
  type Completion,
  type Gathered,
  type Node,
} from "./explorer";
import { nameAt } from "./funcsource";
import { wordStart } from "./idioms";
import { borrowWhenFree } from "./infoview";
import { readInsight } from "./insightconfig";
import type { Live } from "./live";
import { QError } from "./qclient";
import { blockAt } from "./statements";
import { TABLE_INFO, HOVER_COLUMNS, readTableInfo, tableMarkdown, type TableInfo } from "./tableinfo";

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

const insight = () => {
  const configuration = workspace.getConfiguration("q-lint");
  return readInsight((key, fallback) => configuration.get(key, fallback));
};

/// Columns an editor hover lists, kept short beside the language server's.
const EDITOR_COLUMNS = 10;

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
  /// Tables' details, by process and name, read since the last refresh.
  private details = new Map<string, Promise<TableInfo | undefined>>();
  private refreshing = false;
  /// The editor's table hover, while q-lint.processExplorer.editorTableHover.enable is on.
  private hoverProvider: { dispose(): unknown } | undefined;
  /// Live completion, while q-lint.processExplorer.liveCompletion.enable is on (#1779).
  private completionProvider: { dispose(): unknown } | undefined;
  /// A refresh asked for while a query ran or another refresh was out,
  /// made once the connection is free; `owedAsked` when it was Refresh's.
  private owed = false;
  private owedAsked = false;
  /// The process evaluated directly whose read waits for Refresh (#2470).
  private directWaiting: string | undefined;
  /// Whether the last refresh found the active process evaluated directly:
  /// read again when that changes (#2495).
  private shownDirect: boolean | undefined;

  constructor(context: ExtensionContext, private readonly live: Live) {
    this.view = window.createTreeView(EXPLORER.view, { treeDataProvider: this });
    context.subscriptions.push(
      this.view,
      this.changed,
      commands.registerCommand(EXPLORER.refresh, () => this.refresh(true)),
      commands.registerCommand(EXPLORER.preview, (node?: Node) => this.preview(node)),
      commands.registerCommand(EXPLORER.toggleAutoRefresh, () => {
        // Where it is set: a user-level write is hidden by a workspace value.
        const configuration = workspace.getConfiguration("q-lint");
        const inWorkspace = configuration.inspect("processExplorer.autoRefresh")?.workspaceValue !== undefined;
        return configuration.update(
          "processExplorer.autoRefresh",
          !settings().autoRefresh,
          inWorkspace ? ConfigurationTarget.Workspace : ConfigurationTarget.Global,
        );
      }),
      live.onDidChange((what) => {
        if (what === "connected") {
          void this.refresh();
        } else if (what === "disconnected") {
          this.kept = undefined;
          this.problem = undefined;
          this.show();
        } else if (this.owed || settings().autoRefresh || this.modeChanged()) {
          void this.refresh();
        }
      }),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.query.unwrapped") && this.modeChanged()) {
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
      workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.processExplorer.editorTableHover") && this.switchHover()),
      workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.processExplorer.liveCompletion") && this.switchCompletion()),
      { dispose: () => (this.hoverProvider?.dispose(), this.completionProvider?.dispose()) },
    );
    this.switchHover();
    this.switchCompletion();
    this.show();
  }

  /// Whether the active process's evaluation is not the one last read as.
  private modeChanged(): boolean {
    return this.shownDirect !== undefined && this.live.activeLabel() !== undefined && (this.live.activeDirect() !== undefined) !== this.shownDirect;
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
  ///
  /// A process evaluated directly (#2470) is never sent `GATHER`: it is
  /// read only when Refresh asks (`asked`), with one plain request per
  /// part (`gatherDirect`), and a part it refuses is shown as unavailable.
  async refresh(asked = false): Promise<void> {
    if (this.refreshing) {
      this.owed = true;
      this.owedAsked ||= asked;
      return;
    }
    // A Refresh that waited for a query is still one.
    asked ||= this.owedAsked;
    this.owedAsked = false;
    const { excludedNamespaces } = settings();
    const direct = this.live.activeDirect();
    this.shownDirect = direct !== undefined;
    if (direct !== undefined && !asked) {
      // Kept from the last Refresh stays; nothing is sent.
      this.directWaiting = direct.label;
      this.owed = false;
      this.show();
      return;
    }
    this.directWaiting = undefined;
    const call = this.live.borrow(async (connection, process) => ({
      process: process.label,
      gathered: connection.isDirect
        ? await gatherDirect(async (request) => {
            try {
              return { ok: true, value: (await connection.evaluate(request)).value };
            } catch (error) {
              if (error instanceof QError) {
                return { ok: false, error: error.message };
              }
              throw error;
            }
          }, excludedNamespaces)
        : readGathered(await connection.call(GATHER, excludedNamespaces.join(" "), LIMITS)),
    }), "the Process Explorer's read");
    if (call === undefined) {
      // Busy with a query, or not connected: `connected` will refresh.
      this.owed = this.live.activeLabel() !== undefined;
      this.owedAsked = asked && this.owed;
      return;
    }
    this.owed = false;
    this.refreshing = true;
    this.show();
    try {
      this.kept = await call;
      this.details.clear();
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
            : this.directWaiting === label && this.kept?.process !== label
              ? `${label} is evaluated directly: Refresh reads its tables, namespaces, functions and variables, each as a plain request.`
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

  private switchHover(): void {
    const on = insight().editorTableHover;
    if (on && this.hoverProvider === undefined) {
      // VS Code shows this hover beside the language server's.
      this.hoverProvider = languages.registerHoverProvider({ language: "q" }, { provideHover: (d, p) => this.hover(d, p) });
    } else if (!on && this.hoverProvider !== undefined) {
      this.hoverProvider.dispose();
      this.hoverProvider = undefined;
    }
  }

  private switchCompletion(): void {
    const on = insight().liveCompletion;
    if (on && this.completionProvider === undefined) {
      // VS Code merges this provider's items with the language server's.
      this.completionProvider = languages.registerCompletionItemProvider({ language: "q" }, { provideCompletionItems: (d, p) => this.complete(d, p) }, ".");
    } else if (!on && this.completionProvider !== undefined) {
      this.completionProvider.dispose();
      this.completionProvider = undefined;
    }
  }

  /// A table's details, asked for once per refresh. Undefined when not
  /// connected to the process the explorer read, or it stayed busy.
  private tableDetails(name: string, wait: number): Promise<TableInfo | undefined> {
    const process = this.live.activeLabel();
    const key = `${process}\0${name}`;
    const kept = this.details.get(key);
    if (kept !== undefined) {
      return kept;
    }
    const asked = borrowWhenFree(
      this.live,
      async (connection) => readTableInfo(await connection.call(TABLE_INFO, name, HOVER_COLUMNS)),
      wait,
    ).then(
      (got) => got?.value,
      () => undefined,
    );
    this.details.set(key, asked);
    // Busy is not kept: the next hover asks again.
    void asked.then((info) => info === undefined && this.details.get(key) === asked && this.details.delete(key));
    return asked;
  }

  /// A table row's tooltip: its details, read when first hovered.
  async resolveTreeItem(item: TreeItem, node: Node): Promise<TreeItem> {
    const process = this.live.activeLabel();
    if (node.kind !== "table" || node.name === undefined || process === undefined || !insight().tableHover) {
      return item;
    }
    const info = await this.tableDetails(node.name, 3000);
    if (info !== undefined) {
      item.tooltip = new MarkdownString(tableMarkdown(node.name, process, info));
    }
    return item;
  }

  /// A hover on a table's name in a q editor, while connected to the process
  /// the explorer read.
  private async hover(document: TextDocument, position: Position): Promise<Hover | undefined> {
    const kept = this.kept;
    if (kept === undefined || this.live.activeLabel() !== kept.process || !insight().editorTableHover) {
      return undefined;
    }
    const word = nameAt(document.lineAt(position.line).text, position.character);
    const entry = word === undefined ? undefined : tableNamed(kept.gathered, word);
    if (word === undefined || entry === undefined) {
      return undefined;
    }
    const info = await this.tableDetails(word, 1000);
    // Listed by a direct process and not read: nothing more is known, so
    // no rows or columns are stated (#2490).
    if (info === undefined && entry.unread === true) {
      return new Hover(new MarkdownString(`**${word}** on ${kept.process}: table, not read - its rows and columns are read only by q-lint's lambda, which direct evaluation does not send.`));
    }
    // Busy: what the explorer already knows, its rows and columns.
    return new Hover(
      new MarkdownString(
        info !== undefined
          ? tableMarkdown(word, kept.process, info, EDITOR_COLUMNS)
          : tableMarkdown(word, kept.process, {
              kind: entry.partitioned ? "partitioned" : entry.keys.length > 0 ? "keyed" : "table",
              rows: entry.count,
              bytes: null,
              partitions: null,
              keys: entry.keys,
              ncols: entry.allCols ?? entry.cols.length,
              columns: entry.cols.map((c) => ({ name: c, type: "", fkey: "", attr: "" })),
            }, EDITOR_COLUMNS),
      ),
    );
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
    const found = blockAt(lines, position.line);
    // No block on a line with text: a comment, or inside a block comment.
    if (found === undefined && lines[position.line].trim() !== "") {
      return [];
    }
    const block = found ?? { start: position.line, end: position.line };
    const text = lines.slice(block.start, block.end + 1).join("\n");
    const offset = lines.slice(block.start, position.line).reduce((n, l) => n + l.length + 1, 0) + position.character;
    // Nothing from the process inside a string or a trailing comment.
    if (!inCode(text, offset)) {
      return [];
    }
    const table = qsqlTable(text, offset);
    // The word being typed, dots and all, so `.ns.f` replaces `.ns.` whole.
    const range = new Range(position.line, wordStart(lines[position.line], position.character), position.line, position.character);
    return liveCompletions(kept.gathered, kept.process, table).map((c) => {
      const item = new CompletionItem(c.label, KINDS[c.kind]);
      item.detail = c.detail;
      item.range = range;
      // A name q cannot parse goes in as Preview reads it, by its symbol.
      if (c.kind !== "column" && qName(c.label) !== c.label) {
        item.insertText = qName(c.label);
      }
      // A table's columns first, inside its statement.
      item.sortText = `${c.kind === "column" ? "0" : "1"}${c.label}`;
      return item;
    });
  }
}
