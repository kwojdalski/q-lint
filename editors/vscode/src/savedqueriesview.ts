// The Saved Queries view (#912): named queries kept for the workspace, run
// on the active connection as a query from the editor is, and edited as q
// documents of their own. The VS Code around `savedqueries.ts`.
//
// A saved query is edited in a `q-lint-saved:/<name>.q` document, served by
// a file system provider over the list: saving the document saves the
// query, and the language server lints it as any q file. With
// `q-lint.savedQueries.enable` off the view and the provider are gone, and
// the commands refuse.
import {
  Disposable,
  EventEmitter,
  FileSystemError,
  FileType,
  FileChangeType,
  MarkdownString,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  commands,
  window,
  workspace,
  type ExtensionContext,
  type FileChangeEvent,
  type FileStat,
  type FileSystemProvider,
  type TreeDataProvider,
  type TreeView,
} from "vscode";
import type { HistoryEntry, Live } from "./live";
import { iconsEscaped } from "./history";
import {
  SAVED_QUERIES,
  SAVED_QUERIES_KEY,
  SAVED_SCHEME,
  nameOfPath,
  nameProblem,
  parseSaved,
  readSavedQueries,
  renamed,
  savedPath,
  suggestedName,
  withQuery,
  type SavedQuery,
} from "./savedqueries";
import { SAVED_LOOKS_KEY, parseLooks, renamedLook, withoutLook } from "./resultlook";

/// What a command is given: a view row, a query's name, or nothing.
type QueryArg = SavedQuery | string | undefined;

export class SavedQueries implements TreeDataProvider<SavedQuery> {
  private readonly changed = new EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly documents: SavedQueryFiles;
  /// The view and the provider, while the setting is on.
  private registered: { view: TreeView<SavedQuery>; provider: Disposable } | undefined;

