// The live half of the extension: q processes to connect to, code run on
// them, what came back, and what was run before.
//
// Nothing here involves the language server, which never runs q. A process
// is touched only once the user connects to it, and then only by the code
// the user sends. What a query sends is `query.ts`'s; how a block is cut into
// statements, `statements.ts`'s; how processes are read and grouped,
// `processes.ts`'s. This file is the VS Code around them.
import {
  commands,
  EventEmitter,
  MarkdownString,
  StatusBarAlignment,
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
  type TextEditor,
  type TreeDataProvider,
} from "vscode";
import {
  grouped,
  merge,
  parseProcesses,
  parseTags,
  portProblem,
  processColour,
  type Process,
} from "./processes";
import { COMMANDS, CONNECTED, VIEWS, readLive } from "./liveconfig";
import { QConnection } from "./qclient";
import { render } from "./query";
import { blockAt, statements } from "./statements";

const PROCESSES_KEY = "q-lint.processes";
const HISTORY_KEY = "q-lint.queryHistory";
/// How many queries the history keeps.
const HISTORY_LIMIT = 200;


const passwordKey = (label: string): string => `q-lint.password.${label}`;

type ProcessRow = { kind: "tag"; tag: string; processes: Process[] } | { kind: "process"; process: Process };
/// What a process command is given: a view row, a process's label (from a
/// keybinding's `args`, or another extension), or nothing - then the user
/// picks one.
type ProcessArg = ProcessRow | string | undefined;

export interface HistoryEntry {
  process: string;
  code: string;
  /// When it was sent, as an ISO string.
  at: string;
  millis: number;
  outcome: "ok" | "error" | "aborted";
  error?: string;
}

const colours = { red: "charts.red", blue: "charts.blue", green: "charts.green" } as const;

class ProcessesView implements TreeDataProvider<ProcessRow> {
  private readonly changed = new EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly live: Live) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(row?: ProcessRow): ProcessRow[] {
    if (row === undefined) {
      return grouped(this.live.processes()).flatMap((group) =>
        group.tag === ""
          ? group.processes.map((process): ProcessRow => ({ kind: "process", process }))
          : [{ kind: "tag", tag: group.tag, processes: group.processes }],
      );
    }
    return row.kind === "tag" ? row.processes.map((process) => ({ kind: "process", process })) : [];
  }

  getTreeItem(row: ProcessRow): TreeItem {
    if (row.kind === "tag") {
      const item = new TreeItem(row.tag, TreeItemCollapsibleState.Expanded);
      const colour = processColour({ label: "", host: "", port: 0, tags: [row.tag] });
      item.iconPath = new ThemeIcon("tag", colour ? new ThemeColor(colours[colour]) : undefined);
      item.contextValue = "tag";
      return item;
    }
    const { process } = row;
    const active = this.live.activeLabel() === process.label;
    const item = new TreeItem(process.label, TreeItemCollapsibleState.None);
    item.description = `${process.host}:${process.port}${active ? " - connected" : ""}`;
    const colour = processColour(process);
    item.iconPath = new ThemeIcon(active ? "debug-start" : "server-process", colour ? new ThemeColor(colours[colour]) : undefined);
    item.tooltip = new MarkdownString(
      [
        `**${process.label}**`,
        `${process.host}:${process.port}${process.tls ? " (TLS)" : ""}`,
        process.user ? `user \`${process.user}\`` : "no user",
        process.tags.length ? `tags: ${process.tags.join(", ")}` : "no tags",
      ].join("\n\n"),
    );
    item.contextValue = active ? "process.connected" : "process";
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
    item.description = `${entry.process} · ${when.toLocaleTimeString()} · ${entry.millis} ms`;
    item.iconPath = new ThemeIcon(
      entry.outcome === "ok" ? "pass" : entry.outcome === "error" ? "error" : "circle-slash",
      entry.outcome === "ok" ? undefined : new ThemeColor(entry.outcome === "error" ? "errorForeground" : "disabledForeground"),
    );
    const tooltip = new MarkdownString();
    tooltip.appendMarkdown(`${entry.process}, ${when.toLocaleString()}, ${entry.millis} ms`);
    if (entry.error !== undefined) {
      tooltip.appendMarkdown(`\n\n'${entry.error}`);
    }
    tooltip.appendCodeblock(entry.code, "q");
    item.tooltip = tooltip;
    item.contextValue = "history";
    return item;
  }
}

