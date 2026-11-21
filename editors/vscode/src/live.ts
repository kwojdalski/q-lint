// The live half of the extension: q processes to connect to, code run on
// them, what came back, and what was run before.
//
// Nothing here involves the language server, which never runs q. A process
// is touched only once the user connects to it, and then only by the code
// the user sends. What a query sends is `query.ts`'s; how a block is cut into
// statements, `statements.ts`'s; how processes are read and grouped,
// `processes.ts`'s; discovery servers, `discoveryservers.ts`'s; what a
// terminal is sent, `terminal.ts`'s. This file is the VS Code around them.
import * as os from "os";
import * as path from "path";
import {
  commands,
  EventEmitter,
  MarkdownString,
  StatusBarAlignment,
  env,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  window,
  workspace,
  type ExtensionContext,
  type OutputChannel,
  type StatusBarItem,
  type Terminal,
  type TextEditor,
  type TreeDataProvider,
  type TreeView,
} from "vscode";
import { children, findDiscovered, qualified, type Row } from "./discovery";
import { DiscoveryServers, discoveryItem } from "./discoveryservers";
import {
  address,
  hostProblem,
  merge,
  parseProcesses,
  plainHost,
  parseTags,
  passwordKey,
  passwordsToForget,
  portProblem,
  processThemeColour,
  processTooltip,
  readProcessFile,
  tlsChoices,
  type Process,
} from "./processes";
import { COMMANDS, CONNECTED, VIEWS, readLive, readProcessSettings, readTerminal } from "./liveconfig";
import { QConnection, QError } from "./qclient";
import { HEARTBEAT, UNANSWERED_MS, backoffDelay, latencyText, readHealth } from "./health";
import { historyHeading, historyLabel, iconsEscaped } from "./history";
import { render } from "./query";
import { QueryModes, type Rendered } from "./resultpanel";
import { blockAt, statements } from "./statements";
import { commandLine, expandHome, parseEnv, replLines, shellKind } from "./terminal";
import { QueryControls } from "./controls";
import { ParameterCache } from "./paramcachecontrol";
import { CONTROL_COMMANDS, FILE_CONNECTIONS_KEY, UNLIMITED, armTimeout, limits, readUnlimited, runUnwrapped, timedOutError, withBinding } from "./querycontrols";
import { elapsedText, finishedText, readProgress, shouldNotify } from "./progress";
import {
  HISTORY_COMMANDS,
  HISTORY_FILTERED,
  OUTCOME_CHOICES,
  readHistorySearch,
  exportFormat,
  filterDescription,
  filtered,
  historyJson,
  historyProcesses,
  historyScript,
  isFiltering,
  normalised,
  type HistoryFilter,
} from "./historyfilter";
import { CONNECT_SCRIPT_COMMANDS, readConnectScript, scriptOf, scriptPath, scriptsBrought, scriptSummary, withScript, type ConnectScript } from "./connectscript";
import { isProduction } from "./agent";
import { PAGE, readPage, type GridPage } from "./grid";
import { PLACEHOLDER_VALUES_KEY, lastValue, placeholderNames, readPlaceholders, remembered, substitute } from "./placeholders";
import { guardCheck, guardQuestion, guardRefusal, readGuard } from "./guard";
import type { GridAnswer, GridPayload } from "./grid";
import { WATCH, WATCHING, intervalProblem, readWatch, watchText } from "./watch";
import { guardedBy } from "./guard";

const PROCESSES_KEY = "q-lint.processes";
const HISTORY_KEY = "q-lint.queryHistory";
/// How many queries the history keeps.
const HISTORY_LIMIT = 200;



/// What a process command is given: a view row, a process's label (from a
/// keybinding's `args`, or another extension), or nothing - then the user
/// picks one. A discovered process is named `server/label`.
type ProcessArg = Row | string | undefined;

export interface HistoryEntry {
  process: string;
  code: string;
  /// When it was sent, as an ISO string.
  at: string;
  millis: number;
  outcome: "ok" | "error" | "aborted" | "timeout";
  error?: string;
  /// Sent by an agent through the language-model tool (#886).
  agent?: true;
}

type From = "line" | "selection" | "block" | "file";

/// The code a query or a send takes from `editor`: the selection, the
/// statement the cursor is in, or its line. Undefined when the cursor is on
/// no statement.
function codeAt(editor: TextEditor, from: From): string | undefined {
  const document = editor.document;
  const line = editor.selection.active.line;
  if (from === "selection" && !editor.selection.isEmpty) {
    return document.getText(editor.selection);
  }
  if (from === "file") {
    return document.getText();
  }
  if (from === "block") {
    const lines = document.getText().split(/\r?\n/);
    const block = blockAt(lines, line);
    return block === undefined ? undefined : lines.slice(block.start, block.end + 1).join("\n");
  }
  return document.lineAt(line).text;
}

/// What a command that reads the active editor says when there is none.
function noEditor(): void {
  void window.showInformationMessage("q-lint: open a q file first: there is no active editor.");
}

function nothingThere(from: From): void {
  void window.showInformationMessage(
    from === "block"
      ? "q-lint: the cursor is on no statement (a blank line, a comment, or inside a block comment)."
      : from === "file"
        ? "q-lint: the file has no statement to run."
        : "q-lint: nothing to run there: it is blank or a comment.",
  );
}

/// A tag's or a process's colour, from `q-lint.processes.tagColors` over
/// the built-in ones.
function colourOf(tags: string[]): ThemeColor | undefined {
  const { tagColors } = readProcessSettings((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback));
  const id = processThemeColour({ label: "", host: "", port: 0, tags }, tagColors);
  return id === undefined ? undefined : new ThemeColor(id);
}

class ProcessesView implements TreeDataProvider<Row> {
  private readonly changed = new EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  /// The rows given out since the last refresh, by parent, and each row's
  /// parent: `reveal` finds a row by the object VS Code was given, so the
  /// same rows are given out until the tree changes.
  private given = new Map<Row | undefined, Row[]>();
  private parents = new Map<Row, Row | undefined>();

  constructor(private readonly live: Live) {}

  refresh(): void {
    this.given = new Map();
    this.parents = new Map();
    this.changed.fire();
  }

  getChildren(row?: Row): Row[] {
    let rows = this.given.get(row);
    if (rows === undefined) {
      rows = children(this.live.processes(), this.live.discovery.discovered(), row);
      this.given.set(row, rows);
      for (const child of rows) {
        this.parents.set(child, row);
      }
    }
    return rows;
  }

  getParent(row: Row): Row | undefined {
    return this.parents.get(row);
  }

  /// The row of `process`, as connected to: a saved process under
  /// its first tag, or a discovered one under its server.
  find(process: Pick<Process, "label" | "server">, under?: Row): Row | undefined {
    for (const row of this.getChildren(under)) {
      if (row.kind === "process" && process.server === undefined && row.process.label === process.label) {
        return row;
      }
      if (row.kind === "discovered" && row.server === process.server && qualified(row.server, row.process.label) === process.label) {
        return row;
      }
      if (row.kind === "tag" || row.kind === "servers" || row.kind === "server") {
        const found = this.find(process, row);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  }

  getTreeItem(row: Row): TreeItem {
    if (row.kind !== "tag" && row.kind !== "process" && row.kind !== "discovered") {
      return discoveryItem(row);
    }
    if (row.kind === "tag") {
      const item = new TreeItem(row.tag, TreeItemCollapsibleState.Expanded);
      item.iconPath = new ThemeIcon("tag", colourOf([row.tag]));
      item.contextValue = "tag";
      return item;
    }
    const { process } = row;
    // A discovered process is connected to under its qualified label, so a
    // saved process of the same label is not shown connected with it.
    const from = row.kind === "discovered" ? row.server : undefined;
    const connected = this.live.activeProcess();
    const active = connected?.server === from && connected?.label === (from === undefined ? process.label : qualified(from, process.label));
    const item = new TreeItem(process.label, TreeItemCollapsibleState.None);
    item.description = `${address(process.host, process.port)}${active ? " - connected" : ""}`;
    item.iconPath = new ThemeIcon(active ? "vm-active" : "server-process", colourOf(process.tags));
    item.tooltip = new MarkdownString(processTooltip(process, from));
    const kind = from === undefined ? "process" : "discovered";
    item.contextValue = active ? `${kind}.connected` : kind;
    // A click connects: the row is the process, and connecting is what it is for.
    item.command = { command: COMMANDS.connect, title: "Connect", arguments: [row] };
    return item;
  }
}

class HistoryView implements TreeDataProvider<HistoryEntry> {
  private readonly changed = new EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly live: Live) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(entry?: HistoryEntry): HistoryEntry[] {
    return entry === undefined ? this.live.shownHistory() : [];
  }

  getTreeItem(entry: HistoryEntry): TreeItem {
    const item = new TreeItem(historyLabel(entry.code), TreeItemCollapsibleState.None);
    const when = new Date(entry.at);
    item.description = `${entry.agent ? "agent · " : ""}${entry.process} · ${when.toLocaleTimeString()} · ${entry.millis} ms`;
    item.iconPath = new ThemeIcon(
      entry.outcome === "ok" ? "pass" : entry.outcome === "error" ? "error" : entry.outcome === "timeout" ? "watch" : "circle-slash",
      new ThemeColor(entry.outcome === "ok" ? "testing.iconPassed" : entry.outcome === "error" ? "errorForeground" : "disabledForeground"),
    );
    const tooltip = new MarkdownString();
    tooltip.appendMarkdown(historyHeading(entry, when.toLocaleString()));
    tooltip.appendCodeblock(entry.code, "q");
    item.tooltip = tooltip;
    item.contextValue = "history";
    return item;
  }
}

/// q in VS Code terminals: a file run in one, and code sent to one. The
/// terminal runs the user's shell, which starts q, so q exiting leaves the
/// shell and the command line shows what was run.
export class QTerminals {
  /// The terminals started here, still open.
  private readonly ours = new Set<Terminal>();
  /// The file each Run Code from Terminal terminal runs.
  private readonly files = new WeakMap<Terminal, string>();
  /// Where code is sent: the last q terminal started, of those still open.
  private last: Terminal | undefined;
  /// The terminal a send is starting, so a second send waits for it.
  private starting: Promise<Terminal | undefined> | undefined;

  constructor(context: ExtensionContext) {
    context.subscriptions.push(
      window.onDidCloseTerminal((terminal) => {
        this.ours.delete(terminal);
        if (terminal === this.last) {
          this.last = [...this.ours].pop();
        }
      }),
    );
  }

