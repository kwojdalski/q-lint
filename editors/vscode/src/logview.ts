// The q and TorQ log viewer (#1004): local log files shown in a read-only
// editor, coloured by level, filtered by level, process, time and text, and
// followed as they grow. Files are read a piece at a time (`logreader.ts`),
// never whole, and only the last `q-lint.processes.logViewer.maxLines`
// entries that pass the filter are kept; a new filter reads the files
// again. Nothing is sent to any process: this reads files on this machine.
import {
  commands,
  EventEmitter,
  ProgressLocation,
  Range,
  StatusBarAlignment,
  ThemeColor,
  Uri,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
  type StatusBarItem,
  type TextEditor,
  type TextEditorDecorationType,
} from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  EntryBuilder,
  LEVELS,
  LOG_COMMANDS,
  LOG_SCHEME,
  LOG_VIEWER_OFF,
  NO_FILTER,
  filterText,
  matches,
  merge,
  readLogViewer,
  validBound,
  type Entry,
  type Filter,
  type Level,
} from "./logparse";
import { readFrom, START, type Position } from "./logreader";
import { plainMessage } from "./history";

/// How often a followed file is checked for new lines.
const FOLLOW_MS = 500;

/// One line of a view's text: the entry's level and, on its first line,
/// where its timestamp and level word are.
interface LineInfo {
  level?: Level;
  time?: [number, number];
  word?: [number, number];
}

interface View {
  id: string;
  uri: Uri;
  files: string[];
  filter: Filter;
  follow: boolean;
  /// The entries that pass the filter, oldest first, at most `max`.
  entries: Entry[];
  max: number;
  positions: Map<string, Position>;
  builders: Map<string, EntryBuilder>;
  /// Every process and level seen, with how many entries.
  processes: Map<string, number>;
  levels: Map<Level, number>;
  text: string;
  lines: LineInfo[];
  /// Reads are run one at a time, in order.
  queue: Promise<void>;
  /// Bumped by each full read, so appends of an older one are dropped.
  generation: number;
  /// While a full read runs, the entries each file passes go to its own
  /// list, merged by time at the end; after it, straight to `entries`.
  loading: Map<string, Entry[]>;
  /// The listeners following each file.
  watchers: Map<string, (now: fs.Stats, before: fs.Stats) => void>;
}

export class LogViewer {
  private readonly views = new Map<string, View>();
  private readonly changed = new EventEmitter<Uri>();
  private registrations: Disposable[] = [];
  private status: StatusBarItem | undefined;
  private decorations: Record<Level | "time", TextEditorDecorationType> | undefined;
  private next = 1;