export class Live {
  private connection: QConnection | undefined;
  private active: Process | undefined;
  /// A connect in progress, so a second one waits for it instead of opening
  /// another.
  private connecting: Promise<boolean> | undefined;
  private running: { code: string; started: number } | undefined;
  private readonly status: StatusBarItem;
  private readonly output: OutputChannel;
  private readonly processesView: ProcessesView;
  private readonly historyView: HistoryView;

  constructor(private readonly context: ExtensionContext) {
    this.output = window.createOutputChannel("q-lint: query");
    this.status = window.createStatusBarItem("q-lint.connection", StatusBarAlignment.Left, 50);
    this.status.name = "q-lint: q connection";
    this.status.command = COMMANDS.connect;
    this.processesView = new ProcessesView(this);
    this.historyView = new HistoryView(this);
    const c = (name: string, run: (...args: never[]) => unknown) => commands.registerCommand(name, run);
    context.subscriptions.push(
      this.output,
      this.status,
      window.registerTreeDataProvider(VIEWS.processes, this.processesView),
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
      { dispose: () => void this.connection?.close() },
    );
    this.showStatus();
    this.status.show();
  }

  /// What the extension returns from `activate`: a read-only view for tests
  /// and for other extensions. Passwords are never in it.
  api(): { processes: () => Process[]; activeLabel: () => string | undefined; history: () => HistoryEntry[] } {
    return {
      processes: () => this.processes(),
      activeLabel: () => this.activeLabel(),
      history: () => this.history(),
    };
  }

  processes(): Process[] {
    return parseProcesses(this.context.globalState.get<unknown>(PROCESSES_KEY, [])).processes;
  }

  activeLabel(): string | undefined {
    return this.connection?.isOpen ? this.active?.label : undefined;
  }