  constructor(
    private readonly context: ExtensionContext,
    private readonly live: Live,
  ) {
    this.documents = new SavedQueryFiles(this);
    const c = (name: string, run: (...args: never[]) => unknown): Disposable => commands.registerCommand(name, run);
    context.subscriptions.push(
      c(SAVED_QUERIES.save, (from?: HistoryEntry | SavedQuery) => this.save(from)),
      c(SAVED_QUERIES.run, (arg?: QueryArg) => this.run(arg)),
      c(SAVED_QUERIES.edit, (arg?: QueryArg) => this.edit(arg)),
      c(SAVED_QUERIES.rename, (arg?: QueryArg, to?: string) => this.renameQuery(arg, to)),
      c(SAVED_QUERIES.remove, (arg?: QueryArg) => this.remove(arg)),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.savedQueries")) {
          this.register();
        }
      }),
      this.changed,
      this.documents,
      { dispose: () => this.unregister() },
    );
    this.register();
  }

  enabled(): boolean {
    const configuration = workspace.getConfiguration("q-lint");
    return readSavedQueries((key, fallback) => configuration.get(key, fallback)).enabled;
  }

  /// Register the view and the provider when the setting is on, and drop
  /// them when it is off.
  private register(): void {
    if (!this.enabled()) {
      this.unregister();
      return;
    }
    if (this.registered === undefined) {
      this.registered = {
        view: window.createTreeView(SAVED_QUERIES.view, { treeDataProvider: this }),
        provider: workspace.registerFileSystemProvider(SAVED_SCHEME, this.documents, { isCaseSensitive: true }),
      };
    }
  }

  private unregister(): void {
    this.registered?.view.dispose();
    this.registered?.provider.dispose();
    this.registered = undefined;
  }

  /// Whether the feature is on; when it is off, says so and how to turn it on.
  private on(): boolean {
    const on = this.enabled();
    if (!on) {
      void window.showInformationMessage("q-lint: Saved queries are turned off. Set q-lint.savedQueries.enable to true to turn them on.");
    }
    return on;
  }

  queries(): SavedQuery[] {
    return parseSaved(this.context.workspaceState.get<unknown>(SAVED_QUERIES_KEY, []));
  }

  /// Keep `list`, the queries named `changed` changed in it.
  async store(list: SavedQuery[], changed: string[] = []): Promise<void> {
    await this.context.workspaceState.update(SAVED_QUERIES_KEY, list);
    this.changed.fire();
    this.documents.changed(changed);
  }

  getChildren(query?: SavedQuery): SavedQuery[] {
    return query === undefined ? this.queries() : [];
  }

  getTreeItem(query: SavedQuery): TreeItem {
    const item = new TreeItem(query.name, TreeItemCollapsibleState.None);
    item.description = suggestedName(query.code) === query.name ? undefined : suggestedName(query.code);
    item.iconPath = new ThemeIcon("bookmark");
    const tooltip = new MarkdownString();
    tooltip.appendText(query.name);
    tooltip.appendCodeblock(query.code, "q");
    item.tooltip = tooltip;
    item.contextValue = "savedQuery";
    // A click opens it: running it is a button away, never a slip.
    item.command = { command: SAVED_QUERIES.edit, title: "Edit", arguments: [query] };
    return item;
  }

  /// The query a command was given, by row or name, or one the user picks.
  private async chosen(arg: QueryArg, title: string): Promise<SavedQuery | undefined> {
    const list = this.queries();
    const name = typeof arg === "string" ? arg : arg?.name;
    if (name !== undefined) {
      const found = list.find((q) => q.name === name);
      if (found === undefined) {
        void window.showErrorMessage(`q-lint: no saved query is named "${name}".`);
      }
      return found;
    }
    if (list.length === 0) {
      void window.showInformationMessage("q-lint: no query is saved yet. Save Query saves the selection, or the statement at the cursor.");
      return undefined;
    }
    const picked = await window.showQuickPick(
      list.map((q) => ({ label: iconsEscaped(q.name), description: iconsEscaped(suggestedName(q.code)), query: q })),
      { title },
    );
    return picked?.query;
  }

  /// Save Query: a Query History entry's code, `{name, code}` given, or the
  /// editor's selection or the statement at the cursor, as written, under
  /// a name asked for.
  async save(from?: HistoryEntry | SavedQuery): Promise<void> {
    if (!this.on()) {
      return;
    }
    const given = from !== undefined && typeof from === "object" && typeof from.code === "string" ? from : undefined;
    const code = given?.code ?? (await this.live.codeFromEditor(false));
    if (code === undefined) {
      return;
    }
    const taken = this.queries().map((q) => q.name);
    let name = given !== undefined && "name" in given && typeof given.name === "string" ? given.name.trim() : undefined;
    if (name === undefined || nameProblem(name, taken) !== undefined) {
      name = (
        await window.showInputBox({
          title: "Save Query: name",
          value: name ?? suggestedName(code),
          prompt: "A name for the query, unique in this workspace's Saved Queries.",
          validateInput: (v) => nameProblem(v, taken),
        })
      )?.trim();
    }
    if (name === undefined) {
      return;
    }
    // Read again: the list may have changed while the box was open.
    const now = this.queries();
    if (nameProblem(name, now.map((q) => q.name)) !== undefined) {
      void window.showErrorMessage(`q-lint: the name "${name}" was taken meanwhile; the query was not saved.`);
      return;
    }
    await this.store(withQuery(now, { name, code }), [name]);
    void window.showInformationMessage(`q-lint: saved the query "${name}".`);
  }

  /// Run a saved query on the active connection, its placeholders asked for.
  async run(arg?: QueryArg): Promise<void> {
    if (!this.on()) {
      return;
    }
    const query = await this.chosen(arg, "Run which saved query?");
    if (query !== undefined) {
      await this.live.runFilledIn(query.code, query.name);
    }
  }

  /// Open a saved query in a q editor of its own; saving it saves the query.
  async edit(arg?: QueryArg): Promise<void> {
    if (!this.on()) {
      return;
    }
    const query = await this.chosen(arg, "Edit which saved query?");
    if (query === undefined) {
      return;
    }
    const document = await workspace.openTextDocument(Uri.from({ scheme: SAVED_SCHEME, path: savedPath(query.name) }));
    await window.showTextDocument(document);
  }

  async renameQuery(arg?: QueryArg, to?: string): Promise<void> {
    if (!this.on()) {
      return;
    }
    const query = await this.chosen(arg, "Rename which saved query?");
    if (query === undefined) {
      return;
    }
    const taken = this.queries().map((q) => q.name).filter((n) => n !== query.name);
    const name =
      typeof to === "string" && nameProblem(to, taken) === undefined
        ? to.trim()
        : (await window.showInputBox({ title: `Rename ${query.name}`, value: query.name, validateInput: (v) => nameProblem(v, taken) }))?.trim();
    if (name === undefined || name === query.name) {
      return;
    }
    const now = this.queries();
    if (!now.some((q) => q.name === query.name) || nameProblem(name, now.map((q) => q.name).filter((n) => n !== query.name)) !== undefined) {
      void window.showErrorMessage(`q-lint: the saved queries changed meanwhile; "${query.name}" was not renamed.`);
      return;
    }
    await this.store(renamed(now, query.name, name), [query.name, name]);
    // Its result's look (#1015, #1019) goes with it.
    await this.context.workspaceState.update(SAVED_LOOKS_KEY, renamedLook(parseLooks(this.context.workspaceState.get<unknown>(SAVED_LOOKS_KEY, {})), query.name, name));
  }

  async remove(arg?: QueryArg): Promise<void> {
    if (!this.on()) {
      return;
    }
    const query = await this.chosen(arg, "Delete which saved query?");
    if (query === undefined) {
      return;
    }
    const yes = "Delete";
    if ((await window.showWarningMessage(`Delete the saved query "${query.name}"?`, { modal: true }, yes)) !== yes) {
      return;
    }
    await this.store(this.queries().filter((q) => q.name !== query.name), [query.name]);
    await this.context.workspaceState.update(SAVED_LOOKS_KEY, withoutLook(parseLooks(this.context.workspaceState.get<unknown>(SAVED_LOOKS_KEY, {})), query.name));
  }
}