  /// Run the active file in a terminal named after it, saving it first. The
  /// terminal it ran in before is closed: running the file again starts a
  /// fresh q. Another file of the same name keeps its own.
  async runFile(): Promise<void> {
    const document = window.activeTextEditor?.document;
    if (document === undefined || document.uri.scheme !== "file") {
      void window.showInformationMessage("q-lint: open a q file saved on disk to run it.");
      return;
    }
    if (document.isDirty && !(await document.save())) {
      return;
    }
    const file = document.uri.fsPath;
    // Closed only once the new one can start: an env file that cannot be
    // read leaves the running q as it was.
    const close = (): void => {
      for (const terminal of this.ours) {
        if (this.files.get(terminal) === file) {
          this.ours.delete(terminal);
          terminal.dispose();
        }
      }
    };
    const terminal = await this.start(path.basename(file), document.uri, file, close);
    terminal?.show();
  }

  /// Start q with no file in a new terminal, which code is sent to from then.
  async repl(): Promise<void> {
    const terminal = await this.start("q", window.activeTextEditor?.document.uri ?? workspace.workspaceFolders?.[0]?.uri);
    terminal?.show();
  }

  /// Send the code at the cursor to the q terminal, starting one if none is
  /// open. Each statement goes as one line, since that is what q's console
  /// reads.
  async send(from: From): Promise<void> {
    const editor = window.activeTextEditor;
    if (editor === undefined) {
      noEditor();
      return;
    }
    const lines = replLines(codeAt(editor, from) ?? "");
    if (lines.length === 0) {
      nothingThere(from);
      return;
    }
    if (this.last === undefined && this.starting === undefined) {
      this.starting = this.start("q", editor.document.uri).finally(() => (this.starting = undefined));
    }
    const terminal = this.last ?? (await this.starting);
    if (terminal === undefined) {
      return;
    }
    terminal.show(true);
    for (const line of lines) {
      terminal.sendText(line, true);
    }
  }