  history(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
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
    void commands.executeCommand("setContext", CONNECTED, label !== undefined);
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
    const user = await window.showInputBox({
      title: "q process: user",
      value: from.user ?? "",
      prompt: "Leave empty to connect without a user",
    });
    if (user === undefined) {
      return undefined;
    }
    let password: string | undefined;
    if (user.trim() !== "") {
      password = await window.showInputBox({
        title: "q process: password",
        password: true,
        prompt: "Kept in VS Code's secret storage. Leave empty to keep the stored one.",
      });
      if (password === undefined) {
        return undefined;
      }
    }
    const tags = await window.showInputBox({
      title: "q process: tags",
      value: (from.tags ?? []).join(", "),
      prompt: "Comma separated. prod, uat and dev are coloured.",
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
        ...(from.tls ? { tls: true } : {}),
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
  private async chosen(row: ProcessArg, title: string): Promise<Process | undefined> {
    if (typeof row === "string") {
      const named = this.processes().find((p) => p.label === row);
      if (named === undefined) {
        void window.showErrorMessage(`q-lint: no q process is labelled "${row}".`);
      }
      return named;
    }
    if (row?.kind === "process") {
      return row.process;
    }
    const processes = this.processes();
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
      prompt: "Comma separated. prod, uat and dev are coloured.",
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
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(await workspace.fs.readFile(files[0])).toString("utf8"));
    } catch (error) {
      void window.showErrorMessage(`q-lint: could not read ${files[0].fsPath}: ${String(error)}`);
      return;
    }
    const { processes, problems } = parseProcesses(json);
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

  private async connectTo(row?: ProcessArg): Promise<boolean> {
    const process = await this.chosen(row, "Connect to which q process?");
    return process === undefined ? false : this.open(process);
  }

  /// Connect to `process`, closing the connection there was. Whether it
  /// connected.
  private open(process: Process): Promise<boolean> {
    if (this.connecting !== undefined) {
      return this.connecting;
    }
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
            QConnection.open({
              host: process.host,
              port: process.port,
              ...(process.user ? { user: process.user, password: password ?? "" } : {}),
              ...(process.tls ? { tls: true } : {}),
            }),
        );
        this.connection = connection;
        this.active = process;
        connection.whenClosed(() => {
          if (this.connection === connection) {
            this.connection = undefined;
            this.running = undefined;
            this.showStatus();
            this.processesView.refresh();
            void window.showWarningMessage(`q-lint: the connection to ${process.label} closed.`);
          }
        });
        return true;
      } catch (error) {
        void window.showErrorMessage(
          `q-lint: could not connect to ${process.label} (${process.host}:${process.port}): ${error instanceof Error ? error.message : String(error)}`,
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

  private async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.running = undefined;
    await connection?.close();
    this.showStatus();
    this.processesView.refresh();
  }

  // --- queries

  private code(editor: TextEditor, from: "line" | "selection" | "block"): string | undefined {
    const document = editor.document;
    const line = editor.selection.active.line;
    if (from === "selection" && !editor.selection.isEmpty) {
      return document.getText(editor.selection);
    }
    if (from === "block") {
      const lines = document.getText().split(/\r?\n/);
      const block = blockAt(lines, line);
      return block === undefined ? undefined : lines.slice(block.start, block.end + 1).join("\n");
    }
    return document.lineAt(line).text;
  }

  private async queryFrom(from: "line" | "selection" | "block"): Promise<void> {
    const editor = window.activeTextEditor;
    if (editor === undefined) {
      return;
    }
    const code = this.code(editor, from);
    if (code === undefined || statements(code).length === 0) {
      void window.showInformationMessage(
        from === "block"
          ? "q-lint: the cursor is on no statement (a blank line, a comment, or inside a block comment)."
          : "q-lint: nothing to run there: it is blank or a comment.",
      );
      return;
    }
    await this.run(code);
  }

  /// The active connection and its process, connecting first if there is
  /// none; undefined when none was connected or a query is still running.
  private async ready(): Promise<{ connection: QConnection; process: Process } | undefined> {
    if (this.connection === undefined && !(await this.connectTo())) {
      return undefined;
    }
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
    }
  }

  /// Run `code` on the active connection, connecting first if there is none.
  private async run(code: string): Promise<void> {
    const ready = await this.ready();
    if (ready === undefined) {
      return;
    }
    const { connection, process } = ready;
    const configuration = workspace.getConfiguration("q-lint");
    const settings = readLive((key, fallback) => configuration.get(key, fallback));
    const started = Date.now();
    this.running = { code, started };
    this.showStatus();
    let entry: HistoryEntry;
    try {
      const answer = await connection.query(statements(code), settings.consoleSize);
      const millis = Date.now() - started;
      entry = {
        process: process.label,
        code,
        at: new Date(started).toISOString(),
        millis,
        outcome: answer.ok ? "ok" : "error",
        ...(answer.ok ? {} : { error: answer.error }),
      };
      this.show(render({ process: process.label, code, answer, millis }, settings), settings.autoClear);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = this.running === undefined || !connection.isOpen;
      entry = {
        process: process.label,
        code,
        at: new Date(started).toISOString(),
        millis: Date.now() - started,
        outcome: aborted ? "aborted" : "error",
        error: aborted && this.running === undefined ? "aborted" : message,
      };
      this.show([`# ${process.label} - ${aborted ? "aborted" : "failed"}: ${message}`], false);
    } finally {
      if (this.running?.started === started) {
        this.running = undefined;
      }
      this.showStatus();
    }
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
  async abort(): Promise<void> {
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
    void this.open(process).then((connected) => {
      if (connected) {
        void window.showInformationMessage(`q-lint: reconnected to ${process.label}.`);
      }
    });
    void window.showInformationMessage(
      `q-lint: stopped waiting for the query. ${process.label} may still be running it; q-lint reconnects once it is free.`,
    );
  }

  private async record(entry: HistoryEntry): Promise<void> {
    await this.context.globalState.update(HISTORY_KEY, [entry, ...this.history()].slice(0, HISTORY_LIMIT));
    this.historyView.refresh();
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

  private async clearHistory(): Promise<void> {
    await this.context.globalState.update(HISTORY_KEY, []);
    this.historyView.refresh();
  }
}
