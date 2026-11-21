// The live half of the extension: q processes to connect to, code run on
// them, what came back, and what was run before.
//
// Nothing here involves the language server, which never runs q. A process
// is touched only once the user connects to it, and then only by the code
// the user sends. What a query sends is `query.ts`'s; how a block is cut into
// statements, `statements.ts`'s; how processes are read and grouped,
// `processes.ts`'s; discovery servers, `discoveryservers.ts`'s; what a
// terminal is sent, `terminal.ts`'s. This file is the VS Code around them.
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
  merge,
  parseProcesses,
  parseTags,
  portProblem,
  processThemeColour,
  readProcessFile,
  tlsChoices,
  type Process,
} from "./processes";
import { COMMANDS, CONNECTED, VIEWS, readLive, readProcessSettings, readTerminal } from "./liveconfig";
import { QConnection } from "./qclient";
import { render } from "./query";
import { QueryModes, type Rendered } from "./resultpanel";
import { blockAt, statements } from "./statements";
import { commandLine, parseEnv, replLines, shellKind } from "./terminal";
import { QueryControls } from "./controls";
import { ParameterCache } from "./paramcachecontrol";
import { CONTROL_COMMANDS, UNLIMITED, armTimeout, limits, readUnlimited, runUnwrapped, timedOutError } from "./querycontrols";

const PROCESSES_KEY = "q-lint.processes";
const HISTORY_KEY = "q-lint.queryHistory";
/// How many queries the history keeps.
const HISTORY_LIMIT = 200;


