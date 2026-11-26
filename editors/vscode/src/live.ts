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
import { randomBytes } from "node:crypto";
import * as path from "path";
import {
  commands,
  EventEmitter,
  MarkdownString,
  RelativePattern,
  StatusBarAlignment,
  env,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
  type OutputChannel,
  type StatusBarItem,
  type Terminal,
  type TextDocument,
  type TextEditor,
  type TreeDataProvider,
  type TreeView,
  type WorkspaceFolder,
} from "vscode";
import { children, findDiscovered, qualified, type Discovered, type Row } from "./discovery";
import { SHARED_COMMANDS, SHARED_FILE, SHARED_SOURCE, mergeShared, readShared, readSharedFile, secretsWarning, withShared } from "./shared";
import { DiscoveryServers, discoveryItem } from "./discoveryservers";
import {
  address,
  hostProblem,
  markdownText,
  merge,
  parseProcesses,
  parseRelabels,
  plainHost,
  parseTags,
  passwordKey,
  sharedPasswordKey,
  editedSince,
  passwordsToForget,
  portProblem,
  processThemeColour,
  processTooltip,
  protectionsRemoved,
  readProcessFile,
  relabelsAfter,
  resaved,
  sshDestination,
  serverTypes,
  givenServerTypes,
  tlsChoices,
  withExtras,
  evaluationOf,
  type Evaluation,
  withProtections,
  withRelabel,
  type Process,
} from "./processes";
import { clickedEditor, unsavedIn } from "./clicked";
import { COMMANDS, CONNECTED, QUERY_RUNNING, VIEWS, readLive, readProcessSettings, readTerminal, type QueryMode } from "./liveconfig";
import { ClosedBeforeHandshake, DirectRefused, QConnection, QError, directRefusal, type DirectMode, type Target } from "./qclient";
import { SshTunnel, TUNNEL_COMMANDS, TunnelConnectError, TunnelHandshakeError, readTunnel } from "./tunnel";
import { GATEWAY_COMMANDS, fileServerTypes, gatewayJoined, gatewayParts, gatewayStatement, isGatewayCall, readGateway, withServerTypes } from "./gateway";
import { isLocalHost } from "./launcher";
import { HEARTBEAT, STEADY_MS, UNANSWERED_MS, backoffDelay, latencyText, readHealth } from "./health";
import { clearedStamp, historyHeading, historyLabel, iconsEscaped, mergedHistory, parseQueryHistory, plainMessage } from "./history";
import { render } from "./query";
import { QueryModes, type PageLater, type Rendered } from "./resultpanel";
import { blockAt, scriptCode, selectionCode, statements } from "./statements";
import { assertWritable, relativeInside } from "./workspacewrite";
import { commandLine, expandHome, qBinaryFrom, relativeBinaryProblem, replLines, shellKind, terminalCwd } from "./terminal";
import { readDotenv, terminalEnv } from "./qenv";
import { dotenvFor, layoutEnvFor } from "./qenvironment";
import type { RunExtra } from "./runargs";
import { QueryControls } from "./controls";
import { ParameterCache } from "./paramcachecontrol";
import { DASHBOARDS_KEY, parseDashboards, retargetedTiles } from "./dashboard";
import { SCHEDULES_KEY, parseSchedules, retargetedSchedules } from "./schedule";
import { moveScratch } from "./scratch";
import { CONTROL_COMMANDS, FILE_CONNECTIONS_KEY, UNLIMITED, UNLIMITED_READ_ONLY, armTimeout, directMode, evaluationText, limits, readUnlimited, runUnwrapped, timedOutError, withBinding } from "./querycontrols";
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
import { CONNECT_SCRIPT_COMMANDS, onConnectBrought, onConnectOf, readConnectScript, scriptOf, scriptPath, scriptSummary, sharedEntry, withScript, type ConnectScript } from "./connectscript";
import { isProduction } from "./agent";
import { PAGE, readPage, type GridPage } from "./grid";
import { PLACEHOLDER_VALUES_KEY, lastValue, placeholderNames, readPlaceholders, remembered, substitute } from "./placeholders";
import { guardCheck, guardQuestion, guardRefusal, guardText, readEnforce, readGuard, refusalQuestion, refusalReason, type GuardCode } from "./guard";
import type { GridAnswer, GridPayload } from "./grid";
import { WATCH, WATCHING, intervalProblem, readWatch, watchText } from "./watch";
import { guardedBy, openTags } from "./guard";
import { readAdmin } from "./admin";
import { credentialCwd, credentialEnv, parseCredentials, runCredentialCommand } from "./credentials";
import { effectiveTimeout, ownTimeout, timeoutDropped, timeoutSource } from "./processtimeout";
import type { Answered } from "./inlineresult";

const PROCESSES_KEY = "q-lint.processes";
/// The address of each process the shared list held when last read (#955).
const SHARED_SEEN_KEY = "q-lint.sharedProcessesSeen";
/// The folders a shared process list is read from: those on disk (#1841).
const sharedFolders = (): readonly WorkspaceFolder[] => (workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
/// Every process renamed or deleted, for the workspaces not open then
/// (#1749); and, in a workspace, the last of them its state has had.
const RELABELS_KEY = "q-lint.processRelabels";
const RELABELS_APPLIED_KEY = "q-lint.processRelabelsApplied";
const HISTORY_KEY = "q-lint.queryHistory";
const HISTORY_CLEARED_KEY = "q-lint.queryHistoryCleared";
/// How many queries the history keeps.
const HISTORY_LIMIT = 200;
/// The seconds a connection apart's connect script may run where no query
/// timeout holds: nobody may be there to stop it (#2567).
const APART_SCRIPT_TIMEOUT = 60;



/// What a process command is given: a view row, a process's label (from a
/// keybinding's `args`, or another extension), or nothing - then the user
/// picks one. A discovered process is named `server/label`.
export type ProcessArg = Row | string | undefined;

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
  // Read as q reads the file: a selection or a line as it reads there, in
  // a block comment or after the script's end (#2287), and the file
  // without the indented lines q skips before its first statement (#2278).
  if (from === "selection" && !editor.selection.isEmpty) {
    return selectionCode(document.getText().split("\n"), editor.selection.start.line, document.getText(editor.selection));
  }
  if (from === "file") {
    return scriptCode(document.getText());
  }
  if (from === "block") {
    const lines = document.getText().split(/\r?\n/);
    const block = blockAt(lines, line);
    return block === undefined ? undefined : lines.slice(block.start, block.end + 1).join("\n");
  }
  return selectionCode(document.getText().split("\n"), line, document.lineAt(line).text);
}

/// The editor a command is for: the one showing `uri`, a Uri a title-bar
/// button handed in, else the active one (#1523).
function clicked(uri: unknown): TextEditor | undefined {
  return clickedEditor(uri, window.visibleTextEditors ?? [], window.activeTextEditor);
}

/// What a command that reads the active editor says when there is none.
function noEditor(): void {
  void window.showInformationMessage("q-lint: open a q file first: there is no active editor.");
}