  constructor(private readonly context: ExtensionContext) {
    const c = (name: string, run: (...args: never[]) => unknown) => commands.registerCommand(name, run);
    context.subscriptions.push(
      c(LOG_COMMANDS.open, (uri?: Uri, uris?: Uri[]) => this.open(uri, uris)),
      c(LOG_COMMANDS.levels, (given?: unknown) => this.filterLevels(given)),
      c(LOG_COMMANDS.processes, (given?: unknown) => this.filterProcesses(given)),
      c(LOG_COMMANDS.time, (given?: unknown) => this.filterTime(given)),
      c(LOG_COMMANDS.text, (given?: unknown) => this.filterText(given)),
      c(LOG_COMMANDS.clear, () => this.setFilter(() => NO_FILTER)),
      c(LOG_COMMANDS.follow, () => this.toggleFollow()),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.processes.logViewer")) {
          this.apply();
        }
      }),
      { dispose: () => this.unregister() },
    );
    this.apply();
  }

  private settings(): { enabled: boolean; maxLines: number } {
    const configuration = workspace.getConfiguration("q-lint");
    return readLogViewer((key, fallback) => configuration.get(key, fallback));
  }

  /// Register the provider, listeners and status bar while on; off, take
  /// them all down and stop following every file.
  private apply(): void {
    const on = this.settings().enabled;
    if (on && this.registrations.length === 0) {
      this.status = window.createStatusBarItem("q-lint.logView", StatusBarAlignment.Left, 48);
      this.status.name = "q-lint: log view";
      this.status.command = LOG_COMMANDS.levels;
      const color = (id: string, whole: boolean) => window.createTextEditorDecorationType({ color: new ThemeColor(id), ...(whole ? { isWholeLine: true } : {}) });
      this.decorations = {
        ERROR: color("errorForeground", true),
        WARN: color("editorWarning.foreground", true),
        INFO: color("editorInfo.foreground", false),
        DEBUG: color("descriptionForeground", true),
        time: color("descriptionForeground", false),
      };
      this.registrations = [
        this.status,
        ...Object.values(this.decorations),
        workspace.registerTextDocumentContentProvider(LOG_SCHEME, {
          onDidChange: this.changed.event,
          provideTextDocumentContent: (uri) => this.viewOf(uri)?.text ?? "This log view is closed. Open the file again with q-lint: Open Log File.",
        }),
        window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.decorate(e))),
        window.onDidChangeActiveTextEditor(() => this.refreshStatus()),
        workspace.onDidCloseTextDocument((document) => {
          const view = this.viewOf(document.uri);
          if (view !== undefined) {
            this.close(view);
          }
        }),
      ];
    } else if (!on) {
      this.unregister();
    }
  }

  private unregister(): void {
    for (const view of [...this.views.values()]) {
      this.close(view);
    }
    for (const d of this.registrations) {
      d.dispose();
    }
    this.registrations = [];
    this.status = undefined;
    this.decorations = undefined;
  }

  private enabled(): boolean {
    if (!this.settings().enabled) {
      void window.showInformationMessage(LOG_VIEWER_OFF);
      return false;
    }
    return true;
  }

  private viewOf(uri: Uri): View | undefined {
    return uri.scheme === LOG_SCHEME ? this.views.get(new URLSearchParams(uri.query).get("view") ?? "") : undefined;
  }

  /// The view in the active editor, or the only one open.
  private activeView(): View | undefined {
    const uri = window.activeTextEditor?.document.uri;
    const view = uri === undefined ? undefined : this.viewOf(uri);
    if (view === undefined && this.views.size === 1) {
      return [...this.views.values()][0];
    }
    if (view === undefined) {
      void window.showInformationMessage("q-lint: open a log view (q-lint: Open Log File) to filter it.");
    }
    return view;
  }

  /// Open `uris` (or `uri`, or files picked) in a new log view; the view's
  /// state, for tests and the e2e run.
  async open(uri?: Uri, uris?: Uri[]): Promise<ReturnType<LogViewer["state"]> | undefined> {
    if (!this.enabled()) {
      return undefined;
    }
    let files = (uris && uris.length > 0 ? uris : uri ? [uri] : []).filter((u) => u.scheme === "file").map((u) => u.fsPath);
    if (files.length === 0) {
      const picked = await window.showOpenDialog({
        canSelectMany: true,
        openLabel: "Open Log",
        title: "Open q or TorQ log files",
        filters: { Logs: ["log", "txt", "out", "err"], "All files": ["*"] },
      });
      files = (picked ?? []).map((u) => u.fsPath);
    }
    if (files.length === 0) {
      return undefined;
    }
    const id = String(this.next++);
    const name = files.length === 1 ? path.basename(files[0]) : `${files.length} logs`;
    const view: View = {
      id,
      uri: Uri.parse(`${LOG_SCHEME}:/${encodeURIComponent(name)}?view=${id}`),
      files,
      filter: NO_FILTER,
      follow: true,
      entries: [],
      max: this.settings().maxLines,
      positions: new Map(),
      builders: new Map(),
      processes: new Map(),
      levels: new Map(),
      text: "",
      lines: [],
      queue: Promise.resolve(),
      generation: 0,
      loading: new Map(),
      watchers: new Map(),
    };
    this.views.set(id, view);
    await this.reload(view);
    const document = await workspace.openTextDocument(view.uri);
    const editor = await window.showTextDocument(document, { preview: false });
    this.decorate(editor);
    this.reveal(view);
    this.watch(view);
    this.refreshStatus();
    return this.state(view);
  }

  /// What a view shows, for tests and the e2e run.
  state(view?: View): { files: string[]; filter: Filter; follow: boolean; text: string; processes: string[]; levels: Level[]; entries: number } | undefined {
    view ??= [...this.views.values()].pop();
    if (view === undefined) {
      return undefined;
    }
    return {
      files: view.files,
      filter: view.filter,
      follow: view.follow,
      text: view.text,
      processes: [...view.processes.keys()].sort(),
      levels: LEVELS.filter((l) => view.levels.has(l)),
      entries: view.entries.length,
    };
  }

  /// Read every file of `view` again from its start, under its filter.
  private reload(view: View): Promise<void> {
    const generation = ++view.generation;
    const run = async (): Promise<void> => {
      const big = (await Promise.all(view.files.map((f) => fs.promises.stat(f).then((s) => s.size, () => 0)))).reduce((a, b) => a + b, 0) > 16 * 1024 * 1024;
      const read = async (): Promise<void> => {
        view.processes.clear();
        view.levels.clear();
        view.loading = new Map(view.files.map((f) => [f, []]));
        for (const file of view.files) {
          const builder = this.builder(view, file);
          try {
            view.positions.set(file, await readFrom(file, START, (line) => builder.push(line)));
          } catch (error) {
            void window.showErrorMessage(plainMessage(`q-lint: could not read ${file}: ${error instanceof Error ? error.message : String(error)}`));
            view.positions.set(file, START);
          }
        }
        if (generation === view.generation) {
          view.entries = merge([...view.loading.values()]).slice(-view.max);
          view.loading = new Map();
          this.render(view);
        }
      };
      if (big) {
        await window.withProgress({ location: ProgressLocation.Notification, title: `q-lint: reading ${path.basename(view.files[0])}${view.files.length > 1 ? " and more" : ""}` }, read);
      } else {
        await read();
      }
    };
    view.queue = view.queue.then(run, run);
    return view.queue;
  }

  /// A builder for `file` that counts what it sees and keeps each entry
  /// that passes the filter.
  private builder(view: View, file: string): EntryBuilder {
    const builder = new EntryBuilder(file, (entry) => {
      if (matches(entry, view.filter)) {
        keep(view.loading.get(file) ?? view.entries, entry, view.max);
      }
    });
    builder.onStart = (entry) => {
      view.processes.set(entry.process, (view.processes.get(entry.process) ?? 0) + 1);
      if (entry.level) {
        view.levels.set(entry.level, (view.levels.get(entry.level) ?? 0) + 1);
      }
    };
    view.builders.set(file, builder);
    return builder;
  }

  /// Read what was appended to each file of a followed view.
  private append(view: View): Promise<void> {
    const generation = view.generation;
    const run = async (): Promise<void> => {
      let restarted = false;
      for (const file of view.files) {
        const builder = view.builders.get(file);
        const from = view.positions.get(file);
        if (builder === undefined || from === undefined || generation !== view.generation) {
          return;
        }
        try {
          const to = await readFrom(file, from, (line) => builder.push(line));
          restarted ||= to.restarted;
          view.positions.set(file, to);
        } catch {
          // Gone for now (being rotated): tried again on the next change.
        }
      }
      if (restarted) {
        // Truncated or rotated: what is kept no longer matches the file.
        void this.reload(view);
        return;
      }
      if (generation === view.generation) {
        this.render(view);
      }
    };
    view.queue = view.queue.then(run, run);
    return view.queue;
  }

  /// Make `view`'s text from its entries, and the entries still open.
  private render(view: View): void {
    const many = view.files.length > 1;
    const open = [...view.builders.values()].map((b) => b.open).filter((e): e is Entry => e !== undefined && matches(e, view.filter));
    const lines: string[] = [];
    const infos: LineInfo[] = [];
    for (const entry of [...view.entries, ...open]) {
      // Several files at once: a line that names no process says which.
      const prefix = many && entry.kind === "q" ? `[${entry.process}] ` : "";
      entry.lines.forEach((line, i) => {
        lines.push(prefix + line);
        const shift = (s?: [number, number]): [number, number] | undefined => (s ? [s[0] + prefix.length, s[1] + prefix.length] : undefined);
        infos.push({
          ...(entry.level ? { level: entry.level } : {}),
          ...(i === 0 && entry.timeSpan ? { time: shift(entry.timeSpan) } : {}),
          ...(i === 0 && entry.levelSpan ? { word: shift(entry.levelSpan) } : {}),
        });
      });
    }
    const text = lines.length > 0 ? lines.join("\n") : view.filter === NO_FILTER ? "(empty)" : "(nothing passes the filter)";
    view.lines = infos;
    if (text !== view.text) {
      view.text = text;
      this.changed.fire(view.uri);
      // The editor takes the new text after the event: colour it then.
      setTimeout(() => {
        for (const editor of window.visibleTextEditors) {
          if (editor.document.uri.toString() === view.uri.toString()) {
            this.decorate(editor);
          }
        }
        this.reveal(view);
      }, 50);
    }
    this.refreshStatus();
  }

  private decorate(editor: TextEditor): void {
    const view = this.viewOf(editor.document.uri);
    if (view === undefined || this.decorations === undefined) {
      return;
    }
    const ranges: Record<Level | "time", Range[]> = { ERROR: [], WARN: [], INFO: [], DEBUG: [], time: [] };
    view.lines.forEach((info, n) => {
      if (info.level === "INFO") {
        if (info.word) ranges.INFO.push(new Range(n, info.word[0], n, info.word[1]));
      } else if (info.level) {
        ranges[info.level].push(new Range(n, 0, n, 0));
      }
      if (info.time && (info.level === undefined || info.level === "INFO")) {
        ranges.time.push(new Range(n, info.time[0], n, info.time[1]));
      }
    });
    for (const key of Object.keys(ranges) as (Level | "time")[]) {
      editor.setDecorations(this.decorations[key], ranges[key]);
    }
  }

  /// A followed view scrolls to its last line.
  private reveal(view: View): void {
    if (!view.follow) {
      return;
    }
    for (const editor of window.visibleTextEditors) {
      if (editor.document.uri.toString() === view.uri.toString()) {
        const last = Math.max(0, editor.document.lineCount - 1);
        editor.revealRange(new Range(last, 0, last, 0));
      }
    }
  }

  /// Check each file of a followed view for new lines.
  private watch(view: View): void {
    if (!view.follow || view.watchers.size > 0) {
      return;
    }
    for (const file of view.files) {
      const listener = (now: fs.Stats, before: fs.Stats): void => {
        if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
          void this.append(view);
        }
      };
      view.watchers.set(file, listener);
      fs.watchFile(file, { interval: FOLLOW_MS, persistent: false }, listener);
    }
    // fs.watchFile takes its first stat asynchronously, so lines appended
    // before it are part of its baseline and raise no change: read once more
    // after the first poll, unless following has stopped since.
    setTimeout(() => {
      if (view.watchers.size > 0) {
        void this.append(view);
      }
    }, FOLLOW_MS);
  }

  /// Stop following: only this view's listeners, so another view of the
  /// same file keeps its own.
  private unwatch(view: View): void {
    for (const [file, listener] of view.watchers) {
      fs.unwatchFile(file, listener);
    }
    view.watchers.clear();
  }

  private close(view: View): void {
    this.unwatch(view);
    view.generation++;
    this.views.delete(view.id);
    this.refreshStatus();
  }

  private async toggleFollow(): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    const view = this.activeView();
    if (view === undefined) {
      return;
    }
    view.follow = !view.follow;
    if (view.follow) {
      this.watch(view);
      // What was appended while paused.
      await this.append(view);
      this.reveal(view);
    } else {
      this.unwatch(view);
    }
    this.refreshStatus();
  }

  private async setFilter(change: (filter: Filter) => Filter): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    const view = this.activeView();
    if (view === undefined) {
      return;
    }
    view.filter = change(view.filter);
    await this.reload(view);
  }

  /// Each filter command takes its value as an argument too, as a
  /// keybinding gives one: a list of levels or processes, `{from, to}`, or
  /// the text.
  private async filterLevels(given?: unknown): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    const view = this.activeView();
    if (view === undefined) {
      return;
    }
    if (Array.isArray(given)) {
      const levels = LEVELS.filter((l) => given.some((g) => typeof g === "string" && g.toUpperCase() === l));
      await this.setFilter((f) => ({ ...f, levels }));
      return;
    }
    const picked = await window.showQuickPick(
      LEVELS.map((level) => ({ label: level, description: `${view.levels.get(level) ?? 0}`, picked: view.filter.levels.includes(level) })),
      { canPickMany: true, title: "Show which levels? (none picked: every line)" },
    );
    if (picked !== undefined) {
      await this.setFilter((f) => ({ ...f, levels: picked.map((p) => p.label as Level) }));
    }
  }

  private async filterProcesses(given?: unknown): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    const view = this.activeView();
    if (view === undefined) {
      return;
    }
    if (Array.isArray(given)) {
      const processes = given.filter((g): g is string => typeof g === "string");
      await this.setFilter((f) => ({ ...f, processes }));
      return;
    }
    const picked = await window.showQuickPick(
      [...view.processes].sort(([a], [b]) => a.localeCompare(b)).map(([name, n]) => ({ label: name, description: `${n}`, picked: view.filter.processes.includes(name) })),
      { canPickMany: true, title: "Show which processes? (none picked: every process)" },
    );
    if (picked !== undefined) {
      await this.setFilter((f) => ({ ...f, processes: picked.map((p) => p.label) }));
    }
  }

  private async filterTime(given?: unknown): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    const view = this.activeView();
    if (view === undefined) {
      return;
    }
    const g = given as { from?: unknown; to?: unknown } | null | undefined;
    // A menu hands in the editor's URI, which is no bound.
    if (typeof g === "object" && g !== null && ("from" in g || "to" in g)) {
      const bound = (v: unknown) => (typeof v === "string" && v.trim() !== "" && validBound(v) ? v.trim() : undefined);
      await this.setFilter((f) => ({ ...f, from: bound(g.from), to: bound(g.to) }));
      return;
    }
    const validateInput = (v: string) => (validBound(v) ? undefined : "A time of day (12:30, 12:30:15.5) or a date and time (2026.11.21D12:30:00, 2026-11-21 12:30); empty for none.");
    const prompt = "A time of day applies to every day in the log; a date and time to that moment. Empty: no bound.";
    const from = await window.showInputBox({ title: "Show entries from", prompt, value: view.filter.from ?? "", validateInput });
    if (from === undefined) {
      return;
    }
    const to = await window.showInputBox({ title: "Show entries up to", prompt, value: view.filter.to ?? "", validateInput });
    if (to === undefined) {
      return;
    }
    await this.setFilter((f) => ({ ...f, from: from.trim() || undefined, to: to.trim() || undefined }));
  }

  private async filterText(given?: unknown): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    const view = this.activeView();
    if (view === undefined) {
      return;
    }
    if (typeof given === "string") {
      await this.setFilter((f) => ({ ...f, text: given || undefined }));
      return;
    }
    const text = await window.showInputBox({ title: "Show entries containing (ignoring case)", value: view.filter.text ?? "", prompt: "Empty: every entry." });
    if (text !== undefined) {
      await this.setFilter((f) => ({ ...f, text: text || undefined }));
    }
  }

  private refreshStatus(): void {
    if (this.status === undefined) {
      return;
    }
    const uri = window.activeTextEditor?.document.uri;
    const view = uri === undefined ? undefined : this.viewOf(uri);
    if (view === undefined) {
      this.status.hide();
      return;
    }
    const filter = filterText(view.filter);
    this.status.text = `$(list-filter) ${filter || "all"} · ${view.entries.length} · ${view.follow ? "following" : "paused"}`;
    this.status.tooltip = `${view.files.join("\n")}\nShowing the last ${view.max} entries that pass the filter. Click to filter by level.`;
    this.status.show();
  }
}

/// Add `entry` to `list`, dropping the oldest past `max` (a tenth at a
/// time, so a long read does not shift the list on every entry).
function keep(list: Entry[], entry: Entry, max: number): void {
  list.push(entry);
  if (list.length > max + Math.ceil(max / 10)) {
    list.splice(0, list.length - max);
  }
}