const passwordKey = (label: string): string => `q-lint.password.${label}`;

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

  /// The row of the process connected to as `label`: a saved process under
  /// its first tag, or a discovered one under its server.
  find(label: string, under?: Row): Row | undefined {
    for (const row of this.getChildren(under)) {
      if (row.kind === "process" && row.process.label === label) {
        return row;
      }
      if (row.kind === "discovered" && qualified(row.server, row.process.label) === label) {
        return row;
      }
      if (row.kind === "tag" || row.kind === "servers" || row.kind === "server") {
        const found = this.find(label, row);
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
    const active = this.live.activeLabel() === (from === undefined ? process.label : qualified(from, process.label));
    const item = new TreeItem(process.label, TreeItemCollapsibleState.None);
    item.description = `${process.host}:${process.port}${active ? " - connected" : ""}`;
    item.iconPath = new ThemeIcon(active ? "vm-active" : "server-process", colourOf(process.tags));
    item.tooltip = new MarkdownString(
      [
        `**${process.label}**`,
        `${process.host}:${process.port}${process.tls ? " (TLS)" : ""}`,
        process.user ? `user \`${process.user}\`` : "no user",
        process.tags.length ? `tags: ${process.tags.join(", ")}` : "no tags",
        ...(from === undefined ? [] : [`listed by ${from}, connected to as \`${qualified(from, process.label)}\``]),
      ].join("\n\n"),
    );
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
    return entry === undefined ? this.live.history() : [];
  }

  getTreeItem(entry: HistoryEntry): TreeItem {
    const first = entry.code.split("\n")[0];
    const item = new TreeItem(first.length > 80 ? `${first.slice(0, 79)}…` : first, TreeItemCollapsibleState.None);
    const when = new Date(entry.at);
    item.description = `${entry.agent ? "agent · " : ""}${entry.process} · ${when.toLocaleTimeString()} · ${entry.millis} ms`;
    item.iconPath = new ThemeIcon(
      entry.outcome === "ok" ? "pass" : entry.outcome === "error" ? "error" : entry.outcome === "timeout" ? "watch" : "circle-slash",
      new ThemeColor(entry.outcome === "ok" ? "testing.iconPassed" : entry.outcome === "error" ? "errorForeground" : "disabledForeground"),
    );
    const tooltip = new MarkdownString();
    tooltip.appendMarkdown(`${entry.process}, ${when.toLocaleString()}, ${entry.millis} ms${entry.agent ? ", run by an agent" : ""}`);
    if (entry.error !== undefined) {
      tooltip.appendMarkdown(`\n\n'${entry.error}`);
    }
    tooltip.appendCodeblock(entry.code, "q");
    item.tooltip = tooltip;
    item.contextValue = "history";
    return item;
  }
}

/// q in VS Code terminals: a file run in one, and code sent to one. The
/// terminal runs the user's shell, which starts q, so q exiting leaves the
/// shell and the command line shows what was run.
class QTerminals {
  /// The terminals started here, still open.
  private readonly ours = new Set<Terminal>();
  /// Where code is sent: the last q terminal started.
  private last: Terminal | undefined;

  constructor(context: ExtensionContext) {
    context.subscriptions.push(
      window.onDidCloseTerminal((terminal) => {
        this.ours.delete(terminal);
        if (terminal === this.last) {
          this.last = undefined;
        }
      }),
    );
  }

  /// Run the active file in a terminal named after it, saving it first. A
  /// terminal of the same name started before is closed: running the file
  /// again starts a fresh q.
  async runFile(): Promise<void> {
    const document = window.activeTextEditor?.document;
    if (document === undefined || document.uri.scheme !== "file") {
      void window.showInformationMessage("q-lint: open a q file saved on disk to run it.");
      return;
    }
    if (document.isDirty && !(await document.save())) {
      return;
    }
    const name = path.basename(document.uri.fsPath);
    for (const terminal of this.ours) {
      if (terminal.name === name) {
        terminal.dispose();
      }
    }
    const terminal = await this.start(name, document.uri, document.uri.fsPath);
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
      return;
    }
    const lines = replLines(codeAt(editor, from) ?? "");
    if (lines.length === 0) {
      nothingThere(from);
      return;
    }
    const terminal = this.last ?? (await this.start("q", editor.document.uri));
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
  /// file cannot be read.
  private async start(name: string, from: Uri | undefined, file?: string): Promise<Terminal | undefined> {
    const configuration = workspace.getConfiguration("q-lint", from);
    const settings = readTerminal((key, fallback) => configuration.get(key, fallback));
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
    const terminal = window.createTerminal({ name, cwd });
    this.ours.add(terminal);
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
  /// The label of the process `connecting` connects to.
  private connectingTo: string | undefined;
  /// Cancels the reconnect after an abort, which waits as long as the
  /// process takes to finish the query it was left with.
  private reconnecting: AbortController | undefined;
  private running: { code: string; started: number } | undefined;
  /// When the query that timed out started, so its entry says so.
  private timedOut: number | undefined;
  private readonly controls: QueryControls;
  private readonly parameterCache: ParameterCache;
  /// The process explorer's call on the connection, if one is out: a query
  /// waits for it (`borrow`).
  private borrowed: Promise<unknown> | undefined;
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
  private readonly modes: QueryModes;
  readonly discovery: DiscoveryServers;

  constructor(private readonly context: ExtensionContext) {
    this.output = window.createOutputChannel("q-lint: query", "q-console");
    this.status = window.createStatusBarItem("q-lint.connection", StatusBarAlignment.Left, 50);
    this.status.name = "q-lint: q connection";
    this.status.command = COMMANDS.connect;
    this.processesView = new ProcessesView(this);
    this.historyView = new HistoryView(this);
    this.processesTree = window.createTreeView(VIEWS.processes, { treeDataProvider: this.processesView });
    this.discovery = new DiscoveryServers(context, { list: () => this.processes(), save: (processes) => this.save(processes) });
    const terminals = new QTerminals(context);
    this.modes = new QueryModes(context);
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
      window.registerTreeDataProvider(VIEWS.history, this.historyView),
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
      this.changed,
      this.discovery.onDidChange(() => this.processesView.refresh()),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.processes.tagColors")) {
          this.processesView.refresh();
        }
      }),
      { dispose: () => void this.connection?.close() },
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
  } {
    return {
      processes: () => this.processes(),
      activeLabel: () => this.activeLabel(),
      history: () => this.history(),
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
    };
  }

  processes(): Process[] {
    return parseProcesses(this.context.globalState.get<unknown>(PROCESSES_KEY, [])).processes;
  }

  activeLabel(): string | undefined {
    return this.connection?.isOpen ? this.active?.label : undefined;
  }

  /// The connected process, as connected to: a discovered one's label qualified.
  activeProcess(): Process | undefined {
    return this.connection?.isOpen ? this.active : undefined;
  }

  history(): HistoryEntry[] {
    this.queries ??= this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
    return this.queries;
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

  private showStatus(): void {
    const label = this.activeLabel();
    if (this.running !== undefined && label !== undefined) {
      this.status.text = `$(sync~spin) q: ${label}`;
      this.status.tooltip = "A query is running. q-lint: Abort Current Query stops waiting for it.";
    } else if (label !== undefined) {
      this.status.text = `$(plug) q: ${label}`;
      this.status.tooltip = `Connected to ${this.active?.host}:${this.active?.port}. Click to switch.`;
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
      validateInput: (v) => (v.trim() === "" ? "A host is needed." : undefined),
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
        host: host.trim(),
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
    if (answer.password !== undefined) {
      await this.context.secrets.store(passwordKey(answer.process.label), answer.password);
    }
    await this.save([...processes, answer.process]);
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
      return { ...row.process, label: qualified(row.server, row.process.label) };
    }
    const processes = [
      ...this.processes(),
      ...listed.flatMap(({ server, state }) => state.processes.map((p) => ({ ...p, label: qualified(server.label, p.label) }))),
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
        label: p.label,
        description: `${p.host}:${p.port}`,
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
    const { process } = answer;
    if (process.label !== old.label) {
      const kept = await this.context.secrets.get(passwordKey(old.label));
      await this.context.secrets.delete(passwordKey(old.label));
      if (kept !== undefined && answer.password === undefined) {
        await this.context.secrets.store(passwordKey(process.label), kept);
      }
    }
    if (answer.password !== undefined) {
      await this.context.secrets.store(passwordKey(process.label), answer.password);
    }
    if (process.user === undefined) {
      await this.context.secrets.delete(passwordKey(process.label));
    }
    await this.save(processes.map((p) => (p.label === old.label ? process : p)));
    if (this.active?.label === old.label) {
      this.active = process;
      this.showStatus();
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
    if (this.active?.label === process.label) {
      await this.disconnect();
    }
    await this.context.secrets.delete(passwordKey(process.label));
    await this.save(this.processes().filter((p) => p.label !== process.label));
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
    const { processes, problems } = read;
    await this.save(merge(this.processes(), processes));
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
    const text = JSON.stringify({ processes: this.processes() }, null, 2) + "\n";
    await workspace.fs.writeFile(file, Buffer.from(text, "utf8"));
    void window.showInformationMessage(`q-lint: exported ${this.processes().length} q process(es) to ${file.fsPath}.`);
  }

  private insertLabel(): void {
    const label = this.activeLabel();
    const editor = window.activeTextEditor;
    if (label === undefined) {
      void window.showInformationMessage("q-lint: not connected to a q process.");
      return;
    }
    if (editor === undefined) {
      return;
    }
    void editor.edit((edit) => {
      for (const selection of editor.selections) {
        edit.replace(selection, label);
      }
    });
  }

  // --- connections

  async connectTo(row?: ProcessArg): Promise<boolean> {
    const process = await this.chosen(row, "Connect to which q process?", true);
    if (process === undefined) {
      return false;
    }
    // A discovered process's user has no password stored until asked for one.
    const saved = this.processes().some((p) => p.label === process.label);
    if (!saved && process.user && (await this.context.secrets.get(passwordKey(process.label))) === undefined) {
      const password = await window.showInputBox({
        title: `q process ${process.label}: password of ${process.user}`,
        password: true,
        prompt: "Kept in VS Code's secret storage.",
      });
      if (password === undefined) {
        return false;
      }
      await this.context.secrets.store(passwordKey(process.label), password);
    }
    const connected = await this.open(process);
    // A discovered process cannot be edited, so a password that did not
    // connect is forgotten: the next connect asks for it again.
    if (!connected && !saved && process.user) {
      await this.context.secrets.delete(passwordKey(process.label));
    }
    return connected;
  }

  /// Connect to `process`, closing the connection there was. Whether it
  /// connected. A reconnect after an abort passes `reconnect`, and waits
  /// with no time limit until it aborts.
  private open(process: Process, reconnect?: AbortSignal): Promise<boolean> {
    if (this.connecting !== undefined) {
      // Another process chosen stops a reconnect waiting for a busy one.
      if (this.connectingTo !== process.label) {
        this.reconnecting?.abort();
      }
      // A connect to another process - a reconnect after an abort, waiting
      // for that process to be free - is let finish and this one follows:
      // its result says nothing of this process.
      return this.connectingTo === process.label ? this.connecting : this.connecting.then(() => this.open(process));
    }
    this.connectingTo = process.label;
    this.connecting = (async () => {
      if (this.connection !== undefined) {
        const old = this.connection;
        this.connection = undefined;
        await old.close();
      }
      const password = process.user ? await this.context.secrets.get(passwordKey(process.label)) : undefined;
      try {
        const connection = await window.withProgress(
          { location: { viewId: VIEWS.processes }, title: `Connecting to ${process.label}` },
          () =>
            QConnection.open(
              {
                host: process.host,
                port: process.port,
                ...(process.user ? { user: process.user, password: password ?? "" } : {}),
                ...(process.tls ? { tls: true } : {}),
              },
              reconnect === undefined ? undefined : Infinity,
              reconnect,
            ),
        );
        this.connection = connection;
        this.active = process;
        connection.whenClosed(() => {
          if (this.connection === connection) {
            this.connection = undefined;
            this.running = undefined;
            this.showStatus();
            this.processesView.refresh();
            this.changed.fire("disconnected");
            void window.showWarningMessage(`q-lint: the connection to ${process.label} closed.`);
          }
        });
        this.changed.fire("connected");
        return true;
      } catch (error) {
        if (!reconnect?.aborted) {
          void window.showErrorMessage(
            `q-lint: could not connect to ${process.label} (${process.host}:${process.port}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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

  private async disconnect(): Promise<void> {
    // A reconnect after an abort, still waiting, is not to connect after this.
    this.reconnecting?.abort();
    const connection = this.connection;
    this.connection = undefined;
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
      return;
    }
    const code = codeAt(editor, from);
    if (code === undefined || statements(code).length === 0) {
      nothingThere(from);
      return;
    }
    // A file with a process of its own switches the connection to it.
    const bound = this.controls.binding(editor.document.uri);
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
    await this.borrowed;
    const connection = this.connection;
    const process = this.active;
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
  /// Undefined when nothing was run; throws what `query` throws.
  async runOnActive<T>(code: string, query: (connection: QConnection) => Promise<T>): Promise<{ process: string; value: T } | undefined> {
    const ready = await this.ready();
    if (ready === undefined) {
      return undefined;
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

  /// Run `code` on the active connection, connecting first if there is none.
  /// The process explorer's Preview runs here too.
  async run(code: string): Promise<void> {
    const ready = await this.ready();
    if (ready === undefined) {
      return;
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
      const answer = controls.unwrapped
        ? await runUnwrapped(connection, cut, { size: consoleSize, limit: gridLimit, unlimited, grid: settings.mode !== "console" })
        : settings.mode !== "console"
          ? await connection.queryGrid(cut, consoleSize, gridLimit)
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
      if (!this.modes.show({ process: process.label, code, answer, millis }, settings)) {
        this.show(render({ process: process.label, code, answer, millis }, settings), settings.autoClear);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = this.running === undefined || !connection.isOpen;
      const timedOut = this.timedOut === started;
      entry = {
        process: process.label,
        code,
        at: new Date(started).toISOString(),
        millis: Date.now() - started,
        outcome: timedOut ? "timeout" : aborted ? "aborted" : "error",
        error: timedOut ? timedOutError(controls.timeout) : aborted && this.running === undefined ? "aborted" : message,
      };
      this.show([`# ${process.label} - ${timedOut ? timedOutError(controls.timeout) : aborted ? "aborted" : "failed"}: ${message}`], false);
    } finally {
      disarm();
      if (this.timedOut === started) {
        this.timedOut = undefined;
      }
      if (this.running?.started === started) {
        this.running = undefined;
      }
      this.showStatus();
    }
    this.changed.fire("queried");
    await this.record(entry);
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
    this.running = undefined;
    this.connection = undefined;
    connection.abort();
    this.showStatus();
    // Not awaited: q runs one message at a time, so the new connection's
    // handshake waits until the process has finished the query it was left
    // with, and the command should not wait with it.
    // It waits as long as that takes, not a connect's usual timeout, until
    // another process is chosen or Disconnect is run.
    this.reconnecting?.abort();
    const reconnecting = new AbortController();
    this.reconnecting = reconnecting;
    void this.open(process, reconnecting.signal).then((connected) => {
      if (this.reconnecting === reconnecting) {
        this.reconnecting = undefined;
      }
      if (connected) {
        void window.showInformationMessage(`q-lint: reconnected to ${process.label}.`);
      }
    });
    void window.showInformationMessage(
      `q-lint: ${timedOut === undefined ? "stopped waiting for the query" : `the query ${timedOutError(timedOut)} (q-lint.query.timeout), and was aborted`}. ${process.label} may still be running it; q-lint reconnects once it is free.`,
    );
  }

  async record(entry: HistoryEntry): Promise<void> {
    this.queries = [entry, ...this.history()].slice(0, HISTORY_LIMIT);
    this.historyView.refresh();
    await this.context.globalState.update(HISTORY_KEY, this.queries);
  }

  private async rerun(entry?: HistoryEntry): Promise<void> {
    if (entry === undefined) {
      const picked = await window.showQuickPick(
        this.history().map((e) => ({ label: e.code.split("\n")[0], description: e.process, entry: e })),
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
    const label = this.activeLabel();
    if (label === undefined) {
      void window.showInformationMessage("q-lint: not connected to a q process.");
      return;
    }
    const row = this.processesView.find(label);
    if (row === undefined) {
      void window.showInformationMessage(`q-lint: ${label} is not in the Processes view.`);
      return;
    }
    await this.processesTree.reveal(row, { select: true, focus: true, expand: true });
  }

  private async clearHistory(): Promise<void> {
    this.queries = [];
    this.historyView.refresh();
    await this.context.globalState.update(HISTORY_KEY, this.queries);
  }
}