  /// A terminal named `name` that starts `q-lint.terminal.qBinary`, on
  /// `file` if one is given, with the variables of `q-lint.terminal.envPath`
  /// set for it. It starts in the workspace folder of `from`, so a script's
  /// relative `\l` reads as it does from a shell there. Undefined if the env
  /// file cannot be read; `before` runs only once it can start.
  private async start(name: string, from: Uri | undefined, file?: string, before?: () => void): Promise<Terminal | undefined> {
    const configuration = workspace.getConfiguration("q-lint", from);
    const read = readTerminal((key, fallback) => configuration.get(key, fallback));
    const settings = { qBinary: expandHome(read.qBinary, os.homedir()), envPath: expandHome(read.envPath, os.homedir()) };
    const folder = (from && workspace.getWorkspaceFolder(from)) ?? workspace.workspaceFolders?.[0];
    const cwd = folder?.uri.fsPath ?? (file !== undefined ? path.dirname(file) : undefined);
    let variables: Record<string, string> = {};
    if (settings.envPath !== "") {
      if (!path.isAbsolute(settings.envPath) && folder === undefined) {
        void window.showErrorMessage(
          `q-lint: q-lint.terminal.envPath "${settings.envPath}" is relative, and there is no workspace folder to read it from.`,
        );
        return undefined;
      }
      const envFile = path.resolve(folder?.uri.fsPath ?? "", settings.envPath);
      let text: string;
      try {
        text = Buffer.from(await workspace.fs.readFile(Uri.file(envFile))).toString("utf8");
      } catch (error) {
        void window.showErrorMessage(
          `q-lint: could not read the env file ${envFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
      const parsed = parseEnv(text);
      variables = parsed.env;
      if (parsed.problems.length > 0) {
        void window.showWarningMessage(
          `q-lint: skipped ${parsed.problems.length} line(s) of ${envFile}: ${parsed.problems.slice(0, 3).join("; ")}`,
        );
      }
    }
    before?.();
    const terminal = window.createTerminal({ name, cwd });
    this.ours.add(terminal);
    if (file !== undefined) {
      this.files.set(terminal, file);
    }
    this.last = terminal;
    // A file inside the folder is named relative to it, as you would type it.
    const relative = file !== undefined && cwd !== undefined ? path.relative(cwd, file) : "";
    const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    const args = file === undefined ? [] : [inside ? relative : file];
    terminal.sendText(commandLine(settings.qBinary, args, shellKind(env.shell), variables), true);
    return terminal;
  }
}

export class Live {
  private connection: QConnection | undefined;
  /// The query history, newest first. Kept here and written through to
  /// `globalState`, never rebuilt from it: a read of `globalState` straight
  /// after a write can return the value before it, and a list rebuilt from
  /// that drops the entry just added.
  private queries: HistoryEntry[] | undefined;
  private active: Process | undefined;
  /// A connect in progress, so a second one waits for it instead of opening
  /// another.
  private connecting: Promise<boolean> | undefined;
  /// The process `connecting` connects to, as `passwordKey` names it.
  private connectingTo: string | undefined;
  /// Set by Disconnect, or a connect to another process, to stop a
  /// reconnect after an abort from trying again.
  private reconnectStopped = false;
  private running: { code: string; started: number } | undefined;
  /// Redraws the status bar each second while a query runs, so its time
  /// counts up (#910).
  private ticker: ReturnType<typeof setInterval> | undefined;
  /// The heartbeat's timer while connected, the last round trip it timed,
  /// and when the one still unanswered was sent (#917).
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private latency: { millis: number; at: number } | undefined;
  private beatSent: number | undefined;
  /// The automatic reconnect under way: its process and try. `reconnectRun`
  /// counts them, so a connect or Disconnect stops the one running.
  private reconnecting: { label: string; attempt: number; of: number } | undefined;
  private reconnectRun = 0;
  /// When the query that timed out started, so its entry says so.
  private timedOut: number | undefined;
  /// When the query Abort, Disconnect or a connect elsewhere stopped waiting
  /// for started, so its entry says so: a connection the process closed is
  /// a failure, not an abort.
  private aborted: number | undefined;
  private readonly controls: QueryControls;
  private readonly parameterCache: ParameterCache;
  /// The process explorer's call on the connection, if one is out: a query
  /// waits for it (`borrow`).
  private borrowed: Promise<unknown> | undefined;
  /// Set on deactivate: a connection opened after it is closed at once.
  private disposed = false;
  private readonly changed = new EventEmitter<"connected" | "disconnected" | "queried">();
  /// Fired when a connection opens or closes, and when a query has finished:
  /// what the process explorer refreshes on.
  readonly onDidChange = this.changed.event;
  private readonly status: StatusBarItem;
  private readonly output: OutputChannel;
  private readonly processesView: ProcessesView;
  /// The Processes view, whose badge shows a live connection.
  private readonly processesTree: TreeView<Row>;
  private readonly historyView: HistoryView;
  /// The Query History view, whose description shows its filter.
  private readonly historyTree: TreeView<HistoryEntry>;
  /// What the Query History view is filtered by (#913), for this window.
  private historyFilter: HistoryFilter = {};
  private readonly modes: QueryModes;
  readonly discovery: DiscoveryServers;
  /// The query being watched (#914): its code, the process it runs on, how
  /// often, how many runs so far, its timer and status bar item, and
  /// whether a run is out.
  private watching:
    | { code: string; label: string; every: number; runs: number; timer: ReturnType<typeof setInterval>; status: StatusBarItem; running: boolean }
    | undefined;

  constructor(private readonly context: ExtensionContext) {
    this.output = window.createOutputChannel("q-lint: query", "q-console");
    this.status = window.createStatusBarItem("q-lint.connection", StatusBarAlignment.Left, 50);
    this.status.name = "q-lint: q connection";
    this.status.command = COMMANDS.connect;
    this.processesView = new ProcessesView(this);
    this.historyView = new HistoryView(this);
    this.processesTree = window.createTreeView(VIEWS.processes, { treeDataProvider: this.processesView });
    this.historyTree = window.createTreeView(VIEWS.history, { treeDataProvider: this.historyView });
    this.discovery = new DiscoveryServers(context, { list: () => this.processes(), save: (processes) => this.save(processes) });
    const terminals = new QTerminals(context);
    this.modes = new QueryModes(context);
    this.modes.setPager((label, offset, count) => this.pageHeld(label, offset, count));
    this.modes.setRunner((code, label) => this.runDrilldown(code, label));
    this.controls = new QueryControls(context, {
      activeLabel: () => this.activeLabel(),
      pick: async (title) => (await this.chosen(undefined, title, true))?.label,
    });
    this.parameterCache = new ParameterCache(context);
    const c = (name: string, run: (...args: never[]) => unknown) => commands.registerCommand(name, run);
    context.subscriptions.push(
      this.output,
      this.status,
      this.processesTree,
      this.historyTree,
      c(COMMANDS.add, () => this.add()),
      c(COMMANDS.edit, (row?: ProcessArg) => this.edit(row)),
      c(COMMANDS.remove, (row?: ProcessArg) => this.remove(row)),
      c(COMMANDS.connect, (row?: ProcessArg) => this.connectTo(row)),
      c(COMMANDS.disconnect, () => this.disconnect()),
      c(COMMANDS.tag, (row?: ProcessArg) => this.tag(row)),
      c(COMMANDS.importList, (file?: Uri) => this.importList(file)),
      c(COMMANDS.exportList, () => this.exportList()),
      c(COMMANDS.refresh, () => this.processesView.refresh()),
      c(COMMANDS.insertLabel, () => this.insertLabel()),
      c(COMMANDS.queryLine, () => this.queryFrom("line")),
      c(COMMANDS.querySelection, () => this.queryFrom("selection")),
      c(COMMANDS.queryBlock, () => this.queryFrom("block")),
      c(COMMANDS.abort, () => this.abort()),
      c(COMMANDS.rerun, (entry?: HistoryEntry) => this.rerun(entry)),
      c(COMMANDS.clearHistory, () => this.clearHistory()),
      c(COMMANDS.runInTerminal, () => terminals.runFile()),
      c(COMMANDS.sendLine, () => terminals.send("line")),
      c(COMMANDS.sendSelection, () => terminals.send("selection")),
      c(COMMANDS.sendBlock, () => terminals.send("block")),
      c(CONTROL_COMMANDS.queryFile, () => this.queryFrom("file")),
      c(CONTROL_COMMANDS.startRepl, () => terminals.repl()),
      c(CONTROL_COMMANDS.copyQuery, (entry?: HistoryEntry) => this.copyQuery(entry)),
      c(CONTROL_COMMANDS.revealProcess, () => this.revealProcess()),
      c(CONNECT_SCRIPT_COMMANDS.set, (row?: ProcessArg, script?: ConnectScript | null) => this.setConnectScript(row, script)),
      c(HISTORY_COMMANDS.filter, (filter?: HistoryFilter) => this.filterHistory(filter)),
      c(HISTORY_COMMANDS.clearFilter, () => this.setHistoryFilter({})),
      c(HISTORY_COMMANDS.export, (file?: Uri) => this.exportHistory(file)),
      c(WATCH.start, (code?: string, every?: number) => this.watch(code, every)),
      c(WATCH.stop, () => this.stopWatching()),
      this.changed,
      this.discovery.onDidChange(() => this.processesView.refresh()),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.processes.tagColors")) {
          this.processesView.refresh();
        }
        if (event.affectsConfiguration("q-lint.connection.heartbeat") || event.affectsConfiguration("q-lint.connection.heartbeatInterval")) {
          this.restartHeartbeat();
        }
        // Turned off, a reconnect under way stops, and a filter goes.
        if (event.affectsConfiguration("q-lint.connection.autoReconnect") && !this.setting(readHealth).autoReconnect) {
          this.stopReconnecting();
        }
        if (event.affectsConfiguration("q-lint.queryHistory.search") && !this.setting(readHistorySearch).enabled) {
          this.setHistoryFilter({});
        }
        if (event.affectsConfiguration("q-lint.query.progress")) {
          this.showStatus();
        }
        if (event.affectsConfiguration("q-lint.query.watch") && !this.setting(readWatch).enabled) {
          this.stopWatching("q-lint.query.watch.enable was turned off");
        }
      }),
      this.changed.event((what) => {
        if (what !== "queried") {
          this.restartHeartbeat();
        }
        // A watch stops on disconnect, and on a connect elsewhere, which
        // closes the connection it ran on first.
        if (what === "disconnected" && this.watching !== undefined) {
          this.stopWatching(`the connection to ${this.watching.label} closed`);
        }
      }),
      {
        dispose: () => {
          this.disposed = true;
          this.stopWatching();
          clearInterval(this.ticker);
          clearInterval(this.heartbeat);
          this.reconnectRun++;
          // A reconnect after an abort stops trying.
          this.reconnectStopped = true;
          void this.connection?.close();
        },
      },
    );
    this.showStatus();
    this.status.show();
  }

  /// What the extension returns from `activate`: a read-only view for tests
  /// and for other extensions. Passwords are never in it.
  api(): {
    processes: () => Process[];
    activeLabel: () => string | undefined;
    history: () => HistoryEntry[];
    /// The entries the Query History view shows, through its filter (#913).
    shownHistory: () => HistoryEntry[];
    /// What the connection's status bar item says: the running time, the
    /// heartbeat's latency, a reconnect (#910, #917).
    statusText: () => string;
    /// What the result panel last drew.
    result: () => Rendered | undefined;
    /// Each discovery server, what it last listed, and why it failed.
    discovered: () => { server: string; url: string; processes: Process[]; problems: string[]; error?: string; loading: boolean }[];
    /// The label of the row selected in the Processes view, and whether
    /// unlimited queries are on.
    selectedProcess: () => string | undefined;
    unlimited: () => boolean;
    /// How many lambdas in the active file cache their parameters (#892).
    cachedLambdas: () => number;
    /// The query being watched, and how many times it has run (#914).
    watching: () => { code: string; label: string; every: number; runs: number } | undefined;
  } {
    return {
      processes: () => this.processes(),
      activeLabel: () => this.activeLabel(),
      history: () => this.history(),
      shownHistory: () => this.shownHistory(),
      statusText: () => this.status.text,
      result: () => this.modes.lastRendered(),
      discovered: () =>
        this.discovery.discovered().map(({ server, state }) => ({
          server: server.label,
          url: server.url,
          processes: state.processes,
          problems: state.problems,
          ...(state.error !== undefined ? { error: state.error } : {}),
          loading: state.loading,
        })),
      selectedProcess: () => {
        const row = this.processesTree.selection[0];
        return row?.kind === "process" ? row.process.label : row?.kind === "discovered" ? qualified(row.server, row.process.label) : undefined;
      },
      unlimited: () => this.controls.unlimited,
      cachedLambdas: () => this.parameterCache.cached(),
      watching: () => {
        const w = this.watching;
        return w === undefined ? undefined : { code: w.code, label: w.label, every: w.every, runs: w.runs };
      },
    };
  }

  processes(): Process[] {
    return parseProcesses(this.context.globalState.get<unknown>(PROCESSES_KEY, []), true).processes;
  }

  activeLabel(): string | undefined {
    return this.connection?.isOpen ? this.active?.label : undefined;
  }

  /// The connected process, as connected to: a discovered one's label qualified.
  activeProcess(): Process | undefined {
    return this.connection?.isOpen ? this.active : undefined;
  }

  /// Whether a query is running on the active connection: connecting
  /// elsewhere now would stop waiting for it.
  isBusy(): boolean {
    return this.connection?.isBusy ?? false;
  }

  history(): HistoryEntry[] {
    this.queries ??= this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
    return this.queries;
  }

  /// The history through the Query History view's filter.
  shownHistory(): HistoryEntry[] {
    return filtered(this.history(), this.historyFilter);
  }

  /// Run `use` on the active connection now, if there is one and no query
  /// is running on it; undefined otherwise. A query sent meanwhile waits for
  /// it instead of being refused.
  borrow<T>(use: (connection: QConnection, process: Process) => Promise<T>): Promise<T> | undefined {
    const connection = this.connection;
    const process = this.active;
    if (connection === undefined || process === undefined || !connection.isOpen || connection.isBusy) {
      return undefined;
    }
    const call = use(connection, process);
    const settled: Promise<unknown> = call.catch(() => {}).finally(() => {
      if (this.borrowed === settled) {
        this.borrowed = undefined;
      }
    });
    this.borrowed = settled;
    return call;
  }

  private async save(processes: Process[]): Promise<void> {
    await this.context.globalState.update(PROCESSES_KEY, processes);
    this.processesView.refresh();
  }

  /// A setting group read with `read`, as configured now.
  private setting<T>(read: (get: <V>(key: string, fallback: V) => V) => T): T {
    const configuration = workspace.getConfiguration("q-lint");
    return read((key, fallback) => configuration.get(key, fallback));
  }

  /// Whether a feature's setting is on; when it is off, says so and how to
  /// turn it on, for a command invoked anyway.
  private featureOn(enabled: boolean, feature: string, key: string): boolean {
    if (!enabled) {
      void window.showInformationMessage(`q-lint: ${feature} is turned off. Set ${key} to true to turn it on.`);
    }
    return enabled;
  }

  /// Whether `code` may be sent to `targets`: when the read-only guard
  /// (#918) finds it would change a guarded one, the user is asked first.
  /// `what` names the code in the question, when it is not a query.
  async guardAllows(code: string, targets: Process[], what?: string): Promise<boolean> {
    const check = guardCheck(code, targets, this.setting(readGuard));
    if (check === undefined) {
      return true;
    }
    const { message, detail } = guardQuestion(check);
    const yes = "Run Anyway";
    return (await window.showWarningMessage(what === undefined ? message : `${what}: ${message}`, { modal: true, detail }, yes)) === yes;
  }

  /// Why `code` is refused on `targets` to a caller that cannot ask the
  /// user, an agent; undefined when the guard lets it be sent.
  guardRefuses(code: string, targets: Process[]): string | undefined {
    const check = guardCheck(code, targets, this.setting(readGuard));
    return check === undefined ? undefined : guardRefusal(check);
  }

  private showStatus(): void {
    const label = this.activeLabel();
    // The time counts only with q-lint.query.progress.enable on (#910).
    const counting = this.running !== undefined && label !== undefined && this.setting(readProgress).enabled;
    if (counting && this.ticker === undefined && !this.disposed) {
      this.ticker = setInterval(() => this.showStatus(), 1000);
    } else if (!counting && this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    if (this.running !== undefined && label !== undefined) {
      const took = elapsedText(Date.now() - this.running.started);
      this.status.text = `$(sync~spin) q: ${iconsEscaped(label)}${counting ? ` ${took}` : ""}`;
      this.status.tooltip = counting
        ? `A query has been running on ${label} for ${took}. q-lint: Abort Current Query stops waiting for it.`
        : "A query is running. q-lint: Abort Current Query stops waiting for it.";
    } else if (label !== undefined) {
      const unanswered = this.beatSent === undefined ? 0 : Date.now() - this.beatSent;
      const health =
        unanswered >= UNANSWERED_MS
          ? ` $(warning) no answer ${elapsedText(unanswered)}`
          : this.latency !== undefined
            ? ` $(pulse) ${latencyText(this.latency.millis)}`
            : "";
      this.status.text = `$(plug) q: ${iconsEscaped(label)}${health}`;
      this.status.tooltip = [
        `Connected to ${this.active === undefined ? "" : address(this.active.host, this.active.port)}. Click to switch.`,
        ...(unanswered >= UNANSWERED_MS
          ? [`The heartbeat has had no answer for ${elapsedText(unanswered)}: the process is busy, or gone.`]
          : this.latency !== undefined
            ? [`Heartbeat round trip ${latencyText(this.latency.millis)}, at ${new Date(this.latency.at).toLocaleTimeString()}.`]
            : []),
      ].join("\n");
    } else if (this.reconnecting !== undefined) {
      const { label: to, attempt, of } = this.reconnecting;
      this.status.text = `$(sync~spin) q: reconnecting to ${iconsEscaped(to)} (${attempt} of ${of})`;
      this.status.tooltip = `The connection to ${to} dropped; q-lint is reconnecting (q-lint.connection.autoReconnect). q-lint: Disconnect stops it.`;
    } else {
      this.status.text = "$(debug-disconnect) q: not connected";
      this.status.tooltip = "Click to connect to a q process.";
    }
    // VS Code also shows a view's badge on its container's activity-bar icon.
    this.processesTree.badge = label === undefined ? undefined : { value: 1, tooltip: `Connected to ${label}` };
    void commands.executeCommand("setContext", CONNECTED, label !== undefined);
    this.controls?.refresh();
  }

  // --- processes

  /// Ask for a process's fields, starting from `from`; undefined if the user
  /// stops part way. `taken` are the labels it may not have.
  private async ask(from: Partial<Process>, taken: Set<string>): Promise<{ process: Process; password?: string } | undefined> {
    const label = await window.showInputBox({
      title: "q process: label",
      value: from.label,
      prompt: "A name for the process, unique in the list",
      validateInput: (v) => (v.trim() === "" ? "A label is needed." : taken.has(v.trim()) ? "That label is taken." : undefined),
    });
    if (label === undefined) {
      return undefined;
    }
    const host = await window.showInputBox({
      title: "q process: host",
      value: from.host ?? "localhost",
      validateInput: hostProblem,
    });
    if (host === undefined) {
      return undefined;
    }
    const port = await window.showInputBox({
      title: "q process: port",
      value: from.port !== undefined ? String(from.port) : "",
      validateInput: portProblem,
    });
    if (port === undefined) {
      return undefined;
    }
    // Editing, an unset `tls` is a process without it; adding, there is no
    // current value.
    const tls = await window.showQuickPick(tlsChoices(from.label === undefined ? undefined : from.tls === true), {
      title: "q process: TLS",
      placeHolder: "Connect over TLS?",
    });
    if (tls === undefined) {
      return undefined;
    }
    // Authentication: a user, then that user's password.
    const user = await window.showInputBox({
      title: "q process: authentication (1 of 2) - user",
      value: from.user ?? "",
      prompt: "The user sent in q's handshake. Leave empty to connect without one, and no password is asked for.",
    });
    if (user === undefined) {
      return undefined;
    }
    let password: string | undefined;
    if (user.trim() !== "") {
      password = await window.showInputBox({
        title: `q process: authentication (2 of 2) - password of ${user.trim()}`,
        password: true,
        prompt:
          from.label === undefined
            ? "Stored in VS Code's SecretStorage, never in settings or an export. Leave empty for none."
            : "Stored in VS Code's SecretStorage, never in settings or an export. Leave empty to keep the stored one.",
      });
      if (password === undefined) {
        return undefined;
      }
    }
    const tags = await window.showInputBox({
      title: "q process: tags",
      value: (from.tags ?? []).join(", "),
      prompt: "Comma separated. prod, uat and dev are coloured; Edit Tag Color colours any other.",
    });
    if (tags === undefined) {
      return undefined;
    }
    return {
      process: {
        label: label.trim(),
        host: plainHost(host),
        port: Number(port),
        ...(user.trim() !== "" ? { user: user.trim() } : {}),
        tags: parseTags(tags),
        ...(tls.tls ? { tls: true } : {}),
      },
      ...(password ? { password } : {}),
    };
  }

  private async add(): Promise<void> {
    const processes = this.processes();
    const answer = await this.ask({}, new Set(processes.map((p) => p.label)));
    if (answer === undefined) {
      return;
    }
    // Read again: the list may have changed while the boxes were open.
    const now = this.processes();
    if (now.some((p) => p.label === answer.process.label)) {
      void window.showErrorMessage(`q-lint: the label "${answer.process.label}" was taken meanwhile; the process was not added.`);
      return;
    }
    if (answer.password !== undefined) {
      await this.context.secrets.store(passwordKey(answer.process), answer.password);
    }
    await this.save([...now, answer.process]);
  }

  /// The process a command was given from a view row, or one the user picks.
  /// A discovered process only when `discovered`, with its label qualified;
  /// a label names a saved process before a discovered one.
  private async chosen(row: ProcessArg, title: string, discovered = false): Promise<Process | undefined> {
    const listed = discovered ? this.discovery.discovered() : [];
    if (typeof row === "string") {
      const named = this.processes().find((p) => p.label === row) ?? findDiscovered(listed, row);
      if (named === undefined) {
        void window.showErrorMessage(`q-lint: no q process is labelled "${row}".`);
      }
      return named;
    }
    if (row?.kind === "process") {
      return row.process;
    }
    if (row?.kind === "discovered") {
      if (!discovered) {
        void window.showInformationMessage("q-lint: a discovered process is not saved. Download Processes saves it.");
        return undefined;
      }
      return { ...row.process, label: qualified(row.server, row.process.label), server: row.server };
    }
    const processes = [
      ...this.processes(),
      ...listed.flatMap(({ server, state }) => state.processes.map((p) => ({ ...p, label: qualified(server.label, p.label), server: server.label }))),
    ];
    if (processes.length === 0) {
      const add = "Add Process";
      if ((await window.showInformationMessage("q-lint: no q processes yet.", add)) === add) {
        await this.add();
      }
      return undefined;
    }
    const picked = await window.showQuickPick(
      processes.map((p) => ({
        label: iconsEscaped(p.label),
        description: address(p.host, p.port),
        detail: p.tags.length ? p.tags.join(", ") : undefined,
        process: p,
      })),
      { title, matchOnDescription: true, matchOnDetail: true },
    );
    return picked?.process;
  }

  private async edit(row?: ProcessArg): Promise<void> {
    const old = await this.chosen(row, "Edit which q process?");
    if (old === undefined) {
      return;
    }
    const processes = this.processes();
    const taken = new Set(processes.map((p) => p.label).filter((l) => l !== old.label));
    const answer = await this.ask(old, taken);
    if (answer === undefined) {
      return;
    }
    // The boxes do not ask for the connect script: it is kept.
    const process = withScript(answer.process, scriptOf(old));
    // Read again: the list may have changed while the boxes were open.
    const now = this.processes();
    const problem = !now.some((p) => p.label === old.label)
      ? `"${old.label}" was deleted meanwhile`
      : process.label !== old.label && now.some((p) => p.label === process.label)
        ? `the label "${process.label}" was taken meanwhile`
        : undefined;
    if (problem !== undefined) {
      void window.showErrorMessage(`q-lint: ${problem}; the process was not changed.`);
      return;
    }
    if (process.label !== old.label) {
      const kept = await this.context.secrets.get(passwordKey(old));
      await this.context.secrets.delete(passwordKey(old));
      if (kept !== undefined && answer.password === undefined) {
        await this.context.secrets.store(passwordKey(process), kept);
      }
    }
    if (answer.password !== undefined) {
      await this.context.secrets.store(passwordKey(process), answer.password);
    }
    if (process.user === undefined) {
      await this.context.secrets.delete(passwordKey(process));
    }
    await this.save(now.map((p) => (p.label === old.label ? process : p)));
    if (process.label !== old.label) {
      await this.rebind(old.label, process.label);
    }
    const active = this.active;
    if (active?.label === old.label && active.server === undefined) {
      // The connection is still to where it was opened: it takes the new
      // label and tags, and keeps its address until connected again.
      const { host, port, user, tls } = active;
      this.active = withScript(
        { label: process.label, host, port, ...(user !== undefined ? { user } : {}), tags: process.tags, ...(tls ? { tls } : {}) },
        scriptOf(process),
      );
      this.showStatus();
      // The explorer keeps what it read under the label it read it for.
      if (process.label !== old.label && this.activeLabel() !== undefined) {
        this.changed.fire("connected");
      }
      const moved = process.host !== host || process.port !== port || process.user !== user || (process.tls === true) !== (tls === true);
      if (moved && this.activeLabel() !== undefined) {
        void window.showInformationMessage(
          `q-lint: still connected to ${process.label} at ${address(host, port)}. Connect to it again to use ${address(process.host, process.port)}.`,
        );
      }
    }
  }

  private async remove(row?: ProcessArg): Promise<void> {
    const process = await this.chosen(row, "Delete which q process?");
    if (process === undefined) {
      return;
    }
    const yes = "Delete";
    const sure = await window.showWarningMessage(`Delete the q process "${process.label}" from the list?`, { modal: true }, yes);
    if (sure !== yes) {
      return;
    }
    if (this.activeLabel() === process.label && this.active?.server === undefined) {
      await this.disconnect();
    }
    await this.context.secrets.delete(passwordKey(process));
    await this.save(this.processes().filter((p) => p.label !== process.label));
    await this.rebind(process.label, undefined);
  }

  /// Bind the files bound to the process `from` to `to` instead, or unbind
  /// them: a binding is by label, and one to no process fails every query.
  private async rebind(from: string, to: string | undefined): Promise<void> {
    let stored = this.context.workspaceState.get<unknown>(FILE_CONNECTIONS_KEY);
    if (typeof stored !== "object" || stored === null) {
      return;
    }
    for (const [uri, label] of Object.entries(stored)) {
      if (label === from) {
        stored = withBinding(stored, uri, to);
      }
    }
    await this.context.workspaceState.update(FILE_CONNECTIONS_KEY, stored);
    this.controls.refresh();
  }

  private async tag(row?: ProcessArg): Promise<void> {
    const process = await this.chosen(row, "Tag which q process?");
    if (process === undefined) {
      return;
    }
    const tags = await window.showInputBox({
      title: `Tags of ${process.label}`,
      value: process.tags.join(", "),
      prompt: "Comma separated. prod, uat and dev are coloured; Edit Tag Color colours any other.",
    });
    if (tags === undefined) {
      return;
    }
    await this.save(this.processes().map((p) => (p.label === process.label ? { ...p, tags: parseTags(tags) } : p)));
    this.retagActive();
  }

  /// Give the connected process, when it is a saved one, its saved tags: an
  /// agent's query warns by them.
  private retagActive(): void {
    const saved = this.active?.server === undefined ? this.processes().find((p) => p.label === this.active?.label) : undefined;
    if (this.active !== undefined && saved !== undefined) {
      this.active = { ...this.active, tags: saved.tags };
    }
  }

  /// Import the processes `file` lists, or a file the user picks.
  private async importList(file?: Uri): Promise<void> {
    const files = file instanceof Uri ? [file] : await window.showOpenDialog({
      title: "Import q processes",
      canSelectMany: false,
      filters: { "Process list": ["json"] },
    });
    if (files === undefined || files.length === 0) {
      return;
    }
    let read: { processes: Process[]; problems: string[] };
    try {
      read = readProcessFile(Buffer.from(await workspace.fs.readFile(files[0])).toString("utf8"));
    } catch (error) {
      void window.showErrorMessage(`q-lint: could not read ${files[0].fsPath}: ${String(error)}`);
      return;
    }
    const { problems } = read;
    let { processes } = read;
    const before = this.processes();
    // Code that runs on a process at every connect is not taken from a file
    // unasked: someone else's list may hold it.
    const brought = scriptsBrought(before, processes);
    if (brought.length > 0) {
      const keep = "Import with Scripts";
      const drop = "Import without Scripts";
      const answer = await window.showWarningMessage(
        `${files[0].fsPath} gives ${brought.length} process(es) a connect script, q code run on the process at every connect: ${brought.slice(0, 5).join(", ")}${brought.length > 5 ? ", ..." : ""}. Keep the scripts?`,
        { modal: true },
        keep,
        drop,
      );
      if (answer === undefined) {
        return;
      }
      if (answer === drop) {
        const old = new Map(before.map((p) => [p.label, p]));
        processes = processes.map((p) => (brought.includes(p.label) ? withScript(p, old.get(p.label) && scriptOf(old.get(p.label)!)) : p));
      }
    }
    for (const label of passwordsToForget(before, processes)) {
      await this.context.secrets.delete(passwordKey({ label }));
    }
    await this.save(merge(before, processes));
    this.retagActive();
    const note = problems.length ? ` Skipped ${problems.length}: ${problems.slice(0, 3).join(" ")}` : "";
    void window.showInformationMessage(`q-lint: imported ${processes.length} q process(es).${note}`);
  }

  private async exportList(): Promise<void> {
    const file = await window.showSaveDialog({
      title: "Export q processes (passwords are not exported)",
      filters: { "Process list": ["json"] },
      defaultUri: workspace.workspaceFolders?.[0]
        ? Uri.joinPath(workspace.workspaceFolders[0].uri, "q-processes.json")
        : undefined,
    });
    if (file === undefined) {
      return;
    }
    const processes = this.processes();
    const text = JSON.stringify({ processes }, null, 2) + "\n";
    try {
      await workspace.fs.writeFile(file, Buffer.from(text, "utf8"));
    } catch (error) {
      void window.showErrorMessage(`q-lint: could not write ${file.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void window.showInformationMessage(`q-lint: exported ${processes.length} q process(es) to ${file.fsPath}.`);
  }

  private insertLabel(): void {
    const label = this.activeLabel();
    const editor = window.activeTextEditor;
    if (label === undefined) {
      void window.showInformationMessage("q-lint: not connected to a q process.");
      return;
    }
    if (editor === undefined) {
      noEditor();
      return;
    }
    void editor.edit((edit) => {
      for (const selection of editor.selections) {
        edit.replace(selection, label);
      }
    });
  }

  /// Set the connect script of a saved process: q code or a q file run on
  /// every connect, before any query (#916). `script` (from a keybinding or
  /// a test) sets it without asking; `null` removes it.
  private async setConnectScript(row?: ProcessArg, script?: ConnectScript | null): Promise<void> {
    if (!this.featureOn(this.setting(readConnectScript).enabled, "Connect scripts", "q-lint.connection.connectScript.enable")) {
      return;
    }
    const process = await this.chosen(row, "Set the connect script of which q process?");
    if (process === undefined) {
      return;
    }
    const current = scriptOf(process);
    let chosen: ConnectScript | undefined;
    if (script === null) {
      chosen = undefined;
    } else if (typeof script === "object" && (script.kind === "code" ? typeof script.code === "string" : typeof script.file === "string")) {
      chosen = script.kind === "code" ? { kind: "code", code: script.code } : { kind: "file", file: script.file };
    } else {
      const picked = await window.showQuickPick(
        [
          { label: "q Code", choice: "code" as const, detail: "A line of q, run as a query is: statements separated by `;`." },
          { label: "q File", choice: "file" as const, detail: "A q file, read at each connect and run as Execute Entire File runs one." },
          { label: "None", choice: "none" as const, detail: "Run nothing on connect." },
        ].map((c) => ({ ...c, ...((current?.kind ?? "none") === c.choice ? { description: `current: ${scriptSummary(current)}` } : {}) })),
        { title: `Connect script of ${process.label}`, placeHolder: "What runs on the process at every connect, before any query?" },
      );
      if (picked === undefined) {
        return;
      }
      if (picked.choice === "code") {
        const code = await window.showInputBox({
          title: `Connect script of ${process.label}: q code`,
          value: current?.kind === "code" ? current.code : "",
          prompt: "Run on every connect, before any query, as a query is. Empty for none.",
          ignoreFocusOut: true,
        });
        if (code === undefined) {
          return;
        }
        chosen = code.trim() === "" ? undefined : { kind: "code", code };
      } else if (picked.choice === "file") {
        const folder = workspace.workspaceFolders?.[0]?.uri;
        const files = await window.showOpenDialog({
          title: `Connect script of ${process.label}: q file`,
          canSelectMany: false,
          filters: { "q script": ["q", "k"] },
          ...(folder !== undefined ? { defaultUri: folder } : {}),
        });
        if (files === undefined || files.length === 0) {
          return;
        }
        // Inside the workspace folder it is kept relative, so the list
        // reads the same on a colleague's machine.
        const relative = folder === undefined ? undefined : path.relative(folder.fsPath, files[0].fsPath);
        chosen = { kind: "file", file: relative !== undefined && relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : files[0].fsPath };
      }
    }
    if (chosen !== undefined && isProduction(process)) {
      const yes = "Set Script";
      const sure = await window.showWarningMessage(
        `${process.label} is a production process (tagged ${process.tags.join(", ")}). Its connect script runs there at every connect, as written, and can change or delete data. Set it?`,
        { modal: true },
        yes,
      );
      if (sure !== yes) {
        return;
      }
    }
    const now = this.processes();
    if (!now.some((p) => p.label === process.label)) {
      void window.showErrorMessage(`q-lint: "${process.label}" was deleted meanwhile; its connect script was not set.`);
      return;
    }
    await this.save(now.map((p) => (p.label === process.label ? withScript(p, chosen) : p)));
    if (this.active?.label === process.label && this.active.server === undefined) {
      this.active = withScript(this.active, chosen);
    }
    void window.showInformationMessage(
      chosen === undefined
        ? `q-lint: ${process.label} runs nothing on connect.`
        : `q-lint: ${process.label} runs its connect script (${scriptSummary(chosen)}) from the next connect.`,
    );
  }

  /// Run `process`'s connect script on `connection`, just opened, before any
  /// query can be: its failure is said, and the connection kept.
  private async runConnectScript(connection: QConnection, process: Process): Promise<void> {
    const script = scriptOf(process);
    if (script === undefined || !this.setting(readConnectScript).enabled) {
      return;
    }
    const failed = (why: string): void => {
      this.show([`# ${process.label} - connect script failed: ${why}`], false);
      void window.showWarningMessage(`q-lint: the connect script of ${process.label} failed: ${why}`);
    };
    let code: string;
    if (script.kind === "code") {
      code = script.code;
    } else {
      const file = scriptPath(script.file, os.homedir(), workspace.workspaceFolders?.[0]?.uri.fsPath);
      if (file === undefined) {
        failed(`${script.file} is relative, and there is no workspace folder to read it from.`);
        return;
      }
      try {
        code = Buffer.from(await workspace.fs.readFile(Uri.file(file))).toString("utf8");
      } catch (error) {
        failed(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    const cut = statements(code);
    if (cut.length === 0) {
      return;
    }
    if (!(await this.guardAllows(code, [process], `The connect script of ${process.label}`))) {
      this.show([`# ${process.label} - connect script not run: changing a read-only process was not confirmed`], false);
      return;
    }
    const configuration = workspace.getConfiguration("q-lint");
    const { consoleSize } = readLive((key, fallback) => configuration.get(key, fallback));
    const started = Date.now();
    try {
      const answer = await window.withProgress(
        { location: { viewId: VIEWS.processes }, title: `Running the connect script of ${process.label}` },
        () =>
          this.controls.settings().unwrapped
            ? runUnwrapped(connection, cut, { size: consoleSize, limit: 0, unlimited: false, grid: false })
            : connection.query(cut, consoleSize),
      );
      if (!answer.ok) {
        failed(`'${answer.error}`);
        return;
      }
      this.output.appendLine(`# ${process.label} - connect script ran (${Date.now() - started} ms)`);
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error));
    }
  }

  // --- connections

  async connectTo(row?: ProcessArg): Promise<boolean> {
    const process = await this.chosen(row, "Connect to which q process?", true);
    // A connect the user asks for stops an automatic reconnect.
    if (process !== undefined) {
      this.stopReconnecting();
    }
    if (process === undefined) {
      return false;
    }
    // A discovered process's user has no password stored until asked for one.
    const saved = process.server === undefined;
    if (!saved && process.user && (await this.context.secrets.get(passwordKey(process))) === undefined) {
      const password = await window.showInputBox({
        title: `q process ${process.label}: password of ${process.user}`,
        password: true,
        prompt: "Kept in VS Code's secret storage.",
      });
      if (password === undefined) {
        return false;
      }
      await this.context.secrets.store(passwordKey(process), password);
      // Kept, so deleting the server forgets it even after a reload.
      await this.discovery.passwordGiven(process.server!, process.label.slice(process.server!.length + 1));
    }
    const connected = await this.open(process);
    // A discovered process cannot be edited, so a password that did not
    // connect is forgotten: the next connect asks for it again.
    if (!connected && !saved && process.user) {
      await this.context.secrets.delete(passwordKey(process));
      await this.discovery.passwordGiven(process.server!, process.label.slice(process.server!.length + 1), false);
    }
    return connected;
  }

  /// Connect to `process`, closing the connection there was. Whether it
  /// connected. `untilFree`, after an abort: a process that does not answer
  /// the handshake is still running the query it was left with, and is
  /// tried again until it does, or until the user disconnects or connects
  /// elsewhere.
  private open(process: Process, untilFree = false, quiet = false): Promise<boolean> {
    if (this.connecting !== undefined) {
      // A connect to another process - a reconnect after an abort, waiting
      // for that process to be free - is stopped and this one follows: its
      // result says nothing of this process.
      if (this.connectingTo === passwordKey(process)) {
        return this.connecting;
      }
      this.reconnectStopped = true;
      return this.connecting.then(() => this.open(process));
    }
    this.reconnectStopped = false;
    this.connectingTo = passwordKey(process);
    this.connecting = (async () => {
      if (this.connection !== undefined) {
        const old = this.connection;
        this.connection = undefined;
        this.aborted = this.running?.started;
        await old.close();
        // Said now, not on connecting: the new one may never come.
        this.changed.fire("disconnected");
      }
      const password = process.user ? await this.context.secrets.get(passwordKey(process)) : undefined;
      try {
        const connection = await window.withProgress(
          { location: { viewId: VIEWS.processes }, title: `Connecting to ${process.label}` },
          async () => {
            const target = {
              host: process.host,
              port: process.port,
              ...(process.user ? { user: process.user, password: password ?? "" } : {}),
              ...(process.tls ? { tls: true } : {}),
            };
            for (;;) {
              try {
                return await QConnection.open(target);
              } catch (error) {
                const busy = error instanceof Error && error.message.startsWith("no answer from ");
                if (!untilFree || !busy || this.reconnectStopped) {
                  throw error;
                }
              }
            }
          },
        );
        // Opened after deactivate (a reconnect after an abort), when nothing
        // would close it, or after the reconnect was stopped.
        if (this.disposed || ((untilFree || quiet) && this.reconnectStopped)) {
          await connection.close();
          return false;
        }
        await this.runConnectScript(connection, process);
        this.connection = connection;
        this.active = process;
        connection.whenClosed(() => {
          if (this.connection === connection) {
            this.connection = undefined;
            this.running = undefined;
            const configuration = workspace.getConfiguration("q-lint");
            const again = readHealth((key, fallback) => configuration.get(key, fallback)).autoReconnect && !this.disposed;
            this.showStatus();
            this.processesView.refresh();
            this.changed.fire("disconnected");
            void window.showWarningMessage(`q-lint: the connection to ${process.label} closed.${again ? " Reconnecting." : ""}`);
            if (again) {
              void this.autoReconnect(process);
            }
          }
        });
        this.changed.fire("connected");
        return true;
      } catch (error) {
        if ((untilFree && this.reconnectStopped) || quiet) {
          return false;
        }
        void window.showErrorMessage(
          `q-lint: could not connect to ${process.label} (${address(process.host, process.port)}): ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      } finally {
        this.showStatus();
        this.processesView.refresh();
      }
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /// Reconnect to `process`, whose connection dropped, waiting longer before
  /// each try (`backoffDelay`), until it connects, the tries run out, or the
  /// user connects elsewhere or disconnects (#917).
  private async autoReconnect(process: Process): Promise<void> {
    const run = ++this.reconnectRun;
    const configuration = workspace.getConfiguration("q-lint");
    const { reconnectAttempts } = readHealth((key, fallback) => configuration.get(key, fallback));
    for (let attempt = 1; attempt <= reconnectAttempts; attempt++) {
      this.reconnecting = { label: process.label, attempt, of: reconnectAttempts };
      this.showStatus();
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)));
      if (run !== this.reconnectRun || this.connection !== undefined) {
        return;
      }
      const connected = await this.open(process, false, true);
      if (run !== this.reconnectRun) {
        return;
      }
      if (connected) {
        this.reconnecting = undefined;
        this.showStatus();
        void window.showInformationMessage(`q-lint: reconnected to ${process.label}.`);
        return;
      }
    }
    this.reconnecting = undefined;
    this.showStatus();
    void window.showWarningMessage(`q-lint: could not reconnect to ${process.label} after ${reconnectAttempts} tries.`);
  }

  /// Stop an automatic reconnect, if one is under way.
  private stopReconnecting(): void {
    this.reconnectRun++;
    if (this.reconnecting !== undefined) {
      this.reconnecting = undefined;
      this.showStatus();
    }
  }

  /// Start the heartbeat for the connection there is, or stop it when there
  /// is none or `q-lint.connection.heartbeat` is 0.
  private restartHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.latency = undefined;
    this.beatSent = undefined;
    const configuration = workspace.getConfiguration("q-lint");
    const { heartbeat } = readHealth((key, fallback) => configuration.get(key, fallback));
    if (heartbeat > 0 && this.activeLabel() !== undefined && !this.disposed) {
      this.heartbeat = setInterval(() => void this.beat(), heartbeat * 1000);
      void this.beat();
    }
    this.showStatus();
  }

  /// Send one heartbeat and time its answer. Skipped while a query or the
  /// explorer's read is out: the connection takes one message at a time,
  /// and is plainly alive. One still unanswered is shown waiting instead.
  private async beat(): Promise<void> {
    if (this.beatSent !== undefined) {
      this.showStatus();
      return;
    }
    const sent = Date.now();
    const call = this.borrow(async (connection) => {
      this.beatSent = sent;
      try {
        await connection.evaluate(HEARTBEAT);
      } catch (error) {
        // A q error is still an answer: a gateway may refuse the string.
        if (!(error instanceof QError)) {
          throw error;
        }
      }
      return connection;
    });
    if (call === undefined) {
      return;
    }
    try {
      const connection = await call;
      if (connection === this.connection) {
        this.latency = { millis: Date.now() - sent, at: Date.now() };
      }
    } catch {
      // Closed meanwhile: whenClosed says so.
    } finally {
      if (this.beatSent === sent) {
        this.beatSent = undefined;
      }
      this.showStatus();
    }
  }

  private async disconnect(): Promise<void> {
    if (this.reconnecting !== undefined && this.connection === undefined) {
      // A try under way is closed once it opens.
      this.reconnectStopped = true;
      this.stopReconnecting();
      return;
    }
    this.reconnectRun++;
    if (this.connection === undefined && this.connecting === undefined) {
      void window.showInformationMessage("q-lint: not connected to a q process.");
      return;
    }
    this.reconnectStopped = true;
    const connection = this.connection;
    this.connection = undefined;
    // A query running on it was stopped by the user, as Abort stops one.
    this.aborted = this.running?.started;
    this.running = undefined;
    await connection?.close();
    this.showStatus();
    this.processesView.refresh();
    this.changed.fire("disconnected");
  }

  // --- queries

  private async queryFrom(from: From): Promise<void> {
    const editor = window.activeTextEditor;
    if (editor === undefined) {
      noEditor();
      return;
    }
    const written = codeAt(editor, from);
    if (written === undefined || statements(written).length === 0) {
      nothingThere(from);
      return;
    }
    const code = await this.filledIn(written);
    if (code === undefined) {
      return;
    }
    await this.queryCode(code, editor.document.uri);
  }

  /// Run `code` from the document `uri` as a query from the editor is run:
  /// on the process the file is bound to, when it has one. A Run code lens
  /// sends its definition here.
  async queryCode(code: string, uri: Uri): Promise<void> {
    // A file with a process of its own switches the connection to it.
    const bound = this.controls.binding(uri);
    if (bound !== undefined && bound !== this.activeLabel()) {
      if (this.connection?.isBusy) {
        void window.showInformationMessage(
          `q-lint: a query is still running on ${this.active?.label}; this file's queries go to ${bound}. q-lint: Abort Current Query stops waiting for it.`,
        );
        return;
      }
      if (!(await this.connectTo(bound))) {
        return;
      }
    }
    await this.run(code);
  }

  /// `code` with its `{{name}}` placeholders given the values the user
  /// types, each box starting from the value given last (#911); undefined
  /// when the user pressed Escape, and nothing is run.
  private async filledIn(code: string): Promise<string | undefined> {
    const configuration = workspace.getConfiguration("q-lint");
    const names = readPlaceholders((key, fallback) => configuration.get(key, fallback)).enabled ? placeholderNames(code) : [];
    if (names.length === 0) {
      return code;
    }
    const stored = this.context.globalState.get<unknown>(PLACEHOLDER_VALUES_KEY);
    const values: Record<string, string> = {};
    for (const [i, name] of names.entries()) {
      const value = await window.showInputBox({
        title: `q-lint: {{${name}}}${names.length > 1 ? ` (${i + 1} of ${names.length})` : ""}`,
        value: lastValue(stored, name) ?? "",
        prompt: `q put in place of {{${name}}} before the query is sent, as written: \`AAPL, 2024.01.01, "text". Escape runs nothing.`,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return undefined;
      }
      Object.defineProperty(values, name, { value, enumerable: true, writable: true, configurable: true });
    }
    await this.context.globalState.update(PLACEHOLDER_VALUES_KEY, remembered(stored, values));
    return substitute(code, values);
  }

  /// The active connection and its process, connecting first if there is
  /// none; undefined when none was connected or a query is still running.
  private async ready(): Promise<{ connection: QConnection; process: Process } | undefined> {
    // A reconnect still under way (after an abort) is waited for, not
    // replaced by asking which process to connect to.
    if (this.connection === undefined && this.connecting !== undefined) {
      await this.connecting;
    }
    if (this.connection === undefined && !(await this.connectTo())) {
      return undefined;
    }
    const before = this.connection;
    await this.borrowed;
    const connection = this.connection;
    const process = this.active;
    if (connection !== before && before !== undefined) {
      // Closed while the explorer's read was out: by Abort, which stopped
      // that read, or by the process.
      void window.showInformationMessage(
        `q-lint: the connection to ${process?.label ?? "the process"} closed before the query was sent; it was not run.`,
      );
      return undefined;
    }
    if (connection === undefined || process === undefined) {
      return undefined;
    }
    if (connection.isBusy) {
      void window.showInformationMessage(
        `q-lint: a query is still running on ${process.label}. q-lint: Abort Current Query stops waiting for it.`,
      );
      return undefined;
    }
    return { connection, process };
  }

  /// Run `query` on the active connection, connecting first if there is
  /// none, for a caller that shows its own result - a notebook cell. The
  /// status bar shows it running, and `abort` stops waiting for it.
  /// Undefined when nothing was run; throws what `query` throws, and why
  /// the read-only guard did not let `code` be sent: asked and declined, or
  /// refused outright for a caller that cannot ask (`guard` "refuse").
  async runOnActive<T>(
    code: string,
    query: (connection: QConnection) => Promise<T>,
    guard: "ask" | "refuse" = "ask",
  ): Promise<{ process: string; value: T } | undefined> {
    let ready = await this.ready();
    if (ready === undefined) {
      return undefined;
    }
    const refused = this.guardRefuses(code, [ready.process]);
    if (refused !== undefined) {
      if (guard === "refuse") {
        throw new Error(refused);
      }
      if (!(await this.guardAllows(code, [ready.process]))) {
        throw new Error(`Not run: changing the read-only process ${ready.process.label} was not confirmed.`);
      }
      // The connection can have changed while the question was open.
      ready = this.stillReady(ready);
      if (ready === undefined) {
        return undefined;
      }
    }
    const started = Date.now();
    this.running = { code, started };
    this.showStatus();
    try {
      return { process: ready.process.label, value: await query(ready.connection) };
    } finally {
      if (this.running?.started === started) {
        this.running = undefined;
      }
      this.showStatus();
      // A cell can define names as a query can: the explorer refreshes after it.
      this.changed.fire("queried");
    }
  }

  /// `ready`, when its connection is still the active one and free: a
  /// question asked since can have taken a while. Says why not.
  private stillReady(ready: { connection: QConnection; process: Process }): { connection: QConnection; process: Process } | undefined {
    if (ready.connection !== this.connection || !ready.connection.isOpen) {
      void window.showInformationMessage(`q-lint: the connection to ${ready.process.label} closed while you were asked; nothing was run.`);
      return undefined;
    }
    if (ready.connection.isBusy) {
      void window.showInformationMessage(`q-lint: a query started on ${ready.process.label} while you were asked; nothing was run.`);
      return undefined;
    }
    return ready;
  }

  /// The code a command takes from the active editor: the selection, or the
  /// statement the cursor is in, its `{{name}}` placeholders filled in
  /// unless `fill` is false. Undefined, having said why, when there is none
  /// or the user pressed Escape.
  async codeFromEditor(fill = true): Promise<string | undefined> {
    const editor = window.activeTextEditor;
    if (editor === undefined) {
      noEditor();
      return undefined;
    }
    const from: From = editor.selection.isEmpty ? "block" : "selection";
    const written = codeAt(editor, from);
    if (written === undefined || statements(written).length === 0) {
      nothingThere(from);
      return undefined;
    }
    return fill ? this.filledIn(written) : written;
  }

  /// Run `code` as a query from the editor is run, its placeholders asked
  /// for first: a saved query (#912).
  async runFilledIn(code: string): Promise<void> {
    const filled = await this.filledIn(code);
    if (filled !== undefined) {
      await this.run(filled);
    }
  }

  /// The process `row` names, or one the user picks, saved or discovered.
  choose(row: ProcessArg, title: string): Promise<Process | undefined> {
    return this.chosen(row, title, true);
  }

  /// Run `code` on `process` over a connection of its own, opened for it
  /// and closed after, so the active connection and its status are left
  /// alone: Query a Tag and Compare Query run here (#906, #907). Its
  /// connect script runs first. The answer is asked for as a grid-mode
  /// query asks, within the query controls (unlimited, unwrapped, the
  /// timeout); `signal` stops waiting. Throws why there is no answer. The
  /// caller asks the read-only guard first.
  async runApart(process: Process, code: string, signal?: AbortSignal): Promise<GridAnswer> {
    const password = process.user ? await this.context.secrets.get(passwordKey(process)) : undefined;
    if (process.user && password === undefined && process.server !== undefined) {
      throw new Error(`no password is stored for ${process.user}: connect to ${process.label} once to give it`);
    }
    const connection = await QConnection.open(
      {
        host: process.host,
        port: process.port,
        ...(process.user ? { user: process.user, password: password ?? "" } : {}),
        ...(process.tls ? { tls: true } : {}),
      },
      undefined,
      signal,
    );
    const stop = (): void => connection.abort();
    signal?.addEventListener("abort", stop);
    const controls = this.controls.settings();
    let timedOut = false;
    const disarm = armTimeout(controls.timeout, () => {
      timedOut = true;
      connection.abort();
    });
    try {
      await this.runConnectScript(connection, process);
      const configuration = workspace.getConfiguration("q-lint");
      const settings = readLive((key, fallback) => configuration.get(key, fallback));
      const unlimited = this.controls.unlimited;
      const { consoleSize, gridLimit } = limits(settings, unlimited);
      const cut = statements(code);
      return controls.unwrapped
        ? await runUnwrapped(connection, cut, { size: consoleSize, limit: gridLimit, unlimited, grid: true })
        : await connection.queryGrid(cut, consoleSize, gridLimit);
    } catch (error) {
      throw timedOut ? new Error(timedOutError(controls.timeout)) : signal?.aborted ? new Error("cancelled") : error;
    } finally {
      disarm();
      signal?.removeEventListener("abort", stop);
      void connection.close();
    }
  }

  /// Show `payload` in the result panel, as a grid when the query mode is
  /// the console, under `label`: Query a Tag's merged table.
  showGrid(label: string, code: string, payload: GridPayload, millis: number): void {
    const configuration = workspace.getConfiguration("q-lint");
    const settings = readLive((key, fallback) => configuration.get(key, fallback));
    this.modes.show(
      { process: label, code, millis, answer: { ok: true, type: 98, text: [], grid: payload } },
      { ...settings, mode: settings.mode === "console" ? "grid" : settings.mode },
    );
  }

  /// Watch Query (#914): run `code` (one given, or the editor's selection
  /// or statement at the cursor) on the active connection now and then
  /// every `every` seconds (one given, or asked for), refreshing its result
  /// in place, until stopped, disconnected, or connected elsewhere. A run
  /// due while a query is out is skipped. The read-only guard asks once, at
  /// the start, as does a guarded or production process.
  async watch(given?: string, every?: number): Promise<void> {
    if (!this.featureOn(this.setting(readWatch).enabled, "Watch Query", "q-lint.query.watch.enable")) {
      return;
    }
    const code = typeof given === "string" ? given : await this.codeFromEditor();
    if (code === undefined) {
      return;
    }
    if (statements(code).length === 0) {
      void window.showInformationMessage("q-lint: the query is empty: it is blank or only comments.");
      return;
    }
    let seconds = typeof every === "number" && intervalProblem(String(every)) === undefined ? every : undefined;
    if (seconds === undefined) {
      const text = await window.showInputBox({
        title: "Watch Query: every how many seconds?",
        value: String(this.setting(readWatch).interval),
        prompt: "The query runs now, and again at this interval until Stop Watching Query, a disconnect, or a connect elsewhere.",
        validateInput: intervalProblem,
      });
      if (text === undefined) {
        return;
      }
      seconds = Number(text.trim());
    }
    const ready = await this.ready();
    if (ready === undefined) {
      return;
    }
    const { process } = ready;
    if (!(await this.guardAllows(code, [process]))) {
      return;
    }
    const tags = guardedBy(process, this.setting(readGuard));
    if (tags.length > 0 || isProduction(process)) {
      const yes = "Watch";
      const asked = await window.showWarningMessage(
        `Watch the query on ${process.label}?`,
        {
          modal: true,
          detail: `${process.label} is tagged ${process.tags.join(", ")}. The query runs there every ${seconds} s until you stop it.`,
        },
        yes,
      );
      if (asked !== yes) {
        return;
      }
    }
    if (this.activeLabel() !== process.label) {
      void window.showInformationMessage(`q-lint: the connection moved from ${process.label} while you were asked; nothing is watched.`);
      return;
    }
    this.stopWatching();
    const status = window.createStatusBarItem("q-lint.watch", StatusBarAlignment.Left, 48);
    status.name = "q-lint: watched query";
    status.command = WATCH.stop;
    status.tooltip = `Watching on ${process.label} every ${seconds} s:\n${code}\nClick to stop.`;
    this.watching = {
      code,
      label: process.label,
      every: seconds,
      runs: 0,
      timer: setInterval(() => void this.watchRun(), seconds * 1000),
      status,
      running: false,
    };
    void commands.executeCommand("setContext", WATCHING, true);
    status.show();
    await this.watchRun();
  }

  /// One run of the watched query; skipped while a query, or the last run,
  /// is still out.
  private async watchRun(): Promise<void> {
    const watched = this.watching;
    if (watched === undefined || watched.running) {
      return;
    }
    if (this.activeLabel() !== watched.label) {
      this.stopWatching(`the connection is no longer to ${watched.label}`);
      return;
    }
    if (this.connection?.isBusy || this.borrowed !== undefined) {
      return;
    }
    watched.running = true;
    const first = watched.runs === 0;
    watched.runs++;
    watched.status.text = watchText(iconsEscaped(watched.label), watched.every, watched.runs);
    try {
      await this.run(watched.code, first ? "watch" : "watched");
    } finally {
      watched.running = false;
    }
  }

  /// Stop the watch, if there is one, saying why when `why` is given.
  private stopWatching(why?: string): void {
    const watched = this.watching;
    if (watched === undefined) {
      if (why === undefined && !this.disposed) {
        void window.showInformationMessage("q-lint: no query is watched.");
      }
      return;
    }
    this.watching = undefined;
    clearInterval(watched.timer);
    watched.status.dispose();
    void commands.executeCommand("setContext", WATCHING, false);
    if (why !== undefined) {
      void window.showInformationMessage(`q-lint: stopped watching the query: ${why}.`);
    }
  }

  /// Run `code` on the active connection, connecting first if there is none.
  /// The process explorer's Preview runs here too. A watched query's first
  /// run (`watch`) asks nothing more, and its later ones (`watched`) are
  /// not recorded, and refresh the result in place.
  async run(code: string, as?: "watch" | "watched"): Promise<void> {
    let ready = await this.ready();
    if (ready === undefined) {
      return;
    }
    if (as === undefined && this.guardRefuses(code, [ready.process]) !== undefined) {
      if (!(await this.guardAllows(code, [ready.process]))) {
        return;
      }
      ready = this.stillReady(ready);
      if (ready === undefined) {
        return;
      }
    }
    const { connection, process } = ready;
    const configuration = workspace.getConfiguration("q-lint");
    const settings = readLive((key, fallback) => configuration.get(key, fallback));
    const controls = this.controls.settings();
    const unlimited = this.controls.unlimited;
    const { consoleSize, gridLimit } = limits(settings, unlimited);
    const started = Date.now();
    this.running = { code, started };
    this.showStatus();
    // A query still running at the timeout is aborted as Abort does.
    const disarm = armTimeout(controls.timeout, () => {
      if (this.running?.started === started) {
        this.timedOut = started;
        void this.abort(controls.timeout);
      }
    });
    let entry: HistoryEntry;
    try {
      // Grid and chart modes ask for the rows too; a value that is not
      // tabular comes back as console mode's text.
      const cut = statements(code);
      // Paging (#922) leaves a cut result on the process: never in
      // unwrapped mode, which sends nothing of ours, nor on production.
      const hold = !controls.unwrapped && settings.mode !== "console" && this.modes.wantsHold(isProduction(process));
      const answer = controls.unwrapped
        ? await runUnwrapped(connection, cut, { size: consoleSize, limit: gridLimit, unlimited, grid: settings.mode !== "console" })
        : settings.mode !== "console"
          ? await connection.queryGrid(cut, consoleSize, gridLimit, this.modes.wantsTree(), hold)
          : unlimited
            ? readUnlimited(await connection.call(UNLIMITED, cut, consoleSize))
            : await connection.query(cut, consoleSize);
      const millis = Date.now() - started;
      entry = {
        process: process.label,
        code,
        at: new Date(started).toISOString(),
        millis,
        outcome: answer.ok ? "ok" : "error",
        ...(answer.ok ? {} : { error: answer.error }),
      };
      if (!this.modes.show({ process: process.label, code, answer, millis, held: hold }, settings, as === "watched")) {
        this.show(render({ process: process.label, code, answer, millis }, settings), settings.autoClear || as === "watched");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = this.aborted === started;
      const timedOut = this.timedOut === started;
      entry = {
        process: process.label,
        code,
        at: new Date(started).toISOString(),
        millis: Date.now() - started,
        outcome: timedOut ? "timeout" : aborted ? "aborted" : "error",
        error: timedOut ? timedOutError(controls.timeout) : aborted ? "aborted" : message,
      };
      this.show([`# ${process.label} - ${timedOut ? timedOutError(controls.timeout) : aborted ? "aborted" : "failed"}: ${message}`], false);
    } finally {
      disarm();
      if (this.timedOut === started) {
        this.timedOut = undefined;
      }
      if (this.aborted === started) {
        this.aborted = undefined;
      }
      if (this.running?.started === started) {
        this.running = undefined;
      }
      this.showStatus();
    }
    if (as === "watched") {
      return;
    }
    this.changed.fire("queried");
    this.notifyFinished(entry);
    await this.record(entry);
  }

  /// Rows `offset` on of the result `label`'s process holds for paging, or
  /// why they could not be fetched. Only on the connection the result came
  /// from, and only when no query is running on it.
  private async pageHeld(label: string, offset: number, count: number): Promise<GridPage | string> {
    const connection = this.connection;
    if (connection === undefined || this.activeLabel() !== label) {
      return `it is no longer the connected process; run the query again to page through it`;
    }
    if (connection.isBusy) {
      return "a query is running on it; scroll again once it ends";
    }
    return readPage(await connection.call(PAGE, offset, count));
  }

  /// Run a drill-down query on the process the result came from, as a
  /// query from the editor is run, after asking when it is a production one.
  private async runDrilldown(code: string, label: string): Promise<void> {
    const process = this.processes().find((p) => p.label === label) ?? (this.active?.label === label ? this.active : undefined);
    if (process !== undefined && isProduction(process)) {
      const yes = "Run";
      const sure = await window.showWarningMessage(
        `${process.label} is a production process (tagged ${process.tags.join(", ")}). Run this drill-down query there?\n\n${code}`,
        { modal: true },
        yes,
      );
      if (sure !== yes) {
        return;
      }
    }
    if (this.activeLabel() !== label) {
      if (this.connection?.isBusy) {
        void window.showInformationMessage(`q-lint: a query is still running on ${this.active?.label}; the drill-down query goes to ${label}.`);
        return;
      }
      if (!(await this.connectTo(label))) {
        return;
      }
    }
    await this.run(code);
  }

  /// Say a long query has ended, when the window is not focused: the user
  /// has gone elsewhere while it ran (#910).
  private notifyFinished(entry: HistoryEntry): void {
    const configuration = workspace.getConfiguration("q-lint");
    const settings = readProgress((key, fallback) => configuration.get(key, fallback));
    if (!shouldNotify(entry.millis, window.state.focused, entry.outcome, settings)) {
      return;
    }
    const text = finishedText(entry.process, entry.millis, entry.outcome, entry.error);
    if (entry.outcome === "ok") {
      void window.showInformationMessage(text);
    } else {
      void window.showWarningMessage(text);
    }
  }

  private show(lines: string[], clear: boolean): void {
    if (lines.length === 0) {
      return;
    }
    if (clear) {
      this.output.clear();
    }
    this.output.appendLine(lines.join("\n"));
    this.output.show(true);
  }

  /// Stop waiting for the running query: q has no message that cancels one,
  /// so the connection is closed - which also stops the process from sending
  /// a result nobody wants - and opened again.
  async abort(timedOut?: number): Promise<void> {
    const connection = this.connection;
    const process = this.active;
    if (connection === undefined || process === undefined || !connection.isBusy) {
      void window.showInformationMessage("q-lint: no query is running.");
      return;
    }
    this.aborted = this.running?.started;
    this.running = undefined;
    this.connection = undefined;
    connection.abort();
    this.showStatus();
    // Not awaited: q runs one message at a time, so the new connection's
    // handshake waits until the process has finished the query it was left
    // with, and the command should not wait with it.
    void this.open(process, true).then((connected) => {
      if (connected) {
        void window.showInformationMessage(`q-lint: reconnected to ${process.label}.`);
      }
    });
    void window.showInformationMessage(
      this.aborted === undefined && timedOut === undefined
        ? `q-lint: stopped the Process Explorer's read of ${process.label}, the only call running. q-lint reconnects once ${process.label} is free.`
        : `q-lint: ${timedOut === undefined ? "stopped waiting for the query" : `the query ${timedOutError(timedOut)} (q-lint.query.timeout), and was aborted`}. ${process.label} may still be running it; q-lint reconnects once it is free.`,
    );
  }

  async record(entry: HistoryEntry): Promise<void> {
    this.queries = [entry, ...this.history()].slice(0, HISTORY_LIMIT);
    this.refreshHistory();
    await this.context.globalState.update(HISTORY_KEY, this.queries);
  }

  private async rerun(entry?: HistoryEntry): Promise<void> {
    if (entry === undefined) {
      const picked = await window.showQuickPick(
        this.history().map((e) => ({ label: iconsEscaped(historyLabel(e.code)), description: iconsEscaped(e.process), entry: e })),
        { title: "Run which query again?" },
      );
      entry = picked?.entry;
    }
    if (entry !== undefined) {
      await this.run(entry.code);
    }
  }

  private async copyQuery(entry?: HistoryEntry): Promise<void> {
    entry ??= this.history()[0];
    if (entry === undefined) {
      void window.showInformationMessage("q-lint: the query history is empty.");
      return;
    }
    await env.clipboard.writeText(entry.code);
  }

  /// Select the connected process in the Processes view, and show the view.
  private async revealProcess(): Promise<void> {
    const process = this.activeProcess();
    if (process === undefined) {
      void window.showInformationMessage("q-lint: not connected to a q process.");
      return;
    }
    const row = this.processesView.find(process);
    if (row === undefined) {
      void window.showInformationMessage(`q-lint: ${process.label} is not in the Processes view.`);
      return;
    }
    await this.processesTree.reveal(row, { select: true, focus: true, expand: true });
  }

  private async clearHistory(): Promise<void> {
    this.queries = [];
    this.refreshHistory();
    await this.context.globalState.update(HISTORY_KEY, this.queries);
  }

  /// Redraw the Query History view, saying what it is filtered by and when
  /// the filter hides every query.
  private refreshHistory(): void {
    this.historyView.refresh();
    const on = isFiltering(this.historyFilter);
    this.historyTree.description = on ? `filtered: ${filterDescription(this.historyFilter)}` : undefined;
    this.historyTree.message =
      on && this.history().length > 0 && this.shownHistory().length === 0 ? "No query in the history matches the filter." : undefined;
  }

  private historySearchOn(): boolean {
    return this.featureOn(this.setting(readHistorySearch).enabled, "Query History search", "q-lint.queryHistory.search.enable");
  }

  private setHistoryFilter(filter: HistoryFilter): void {
    this.historyFilter = normalised(filter);
    void commands.executeCommand("setContext", HISTORY_FILTERED, isFiltering(this.historyFilter));
    this.refreshHistory();
  }

  /// Filter the Query History view by process, outcome and text, asked for
  /// in turn starting from the current filter, or set to `given` (from a
  /// keybinding's `args`). Escape leaves the filter as it was.
  private async filterHistory(given?: HistoryFilter): Promise<void> {
    if (!this.historySearchOn()) {
      return;
    }
    if (typeof given === "object" && given !== null) {
      this.setHistoryFilter({
        ...(typeof given.process === "string" ? { process: given.process } : {}),
        ...(OUTCOME_CHOICES.some((c) => c.outcome !== undefined && c.outcome === given.outcome) ? { outcome: given.outcome } : {}),
        ...(typeof given.text === "string" ? { text: given.text } : {}),
      });
      return;
    }
    const now = this.historyFilter;
    const anyProcess = "Any process";
    const processes = historyProcesses(this.history());
    if (now.process !== undefined && !processes.includes(now.process)) {
      processes.push(now.process);
    }
    const process = await window.showQuickPick(
      [anyProcess, ...processes].map((p) => ({
        label: iconsEscaped(p),
        name: p === anyProcess ? undefined : p,
        ...((p === anyProcess ? now.process === undefined : now.process === p) ? { description: "current" } : {}),
      })),
      { title: "Filter Query History (1 of 3): process", placeHolder: "Show the queries run on which process?" },
    );
    if (process === undefined) {
      return;
    }
    const outcome = await window.showQuickPick(
      OUTCOME_CHOICES.map((c) => ({ ...c, ...(c.outcome === now.outcome ? { description: "current" } : {}) })),
      { title: "Filter Query History (2 of 3): outcome", placeHolder: "Show the queries with which outcome?" },
    );
    if (outcome === undefined) {
      return;
    }
    const text = await window.showInputBox({
      title: "Filter Query History (3 of 3): text",
      value: now.text ?? "",
      prompt: "Text found in the query's code or q's error, ignoring case. Empty for any.",
    });
    if (text === undefined) {
      return;
    }
    this.setHistoryFilter({ process: process.name, outcome: outcome.outcome, text });
  }

  /// Write the queries the Query History view shows, through its filter, to
  /// `file` or one the user picks: a `.q` file as a q script, else JSON.
  private async exportHistory(file?: Uri): Promise<void> {
    if (!this.historySearchOn()) {
      return;
    }
    const entries = this.shownHistory();
    if (entries.length === 0) {
      void window.showInformationMessage(
        isFiltering(this.historyFilter) ? "q-lint: no query in the history matches the filter." : "q-lint: the query history is empty.",
      );
      return;
    }
    const target =
      file instanceof Uri
        ? file
        : await window.showSaveDialog({
            title: `Export ${entries.length} quer${entries.length === 1 ? "y" : "ies"} from the history`,
            filters: { JSON: ["json"], "q script": ["q"] },
            defaultUri: workspace.workspaceFolders?.[0] ? Uri.joinPath(workspace.workspaceFolders[0].uri, "q-history.json") : undefined,
          });
    if (target === undefined) {
      return;
    }
    const text = exportFormat(target.fsPath) === "q" ? historyScript(entries) : historyJson(entries);
    try {
      await workspace.fs.writeFile(target, Buffer.from(text, "utf8"));
    } catch (error) {
      void window.showErrorMessage(`q-lint: could not write ${target.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void window.showInformationMessage(`q-lint: exported ${entries.length} quer${entries.length === 1 ? "y" : "ies"} to ${target.fsPath}.`);
  }
}