/// The `q-lint-saved:` documents: each saved query as a q file, read from
/// the list and saved back to it.
class SavedQueryFiles implements FileSystemProvider {
  private readonly files = new EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile = this.files.event;
  /// When each query was last changed, for its document's `mtime`.
  private readonly changedAt = new Map<string, number>();

  constructor(private readonly saved: SavedQueries) {}

  /// Say the documents of the queries named `names` changed.
  changed(names: string[]): void {
    const now = Date.now();
    for (const name of names) {
      this.changedAt.set(name, now);
    }
    if (names.length > 0) {
      this.files.fire(names.map((name) => ({ type: FileChangeType.Changed, uri: Uri.from({ scheme: SAVED_SCHEME, path: savedPath(name) }) })));
    }
  }

  dispose(): void {
    this.files.dispose();
  }

  private named(uri: Uri): SavedQuery {
    const name = nameOfPath(uri.path);
    const query = name === undefined ? undefined : this.saved.queries().find((q) => q.name === name);
    if (query === undefined) {
      throw FileSystemError.FileNotFound(uri);
    }
    return query;
  }

  watch(): Disposable {
    return new Disposable(() => {});
  }

  stat(uri: Uri): FileStat {
    if (uri.path === "/") {
      return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const query = this.named(uri);
    const at = this.changedAt.get(query.name) ?? 0;
    return { type: FileType.File, ctime: 0, mtime: at, size: Buffer.byteLength(query.code, "utf8") };
  }

  readDirectory(): [string, FileType][] {
    return this.saved.queries().map((q) => [savedPath(q.name).slice(1), FileType.File]);
  }

  createDirectory(uri: Uri): void {
    throw FileSystemError.NoPermissions(uri);
  }

  readFile(uri: Uri): Uint8Array {
    return Buffer.from(this.named(uri).code, "utf8");
  }

  /// Saving the document saves the query; a document of a query deleted or
  /// renamed since is not saved, and says so.
  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    if (!this.saved.enabled()) {
      throw FileSystemError.Unavailable("q-lint.savedQueries.enable is off");
    }
    const query = this.named(uri);
    await this.saved.store(withQuery(this.saved.queries(), { name: query.name, code: Buffer.from(content).toString("utf8") }), [query.name]);
  }

  delete(uri: Uri): void {
    throw FileSystemError.NoPermissions(uri);
  }

  rename(uri: Uri): void {
    throw FileSystemError.NoPermissions(uri);
  }
}