function nothingThere(from: From): void {
  void window.showInformationMessage(
    plainMessage(from === "block"
      ? "q-lint: the cursor is on no statement (a blank line, a comment, or inside a block comment)."
      : from === "file"
        ? "q-lint: the file has no statement to run."
        : "q-lint: nothing to run there: it is blank or a comment."),
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
      rows = children(this.live.processes(), this.live.discovery.discovered(), row, this.live.sharedList()[0]);
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
      if (row.kind === "tag" || row.kind === "servers" || row.kind === "server" || row.kind === "shared") {
        const found = this.find(process, row);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  }

  getTreeItem(row: Row): TreeItem {
    if (row.kind === "shared") {
      const item = new TreeItem(`Workspace: ${SHARED_FILE}`, TreeItemCollapsibleState.Expanded);
      const n = row.state.processes.length;
      item.description = row.state.error !== undefined ? "failed" : `${n} process${n === 1 ? "" : "es"}`;
      item.iconPath = new ThemeIcon("repo", row.state.error !== undefined ? new ThemeColor("errorForeground") : undefined);
      item.tooltip = new MarkdownString(
        `The processes ${markdownText(row.file)} lists, shared with the repository. Once connected, one is \`${SHARED_SOURCE}/label\`.`,
      );
      item.contextValue = "sharedProcesses";
      return item;
    }
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
    const running = from === undefined && this.live.launched(process.label);
    item.description = `${address(process.host, process.port)}${hostProblem(process.host) !== undefined ? " - not a host" : ""}${active ? " - connected" : ""}${running ? " - running" : ""}`;
    item.iconPath = new ThemeIcon(active ? "vm-active" : "server-process", colourOf(process.tags));
    item.tooltip = new MarkdownString(processTooltip(process, from));
    const kind = from === undefined ? "process" : "discovered";
    item.contextValue = active ? `${kind}.connected` : kind;
    // A click connects: the row is the process, and connecting is what it is
    // for. Not the connected row's: it would reconnect, dropping a query
    // running there (#1506).
    if (!active) {
      item.command = { command: COMMANDS.connect, title: "Connect", arguments: [row] };
    }
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
  /// Those whose q has ended, leaving the shell: code is not typed into it.
  private readonly ended = new WeakSet<Terminal>();

  constructor(context: ExtensionContext) {
    context.subscriptions.push(
      window.onDidCloseTerminal((terminal) => {
        this.ours.delete(terminal);
        if (terminal === this.last) {
          this.last = this.latest();
        }
      }),
    );
    // Shell integration (VS Code 1.93) tells when the command a terminal
    // ran - its q - has ended: from then on its shell would read the q
    // code sent to it, so it is no longer where code goes (#1675).
    // Older VS Code has none.
    const ends: typeof window.onDidEndTerminalShellExecution | undefined = window.onDidEndTerminalShellExecution;
    if (typeof ends === "function") {
      context.subscriptions.push(
        ends((event) => {
          if (this.ours.has(event.terminal)) {
            this.ended.add(event.terminal);
            if (event.terminal === this.last) {
              this.last = this.latest();
            }
          }
        }),
      );
    }
  }

  /// The last q terminal started of those open whose q still runs.
  private latest(): Terminal | undefined {
    return [...this.ours].filter((t) => !this.ended.has(t)).pop();
  }

  /// Run the active file - or `document`, the one whose Run button was
  /// clicked - in a terminal named after it, saving it first. The
  /// terminal it ran in before is closed: running the file again starts a
  /// fresh q. Another file of the same name keeps its own. `extra`: Run File
  /// with Arguments' words after the file (`.z.x`) and lines typed into q
  /// once it starts.
  async runFile(extra?: RunExtra, document = window.activeTextEditor?.document): Promise<void> {
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
    const terminal = await this.start(path.basename(file), document.uri, file, close, extra?.args);
    // Typed once q is started: the shell hands them to q's console.
    for (const line of extra?.input ?? []) {
      terminal?.sendText(line, true);
    }
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
    const code = codeAt(editor, from) ?? "";
    if (replLines(code).length === 0) {
      nothingThere(from);
      return;
    }
    await this.sendCode(code, editor.document.uri);
  }

  /// Send `code`, from the document `from`, to the q terminal as `send`
  /// does: Smart Send's terminal target (#957).
  async sendCode(code: string, from: Uri): Promise<void> {
    const lines = replLines(code);
    if (lines.length === 0) {
      return;
    }
    if (this.last === undefined && this.starting === undefined) {
      this.starting = this.start("q", from).finally(() => (this.starting = undefined));
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
  /// set for it. It starts in the workspace folder of `from` (else the
  /// file's directory), so a script's relative `\l` reads as it does from a
  /// shell there. Undefined if the env file cannot be read, or cmd cannot
  /// pass the line; `before` runs only once it can start.
  private async start(name: string, from: Uri | undefined, file?: string, before?: () => void, extraArgs: string[] = []): Promise<Terminal | undefined> {
    const configuration = workspace.getConfiguration("q-lint", from);
    const read = readTerminal((key, fallback) => configuration.get(key, fallback));
    const settings = { qBinary: expandHome(read.qBinary, os.homedir()), envPath: expandHome(read.envPath, os.homedir()) };
    // Folders on disk: a virtual one is no directory to start in (#1843).
    const onDisk = (f: WorkspaceFolder | undefined): WorkspaceFolder | undefined => (f?.uri.scheme === "file" ? f : undefined);
    const own = onDisk(from && workspace.getWorkspaceFolder(from));
    const folder = own ?? workspace.workspaceFolders?.find((f) => f.uri.scheme === "file");
    const cwd = terminalCwd(own?.uri.fsPath, folder?.uri.fsPath, file, path.dirname);
    let variables: Record<string, string> = {};
    // The folder's own program or env file, in a folder that is not trusted,
    // is the repository's: refused, as dotenvFor and the launcher do (#1825).
    const trusted = workspace.isTrusted !== false;
    if (qBinaryFrom(settings.qBinary, folder?.uri.fsPath, os.homedir(), trusted) === undefined) {
      void window.showErrorMessage(plainMessage(`q-lint: ${relativeBinaryProblem(settings.qBinary, trusted)}.`));
      return undefined;
    }
    if (settings.envPath !== "") {
      if (!path.isAbsolute(settings.envPath) && !trusted) {
        void window.showErrorMessage(
          plainMessage(`q-lint: q-lint.terminal.envPath "${settings.envPath}" is relative to the workspace folder, which is not trusted: name it by its full path.`),
        );
        return undefined;
      }
      if (!path.isAbsolute(settings.envPath) && folder === undefined) {
        void window.showErrorMessage(
          plainMessage(`q-lint: q-lint.terminal.envPath "${settings.envPath}" is relative, and there is no workspace folder to read it from.`),
        );
        return undefined;
      }
      const envFile = path.resolve(folder?.uri.fsPath ?? "", settings.envPath);
      let text: string;
      try {
        text = Buffer.from(await workspace.fs.readFile(Uri.file(envFile))).toString("utf8");
      } catch (error) {
        void window.showErrorMessage(
          plainMessage(`q-lint: could not read the env file ${envFile}: ${error instanceof Error ? error.message : String(error)}`),
        );
        return undefined;
      }
      // Lines it could not read are named by number alone: one may be a
      // secret with a typo in it (#1685).
      const parsed = readDotenv(text);
      variables = parsed.env;
      if (parsed.badLines.length > 0) {
        void window.showWarningMessage(
          plainMessage(`q-lint: skipped ${parsed.badLines.length} line(s) of ${envFile}, not NAME=value: line ${parsed.badLines.join(", ")}`),
        );
      }
    }
    // The `.env` file's variables go in the terminal's environment, never on
    // its command line, where they would show; the layout's stay under the
    // env file's. A relative q's layout is read where it is, the folder's
    // (#1839).
    const layout = layoutEnvFor(qBinaryFrom(settings.qBinary, folder?.uri.fsPath, os.homedir()) ?? settings.qBinary, from);
    const { shown, hidden, refs } = terminalEnv(layout, variables, await dotenvFor(from));
    // A file inside the folder is named relative to it, as you would type it.
    // One starting with `-` from `./`, or q reads it as an option (#2373).
    const inside = file !== undefined && cwd !== undefined ? relativeInside(cwd, file) : undefined;
    const relative = inside?.startsWith("-") ? `.${path.sep}${inside}` : inside;
    const args = file === undefined ? [] : [relative ?? file, ...extraArgs];
    // A relative q is the folder's, as in the launcher, also for a file
    // outside every folder, whose terminal starts elsewhere (#1716).
    const binary = cwd === folder?.uri.fsPath ? settings.qBinary : (qBinaryFrom(settings.qBinary, folder?.uri.fsPath, os.homedir()) ?? settings.qBinary);
    const line = commandLine(binary, args, shellKind(env.shell), shown, refs);
    if (typeof line !== "string") {
      void window.showErrorMessage(plainMessage(`q-lint: ${line.error}`));
      return undefined;
    }
    before?.();
    const terminal = window.createTerminal({ name, cwd, ...(Object.keys(hidden).length > 0 ? { env: hidden } : {}) });
    this.ours.add(terminal);
    if (file !== undefined) {
      this.files.set(terminal, file);
    }
    this.last = terminal;
    terminal.sendText(line, true);
    return terminal;
  }
}

/// The seconds left of a `timeout` (0: none) after `waited` ms: never 0,
/// which would be none.
function left(timeout: number, waited: number): number {
  return timeout > 0 ? Math.max(timeout - waited / 1000, 0.001) : 0;
}

/// Where `process` is connected to, with `password` for its user.
function targetOf(process: Process, password: string | undefined): Target {
  return {
    host: process.host,
    port: process.port,
    ...(process.user ? { user: process.user, password: password ?? "" } : {}),
    ...(process.tls ? { tls: true } : {}),
  };
}

/// The process a connection opened to `opened` is to once the saved process
/// it was is edited to `saved`: it takes the new label, tags and connect
/// script, and keeps its address and tunnel until connected again - and,
/// moved, its old tags as well (#1443).
function stillOpen(opened: Process, saved: Process): Process {
  const { host, port, user, tls } = opened;
  return withExtras(
    withScript({ label: saved.label, host, port, ...(user !== undefined ? { user } : {}), tags: openTags(opened, saved), ...(tls ? { tls } : {}) }, scriptOf(saved)),
    { ...saved, ssh: opened.ssh },
  );
}

/// Why nothing was sent: a question asked about `expected`, and another
/// process became active while it was open (#1081). Callers that send
/// after a modal or an input box pass the label they asked about as
/// `expect` to `Live.runOnActive` or `borrowWhenFree`, which throw this.
export function movedFrom(expected: string): Error {
  return new Error(`${expected} is no longer the active process; nothing was run.`);
}

/// What `Live.runOnActive` throws for a query it stopped waiting for: the
/// process's own timeout, or Abort, Disconnect or a connect elsewhere. Its
/// message is the one thrown before; `outcome` is how the history keeps
/// it, as `run` keeps its own (#1872).
export class Stopped extends Error {
  constructor(
    message: string,
    readonly outcome: "aborted" | "timeout",
  ) {
    super(message);
  }
}

/// What `Live.runApart` throws when it is cancelled before its connection
/// opens: nothing was sent to the process, so its caller records no run.
/// Its message is the connect's own (#1926).
export class NotSent extends Error {}

export class Live {
  /// Run the active file in its q terminal with Run File with Arguments'
  /// extra words and input (#1005).
  readonly runFileWith: (extra: RunExtra, document?: TextDocument) => Promise<void>;
  private connection: QConnection | undefined;
  /// The query history, newest first. Kept here and written through to
  /// `globalState`, never rebuilt from it alone: a read of `globalState`
  /// straight after a write can return the value before it, and a list
  /// rebuilt from that drops the entry just added. Merged with it at each
  /// read, since every window writes it (#1619).
  private queries: HistoryEntry[] = [];
  private active: Process | undefined;
  /// The connection `open` is running the connect script on, before it is
  /// the active one: what Disconnect closes then.
  private opening: QConnection | undefined;
  /// The SSH tunnels open, stopped now when the extension host goes: one
  /// left to its connection's close outlives a host that exits first (#1518).
  private readonly tunnels = new Set<SshTunnel>();
  private readonly closeTunnels = (): void => {
    for (const tunnel of this.tunnels) {
      tunnel.close();
    }
  };
  /// The connections `openSeparate` handed out and still open: a stream's.
  private readonly separate = new Set<{ connection: QConnection; process: Process }>();
  /// Connections apart still running their connect script, which Abort and
  /// Disconnect close: nothing else reaches them (#2567).
  private readonly preparingApart = new Set<{ connection: QConnection; process: Process }>();
  /// Stops the connect under way: a reconnect after an abort that waits for
  /// the process to be free, or any connect Disconnect or a connect
  /// elsewhere replaces (#1704).
  private stopConnect: AbortController | undefined;
  /// A connect in progress, so a second one waits for it instead of opening
  /// another.
  private connecting: Promise<boolean> | undefined;
  /// The process `connecting` connects to, as `passwordKey` names it, and
  /// as it becomes the active one: edited or tagged meanwhile, as it is now (#1700).
  private connectingTo: string | undefined;
  private connectingAs: Process | undefined;
  /// Set by Disconnect, or a connect to another process, to stop a
  /// reconnect after an abort from trying again.
  private reconnectStopped = false;
  /// Counts Disconnects: a connect under way when it changes was
  /// disconnected, and closes what it opens (#1073).
  private disconnects = 0;
  private running: { code: string; started: number } | undefined;
  /// Queries waiting in `ready` to be sent - for a connect under way, or a
  /// background read out on the connection: shown running, and ended by
  /// Abort and by their timeout as a query sent is (#2126).
  private readonly waiters = new Set<{ started: number; stop: AbortController }>();
  /// The automatic reconnects made to a process since its connection last
  /// held: answered a query, or stayed up `STEADY_MS`. A process that
  /// accepts and then drops each connection is retried only
  /// `q-lint.connection.reconnectAttempts` times in all (#2129).
  private reconnectTries: { label: string; tried: number } | undefined;
  /// The connection a query was last answered on.
  private answeredOn: QConnection | undefined;
  /// Settles when the automatic reconnect under way ends or is stopped: a
  /// query sent meanwhile waits for it (#2132).
  private reconnectDone: Promise<void> | undefined;
  private endReconnect: (() => void) | undefined;
  /// Redraws the status bar each second while a query runs, so its time
  /// counts up (#910).
  private ticker: ReturnType<typeof setInterval> | undefined;
  /// The heartbeat's timer while connected, the last round trip it timed,
  /// and when the one still unanswered was sent (#917).
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private latency: { millis: number; at: number } | undefined;
  private beatSent: number | undefined;
  /// The connection the heartbeat was last started for: started again on
  /// the same one, a beat still unanswered stays shown (#1710).
  private beatOn: QConnection | undefined;
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
  /// The processes said to have no `reval`, so the read-only guard's
  /// backstop cannot hold there: each is said once.
  private readonly toldNoReval = new Set<string>();
  /// The guarded processes said to be evaluated directly, without `reval`.
  private readonly toldDirect = new Set<string>();
  /// The last query from the editor that failed, with q's backtrace: what
  /// Capture Locals at Last Error (#985) runs again. Not one sent through a
  /// gateway, nor in direct evaluation, which has no backtrace.
  lastFailure: { process: string; code: string; error: string; trace: string } | undefined;
  private readonly controls: QueryControls;

  /// Whether Toggle Unlimited Query is on: every row and the whole text.
  queryUnlimited(): boolean {
    return this.controls.unlimited;
  }
  private readonly parameterCache: ParameterCache;
  /// The process explorer's call on the connection, if one is out: a query
  /// waits for it (`borrow`). `borrower` says whose it is, for Abort (#1709).
  private borrowed: Promise<unknown> | undefined;
  private borrower = "";
  /// Set on deactivate: a connection opened after it is closed at once.
  private disposed = false;
  private readonly changed = new EventEmitter<"connected" | "disconnected" | "queried" | "edited">();
  /// Fired when a connection opens or closes, and when a query has finished:
  /// what the process explorer refreshes on. "edited": the connected
  /// process kept its label and took new tags (#1460).
  readonly onDidChange = this.changed.event;
  /// Fired with the answer to a query run from an editor's line or
  /// selection, and where it came from: what inline results (#1047) draw.
  private readonly answered = new EventEmitter<Answered>();
  readonly onDidAnswer = this.answered.event;
  private readonly tiles = new EventEmitter<void>();
  /// Fired when dashboard tiles were removed or retargeted - their process
  /// or saved query deleted or renamed - for an open dashboard to draw them
  /// again (#2550).
  readonly onDidChangeTiles = this.tiles.event;
  /// The line a Run Line or Run Selection is running from, until `run`
  /// takes it.
  private origin: { uri: string; line: number; version?: number } | undefined;
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
    | { code: string; label: string; every: number; runs: number; timer: ReturnType<typeof setInterval>; status: StatusBarItem; running: boolean; asked: { write: boolean; tagged: boolean }; serverTypes?: string[] }
    | undefined;
  /// The workspace's shared process list as last read (#955), when it is
  /// on and the file is there, and the watcher on the file.
  private shared: Discovered | undefined;
  /// The folder (its URI) whose list names each shared process, by its
  /// qualified label: what its password is kept by (#2513).
  private sharedFolders = new Map<string, string>();
  private sharedWatcher: Disposable | undefined;
  /// Bumped by each read, so a slow one does not overwrite a later one.
  private sharedRead = 0;
  /// The q terminals, for Smart Send (#957).
  private terminals: QTerminals | undefined;
  /// Told each async message the active connection's process sends:
  /// `.qlint.view` and `.qlint.plot` (#960).
  private readonly asyncListeners = new Set<(message: Buffer, process: Process) => void>();

  constructor(private readonly context: ExtensionContext) {
    this.output = window.createOutputChannel("q-lint: query", "q-console");
    this.status = window.createStatusBarItem("q-lint.connection", StatusBarAlignment.Left, 50);
    this.status.name = "q-lint: q connection";
    this.status.command = COMMANDS.connect;
    this.processesView = new ProcessesView(this);
    this.historyView = new HistoryView(this);
    this.processesTree = window.createTreeView(VIEWS.processes, { treeDataProvider: this.processesView });
    this.historyTree = window.createTreeView(VIEWS.history, { treeDataProvider: this.historyView });
    this.discovery = new DiscoveryServers(context, { list: () => this.processes(), save: (processes, given) => this.save(processes, given), gone: (server) => this.serverGone(server) });
    const terminals = new QTerminals(context);
    this.terminals = terminals;
    this.runFileWith = (extra, document) => terminals.runFile(extra, document);
    this.modes = new QueryModes(context);
    this.modes.setPager((label, offset, count, token) => this.pageHeld(label, offset, count, token));
    // A drill-down from a gateway's result goes to the servers it came from (#2437).
    this.modes.setRunner((code, label, from) => this.runOnProcess(code, label, { serverTypes: gatewayParts(from)?.types }));
    this.controls = new QueryControls(context, {
      activeLabel: () => this.activeLabel(),
      activeDirect: () => this.activeDirect(),
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
      c(COMMANDS.querySelection, (uri?: unknown) => this.queryFrom("selection", undefined, uri)),
      c(COMMANDS.queryBlock, (uri?: unknown) => this.queryFrom("block", undefined, uri)),
      c(COMMANDS.abort, () => this.abort()),
      c(COMMANDS.rerun, (entry?: HistoryEntry) => this.rerun(entry)),
      c(COMMANDS.clearHistory, () => this.clearHistory()),
      c(COMMANDS.runInTerminal, (uri?: unknown) => terminals.runFile(undefined, clicked(uri)?.document)),
      c(COMMANDS.sendLine, () => terminals.send("line")),
      c(COMMANDS.sendSelection, () => terminals.send("selection")),
      c(COMMANDS.sendBlock, () => terminals.send("block")),
      c(CONTROL_COMMANDS.queryFile, (uri?: unknown) => this.queryFrom("file", undefined, uri)),
      c(CONTROL_COMMANDS.startRepl, () => terminals.repl()),
      c(CONTROL_COMMANDS.copyQuery, (entry?: HistoryEntry) => this.copyQuery(entry)),
      c(CONTROL_COMMANDS.revealProcess, () => this.revealProcess()),
      c(CONNECT_SCRIPT_COMMANDS.set, (row?: ProcessArg, script?: ConnectScript | null) => this.setConnectScript(row, script)),
      c(TUNNEL_COMMANDS.set, (row?: ProcessArg, destination?: string | null) => this.setSshTunnel(row, destination)),
      c(SHARED_COMMANDS.add, (row?: ProcessArg) => this.addToShared(row)),
      c(GATEWAY_COMMANDS.set, (row?: ProcessArg, types?: string | string[] | null) => this.setGateway(row, types)),
      c(CONTROL_COMMANDS.setEvaluation, (row?: ProcessArg, mode?: string | null) => this.setEvaluation(row, mode)),
      c(GATEWAY_COMMANDS.queryWith, (types?: unknown) => this.queryGatewayWith(givenServerTypes(types))),
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
        // The tooltip says the active process's evaluation, which the setting can change (#2489).
        if (event.affectsConfiguration("q-lint.query.progress") || event.affectsConfiguration("q-lint.query.unwrapped")) {
          this.showStatus();
        }
        if (event.affectsConfiguration("q-lint.query.watch") && !this.setting(readWatch).enabled) {
          this.stopWatching("q-lint.query.watch.enable was turned off");
        }
        if (event.affectsConfiguration("q-lint.processes.shared")) {
          this.watchShared();
        }
        // Turned off, a connection through a tunnel closes with its tunnel,
        // a stream's apart too (#1517).
        if (event.affectsConfiguration("q-lint.connection.sshTunnel") && !this.setting(readTunnel).enabled) {
          this.closeSeparate((p) => p.ssh !== undefined);
          if (this.active?.ssh !== undefined && this.connection !== undefined) {
            void this.disconnect();
          }
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
          this.closeTunnels();
          globalThis.process.off("exit", this.closeTunnels);
          this.sharedWatcher?.dispose();
        },
      },
      workspace.onDidGrantWorkspaceTrust(() => void this.loadShared()),
    );
    globalThis.process.on("exit", this.closeTunnels);
    this.showStatus();
    this.status.show();
    this.watchShared();
    void this.applyRelabels();
  }

  /// The workspace's shared process list, as a discovery server's list is
  /// given: empty while it is off or there is no file.
  sharedList(): Discovered[] {
    return this.shared === undefined ? [] : [this.shared];
  }

  /// Watch and read the shared list while `q-lint.processes.shared.enable`
  /// is on; turned off, stop, forget what it listed, and close a connection
  /// to one of its processes.
  private watchShared(): void {
    this.sharedWatcher?.dispose();
    this.sharedWatcher = undefined;
    const folders = sharedFolders();
    if (!this.setting(readShared).enabled || folders.length === 0) {
      this.sharedRead++;
      const had = this.shared !== undefined;
      this.shared = undefined;
      if (had) {
        this.processesView.refresh();
      }
      this.closeSeparate((p) => p.server === SHARED_SOURCE);
      if (this.active?.server === SHARED_SOURCE && this.connection !== undefined) {
        void this.disconnect();
      }
      return;
    }
    // Each folder's file: in a multi-root workspace each repository may
    // commit its own (#1841).
    const reload = (): void => void this.loadShared();
    const watchers = folders.map((folder) => {
      const watcher = workspace.createFileSystemWatcher(new RelativePattern(folder, SHARED_FILE));
      watcher.onDidCreate(reload);
      watcher.onDidChange(reload);
      watcher.onDidDelete(reload);
      return watcher;
    });
    this.sharedWatcher = { dispose: () => watchers.forEach((w) => w.dispose()) };
    void this.loadShared();
  }

  /// Write a saved process into the shared list, creating it if need be
  /// (#955): its address, user, tags and settings, never a password.
  private async addToShared(row?: ProcessArg): Promise<void> {
    if (!this.featureOn(this.setting(readShared).enabled, "The shared process list", "q-lint.processes.shared.enable")) {
      return;
    }
    const folders = sharedFolders();
    if (folders.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: open a folder first: the shared process list is its ${SHARED_FILE}.`));
      return;
    }
    const folder = folders.length === 1 ? folders[0] : await window.showWorkspaceFolderPick({ placeHolder: `Share it in which folder's ${SHARED_FILE}?` });
    if (folder === undefined) {
      return;
    }
    const chosen = await this.chosen(row, "Share which q process with the repository?");
    if (chosen === undefined) {
      return;
    }
    // What runs or reaches somewhere at connect can hold a secret - a
    // password in a connect script, a launch's environment - and the file
    // is committed: it is shown and asked about first (#1528).
    // An SSH tunnel is always shared: it holds no secret (#1715).
    let process = chosen;
    const extras = (onConnectBrought([], [chosen])[0]?.what ?? []).filter((what) => what !== "SSH tunnel");
    if (extras.length > 0) {
      const all = "Share All";
      const without = "Share Without Them";
      const { init, initFile, credentialCommand, launch } = chosen;
      const answer = await window.showWarningMessage(
        plainMessage(`${chosen.label} has a ${extras.join(", ")}. ${SHARED_FILE} is committed with the code: everyone who clones it reads what is written there, as shown below. Share them too?`),
        { modal: true, detail: JSON.stringify({ init, initFile, credentialCommand, launch }, null, 2) },
        all,
        without,
      );
      if (answer === undefined) {
        return;
      }
      process = sharedEntry(chosen, answer === all, folder.uri.fsPath);
    }
    const file = Uri.joinPath(folder.uri, SHARED_FILE);
    // Written under unsaved edits, the next save conflicts (#1531).
    if (unsavedIn(file, workspace.textDocuments ?? [])) {
      void window.showWarningMessage(plainMessage(`q-lint: ${SHARED_FILE} has unsaved changes; save it, then share ${process.label} again. Nothing was written.`));
      return;
    }
    let text: string | undefined;
    try {
      text = Buffer.from(await workspace.fs.readFile(file)).toString("utf8");
    } catch {
      text = undefined;
    }
    // A file there that is not JSON is the problem, not the write (#1876).
    let next: string;
    try {
      next = withShared(text, process);
    } catch (error) {
      void window.showErrorMessage(
        plainMessage(`q-lint: ${file.fsPath} is not JSON: ${error instanceof Error ? error.message : String(error)}. Correct it, then share ${process.label} again. Nothing was written.`),
      );
      return;
    }
    try {
      assertWritable(folder.uri.fsPath, file.fsPath);
      await workspace.fs.writeFile(file, Buffer.from(next, "utf8"));
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${file.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    await this.loadShared();
    void window.showInformationMessage(
      plainMessage(`q-lint: ${process.label} is in ${SHARED_FILE}, without its password${process.user !== undefined ? `: each user is asked for ${process.user}'s on connect` : ""}.`),
    );
  }

  /// Where `process`'s password is kept: a shared-list process's by this
  /// folder and its address too (#1824).
  private passwordKey(process: Pick<Process, "label" | "server"> & Partial<Pick<Process, "host" | "port" | "user" | "tls" | "ssh">>): string {
    return process.server === SHARED_SOURCE && process.host !== undefined && process.port !== undefined
      ? sharedPasswordKey({ ...process, host: process.host, port: process.port }, this.sharedFolder(process.label))
      : passwordKey(process);
  }

  /// The folder (its URI) whose shared list names the process `label`
  /// (qualified, `.qlint/rdb`): not the first folder, so opening the
  /// repository in another workspace, or reordering its folders, keeps its
  /// password (#2513). The first folder's for one no list names now.
  sharedFolder(label: string): string {
    return this.sharedFolders.get(label) ?? workspace.workspaceFolders?.[0]?.uri.toString() ?? "";
  }

  /// Read the shared list again. A process whose host, port or user changed
  /// since it was last read forgets the password given for it.
  private async loadShared(): Promise<void> {
    const folders = sharedFolders();
    const run = ++this.sharedRead;
    if (!this.setting(readShared).enabled || folders.length === 0) {
      return;
    }
    // Every folder's file, as one list (#1841).
    const found = (
      await Promise.all(
        folders.map(async (folder) => {
          const file = Uri.joinPath(folder.uri, SHARED_FILE);
          try {
            return { folder, file, text: Buffer.from(await workspace.fs.readFile(file)).toString("utf8") };
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((f) => f !== undefined);
    if (run !== this.sharedRead) {
      return;
    }
    const server = { label: SHARED_SOURCE, url: found.map((f) => f.file.fsPath).join(", ") };
    if (found.length === 0) {
      this.shared = undefined;
    } else {
      try {
        const trusted = workspace.isTrusted === true;
        const lists: Parameters<typeof mergeShared>[0] = [];
        const broken: string[] = [];
        for (const { folder, file, text } of found) {
          try {
            lists.push({ name: folder.name, path: folder.uri.fsPath, read: readSharedFile(text, trusted) });
          } catch (error) {
            if (found.length === 1) {
              throw error;
            }
            broken.push(`${file.fsPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (lists.length === 0) {
          throw new SyntaxError(broken.join("; "));
        }
        const merged = mergeShared(lists, workspace.workspaceFolders?.[0]?.uri.fsPath);
        const read = { ...merged, problems: [...merged.problems, ...broken] };
        const uris = new Map(found.map(({ folder }) => [folder.uri.fsPath, folder.uri.toString()]));
        const folderOf = new Map(read.processes.map((p, i) => [qualified(SHARED_SOURCE, p.label), uris.get(read.folders[i]) ?? ""]));
        const before = this.context.workspaceState.get<unknown>(SHARED_SEEN_KEY);
        const seen = parseProcesses(Array.isArray(before) ? before : [], true).processes;
        for (const label of passwordsToForget(seen, read.processes)) {
          const was = seen.find((p) => p.label === label);
          if (was !== undefined) {
            // Kept by the folder it was read from, or, read in another
            // window, by the one that names it now.
            const key = qualified(SHARED_SOURCE, label);
            const folder = this.sharedFolders.get(key) ?? folderOf.get(key) ?? this.sharedFolder(key);
            await this.context.secrets.delete(sharedPasswordKey({ ...was, label: key }, folder));
          }
        }
        await this.context.workspaceState.update(
          SHARED_SEEN_KEY,
          // With how it is reached, so a list that turns off TLS or a tunnel
          // forgets the password too (#1269).
          read.processes.map(({ label, host, port, user, tls, ssh }) => ({
            label,
            host,
            port,
            ...(user !== undefined ? { user } : {}),
            ...(tls === true ? { tls } : {}),
            ...(ssh !== undefined ? { ssh } : {}),
          })),
        );
        if (run !== this.sharedRead) {
          return;
        }
        this.shared = { server, state: { processes: read.processes, problems: read.problems, loading: false, removed: false, fetchedAt: Date.now() } };
        this.sharedFolders = folderOf;
        if (read.secrets.length > 0) {
          void window.showWarningMessage(plainMessage(secretsWarning(read.secrets)));
        }
      } catch (error) {
        this.shared = { server, state: { processes: [], problems: [], loading: false, removed: false, error: `not JSON: ${error instanceof Error ? error.message : String(error)}` } };
      }
    }
    this.processesView.refresh();
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
    /// The workspace's shared process list (#955), when it is shown.
    sharedProcesses: () => { file: string; processes: Process[]; problems: string[]; error?: string } | undefined;
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
      sharedProcesses: () =>
        this.shared === undefined
          ? undefined
          : {
              file: this.shared.server.url,
              processes: this.shared.state.processes,
              problems: this.shared.state.problems,
              ...(this.shared.state.error !== undefined ? { error: this.shared.state.error } : {}),
            },
    };
  }

  /// Where the extension's own files are, for a webview of another view.
  get extensionUri(): Uri {
    return this.context.extensionUri;
  }

  processes(): Process[] {
    return parseProcesses(this.context.globalState.get<unknown>(PROCESSES_KEY, []), true, true).processes;
  }

  activeLabel(): string | undefined {
    return this.connection?.isOpen ? this.active?.label : undefined;
  }

  /// The connected process, as connected to: a discovered one's label qualified.
  activeProcess(): Process | undefined {
    return this.connection?.isOpen ? this.active : undefined;
  }

  /// The process the file `uri` is bound to by Choose Connection for File,
  /// if any: where hot reload on save (#934) sends its definitions.
  fileBinding(uri: Uri): string | undefined {
    return this.controls.binding(uri);
  }

  /// Connect to the process the file `uri` is bound to, when it has one
  /// and it is not the active connection, before a command sends that
  /// file's code: a cell, a process tool, a watch. False, having said why,
  /// when the connection cannot move there: a query is still running, or
  /// the connect failed.
  async toFileBinding(uri: Uri | undefined): Promise<boolean> {
    const bound = uri === undefined ? undefined : this.fileBinding(uri);
    if (bound === undefined || bound === this.activeLabel()) {
      return true;
    }
    if (this.isBusy()) {
      void window.showInformationMessage(
        plainMessage(`q-lint: a query is still running on ${this.activeLabel()}; this file's code goes to ${bound}. q-lint: Abort Current Query stops waiting for it.`),
      );
      return false;
    }
    return this.connectTo(bound);
  }

  /// Whether Toggle Unlimited Query is on: a pane that runs code asks too (#2362).
  isUnlimited(): boolean {
    return this.controls.unlimited;
  }

  /// Whether a query is running on the active connection: connecting
  /// elsewhere now would stop waiting for it.
  isBusy(): boolean {
    return this.connection?.isBusy ?? false;
  }

  history(): HistoryEntry[] {
    this.queries = mergedHistory(undefined, this.queries, this.storedHistory(), this.historyCleared(), HISTORY_LIMIT);
    return this.queries;
  }

  /// When Clear History was last run, in any window.
  private historyCleared(): string | undefined {
    const stored = this.context.globalState.get<unknown>(HISTORY_CLEARED_KEY);
    return typeof stored === "string" ? stored : undefined;
  }

  private storedHistory(): HistoryEntry[] {
    return parseQueryHistory<HistoryEntry>(this.context.globalState.get<unknown>(HISTORY_KEY, []));
  }

  /// The history through the Query History view's filter.
  shownHistory(): HistoryEntry[] {
    return filtered(this.history(), this.historyFilter);
  }

  /// Run `use` on the active connection now, if there is one and no query
  /// is running on it; undefined otherwise. A query sent meanwhile waits for
  /// it instead of being refused. `what` names the call, as Abort says it.
  borrow<T>(use: (connection: QConnection, process: Process) => Promise<T>, what = "a background read"): Promise<T> | undefined {
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
    this.borrower = what;
    return call;
  }

  /// Whether a process of this label was started from the Processes view
  /// and still runs (#954): the launcher sets it.
  launched: (label: string) => boolean = () => false;

  /// A saved process was renamed `from` to `to`: the launcher keeps what it
  /// started under the new label.
  relabelled: (from: string, to: string) => void = () => {};

  /// Redraw the Processes view.
  refreshProcesses(): void {
    this.processesView.refresh();
  }

  /// Save `processes` as the list, for the views around this one.
  saveProcesses(processes: Process[]): Promise<void> {
    return this.save(processes);
  }

  /// Save `processes` as the list. One new to it starts with no password
  /// but its own - `given`: the labels one was just stored for. What is
  /// under a new label's key was another's: a discovered process's, kept
  /// there up to 0.26, and it was sent for this one unasked (#1887).
  private async save(processes: Process[], given: string[] = []): Promise<void> {
    const before = new Set(this.processes().map((p) => p.label));
    const fresh = processes.map((p) => p.label).filter((label) => !before.has(label));
    for (const label of fresh) {
      if (!given.includes(label)) {
        await this.context.secrets.delete(this.passwordKey({ label }));
      }
      await this.vacate(label, fresh.length === 1);
    }
    await this.context.globalState.update(PROCESSES_KEY, processes);
    // The connected process, and one being connected to, are the entries
    // captured at connect: a timeout or credential command set since is
    // theirs from now, not from the next manual connect (#1988).
    for (const saved of processes) {
      if (this.active?.label === saved.label && this.active.server === undefined) {
        this.active = resaved(this.active, saved);
      }
      if (this.connectingAs?.label === saved.label && this.connectingAs.server === undefined) {
        this.connectingAs = resaved(this.connectingAs, saved);
      }
    }
    this.processesView.refresh();
  }

  /// Delete what a process once labelled `label` left, before another takes
  /// the label: v0.36 deleted a process and kept its scheduled exports and
  /// dashboard tiles, which then ran on the next one of that label (#1879).
  /// Not the tiles and files of a discovered or shared process that answers
  /// to the label. `logged` for the workspaces not open, as a deletion is: a
  /// list downloaded or imported is not, the log keeping its last hundred.
  private async vacate(label: string, logged: boolean): Promise<void> {
    const schedules = parseSchedules(this.context.workspaceState.get<unknown>(SCHEDULES_KEY, []));
    const scheduled = schedules.filter((s) => s.process === label).length;
    let tiles = 0;
    if (findDiscovered([...this.discovery.discovered(), ...this.sharedList()], label) !== undefined) {
      // A scheduled export runs on a saved process only.
      if (scheduled > 0) {
        await this.context.workspaceState.update(SCHEDULES_KEY, retargetedSchedules(schedules, label, undefined));
      }
    } else {
      const dashboards = parseDashboards(this.context.workspaceState.get<unknown>(DASHBOARDS_KEY, []));
      tiles = dashboards.reduce((n, d) => n + d.tiles.filter((t) => t.process === label).length, 0);
      await (logged ? this.rebind(label, undefined) : this.retarget(label, undefined));
    }
    if (scheduled + tiles > 0) {
      void window.showInformationMessage(
        plainMessage(`q-lint: the ${scheduled} scheduled export(s) and ${tiles} dashboard tile(s) an earlier process labelled "${label}" left were deleted.`),
      );
    }
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
      void window.showInformationMessage(plainMessage(`q-lint: ${feature} is turned off. Set ${key} to true to turn it on.`));
    }
    return enabled;
  }

  /// Whether `code` may be sent to `targets`: when the read-only guard
  /// (#918) finds it would change a guarded one, the user is asked first.
  /// `what` names the code in the question, when it is not a query.
  async guardAllows(code: GuardCode, targets: Process[], what?: string): Promise<boolean> {
    const check = guardCheck(code, targets, this.setting(readGuard));
    if (check === undefined) {
      return true;
    }
    const { message, detail } = guardQuestion(check);
    const yes = "Run Anyway";
    return (await window.showWarningMessage(plainMessage(what === undefined ? message : `${what}: ${message}`), { modal: true, detail }, yes)) === yes;
  }

  /// Why `code` is refused on `targets` to a caller that cannot ask the
  /// user, an agent; undefined when the guard lets it be sent.
  guardRefuses(code: GuardCode, targets: Process[]): string | undefined {
    const check = guardCheck(code, targets, this.setting(readGuard));
    return check === undefined ? undefined : guardRefusal(check);
  }

  /// Set `connection` to evaluate the statements next sent under `reval`
  /// (`query.ts`'s `trapLines`) when that is the guard's backstop for
  /// `code` on `process`: the process is guarded,
  /// q-lint.processes.readOnlyGuard.enforce is on, and the guard reads
  /// `code` as read-only - code it asked about and the user confirmed goes
  /// as it is. Not on a TorQ gateway, whose `.gw.syncexec` changes the
  /// gateway itself, so the guard alone holds there. Whether it was set.
  private backstop(connection: QConnection, process: Process, code: GuardCode): boolean {
    if (connection.isDirect) {
      connection.readOnly = false;
      connection.refused = undefined;
      this.sayNoReval(connection, process);
      return false;
    }
    const on =
      this.setting(readEnforce) &&
      guardedBy(process, this.setting(readGuard)).length > 0 &&
      (process.gateway === undefined || !this.setting(readGateway).enabled) &&
      !isGatewayCall(guardText(code)) &&
      this.guardRefuses(code, [process]) === undefined;
    connection.readOnly = on;
    connection.refused = undefined;
    return on;
  }

  /// On a direct connection to a guarded process, said once: nothing of
  /// q-lint's runs there, so `reval` is not applied and the process does
  /// not enforce read-only; the guard's own reading still holds (#2470).
  private sayNoReval(connection: QConnection, process: Process): void {
    const mode = connection.direct();
    if (mode === undefined || guardedBy(process, this.setting(readGuard)).length === 0 || this.toldDirect.has(process.label)) {
      return;
    }
    this.toldDirect.add(process.label);
    void window.showInformationMessage(
      plainMessage(
        `q-lint: ${process.label} uses direct evaluation (${mode.from === "process" ? 'its "evaluation"' : "q-lint.query.unwrapped"}), so your code is sent as plain strings and reval is not applied: ${process.label} does not enforce read-only. The read-only guard still reads what is sent and asks before code that would change it.`,
      ),
    );
  }

  /// After a send `backstop` set: `reval`'s refusal, if it refused, and
  /// `connection` back to evaluating as it did. A process found to have
  /// no `reval` is said once.
  private backstopped(connection: QConnection, process: Process): string | undefined {
    const refused = connection.refused;
    connection.readOnly = false;
    connection.refused = undefined;
    if (connection.noReval && !this.toldNoReval.has(process.label)) {
      this.toldNoReval.add(process.label);
      void window.showInformationMessage(
        plainMessage(`q-lint: ${process.label} has no reval, so code the read-only guard reads as read-only is sent to it as it is: the guard alone holds there (q-lint.processes.readOnlyGuard.enforce).`),
      );
    }
    return refused;
  }

  /// Whether to send again, as it is, code `reval` refused on `process`
  /// with `refused`: the user is asked.
  private async refusedAnyway(process: Process, refused: string): Promise<boolean> {
    const yes = "Run Anyway";
    return (
      (await window.showWarningMessage(
        plainMessage(refusalQuestion(process.label, refused)),
        {
          modal: true,
          detail:
            "The read-only guard read this code as read-only, so it was sent under reval, q's read-only evaluation (q-lint.processes.readOnlyGuard.enforce), and q refused it: it would change the process - assign a global, write or delete a file, run a system command - or calls something that does. Run Anyway sends it again as it is.",
        },
        yes,
      )) === yes
    );
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
    } else if (this.waiters.size > 0) {
      const to = label ?? this.connectingAs?.label ?? this.reconnecting?.label ?? "the process";
      this.status.text = `$(sync~spin) q: ${iconsEscaped(to)} waiting`;
      this.status.tooltip = `A query waits to be sent to ${to}: a connect, or another call, is under way. q-lint: Abort Current Query stops it.`;
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
        ...(this.active === undefined ? [] : [evaluationText(label, this.activeDirect(), this.active.evaluation !== undefined)]),
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
    void commands.executeCommand("setContext", QUERY_RUNNING, (this.running !== undefined && label !== undefined) || this.waiters.size > 0);
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
            : "Stored in VS Code's SecretStorage, never in settings or an export. Leave empty to keep the stored one; a new user, host or port forgets it.",
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
      void window.showErrorMessage(plainMessage(`q-lint: the label "${answer.process.label}" was taken meanwhile; the process was not added.`));
      return;
    }
    if (answer.password !== undefined) {
      await this.context.secrets.store(this.passwordKey(answer.process), answer.password);
    }
    await this.save([...now, answer.process], answer.password !== undefined ? [answer.process.label] : []);
  }

  /// The process a command was given from a view row, or one the user picks.
  /// A discovered process only when `discovered`, with its label qualified;
  /// a label names a saved process before a discovered one.
  private async chosen(row: ProcessArg, title: string, discovered = false): Promise<Process | undefined> {
    const listed = discovered ? [...this.discovery.discovered(), ...this.sharedList()] : [];
    if (typeof row === "string") {
      const named = this.processes().find((p) => p.label === row) ?? findDiscovered(listed, row);
      if (named === undefined) {
        void window.showErrorMessage(plainMessage(`q-lint: no q process is labelled "${row}".`));
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
        detail: p.tags.length ? iconsEscaped(p.tags.join(", ")) : undefined,
        process: p,
      })),
      { title, matchOnDescription: true, matchOnDetail: true },
    );
    return picked?.process;
  }

  /// The process a command was given, or one the user picks, a discovered
  /// one with its label qualified: for the views around this one.
  pick(row: ProcessArg, title: string): Promise<Process | undefined> {
    return this.chosen(row, title, true);
  }

  /// The process `label` names, as a connect to it finds it: a saved one
  /// before a discovered or shared one, whose label is qualified. For a view
  /// that keeps a label `pick` gave (#1122, #1125).
  named(label: string): Process | undefined {
    return this.processes().find((p) => p.label === label) ?? findDiscovered([...this.discovery.discovered(), ...this.sharedList()], label);
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
    const process = withExtras(withScript(answer.process, scriptOf(old)), old);
    // Read again: the list may have changed while the boxes were open.
    const now = this.processes();
    const problem = !now.some((p) => p.label === old.label)
      ? `"${old.label}" was deleted meanwhile`
      : process.label !== old.label && now.some((p) => p.label === process.label)
        ? `the label "${process.label}" was taken meanwhile`
        : undefined;
    if (problem !== undefined) {
      void window.showErrorMessage(plainMessage(`q-lint: ${problem}; the process was not changed.`));
      return;
    }
    // A password left empty is kept, but not for another user, host or port:
    // it was given for the one it was stored with (#1109).
    const moved = passwordsToForget([old], [{ ...process, label: old.label }]).length > 0;
    if (process.label !== old.label) {
      const kept = await this.context.secrets.get(this.passwordKey(old));
      await this.context.secrets.delete(this.passwordKey(old));
      // What is under the new label's key is not this process's (#1887).
      await this.context.secrets.delete(this.passwordKey(process));
      if (kept !== undefined && answer.password === undefined && !moved) {
        await this.context.secrets.store(this.passwordKey(process), kept);
      }
    }
    if (answer.password !== undefined) {
      await this.context.secrets.store(this.passwordKey(process), answer.password);
    } else if (moved) {
      await this.context.secrets.delete(this.passwordKey(process));
    }
    if (process.user === undefined) {
      await this.context.secrets.delete(this.passwordKey(process));
    }
    if (process.label !== old.label) {
      // Before the redraw, so its row is still shown running (#1692).
      this.relabelled(old.label, process.label);
    }
    await this.save(now.map((p) => (p.label === old.label ? process : p)), [process.label]);
    if (process.label !== old.label) {
      await this.rebind(old.label, process.label);
      this.modes.processRenamed(old.label, process.label);
    }
    // A query watched on it, on the same connection, goes on under the new label (#1707).
    const watched = this.watching;
    if (watched !== undefined && watched.label === old.label && process.label !== old.label && this.active?.label === old.label && this.active.server === undefined) {
      watched.label = process.label;
      watched.status.tooltip = `Watching on ${process.label} every ${watched.every} s:\n${watched.code}\nClick to stop.`;
    }
    // One being connected to is connected to as it is now (#1700).
    if (this.connectingAs?.label === old.label && this.connectingAs.server === undefined) {
      this.connectingAs = stillOpen(this.connectingAs, process);
      this.connectingTo = this.passwordKey(process);
    }
    const active = this.active;
    if (active?.label === old.label && active.server === undefined) {
      // The connection is still to where it was opened (#1443).
      const { host, port, user, tls } = active;
      this.active = stillOpen(active, process);
      this.showStatus();
      // The explorer keeps what it read under the label it read it for.
      if (process.label !== old.label && this.activeLabel() !== undefined) {
        this.changed.fire("connected");
      } else if (process.tags.join(",") !== active.tags.join(",") && this.activeLabel() !== undefined) {
        // What is drawn by its tags, as the environment colour, is redrawn.
        this.changed.fire("edited");
      }
      const moved = process.host !== host || process.port !== port || process.user !== user || (process.tls === true) !== (tls === true);
      if (moved && this.activeLabel() !== undefined) {
        void window.showInformationMessage(
          plainMessage(`q-lint: still connected to ${process.label} at ${address(host, port)}. Connect to it again to use ${address(process.host, process.port)}.`),
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
    // Its dashboard tiles and scheduled exports go with it (#1617).
    const tiles = parseDashboards(this.context.workspaceState.get<unknown>(DASHBOARDS_KEY, [])).reduce((n, d) => n + d.tiles.filter((t) => t.process === process.label).length, 0);
    const scheduled = parseSchedules(this.context.workspaceState.get<unknown>(SCHEDULES_KEY, [])).filter((s) => s.process === process.label).length;
    const also = (tiles === 0 ? "" : ` Its ${tiles} dashboard tile(s) are removed with it.`) + (scheduled === 0 ? "" : ` Its ${scheduled} scheduled export(s) are deleted with it.`);
    const sure = await window.showWarningMessage(plainMessage(`Delete the q process "${process.label}" from the list?${also}`), { modal: true }, yes);
    if (sure !== yes) {
      return;
    }
    // Or being connected to: it would become the active one once deleted.
    // Or reconnected to after a drop, between tries too (#1701).
    const connecting = this.connecting !== undefined && this.connectingTo === this.passwordKey(process);
    const reconnecting = this.reconnecting?.label === process.label && this.connection === undefined && this.active?.server === undefined;
    if ((this.activeLabel() === process.label && this.active?.server === undefined) || connecting || reconnecting) {
      await this.disconnect();
    }
    await this.context.secrets.delete(this.passwordKey(process));
    await this.save(this.processes().filter((p) => p.label !== process.label));
    await this.rebind(process.label, undefined);
  }

  /// Bind the files bound to the process `from` to `to` instead, or unbind
  /// them: a binding is by label, and one to no process fails every query.
  /// Dashboard tiles and scheduled exports, also by label, move with it, or
  /// go with a deleted process (#1617).
  private async rebind(from: string, to: string | undefined): Promise<void> {
    // Processes are every window's, tiles and schedules this workspace's:
    // the others follow from the log when they next open (#1749).
    await this.applyRelabels();
    const log = withRelabel(parseRelabels(this.context.globalState.get<unknown>(RELABELS_KEY)), from, to);
    await this.context.globalState.update(RELABELS_KEY, log);
    await this.context.workspaceState.update(RELABELS_APPLIED_KEY, log[log.length - 1].n);
    await this.retarget(from, to);
    // Its scratch buffer is by label too, in storage every window shares (#2405).
    moveScratch(this.context.globalStorageUri?.fsPath, from, to);
  }

  /// The renames and deletions made in other workspaces since this one's
  /// state last had them, applied to it (#1749).
  private async applyRelabels(): Promise<void> {
    const log = parseRelabels(this.context.globalState.get<unknown>(RELABELS_KEY));
    const applied = this.context.workspaceState.get<number>(RELABELS_APPLIED_KEY, 0);
    const pending = relabelsAfter(log, applied);
    if (pending.length === 0) {
      return;
    }
    await this.context.workspaceState.update(RELABELS_APPLIED_KEY, log[log.length - 1].n);
    for (const r of pending) {
      await this.retarget(r.from, r.to ?? undefined);
    }
  }

  private async retarget(from: string, to: string | undefined): Promise<void> {
    await this.context.workspaceState.update(DASHBOARDS_KEY, retargetedTiles(parseDashboards(this.context.workspaceState.get<unknown>(DASHBOARDS_KEY, [])), from, to));
    this.tiles.fire();
    await this.context.workspaceState.update(SCHEDULES_KEY, retargetedSchedules(parseSchedules(this.context.workspaceState.get<unknown>(SCHEDULES_KEY, [])), from, to));
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
  /// agent's query warns by them. Saved at another address, it keeps its
  /// own as well until connected again (#1443).
  private retagActive(): void {
    const saved = this.active?.server === undefined ? this.processes().find((p) => p.label === this.active?.label) : undefined;
    if (this.active !== undefined && saved !== undefined) {
      const was = this.active.tags;
      this.active = { ...this.active, tags: openTags(this.active, saved) };
      // What is drawn by its tags, as the environment colour, is redrawn (#1703).
      if (this.active.tags.join(",") !== was.join(",") && this.activeLabel() !== undefined) {
        this.changed.fire("edited");
      }
    }
    // And one being connected to, once it connects (#1700).
    const pending = this.connectingAs?.server === undefined ? this.processes().find((p) => p.label === this.connectingAs?.label) : undefined;
    if (this.connectingAs !== undefined && pending !== undefined) {
      this.connectingAs = { ...this.connectingAs, tags: openTags(this.connectingAs, pending) };
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
      void window.showErrorMessage(plainMessage(`q-lint: could not read ${files[0].fsPath}: ${String(error)}`));
      return;
    }
    const { problems } = read;
    let { processes } = read;
    const before = this.processes();
    // Code that runs on a process, or on this machine, at every connect - a
    // connect script, a credential command, a launch definition - and a
    // tunnel the password is sent through are not taken from a file unasked:
    // someone else's list may hold them (#1108).
    const brought = onConnectBrought(before, processes);
    if (brought.length > 0) {
      const scriptsOnly = brought.every(({ what }) => what.length === 1 && what[0] === "connect script");
      const keep = scriptsOnly ? "Import with Scripts" : "Import with Them";
      const drop = scriptsOnly ? "Import without Scripts" : "Import without Them";
      const listed = `${brought.slice(0, 5).map(({ label, what }) => (scriptsOnly ? label : `${label} (${what.join(", ")})`)).join(", ")}${brought.length > 5 ? ", ..." : ""}`;
      const answer = await window.showWarningMessage(
        plainMessage(scriptsOnly
          ? `${files[0].fsPath} gives ${brought.length} process(es) a connect script, q code run on the process at every connect: ${listed}. Keep the scripts?`
          : `${files[0].fsPath} gives ${brought.length} process(es) what runs at every connect - a connect script runs q code on the process, a credential command or launch definition a command on this machine, and an SSH tunnel decides where the password goes: ${listed}. Keep them?`),
        { modal: true },
        keep,
        drop,
      );
      if (answer === undefined) {
        return;
      }
      if (answer === drop) {
        const old = new Map(before.map((p) => [p.label, p]));
        const labels = new Set(brought.map(({ label }) => label));
        processes = processes.map((p) => (labels.has(p.label) ? onConnectOf(p, old.get(p.label)) : p));
      }
    }
    // Nor is what protects a process taken away unasked: its TLS, its SSH
    // tunnel, a tag the read-only guard guards it by (#1269).
    const guardTags = this.setting(readGuard).tags;
    const removed = protectionsRemoved(before, processes, guardTags);
    if (removed.length > 0) {
      const keep = "Keep Them";
      const drop = "Import as Written";
      const listed = `${removed.slice(0, 5).map(({ label, what }) => `${label} (${what.join(", ")})`).join(", ")}${removed.length > 5 ? ", ..." : ""}`;
      const answer = await window.showWarningMessage(
        plainMessage(`${files[0].fsPath} takes from ${removed.length} process(es) what protects them - TLS, an SSH tunnel, a tag the read-only guard guards: ${listed}. Keep them?`),
        { modal: true },
        keep,
        drop,
      );
      if (answer === undefined) {
        return;
      }
      if (answer === keep) {
        const old = new Map(before.map((p) => [p.label, p]));
        const labels = new Set(removed.map(({ label }) => label));
        processes = processes.map((p) => (labels.has(p.label) ? withProtections(p, old.get(p.label), guardTags) : p));
      }
    }
    // Reached another way - TLS or a tunnel changed - its password is forgotten.
    for (const label of passwordsToForget(before, processes)) {
      await this.context.secrets.delete(this.passwordKey({ label }));
    }
    await this.save(merge(before, processes));
    this.retagActive();
    const note = problems.length ? ` Skipped ${problems.length}: ${problems.slice(0, 3).join(" ")}` : "";
    void window.showInformationMessage(plainMessage(`q-lint: imported ${processes.length} q process(es).${note}`));
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
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${file.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    void window.showInformationMessage(plainMessage(`q-lint: exported ${processes.length} q process(es) to ${file.fsPath}.`));
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
        // Kept whole: a saved process is every window's, and a path
        // relative to this folder read another workspace's file of that
        // name when connected from there (#1527).
        chosen = { kind: "file", file: files[0].fsPath };
      }
    }
    if (chosen !== undefined && isProduction(process)) {
      const yes = "Set Script";
      const sure = await window.showWarningMessage(
        plainMessage(`${process.label} is a production process (tagged ${process.tags.join(", ")}). Its connect script runs there at every connect, as written, and can change or delete data. Set it?`),
        { modal: true },
        yes,
      );
      if (sure !== yes) {
        return;
      }
    }
    const now = this.processes();
    if (!now.some((p) => p.label === process.label)) {
      void window.showErrorMessage(plainMessage(`q-lint: "${process.label}" was deleted meanwhile; its connect script was not set.`));
      return;
    }
    await this.save(now.map((p) => (p.label === process.label ? withScript(p, chosen) : p)));
    if (this.active?.label === process.label && this.active.server === undefined) {
      this.active = withScript(this.active, chosen);
    }
    void window.showInformationMessage(
      plainMessage(chosen === undefined
        ? `q-lint: ${process.label} runs nothing on connect.`
        : `q-lint: ${process.label} runs its connect script (${scriptSummary(chosen)}) from the next connect.`),
    );
  }

  /// Run `process`'s connect script on `connection`, just opened, before any
  /// query can be: its failure is said, and the connection kept. `stopped`
  /// says the connect was given up - a disconnect - while the read-only
  /// guard's question was open: nothing is sent then (#1357). `unattended`:
  /// run from a timer, with nobody to ask - a script the guard holds is not
  /// run, and that or a failure throws for the caller to report (#1618).
  /// `throws`: a failure throws rather than being said - a connection apart
  /// is not handed out unprepared, or closed by a timeout (#1713).
  private async runConnectScript(connection: QConnection, process: Process, stopped: () => boolean = () => false, unattended = false, throws = unattended): Promise<void> {
    const script = scriptOf(process);
    if (script === undefined || !this.setting(readConnectScript).enabled) {
      return;
    }
    const failed = (why: string): void => {
      if (throws) {
        throw new Error(`the connect script of ${process.label} failed: ${why}`);
      }
      this.show([`# ${process.label} - connect script failed: ${why}`], false);
      void window.showWarningMessage(plainMessage(`q-lint: the connect script of ${process.label} failed: ${why}`));
    };
    let code: string;
    if (script.kind === "code") {
      code = script.code;
    } else {
      // A relative file is the opened folder's: in one not trusted, that is
      // the repository's q code, run on the process (#1527).
      if (workspace.isTrusted === false && scriptPath(script.file, os.homedir(), undefined) === undefined) {
        failed(`${script.file} is relative to the workspace folder, which is not trusted: it was not run. Name the file by its full path.`);
        return;
      }
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
    // A script, read as q loads one (#2278).
    const cut = statements(scriptCode(code));
    if (cut.length === 0) {
      return;
    }
    const refused = unattended ? this.guardRefuses(code, [process]) : undefined;
    if (refused !== undefined) {
      if (throws) {
        throw new Error(`the connect script of ${process.label} was not run, and nothing was: ${refused}`);
      }
      // A reconnect q-lint makes itself connects without it, as one whose
      // question was declined does, and says so (#2133).
      failed(`it would change ${process.label}, and a reconnect asks nobody: it was not run. Connect to ${process.label} to be asked.`);
      return;
    }
    if (!unattended && !(await this.guardAllows(code, [process], `The connect script of ${process.label}`))) {
      this.show([`# ${process.label} - connect script not run: changing a read-only process was not confirmed`], false);
      return;
    }
    if (stopped()) {
      return;
    }
    const configuration = workspace.getConfiguration("q-lint");
    const { consoleSize } = readLive((key, fallback) => configuration.get(key, fallback));
    const started = Date.now();
    // A script that blocks holds the connect, and every one after it: it
    // times out as a query does, and a disconnect closes it (#1505). On a
    // connection apart it is bounded even with no query timeout, and Abort
    // or Disconnect closes it (#2567).
    const controls = this.controls.settings();
    const timeout = effectiveTimeout(process, controls.timeout, this.setting(readAdmin).processTimeout) || (throws ? APART_SCRIPT_TIMEOUT : 0);
    let timedOut = false;
    const disarm = armTimeout(timeout, () => {
      timedOut = true;
      connection.abort();
    });
    const preparing = { connection, process };
    if (throws) {
      this.preparingApart.add(preparing);
    }
    try {
      const answer = await window.withProgress(
        { location: { viewId: VIEWS.processes }, title: `Running the connect script of ${process.label}` },
        () =>
          connection.isDirect
            ? runUnwrapped(connection, cut, { size: consoleSize, limit: 0, unlimited: false, grid: false })
            : connection.query(cut, consoleSize),
      );
      if (!answer.ok) {
        failed(`'${answer.error}`);
        return;
      }
      this.output.appendLine(`# ${process.label} - connect script ran (${Date.now() - started} ms)`);
    } catch (error) {
      if (throws && error instanceof Error && error.message.startsWith(`the connect script of ${process.label} failed`)) {
        throw error;
      }
      if (!stopped()) {
        failed(timedOut ? timedOutError(timeout) : error instanceof Error ? error.message : String(error));
      }
    } finally {
      disarm();
      this.preparingApart.delete(preparing);
    }
  }

  /// Close the connections apart still in their connect script; the labels
  /// of their processes.
  private stopPreparingApart(): string[] {
    const labels = [...this.preparingApart].map(({ connection, process }) => (connection.abort(), process.label));
    this.preparingApart.clear();
    return [...new Set(labels)];
  }

  // --- connections

  async connectTo(row?: ProcessArg): Promise<boolean> {
    const process = await this.chosen(row, "Connect to which q process?", true);
    // A connect the user asks for stops an automatic reconnect, and the
    // tries after its next drop start again.
    if (process !== undefined) {
      this.stopReconnecting();
      this.reconnectTries = undefined;
    }
    if (process === undefined) {
      return false;
    }
    // A discovered process's user has no password stored until asked for one.
    const saved = process.server === undefined;
    // One whose credential command (#1034) gives its password is not asked.
    const commanded = process.credentialCommand !== undefined && this.setting(readAdmin).credentialCommand;
    if (!saved && process.user && !commanded && (await this.context.secrets.get(this.passwordKey(process))) === undefined) {
      const password = await window.showInputBox({
        title: `q process ${process.label}: password of ${process.user}`,
        password: true,
        prompt: "Kept in VS Code's secret storage.",
      });
      if (password === undefined) {
        return false;
      }
      await this.context.secrets.store(this.passwordKey(process), password);
      // Kept, so deleting the server forgets it even after a reload.
      await this.discovery.passwordGiven(process.server!, process.label.slice(process.server!.length + 1));
    }
    const outcome: { refused?: boolean } = {};
    const connected = await this.open(process, false, false, this.disconnects, outcome);
    // A discovered process cannot be edited, so a password that was refused
    // is forgotten: the next connect asks for it again. One that met a host
    // down or a timeout is kept (#1511).
    if (!connected && outcome.refused === true && !saved && process.user && !commanded) {
      await this.context.secrets.delete(this.passwordKey(process));
      await this.discovery.passwordGiven(process.server!, process.label.slice(process.server!.length + 1), false);
    }
    return connected;
  }

  /// Connect to `process`, closing the connection there was. Whether it
  /// connected. `untilFree`, after an abort: a process that does not answer
  /// the handshake is still running the query it was left with, and is
  /// tried again until it does, or until the user disconnects or connects
  /// elsewhere.
  /// `outcome.refused` is set when the process closed before the handshake:
  /// how it refuses a user or password.
  private open(process: Process, untilFree = false, quiet = false, disconnects = this.disconnects, outcome: { refused?: boolean } = {}): Promise<boolean> {
    if (this.connecting !== undefined) {
      // A connect to another process - a reconnect after an abort, waiting
      // for that process to be free - is stopped and this one follows: its
      // result says nothing of this process.
      // One to this process that was stopped is followed as well.
      if (this.connectingTo === this.passwordKey(process) && this.stopConnect?.signal.aborted !== true) {
        return this.connecting;
      }
      // A connect script that blocks is closed too: no timeout may end it (#1712).
      this.reconnectStopped = true;
      this.stopConnect?.abort();
      // One running its connect script, which may never answer.
      this.opening?.abort();
      return this.connecting.then(() => this.open(process, false, false, disconnects, outcome));
    }
    this.reconnectStopped = false;
    // A wait for a busy process is cut short, not run out, when it stops
    // (#1510), and so is any connect replaced by another or by Disconnect (#1704).
    const cut = new AbortController();
    this.stopConnect = cut;
    this.connectingTo = this.passwordKey(process);
    this.connectingAs = process;
    this.connecting = (async () => {
      if (this.connection !== undefined) {
        const old = this.connection;
        this.connection = undefined;
        this.aborted = this.running?.started;
        // A query running on it is stopped, as at Disconnect (#2556).
        if (old.isBusy) {
          old.abort();
        } else {
          await old.close();
        }
        // Said now, not on connecting: the new one may never come.
        this.changed.fire("disconnected");
      }
      try {
        const connection = await window.withProgress(
          { location: { viewId: VIEWS.processes }, title: `Connecting to ${process.label}` },
          async () => {
            const target = await this.targetFor(process, cut.signal);
            for (;;) {
              try {
                return await this.dial(process, target, cut.signal);
              } catch (error) {
                const busy = error instanceof Error && error.message.startsWith("no answer from ");
                if (!untilFree || !busy || this.reconnectStopped || cut.signal.aborted) {
                  throw error;
                }
              }
            }
          },
        );
        // Opened after deactivate (a reconnect after an abort), when nothing
        // would close it, after the reconnect was stopped, or after the user
        // disconnected while it was opening, or connected elsewhere.
        const stopped = (): boolean => this.disposed || disconnects !== this.disconnects || cut.signal.aborted || ((untilFree || quiet) && this.reconnectStopped);
        if (stopped()) {
          await connection.close();
          return false;
        }
        this.opening = connection;
        try {
          // A reconnect from a timer or after an abort asks no question:
          // nobody may be at the keyboard, and every query waits on it (#2133).
          await this.runConnectScript(connection, process, stopped, untilFree || quiet, false);
        } finally {
          this.opening = undefined;
        }
        if (stopped() || !connection.isOpen) {
          await connection.close();
          return false;
        }
        this.connection = connection;
        this.active = this.connectingAs ?? process;
        const openedAt = Date.now();
        // The process as it is when a message comes or the connection
        // closes, not as connected to: it may be renamed or tagged since (#1699).
        connection.whenAsync((message) => {
          if (this.connection === connection) {
            for (const listener of this.asyncListeners) {
              listener(message, this.active ?? process);
            }
          }
        });
        connection.whenClosed(() => {
          if (this.connection === connection) {
            const now = this.active ?? process;
            if (this.answeredOn === connection || Date.now() - openedAt >= STEADY_MS) {
              this.reconnectTries = undefined;
            }
            this.connection = undefined;
            this.running = undefined;
            const configuration = workspace.getConfiguration("q-lint");
            const again = readHealth((key, fallback) => configuration.get(key, fallback)).autoReconnect && !this.disposed;
            this.showStatus();
            this.processesView.refresh();
            this.changed.fire("disconnected");
            void window.showWarningMessage(plainMessage(`q-lint: the connection to ${now.label} closed.${again ? " Reconnecting." : ""}`));
            if (again) {
              void this.autoReconnect(now);
            }
          }
        });
        this.changed.fire("connected");
        return true;
      } catch (failure) {
        outcome.refused = failure instanceof ClosedBeforeHandshake || failure instanceof TunnelHandshakeError;
        if ((untilFree && this.reconnectStopped) || quiet || disconnects !== this.disconnects || cut.signal.aborted) {
          return false;
        }
        // ssh's own words are shown here and kept nowhere (#1355).
        const error = failure instanceof TunnelConnectError ? failure.shown() : failure;
        void window.showErrorMessage(
          plainMessage(`q-lint: could not connect to ${process.label} (${address(process.host, process.port)}): ${error instanceof Error ? error.message : String(error)}`),
        );
        return false;
      } finally {
        this.showStatus();
        this.processesView.refresh();
      }
    })().finally(() => {
      this.connecting = undefined;
      this.connectingAs = undefined;
    });
    return this.connecting;
  }

  /// Open a connection to `process` at `target`, through the SSH tunnel it
  /// names, if it names one (#908): the tunnel closes with the connection,
  /// and the connection with the tunnel. `signal` stops the connect.
  private async dial(process: Process, target: Target, signal?: AbortSignal): Promise<QConnection> {
    const connection = await this.dialed(process, target, signal);
    // Asked at each send, so a changed setting or process holds at once (#2470).
    connection.direct = () => this.directOf(connection === this.connection && this.active !== undefined ? this.active : process);
    return connection;
  }

  /// Whether, and why, `process` is evaluated directly (#2470).
  private directOf(process: Process): DirectMode | undefined {
    return directMode(process, this.controls.settings().unwrapped);
  }

  /// Whether, and why, the active process is evaluated directly: what the
  /// status bar says.
  activeDirect(): DirectMode | undefined {
    return this.active === undefined ? undefined : this.directOf(this.active);
  }

  private async dialed(process: Process, target: Target, signal?: AbortSignal): Promise<QConnection> {
    if (process.ssh === undefined) {
      return QConnection.open(target, undefined, signal);
    }
    if (!this.setting(readTunnel).enabled) {
      throw new Error(
        `it is reached through an SSH tunnel via ${process.ssh}, and SSH tunnels are turned off. Set q-lint.connection.sshTunnel.enable to true to turn them on`,
      );
    }
    // Cancelled while ssh opens the forward: stop waiting for it too (#1459).
    const tunnel = await SshTunnel.open({ destination: process.ssh, host: target.host, port: target.port, signal });
    this.tunnels.add(tunnel);
    tunnel.whenClosed(() => this.tunnels.delete(tunnel));
    try {
      const connection = await QConnection.open(
        {
          ...target,
          ...tunnel.endpoint,
          ...(target.tls ? { servername: target.host } : {}),
        },
        undefined,
        signal,
      );
      connection.whenClosed(() => tunnel.close());
      tunnel.whenClosed(() => connection.abort());
      return connection;
    } catch (error) {
      // The socket was the tunnel's loopback end, whose address means
      // nothing to the user, and its closing before the handshake is as
      // likely a forward that reached no q as a refused user (#1355).
      const where = address(target.host, target.port);
      let failure = error;
      if (error instanceof ClosedBeforeHandshake) {
        // What ssh says of a forward that failed can come just after the close.
        await new Promise((resolve) => setTimeout(resolve, 100));
        failure = new TunnelHandshakeError(
          `the connection through the SSH tunnel via ${process.ssh} closed before the handshake: no q process answers at ${where} as ${process.ssh} reaches it, or the user or password was refused`,
          tunnel.said,
        );
      } else if (error instanceof Error) {
        error.message = error.message.split(tunnel.where).join(where);
      }
      tunnel.close();
      throw failure;
    }
  }

  /// A connection of its own to `process`, apart from the active one, with
  /// its stored password and through its tunnel; the caller closes it. No
  /// timeout: a stream's subscription holds it open. A call that should end
  /// goes through `callSeparate`.
  /// Its connect script runs first, as on every connect (#1509).
  /// `abandoned`: whether the caller has given up while it dialled; then it
  /// is closed before its connect script runs, and this throws (#2554).
  /// `signal` gives it up while it connects (#2567).
  async openSeparate(process: Process, abandoned?: () => boolean, signal?: AbortSignal): Promise<QConnection> {
    const connection = await this.dial(process, await this.targetFor(process, signal), signal);
    if (abandoned?.()) {
      connection.abort();
      throw new Error(`given up before ${process.label} connected`);
    }
    const stop = (): void => connection.abort();
    signal?.addEventListener("abort", stop);
    try {
      await this.runConnectScript(connection, process, () => signal?.aborted === true, false, true);
      if (signal?.aborted) {
        throw new Error("cancelled");
      }
    } catch (error) {
      connection.abort();
      throw error;
    } finally {
      signal?.removeEventListener("abort", stop);
    }
    const kept = { connection, process };
    this.separate.add(kept);
    connection.whenClosed(() => this.separate.delete(kept));
    return connection;
  }

  /// Close the connections apart to the processes `which` picks: a setting
  /// that reached them was turned off.
  private closeSeparate(which: (process: Process) => boolean): void {
    for (const { connection, process } of [...this.separate]) {
      if (which(process)) {
        connection.abort();
      }
    }
  }

  /// `use` over a connection of its own to `process` (`openSeparate`),
  /// closed after: Diff Function, Find in Processes and the schema
  /// migration's other side read here. While
  /// `q-lint.query.processTimeout.enable` is on, the process's own timeout
  /// (#1036) holds as it does in `run` and `runApart`: when it passes, the
  /// connection is dropped, the user told, and this throws the timeout.
  async callSeparate<T>(process: Process, use: (connection: QConnection) => Promise<T>, abandoned?: () => boolean): Promise<T> {
    const connection = await this.openSeparate(process, abandoned);
    const enabled = this.setting(readAdmin).processTimeout;
    const timeout = ownTimeout(process, enabled);
    let timedOut = false;
    const disarm = armTimeout(timeout, () => {
      timedOut = true;
      connection.abort();
      void window.showInformationMessage(plainMessage(timeoutDropped(process, timeout, enabled)));
    });
    try {
      return await use(connection);
    } catch (error) {
      throw timedOut ? new Error(`${timedOutError(timeout)} (${timeoutSource(process, enabled)})`) : error;
    } finally {
      disarm();
      void connection.close();
    }
  }

  /// Where and as whom `process` is connected to: its user and stored
  /// password, or what its credential command (#1034) prints, run now and
  /// kept nowhere. Throws why the command gave none.
  private async targetFor(process: Process, signal?: AbortSignal): Promise<Target> {
    if (process.credentialCommand === undefined || !this.setting(readAdmin).credentialCommand) {
      // The label's password is for the address and user saved under it: a
      // connection kept where it was when that was edited (#1443) gets none (#2124).
      const saved = process.server === undefined ? this.processes().find((p) => p.label === process.label) : undefined;
      if (process.user && saved !== undefined && passwordsToForget([process], [saved]).length > 0) {
        throw new Error(`${editedSince(process, saved)} since it was connected, and its password is for that: connect to it again`);
      }
      const password = process.user ? await this.context.secrets.get(this.passwordKey(process)) : undefined;
      return targetOf(process, password);
    }
    // Stopped with the connect it is for: by Disconnect, or a connect elsewhere (#2127).
    const output = await runCredentialCommand(process.credentialCommand, {
      signal,
      cwd: credentialCwd(workspace.isTrusted !== false, workspace.workspaceFolders?.[0]?.uri.fsPath, os.homedir()),
      env: credentialEnv(process),
    });
    const given = parseCredentials(output, process.user);
    if ("problem" in given) {
      throw new Error(`its credential command gave no credentials: ${given.problem}`);
    }
    return { ...targetOf({ ...process, user: undefined }, undefined), user: given.user ?? "", password: given.password };
  }

  /// Set the SSH destination a saved process is reached through (#908), or
  /// clear it. `destination` (from a keybinding or a test) sets it without
  /// asking; `""` or `null` clears it.
  private async setSshTunnel(row?: ProcessArg, destination?: string | null): Promise<void> {
    if (!this.featureOn(this.setting(readTunnel).enabled, "SSH tunnels", "q-lint.connection.sshTunnel.enable")) {
      return;
    }
    const process = await this.chosen(row, "Reach which q process through an SSH tunnel?");
    if (process === undefined) {
      return;
    }
    let given = destination === null ? "" : destination;
    if (typeof given !== "string") {
      given = await window.showInputBox({
        title: `SSH tunnel of ${process.label}`,
        value: process.ssh ?? "",
        prompt: `The jump host q-lint runs \`ssh -N -L\` through to reach ${address(process.host, process.port)}, as you would type it: bastion, me@bastion or me@bastion:2222. ssh uses your agent and ~/.ssh/config, and never asks for a password. Empty: connect directly.`,
        validateInput: (v) => (v.trim() === "" || sshDestination(v) !== undefined ? undefined : "A destination ssh takes: no spaces or quotes, and not starting with -."),
        ignoreFocusOut: true,
      });
      if (given === undefined) {
        return;
      }
    }
    const ssh = given.trim() === "" ? undefined : sshDestination(given);
    if (given.trim() !== "" && ssh === undefined) {
      void window.showErrorMessage(plainMessage(`q-lint: "${given}" is not an SSH destination; the tunnel was not set.`));
      return;
    }
    const now = this.processes();
    if (!now.some((p) => p.label === process.label)) {
      void window.showErrorMessage(plainMessage(`q-lint: "${process.label}" was deleted meanwhile; its tunnel was not set.`));
      return;
    }
    const saved = now.find((p) => p.label === process.label)!;
    const updated = withExtras(saved, { ...saved, ssh });
    // Another tunnel reaches another q: its password was not given for that (#2371).
    if (passwordsToForget([saved], [updated]).length > 0) {
      await this.context.secrets.delete(this.passwordKey(saved));
    }
    await this.save(now.map((p) => (p.label === process.label ? updated : p)));
    void window.showInformationMessage(
      plainMessage(ssh === undefined
        ? `q-lint: ${process.label} is connected to directly from the next connect.`
        : `q-lint: ${process.label} is reached through an SSH tunnel via ${ssh} from the next connect.`),
    );
  }

  /// Reconnect to `process`, whose connection dropped, waiting longer before
  /// each try (`backoffDelay`), until it connects, the tries run out, or the
  /// user connects elsewhere or disconnects (#917).
  private async autoReconnect(dropped: Process): Promise<void> {
    let end = (): void => {};
    const done = new Promise<void>((resolve) => (end = resolve));
    this.reconnectDone = done;
    this.endReconnect = end;
    try {
      await this.tryReconnecting(dropped);
    } finally {
      end();
      if (this.reconnectDone === done) {
        this.reconnectDone = undefined;
        this.endReconnect = undefined;
      }
    }
  }

  private async tryReconnecting(dropped: Process): Promise<void> {
    const run = ++this.reconnectRun;
    // Read before each try: lowered meanwhile, the tries stop there (#1850).
    const attempts = (): number => readHealth((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).reconnectAttempts;
    let process = dropped;
    // Counted on from the reconnects before, while none of them held.
    const carried = this.reconnectTries?.label === dropped.label ? this.reconnectTries.tried : 0;
    this.reconnectTries = undefined;
    let tried = carried;
    for (let attempt = carried + 1; attempt <= attempts(); attempt++) {
      this.reconnecting = { label: process.label, attempt, of: attempts() };
      this.showStatus();
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)));
      if (run !== this.reconnectRun || this.connection !== undefined) {
        return;
      }
      if (attempt > attempts()) {
        break;
      }
      tried = attempt;
      // Each try connects to it as it is now - renamed, tagged, given a
      // connect script meanwhile - and a saved one as saved (#1699).
      const now = this.active ?? process;
      const saved = now.server === undefined ? this.processes().find((p) => p.label === now.label) : now;
      if (saved === undefined) {
        this.reconnecting = undefined;
        this.showStatus();
        return;
      }
      process = saved;
      const connected = await this.open(process, false, true);
      if (run !== this.reconnectRun) {
        return;
      }
      if (connected) {
        this.reconnectTries = { label: process.label, tried: attempt };
        this.reconnecting = undefined;
        this.showStatus();
        void window.showInformationMessage(plainMessage(`q-lint: reconnected to ${process.label}.`));
        return;
      }
    }
    this.reconnecting = undefined;
    this.showStatus();
    void window.showWarningMessage(plainMessage(`q-lint: could not reconnect to ${process.label} after ${tried} ${tried === 1 ? "try" : "tries"}.`));
  }

  /// The discovery server `server` was deleted, or its processes removed:
  /// a process of its is listed nowhere now, so the connection to one is
  /// closed and not reconnected, as deleting a saved process closes its
  /// own (#2565).
  async serverGone(server: string): Promise<void> {
    if (this.active?.server === server && (this.connection !== undefined || this.connecting !== undefined || this.reconnecting !== undefined)) {
      await this.disconnect();
    }
  }

  /// The process `label`, started from here at `port`, is being stopped
  /// (Stop Process): the connection to it closes as one the user closed,
  /// and nothing reconnects to it (#2134).
  async stopping(label: string, port: number): Promise<void> {
    const at = this.active;
    const to = at !== undefined && at.label === label && at.server === undefined && at.ssh === undefined && isLocalHost(at.host) && at.port === port;
    if (to && (this.connection !== undefined || this.connecting !== undefined)) {
      await this.disconnect();
    } else if (this.reconnecting?.label === label) {
      this.stopReconnecting();
    }
  }

  /// Stop an automatic reconnect, if one is under way.
  private stopReconnecting(): void {
    this.reconnectRun++;
    // What waits for it goes on now, not after the backoff it sleeps in.
    this.endReconnect?.();
    if (this.reconnecting !== undefined) {
      // A try dialing now is stopped too, not left to connect (#1705).
      if (this.connection === undefined) {
        this.reconnectStopped = true;
        this.stopConnect?.abort();
      }
      this.reconnecting = undefined;
      this.showStatus();
    }
  }

  /// Start the heartbeat for the connection there is, or stop it when there
  /// is none or `q-lint.connection.heartbeat` is 0.
  private restartHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const configuration = workspace.getConfiguration("q-lint");
    const { heartbeat } = readHealth((key, fallback) => configuration.get(key, fallback));
    const on = heartbeat > 0 && this.activeLabel() !== undefined && !this.disposed;
    // Started again on the same connection - an edit, a retag - a beat
    // still unanswered stays: the next ones are skipped while it is out (#1710).
    if (!on || this.connection !== this.beatOn) {
      this.latency = undefined;
      this.beatSent = undefined;
    }
    this.beatOn = on ? this.connection : undefined;
    if (on) {
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
    }, "the heartbeat");
    if (call === undefined) {
      return;
    }
    // Unanswered for UNANSWERED_MS, it shows so then, and its wait counts
    // up each second - not at the next beat, an interval away (#2131).
    let ticker: ReturnType<typeof setInterval> | undefined;
    const watch = setTimeout(() => {
      if (this.beatSent === sent && !this.disposed) {
        this.showStatus();
        ticker = setInterval(() => this.showStatus(), 1000);
      }
    }, UNANSWERED_MS);
    try {
      const connection = await call;
      if (connection === this.connection) {
        this.latency = { millis: Date.now() - sent, at: Date.now() };
      }
    } catch {
      // Closed meanwhile: whenClosed says so.
    } finally {
      clearTimeout(watch);
      clearInterval(ticker);
      if (this.beatSent === sent) {
        this.beatSent = undefined;
      }
      this.showStatus();
    }
  }

  private async disconnect(): Promise<void> {
    this.disconnects++;
    // One running its connect script, which may never answer (#1505), and
    // the connections apart running theirs (#2567).
    this.opening?.abort();
    const apart = this.stopPreparingApart();
    if (this.reconnecting !== undefined && this.connection === undefined) {
      // A try under way is closed once it opens.
      this.reconnectStopped = true;
      this.stopReconnecting();
      return;
    }
    this.reconnectRun++;
    if (this.connection === undefined && this.connecting === undefined) {
      void window.showInformationMessage(plainMessage(apart.length > 0 ? `q-lint: stopped the connect script of ${apart.join(", ")} on a connection of its own.` : "q-lint: not connected to a q process."));
      return;
    }
    this.reconnectStopped = true;
    this.stopConnect?.abort();
    const connection = this.connection;
    this.connection = undefined;
    // A query running on it was stopped by the user, as Abort stops one:
    // closed at once, not after waiting for its answer, which would be
    // shown and recorded as run (#2556).
    this.aborted = this.running?.started;
    this.running = undefined;
    if (connection?.isBusy) {
      connection.abort();
    } else {
      await connection?.close();
    }
    this.showStatus();
    this.processesView.refresh();
    this.changed.fire("disconnected");
  }

  // --- queries

  private async queryFrom(from: From, serverTypes?: string[], uri?: unknown): Promise<void> {
    const editor = clicked(uri);
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
    const { selection } = editor;
    // The last line of a selection that ends at a line's start is the one before.
    const last = selection.isEmpty ? selection.active.line : selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line - 1 : selection.end.line;
    this.origin = from === "line" || from === "selection" ? { uri: editor.document.uri.toString(), line: last, version: editor.document.version } : undefined;
    try {
      await this.queryCode(code, editor.document.uri, serverTypes);
    } finally {
      this.origin = undefined;
    }
  }

  /// Run `code` from the document `uri` as a query from the editor is run:
  /// on the process the file is bound to, when it has one. A Run code lens
  /// sends its definition here.
  async queryCode(code: string, uri: Uri, serverTypes?: string[]): Promise<void> {
    // A file with a process of its own switches the connection to it.
    const bound = this.controls.binding(uri);
    if (bound !== undefined && bound !== this.activeLabel()) {
      if (this.connection?.isBusy) {
        void window.showInformationMessage(
          plainMessage(`q-lint: a query is still running on ${this.active?.label}; this file's queries go to ${bound}. q-lint: Abort Current Query stops waiting for it.`),
        );
        return;
      }
      if (!(await this.connectTo(bound))) {
        return;
      }
    }
    // A file can name the server types its queries go to on a gateway.
    const document = window.activeTextEditor?.document;
    const named = document !== undefined && document.uri.toString() === uri.toString() ? fileServerTypes(document.getText()) : undefined;
    // Types chosen for a gateway call already made, a history entry, are
    // its types now; a call of any other shape keeps its own, said (#2592).
    const retyped = serverTypes !== undefined && isGatewayCall(code) ? withServerTypes(code, serverTypes) : undefined;
    if (serverTypes !== undefined && isGatewayCall(code) && retyped === undefined) {
      void window.showInformationMessage(plainMessage(`q-lint: this code is a gateway call already, so it goes to the server types it names, not ${serverTypes.join(", ")}.`));
    }
    await this.run(retyped ?? code, undefined, serverTypes ?? named);
  }

  /// `code` as it goes to `process`: through `.gw.syncexec` on a TorQ gateway
  /// (#909), to `serverTypes` or else the process's own; as written to any
  /// other process, or with q-lint.connection.torqGateway.enable off.
  private throughGateway(code: string, process: Process, serverTypes?: string[]): string {
    const types = serverTypes ?? process.gateway;
    // `/ @servertypes none` names no server: the gateway itself (#2588).
    if (process.gateway === undefined || types === undefined || types.length === 0 || isGatewayCall(code) || !this.setting(readGateway).enabled) {
      return code;
    }
    const cut = statements(code);
    return cut.length === 0 ? code : gatewayStatement(cut, types);
  }

  /// `cut`, statements for the active process, as they go to it from a
  /// feature that runs code as Run does - the REPL, a notebook cell, an
  /// agent: through `.gw.syncexec` on a TorQ gateway (#909), to the
  /// process's server types. `plain` when that is a gateway call, which
  /// defers its reply past any lambda of q-lint's, so it goes as plain
  /// strings (#2584).
  gatewayed(cut: string[]): { cut: string[]; plain: boolean } {
    const process = this.active;
    if (process === undefined || cut.length === 0) {
      return { cut, plain: false };
    }
    const sent = this.throughGateway(cut.join("\n"), process);
    return { cut: statements(sent), plain: isGatewayCall(sent) };
  }

  /// Whether Run sends `code` to the active process through `.gw.syncexec`:
  /// it is a TorQ gateway (#909), and `code` not the gateway's own.
  goesThroughGateway(code: string): boolean {
    const process = this.activeProcess();
    return process !== undefined && this.throughGateway(code, process) !== code;
  }

  /// `code` on the active process through `.gw.syncexecj`, its servers'
  /// answers joined by `join` on the gateway, where Run would send it
  /// through `.gw.syncexec`; undefined elsewhere. Copy Value as JSON (#2433).
  gatewayJoinedOnActive(code: string, join: string): string | undefined {
    const types = this.activeProcess()?.gateway;
    return types === undefined || !this.goesThroughGateway(code) ? undefined : gatewayJoined(statements(code), types, join);
  }

  /// Why `feature`, which runs `code` inside a lambda of q-lint's, refuses
  /// it on the active process: a TorQ gateway Run would send it through
  /// `.gw.syncexec` to, whose deferred reply never reaches that lambda
  /// (#2584), so it would run on the gateway itself instead. Undefined
  /// elsewhere, and for the gateway's own code.
  gatewayRefusal(feature: string, code: string): string | undefined {
    const process = this.activeProcess();
    if (process === undefined || !this.goesThroughGateway(code)) {
      return undefined;
    }
    return `q-lint: ${feature} runs the code in q-lint's own q, which on the TorQ gateway ${process.label} would run it on the gateway itself, not through .gw.syncexec on its servers as Run Query does. Use Run Query there.`;
  }

  /// Mark a saved process as a TorQ gateway with the server types its
  /// queries go to, or unmark it. `types` (from a keybinding or a test) sets
  /// them without asking; `""`, `[]` or `null` unmarks it.
  private async setGateway(row?: ProcessArg, types?: string | string[] | null): Promise<void> {
    if (!this.featureOn(this.setting(readGateway).enabled, "TorQ gateways", "q-lint.connection.torqGateway.enable")) {
      return;
    }
    const process = await this.chosen(row, "Mark which q process as a TorQ gateway?");
    if (process === undefined) {
      return;
    }
    let given: string | string[] | undefined = types === null ? "" : types;
    if (given === undefined) {
      given = await window.showInputBox({
        title: `TorQ gateway: server types of ${process.label}`,
        value: (process.gateway ?? []).join(" "),
        prompt: "The server types a query goes to through .gw.syncexec, unless the file or the query names others: rdb hdb. Empty: not a gateway.",
        validateInput: (v) => (v.trim() === "" || serverTypes(v) !== undefined ? undefined : "Server types are q names: rdb hdb."),
        ignoreFocusOut: true,
      });
      if (given === undefined) {
        return;
      }
    }
    const gateway = serverTypes(given);
    const now = this.processes();
    if (!now.some((p) => p.label === process.label)) {
      void window.showErrorMessage(plainMessage(`q-lint: "${process.label}" was deleted meanwhile; it was not changed.`));
      return;
    }
    await this.save(now.map((p) => (p.label === process.label ? withExtras(p, { ...p, gateway }) : p)));
    if (this.active?.label === process.label && this.active.server === undefined) {
      this.active = withExtras(this.active, { ...this.active, gateway });
    }
    void window.showInformationMessage(
      plainMessage(gateway === undefined
        ? `q-lint: ${process.label} is no TorQ gateway; its queries go as written.`
        : `q-lint: queries to ${process.label} go through .gw.syncexec to ${gateway.join(", ")}.`),
    );
  }

  /// Set how a saved process's code is evaluated (#2470): `direct`, as
  /// plain strings, `wrapped`, in q-lint's lambda, or neither, following
  /// q-lint.query.unwrapped. `mode` (from a keybinding or a test) sets it
  /// without asking; `""` or `null` is neither.
  private async setEvaluation(row?: ProcessArg, mode?: string | null): Promise<void> {
    const process = await this.chosen(row, "Set the evaluation of which q process?");
    if (process === undefined) {
      return;
    }
    let chosen: Evaluation | undefined;
    if (mode === undefined) {
      const global = this.controls.settings().unwrapped ? "direct" : "wrapped";
      const items = [
        { label: "Follow q-lint.query.unwrapped", description: `now ${global}`, value: undefined },
        { label: "Wrapped", description: "q-lint's lambda runs the code: backtrace, reval, every feature", value: "wrapped" as const },
        { label: "Direct", description: "plain strings only, for a process that refuses a lambda", value: "direct" as const },
      ];
      const picked = await window.showQuickPick(
        items.map((i) => ({ ...i, picked: i.value === process.evaluation })),
        { title: `Evaluation of ${process.label}`, placeHolder: `Now: ${process.evaluation ?? `following q-lint.query.unwrapped (${global})`}` },
      );
      if (picked === undefined) {
        return;
      }
      chosen = picked.value;
    } else {
      chosen = evaluationOf(mode);
      // Only "" and null mean neither: anything else unknown, a typo in a
      // keybinding, is refused rather than taken as that (#2487).
      if (chosen === undefined && mode !== "" && mode !== null) {
        void window.showErrorMessage(plainMessage(`q-lint: ${JSON.stringify(mode) ?? String(mode)} is no evaluation: give "direct", "wrapped", or "" (or null) to follow q-lint.query.unwrapped. ${process.label} was not changed.`));
        return;
      }
    }
    const now = this.processes();
    if (!now.some((p) => p.label === process.label)) {
      void window.showErrorMessage(plainMessage(`q-lint: "${process.label}" was deleted meanwhile; it was not changed.`));
      return;
    }
    const set = (p: Process): Process => {
      const { evaluation: _old, ...rest } = p;
      void _old;
      return withExtras({ ...rest }, { ...rest, ...(chosen !== undefined ? { evaluation: chosen } : {}) });
    };
    await this.save(now.map((p) => (p.label === process.label ? set(p) : p)));
    if (this.active?.label === process.label && this.active.server === undefined) {
      this.active = set(this.active);
      // What is read of it depends on its evaluation (#2495).
      this.changed.fire("edited");
    }
    this.showStatus();
    const effective = this.directOf(set(process)) === undefined ? "wrapped" : "direct";
    void window.showInformationMessage(
      plainMessage(
        chosen === undefined
          ? `q-lint: ${process.label} follows q-lint.query.unwrapped: its code is evaluated ${effective} now.`
          : chosen === "direct"
            ? `q-lint: ${process.label}'s code is sent as plain strings (direct evaluation); features that need q-lint's lambda are refused there.`
            : `q-lint: ${process.label}'s code runs in q-lint's lambda (wrapped evaluation), whatever q-lint.query.unwrapped says.`,
      ),
    );
  }

  /// Query the selection, or the current line, on the connected gateway with
  /// server types asked for (or `types`, from a keybinding).
  private async queryGatewayWith(types?: string | string[]): Promise<void> {
    if (!this.featureOn(this.setting(readGateway).enabled, "TorQ gateways", "q-lint.connection.torqGateway.enable")) {
      return;
    }
    const process = this.activeProcess();
    if (process?.gateway === undefined) {
      void window.showInformationMessage(
        plainMessage(`q-lint: ${process === undefined ? "not connected to a q process" : `${process.label} is not marked as a TorQ gateway`}. Set Gateway Server Types marks one.`),
      );
      return;
    }
    // The file's code goes to the process it is bound to: not the gateway
    // asked about, it would run there without the types (#2370).
    const file = window.activeTextEditor?.document.uri;
    const bound = file === undefined ? undefined : this.fileBinding(file);
    if (bound !== undefined && bound !== process.label) {
      void window.showInformationMessage(
        plainMessage(`q-lint: this file's queries go to ${bound}, not the gateway ${process.label}; nothing was run. Clear or change the file's connection to query ${process.label} on server types.`),
      );
      return;
    }
    let given = types;
    if (given === undefined) {
      const document = window.activeTextEditor?.document;
      given = await window.showInputBox({
        title: `Query ${process.label} on server types`,
        value: ((document !== undefined ? fileServerTypes(document.getText()) : undefined) ?? process.gateway).join(" "),
        prompt: "The server types this query goes to through .gw.syncexec: rdb hdb.",
        validateInput: (v) => (serverTypes(v) !== undefined ? undefined : "Server types are q names: rdb hdb."),
      });
      if (given === undefined) {
        return;
      }
    }
    const chosen = serverTypes(given);
    if (chosen === undefined) {
      void window.showErrorMessage("q-lint: no server types given; nothing was run.");
      return;
    }
    await this.queryFrom("selection", chosen);
  }

  /// `code` with its `{{name}}` placeholders given the values the user
  /// types, each box starting from the value given last (#911); undefined
  /// when the user pressed Escape, and nothing is run.
  async filledIn(code: string): Promise<string | undefined> {
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
    // Read again: another window may have remembered values while these
    // boxes were open, and they are kept (#2527).
    await this.context.globalState.update(PLACEHOLDER_VALUES_KEY, remembered(this.context.globalState.get<unknown>(PLACEHOLDER_VALUES_KEY), values));
    return substitute(code, values);
  }

  /// The active connection and its process, connecting first if there is
  /// none; undefined when none was connected or a query is still running.
  /// `seconds` (0: none) bound the wait for a connect under way or a
  /// background read, and Abort ends it (#2126), as `signal` does for its
  /// caller's wait alone (#2560); `waited` is how long it was.
  private async ready(seconds = 0, source = "q-lint.query.timeout", signal?: AbortSignal): Promise<{ connection: QConnection; process: Process; waited: number } | undefined> {
    const waiter = { started: 0, stop: new AbortController() };
    const stop = (): void => waiter.stop.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted === true) {
      stop();
    }
    let disarm = (): void => {};
    let timedOut = false;
    // Whether `what` settled, rather than the wait being stopped.
    const wait = async (what: Promise<unknown> | undefined): Promise<boolean> => {
      if (what === undefined) {
        return true;
      }
      if (!this.waiters.has(waiter)) {
        waiter.started = Date.now();
        this.waiters.add(waiter);
        disarm = armTimeout(seconds, () => {
          timedOut = true;
          waiter.stop.abort();
        });
        this.showStatus();
      }
      const stopped = waiter.stop.signal.aborted
        ? Promise.resolve(false as const)
        : new Promise<false>((resolve) => waiter.stop.signal.addEventListener("abort", () => resolve(false), { once: true }));
      const settled = await Promise.race([what.then(() => true, () => true), stopped]);
      if (!settled) {
        const to = this.active?.label ?? this.connectingAs?.label ?? this.reconnecting?.label ?? "the process";
        void window.showInformationMessage(
          plainMessage(timedOut
            ? `q-lint: the query ${timedOutError(seconds)} (${source}) waiting to be sent to ${to}; it was not run.`
            : `q-lint: stopped the query waiting to be sent to ${to}; it was not run.`),
        );
      }
      return settled;
    };
    try {
      const ready = await this.readyAfter(wait);
      return ready === undefined ? undefined : { ...ready, waited: waiter.started === 0 ? 0 : Date.now() - waiter.started };
    } finally {
      disarm();
      signal?.removeEventListener("abort", stop);
      if (this.waiters.delete(waiter)) {
        this.showStatus();
      }
    }
  }

  private async readyAfter(wait: (what: Promise<unknown> | undefined) => Promise<boolean>): Promise<{ connection: QConnection; process: Process } | undefined> {
    // A reconnect still under way (after an abort, or an automatic one
    // between its tries, #2132) is waited for, not replaced by asking which
    // process to connect to.
    if (this.connection === undefined && this.reconnecting !== undefined && !(await wait(this.reconnectDone))) {
      return undefined;
    }
    if (this.connection === undefined && this.connecting !== undefined && !(await wait(this.connecting))) {
      return undefined;
    }
    if (this.connection === undefined && !(await this.connectTo())) {
      return undefined;
    }
    const before = this.connection;
    if (!(await wait(this.borrowed))) {
      return undefined;
    }
    const connection = this.connection;
    const process = this.active;
    if (connection !== before && before !== undefined) {
      // Closed while the explorer's read was out: by Abort, which stopped
      // that read, or by the process.
      void window.showInformationMessage(
        plainMessage(`q-lint: the connection to ${process?.label ?? "the process"} closed before the query was sent; it was not run.`),
      );
      return undefined;
    }
    if (connection === undefined || process === undefined) {
      return undefined;
    }
    if (connection.isBusy) {
      void window.showInformationMessage(
        plainMessage(`q-lint: a query is still running on ${process.label}. q-lint: Abort Current Query stops waiting for it.`),
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
  /// With `expect`, the label of the process a question asked about, it
  /// throws `movedFrom` instead of running on any other (#1081). `signal`
  /// stops this call's wait to be sent, and nothing else's (#2560). With
  /// `lambda`, for a feature that needs q-lint's lambda, a direct
  /// connection is refused before the guard asks: nothing would be sent.
  async runOnActive<T>(
    code: GuardCode,
    query: (connection: QConnection) => Promise<T>,
    guard: "ask" | "refuse" = "ask",
    expect?: string,
    signal?: AbortSignal,
    lambda = false,
  ): Promise<{ process: string; value: T } | undefined> {
    // Checked before `ready` would connect and before the guard asks: no
    // question about a process nothing will be sent to. `stillReady` keeps
    // it the same connection after.
    if (expect !== undefined && this.activeLabel() !== expect) {
      throw movedFrom(expect);
    }
    const asked = this.active ?? this.connectingAs;
    const first = await this.ready(ownTimeout(asked, this.setting(readAdmin).processTimeout), timeoutSource(asked, this.setting(readAdmin).processTimeout), signal);
    if (first === undefined) {
      return undefined;
    }
    const { waited } = first;
    let ready: { connection: QConnection; process: Process } | undefined = first;
    if (expect !== undefined && ready.process.label !== expect) {
      throw movedFrom(expect);
    }
    // Refused before the guard asks about a change that cannot be sent (#2485).
    const direct = lambda ? ready.connection.direct() : undefined;
    if (direct !== undefined) {
      throw new DirectRefused(directRefusal(direct));
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
    if (this.overtaken(ready)) {
      return undefined;
    }
    const started = Date.now();
    this.running = { code: guardText(code), started };
    this.showStatus();
    // The process's own timeout (#1036), while it is on, as in `run`: the
    // connection is dropped as Abort drops it, and the user told.
    // `q-lint.query.timeout` stays a timeout for queries run from the editor.
    const enabled = this.setting(readAdmin).processTimeout;
    const timeout = ownTimeout(ready.process, enabled);
    let timedOut = false;
    // What is left of it after waiting to be sent.
    const expire = (): void => {
      if (this.running?.started === started) {
        timedOut = true;
        void this.abort(timeout, timeoutSource(ready?.process, enabled));
      }
    };
    let disarm = armTimeout(left(timeout, waited), expire);
    try {
      const backstopped = this.backstop(ready.connection, ready.process, code);
      let value: T | undefined;
      // A query that throws `reval`'s refusal (`QConnection.guarded`) is
      // asked about as one that answers it; declined, it throws it.
      let thrown: { error: unknown } | undefined;
      try {
        value = await query(ready.connection);
      } catch (error) {
        if (!backstopped || ready.connection.refused === undefined) {
          throw error;
        }
        thrown = { error };
      } finally {
        // Back to evaluating as it did, whatever the query threw.
        if (backstopped) {
          ready.connection.readOnly = false;
        }
      }
      const refused = backstopped ? this.backstopped(ready.connection, ready.process) : undefined;
      if (refused !== undefined) {
        if (guard === "refuse") {
          throw new Error(refusalReason(ready.process.label, refused));
        }
        // Not timed while the user is asked (#2559).
        disarm();
        if (await this.refusedAnyway(ready.process, refused)) {
          if (!ready.connection.isOpen || ready.connection.isBusy) {
            throw new Error(`Not run again: the connection to ${ready.process.label} closed or became busy while you were asked.`);
          }
          disarm = armTimeout(timeout, expire);
          value = await query(ready.connection);
          thrown = undefined;
        }
      }
      if (thrown !== undefined) {
        throw thrown.error;
      }
      this.answeredOn = ready.connection;
      return { process: ready.process.label, value: value as T };
    } catch (error) {
      if (timedOut) {
        throw new Stopped(`${timedOutError(timeout)} (${timeoutSource(ready.process, enabled)})`, "timeout");
      }
      throw this.aborted === started ? new Stopped(error instanceof Error ? error.message : String(error), "aborted") : error;
    } finally {
      disarm();
      if (this.aborted === started) {
        this.aborted = undefined;
      }
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
      void window.showInformationMessage(plainMessage(`q-lint: the connection to ${ready.process.label} closed while you were asked; nothing was run.`));
      return undefined;
    }
    if (ready.connection.isBusy) {
      void window.showInformationMessage(plainMessage(`q-lint: a query started on ${ready.process.label} while you were asked; nothing was run.`));
      return undefined;
    }
    return ready;
  }

  /// Whether a call that asked `ready` in the same turn has sent its query
  /// since: both pass its check, made before either sends (#1353). Says so,
  /// as `ready` does of a query it finds running.
  private overtaken(ready: { connection: QConnection; process: Process }): boolean {
    if (!ready.connection.isBusy) {
      return false;
    }
    void window.showInformationMessage(
      plainMessage(`q-lint: a query is still running on ${ready.process.label}. q-lint: Abort Current Query stops waiting for it.`),
    );
    return true;
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

  /// Run `code` from the document `uri` as Query Current Block runs it:
  /// its placeholders asked for, on the process the file is bound to.
  /// Smart Send's query target (#957).
  async queryFilledIn(code: string, uri: Uri): Promise<void> {
    const filled = await this.filledIn(code);
    if (filled !== undefined) {
      await this.queryCode(filled, uri);
    }
  }

  /// Send `code` from the document `uri` to the q terminal, starting one if
  /// none is open: Smart Send's terminal target (#957).
  sendToTerminal(code: string, uri: Uri): Promise<void> {
    return this.terminals?.sendCode(code, uri) ?? Promise.resolve();
  }

  /// Hear each async message the active connection's process sends, with
  /// that process, until the returned disposable is disposed (#960).
  onAsyncMessage(listener: (message: Buffer, process: Process) => void): Disposable {
    this.asyncListeners.add(listener);
    return { dispose: () => void this.asyncListeners.delete(listener) };
  }

  /// Run `code` as a query from the editor is run, its placeholders asked
  /// for first: a saved query (#912).
  /// `saved`: the saved query's name, whose look its result keeps (#1015).
  async runFilledIn(code: string, saved?: string): Promise<void> {
    const filled = await this.filledIn(code);
    if (filled !== undefined) {
      this.modes.expectSaved(saved, filled);
      try {
        await this.run(filled);
      } finally {
        this.modes.expectSaved(undefined);
      }
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
  /// timeout); `signal` stops waiting. On a TorQ gateway it goes through
  /// `.gw.syncexec` to the process's server types, as `run` sends it. Throws
  /// why there is no answer. The caller asks the read-only guard first.
  /// `whole`: every row and the whole text, whatever the limits - a
  /// scheduled export writes the result, not its first page (#1613).
  /// `unattended`: run from a timer - a tile's refresh, a schedule - so the
  /// connect script asks nobody and its failure is thrown (#1618).
  /// `serverTypes`: a gateway's, the file's `/ @servertypes` (#2363).
  async runApart(process: Process, code: string, signal?: AbortSignal, options: { whole?: boolean; unattended?: boolean; serverTypes?: string[] } = {}): Promise<GridAnswer> {
    const commanded = process.credentialCommand !== undefined && this.setting(readAdmin).credentialCommand;
    if (!commanded && process.user && process.server !== undefined && (await this.context.secrets.get(this.passwordKey(process))) === undefined) {
      throw new Error(`no password is stored for ${process.user}: connect to ${process.label} once to give it`);
    }
    // Through its tunnel, as any connect to it is (#1070). Cancelled while
    // it opens, nothing was sent, and the error says so (#1926).
    const connection = await (async () => this.dial(process, await this.targetFor(process, signal), signal))().catch((error: unknown) => {
      throw signal?.aborted && error instanceof Error ? new NotSent(error.message) : error;
    });
    const stop = (): void => connection.abort();
    signal?.addEventListener("abort", stop);
    const controls = this.controls.settings();
    const timeout = effectiveTimeout(process, controls.timeout, this.setting(readAdmin).processTimeout);
    let timedOut = false;
    const expire = (): void => {
      timedOut = true;
      connection.abort();
    };
    let disarm = armTimeout(timeout, expire);
    try {
      await this.runConnectScript(connection, process, undefined, options.unattended === true);
      const configuration = workspace.getConfiguration("q-lint");
      const settings = readLive((key, fallback) => configuration.get(key, fallback));
      const unlimited = this.controls.unlimited || options.whole === true;
      const { consoleSize, gridLimit } = limits(settings, unlimited);
      // On a TorQ gateway, through `.gw.syncexec`, as `run` sends it (#1230).
      const sent = this.throughGateway(code, process, options.serverTypes);
      const cut = statements(sent);
      // A gateway call defers its reply, so it goes as plain strings (#2584).
      if (connection.isDirect || isGatewayCall(sent)) {
        this.sayNoReval(connection, process);
        return await runUnwrapped(connection, cut, { size: consoleSize, limit: gridLimit, unlimited, grid: true });
      }
      // Under `reval` where that is the guard's backstop; a refusal is
      // asked about, or thrown from a timer (#1618).
      const backstopped = this.backstop(connection, process, code);
      const answer = await connection.queryGrid(cut, consoleSize, gridLimit);
      const refused = backstopped ? this.backstopped(connection, process) : undefined;
      if (refused === undefined) {
        return answer;
      }
      if (options.unattended === true) {
        throw new Error(refusalReason(process.label, refused));
      }
      // The user's time to answer is not the query's (#2559).
      disarm();
      if (!(await this.refusedAnyway(process, refused))) {
        return answer;
      }
      disarm = armTimeout(timeout, expire);
      return await connection.queryGrid(cut, consoleSize, gridLimit);
    } catch (error) {
      throw timedOut ? new Error(timedOutError(timeout)) : signal?.aborted ? new Error("cancelled") : error;
    } finally {
      disarm();
      signal?.removeEventListener("abort", stop);
      void connection.close();
    }
  }

  /// Show `payload` in the result panel, as a grid when the query mode is
  /// the console, under `label`: Query a Tag's merged table.
  /// `mode`: shown as that, whatever the query mode: `.qlint.plot`'s chart
  /// (#960).
  showGrid(label: string, code: string, payload: GridPayload, millis: number, mode?: "grid" | "chart", merged?: boolean): void {
    const configuration = workspace.getConfiguration("q-lint");
    const settings = readLive((key, fallback) => configuration.get(key, fallback));
    this.modes.show(
      { process: label, code, millis, answer: { ok: true, type: 98, text: [], grid: payload }, ...(merged ? { merged } : {}) },
      { ...settings, mode: mode ?? (settings.mode === "console" ? "grid" : settings.mode) },
    );
  }

  /// Watch Query (#914): run `code` (one given, or the editor's selection
  /// or statement at the cursor) on the active connection now and then
  /// every `every` seconds (one given, or asked for), refreshing its result
  /// in place, until stopped, disconnected, or connected elsewhere. A run
  /// due while a query is out is skipped. The read-only guard asks once, at
  /// the start, as does a guarded or production process; one it would ask
  /// later, the process guarded meanwhile, stops the watch.
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
    // Code from the editor goes to a gateway's servers as Run Query sends
    // it: on the types the file names (#2368).
    const document = typeof given === "string" ? undefined : window.activeTextEditor?.document;
    const serverTypes = document === undefined ? undefined : fileServerTypes(document.getText());
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
    // The editor's code goes to its file's process (#2444).
    if (typeof given !== "string" && !(await this.toFileBinding(window.activeTextEditor?.document.uri))) {
      return;
    }
    const ready = await this.ready();
    if (ready === undefined) {
      return;
    }
    const { process } = ready;
    const write = this.guardRefuses(code, [process]) !== undefined;
    if (!(await this.guardAllows(code, [process]))) {
      return;
    }
    const tags = guardedBy(process, this.setting(readGuard));
    if (tags.length > 0 || isProduction(process)) {
      const yes = "Watch";
      const asked = await window.showWarningMessage(
        plainMessage(`Watch the query on ${process.label}?`),
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
      void window.showInformationMessage(plainMessage(`q-lint: the connection moved from ${process.label} while you were asked; nothing is watched.`));
      return;
    }
    // Turned off while it asked: stopWatching had nothing to stop (#1451).
    if (!this.setting(readWatch).enabled) {
      return;
    }
    // One watched before is replaced; with none, nothing is said (#1708).
    if (this.watching !== undefined) {
      this.stopWatching();
    }
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
      asked: { write, tagged: tags.length > 0 || isProduction(process) },
      ...(serverTypes !== undefined ? { serverTypes } : {}),
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
    // A question the start did not ask, because the process was not guarded
    // then - the guard's tags changed, or the process was retagged - stops
    // the watch rather than sending it unasked (#1847).
    const now = this.activeProcess();
    const process = now === undefined || now.server !== undefined ? now : (this.processes().find((p) => p.label === now.label) ?? now);
    if (process !== undefined) {
      const write = !watched.asked.write && this.guardRefuses(watched.code, [process]) !== undefined;
      const tagged = !watched.asked.tagged && (guardedBy(process, this.setting(readGuard)).length > 0 || isProduction(process));
      if (write || tagged) {
        this.stopWatching(`${watched.label} is now ${write ? "read-only" : "guarded"} (q-lint.processes.readOnlyGuard); Watch Query again to be asked`);
        return;
      }
    }
    if (this.connection?.isBusy || this.borrowed !== undefined) {
      return;
    }
    watched.running = true;
    const first = watched.runs === 0;
    watched.runs++;
    watched.status.text = watchText(iconsEscaped(watched.label), watched.every, watched.runs);
    try {
      await this.run(watched.code, first ? "watch" : "watched", watched.serverTypes);
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
      void window.showInformationMessage(plainMessage(`q-lint: stopped watching the query: ${why}.`));
    }
  }

  /// Run `code` on the active connection, connecting first if there is none.
  /// The process explorer's Preview runs here too. A watched query's first
  /// run (`watch`) asks nothing more, and its later ones (`watched`) are
  /// not recorded, and refresh the result in place. On a TorQ gateway the
  /// code goes through `.gw.syncexec` to `serverTypes` (#909); the guard
  /// reads it as written. `mode` shows the result as a grid or a chart
  /// whatever q-lint.query.mode is: a data file opened in the grid (#962).
  async run(written: string, as?: "watch" | "watched", serverTypes?: string[], mode?: QueryMode): Promise<void> {
    const origin = as === undefined ? this.origin : undefined;
    this.origin = undefined;
    const asked = this.active ?? this.connectingAs;
    const askedOn = this.setting(readAdmin).processTimeout;
    const first = await this.ready(effectiveTimeout(asked, this.controls.settings().timeout, askedOn), timeoutSource(asked, askedOn));
    if (first === undefined) {
      return;
    }
    const { waited } = first;
    let ready: { connection: QConnection; process: Process } | undefined = first;
    if (as === undefined && this.guardRefuses(written, [ready.process]) !== undefined) {
      if (!(await this.guardAllows(written, [ready.process]))) {
        return;
      }
      ready = this.stillReady(ready);
      if (ready === undefined) {
        return;
      }
    }
    if (this.overtaken(ready)) {
      return;
    }
    const { connection, process } = ready;
    const code = this.throughGateway(written, process, serverTypes);
    const configuration = workspace.getConfiguration("q-lint");
    const settings = { ...readLive((key, fallback) => configuration.get(key, fallback)), ...(mode !== undefined ? { mode } : {}) };
    const controls = this.controls.settings();
    const unlimited = this.controls.unlimited;
    const { consoleSize, gridLimit } = limits(settings, unlimited);
    // A process's own timeout (#1036) over q-lint.query.timeout.
    const timeoutOn = this.setting(readAdmin).processTimeout;
    const timeout = effectiveTimeout(process, controls.timeout, timeoutOn);
    const started = Date.now();
    this.running = { code, started };
    this.showStatus();
    // A query still running at the timeout is aborted as Abort does; the
    // time it waited to be sent counts (#2126).
    const expire = (): void => {
      if (this.running?.started === started) {
        this.timedOut = started;
        void this.abort(timeout, timeoutSource(process, timeoutOn));
      }
    };
    let disarm = armTimeout(left(timeout, waited), expire);
    let entry: HistoryEntry;
    try {
      // Grid and chart modes ask for the rows too; a value that is not
      // tabular comes back as console mode's text.
      const cut = statements(code);
      // Paging (#922) leaves a cut result on the process: never in
      // direct evaluation, which sends nothing of ours, nor on production or
      // a process the read-only guard (#918) guards, as holding assigns.
      const readOnly = isProduction(process) || guardedBy(process, this.setting(readGuard)).length > 0;
      // A gateway call defers its reply past any lambda of ours, so it goes
      // as plain strings too (#2584).
      const direct = connection.isDirect || isGatewayCall(code);
      const hold = !direct && settings.mode !== "console" && this.modes.wantsHold(readOnly);
      // This result's own, so a page is of it and no other (#2128).
      const token = hold ? randomBytes(16).toString("hex") : undefined;
      const send = async () =>
        direct
          ? await runUnwrapped(connection, cut, { size: consoleSize, limit: gridLimit, unlimited, grid: settings.mode !== "console" })
          : settings.mode !== "console"
            ? await connection.queryGrid(cut, consoleSize, gridLimit, this.modes.wantsTree(), token)
            : unlimited
              ? await connection.trapped(UNLIMITED, UNLIMITED_READ_ONLY, readUnlimited, cut, consoleSize)
              : await connection.query(cut, consoleSize);
      // Direct evaluation sends the text alone, so nothing of ours can put
      // it under `reval`: the guard alone holds there (`backstop` says so).
      const backstopped = this.backstop(connection, process, written);
      let answer: Awaited<ReturnType<typeof send>>;
      try {
        answer = await send();
      } finally {
        if (backstopped) {
          connection.readOnly = false;
        }
      }
      const refused = backstopped ? this.backstopped(connection, process) : undefined;
      // A watched query's later runs ask nothing: its error says why.
      // Not timed while the user is asked; the query sent again has a
      // timeout of its own (#2559).
      if (refused !== undefined && as !== "watched") {
        disarm();
      }
      if (refused !== undefined && as !== "watched" && (await this.refusedAnyway(process, refused))) {
        if (connection.isOpen && !connection.isBusy && this.connection === connection) {
          disarm = armTimeout(timeout, expire);
          answer = await send();
        } else {
          void window.showInformationMessage(plainMessage(`q-lint: the connection to ${process.label} closed or became busy while you were asked; nothing more was run.`));
        }
      }
      const millis = Date.now() - started;
      // Answered: the connection holds, and a drop after starts the tries again (#2129).
      this.answeredOn = connection;
      if (!answer.ok && code === written && !direct) {
        this.lastFailure = { process: process.label, code, error: answer.error, trace: answer.trace };
      }
      entry = {
        process: process.label,
        code,
        at: new Date(started).toISOString(),
        millis,
        outcome: answer.ok ? "ok" : "error",
        ...(answer.ok ? {} : { error: answer.error }),
      };
      if (origin !== undefined) {
        this.answered.fire({ process: process.label, answer, millis, ...origin });
      }
      if (!this.modes.show({ process: process.label, code, answer, millis, held: hold, ...(token !== undefined ? { token } : {}) }, settings, as === "watched")) {
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
        error: timedOut ? timedOutError(timeout) : aborted ? "aborted" : message,
      };
      this.show([`# ${process.label} - ${timedOut ? timedOutError(timeout) : aborted ? "aborted" : "failed"}: ${message}`], false);
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
  /// Either of those may pass, so the result stays held (#1634).
  private async pageHeld(label: string, offset: number, count: number, token: string | undefined): Promise<GridPage | PageLater | string> {
    if (token === undefined) {
      return "the process holds no rows of this result";
    }
    const connection = this.connection;
    if (connection === undefined || this.activeLabel() !== label) {
      return { later: "it is not the connected process now; connect to it again, then scroll again" };
    }
    if (connection.isBusy) {
      return { later: "a query is running on it; scroll again once it ends" };
    }
    // Nothing is sent while it is evaluated directly, and the process keeps
    // the result: later, not gone (#2566).
    if (connection.isDirect) {
      return { later: "it is evaluated directly now, and paging needs q-lint's lambda; turn direct evaluation off, then scroll again" };
    }
    return readPage(await connection.call(PAGE, token, offset, count));
  }

  /// The saved query `from` was renamed `to`, or deleted: the results it
  /// gave follow it (#1413).
  savedRenamed(from: string, to: string | undefined): void {
    this.modes.savedRenamed(from, to);
    this.tiles.fire();
  }

  /// Dashboard tiles were changed in the workspace state: an open dashboard
  /// draws them again (#2550).
  tilesChanged(): void {
    this.tiles.fire();
  }

  /// The result the panel shows, with the process and code it came from.
  resultOnShow(): { process: string; code: string; payload: GridPayload; run: number; merged?: boolean } | undefined {
    return this.modes.current();
  }

  /// Run a query on the process a result came from - a drill-down query
  /// (#927), a wrangle step (#961), a cell edit (#964) - as a query from the
  /// editor is run, read by the guard, after asking when it is a production
  /// one (unless `askProduction` is false: the caller asked already).
  /// `serverTypes`: on a gateway, those the result came from (#2437).
  async runOnProcess(code: string, label: string, options: { what?: string; mode?: QueryMode; askProduction?: boolean; serverTypes?: string[] } = {}): Promise<void> {
    // The connected process when it is the one named - a saved process may
    // share a discovered one's label (#1711) - and `named` also finds a
    // discovered or shared process (#1425).
    const process = this.activeLabel() === label ? this.active : this.named(label) ?? (this.active?.label === label ? this.active : undefined);
    if (process !== undefined && isProduction(process) && options.askProduction !== false) {
      const yes = "Run";
      const sure = await window.showWarningMessage(
        plainMessage(`${process.label} is a production process (tagged ${process.tags.join(", ")}). Run this ${options.what ?? "drill-down query"} there?\n\n${code}`),
        { modal: true },
        yes,
      );
      if (sure !== yes) {
        return;
      }
    }
    if (this.activeLabel() !== label) {
      if (this.connection?.isBusy) {
        void window.showInformationMessage(plainMessage(`q-lint: a query is still running on ${this.active?.label}; the ${options.what ?? "drill-down query"} goes to ${label}.`));
        return;
      }
      if (!(await this.connectTo(label))) {
        return;
      }
    }
    await this.run(code, undefined, options.serverTypes, options.mode);
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
      void window.showInformationMessage(plainMessage(text));
    } else {
      void window.showWarningMessage(plainMessage(text));
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
  async abort(timedOut?: number, source = "q-lint.query.timeout"): Promise<void> {
    // Queries not sent yet are stopped (#2126); a background read they
    // wait behind is stopped as well, as before, and a connect left to run.
    if (timedOut === undefined && this.running === undefined && this.waiters.size > 0) {
      for (const waiter of [...this.waiters]) {
        waiter.stop.abort();
      }
      if (this.connection?.isBusy !== true) {
        return;
      }
    }
    const connection = this.connection;
    const process = this.active;
    if (connection === undefined || process === undefined || !connection.isBusy) {
      const stopped = timedOut === undefined ? this.stopPreparingApart() : [];
      void window.showInformationMessage(plainMessage(stopped.length > 0 ? `q-lint: stopped the connect script of ${stopped.join(", ")} on a connection of its own.` : "q-lint: no query is running."));
      return;
    }
    this.aborted = this.running?.started;
    this.running = undefined;
    this.connection = undefined;
    connection.abort();
    this.showStatus();
    // Said now: the reconnect may fail, and fires nothing then (#1702).
    this.processesView.refresh();
    this.changed.fire("disconnected");
    // Not awaited: q runs one message at a time, so the new connection's
    // handshake waits until the process has finished the query it was left
    // with, and the command should not wait with it.
    // To the process as saved, as an auto-reconnect is (#1699): one edited
    // to another address or user since it was connected has its password
    // stored for that one, never to be sent to where the connection was (#2124).
    const again = process.server === undefined ? (this.processes().find((p) => p.label === process.label) ?? process) : process;
    void this.open(again, true).then((connected) => {
      if (connected) {
        void window.showInformationMessage(plainMessage(`q-lint: reconnected to ${again.label}.`));
      }
    });
    void window.showInformationMessage(
      plainMessage(this.aborted === undefined && timedOut === undefined
        ? `q-lint: stopped ${this.borrowed !== undefined ? this.borrower : "a background read"} of ${process.label}, the only call running. q-lint reconnects once ${process.label} is free.`
        : `q-lint: ${timedOut === undefined ? "stopped waiting for the query" : `the query ${timedOutError(timedOut)} (${source}), and was aborted`}. ${process.label} may still be running it; q-lint reconnects once it is free.`),
    );
  }

  async record(entry: HistoryEntry): Promise<void> {
    // A Clear stamped by a clock that was ahead would drop this query at
    // the next merge, and every one after it (#1882).
    const cleared = clearedStamp(this.historyCleared(), entry.at, new Date());
    if (cleared !== this.historyCleared()) {
      await this.context.globalState.update(HISTORY_CLEARED_KEY, cleared);
    }
    this.queries = mergedHistory(entry, this.queries, this.storedHistory(), this.historyCleared(), HISTORY_LIMIT);
    this.refreshHistory();
    await this.context.globalState.update(HISTORY_KEY, this.queries);
  }

  private async rerun(entry?: HistoryEntry): Promise<void> {
    if (entry === undefined) {
      // Nothing to pick from: said as Copy Query says it (#2262).
      if (this.history().length === 0) {
        void window.showInformationMessage("q-lint: the query history is empty.");
        return;
      }
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
      void window.showInformationMessage(plainMessage(`q-lint: ${process.label} is not in the Processes view.`));
      return;
    }
    await this.processesTree.reveal(row, { select: true, focus: true, expand: true });
  }

  private async clearHistory(): Promise<void> {
    this.queries = [];
    // When, so another window's copy drops what it held from before (#1619).
    await this.context.globalState.update(HISTORY_CLEARED_KEY, new Date().toISOString());
    await this.context.globalState.update(HISTORY_KEY, []);
    this.refreshHistory();
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
        plainMessage(isFiltering(this.historyFilter) ? "q-lint: no query in the history matches the filter." : "q-lint: the query history is empty."),
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
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${target.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    void window.showInformationMessage(plainMessage(`q-lint: exported ${entries.length} quer${entries.length === 1 ? "y" : "ies"} to ${target.fsPath}.`));
  }
}
