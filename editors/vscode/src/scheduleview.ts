// Scheduled exports (#1039): Add Scheduled Export makes one from a saved
// query, a process, a format, its times and a file; while VS Code is open
// and the feature is on, a timer runs each when due on a connection of its
// own (`Live.runApart`, so the connected process and its queries are left
// alone) and writes the result. Manage Scheduled Exports runs one now or
// removes it. The schedules are kept per workspace, as saved queries are.
// Off (the default), no timer runs and the commands refuse.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Uri, commands, window, workspace, type ExtensionContext } from "vscode";
import { ADMIN_COMMANDS, adminOff, readAdmin } from "./admin";
import { textPayload } from "./asyncquery";
import { toCsv, toGrid } from "./grid";
import type { Live } from "./live";
import { readLive } from "./liveconfig";
import { exportResult } from "./resultexport";
import { SAVED_QUERIES_KEY, parseSaved } from "./savedqueries";
import {
  SCHEDULES_KEY,
  SCHEDULE_FORMATS,
  incomplete,
  isDue,
  outputPath,
  parseSchedules,
  parseWhen,
  scheduleProblem,
  scheduleText,
  writeWhole,
  type ScheduleFormat,
  type ScheduledExport,
} from "./schedule";
import { iconsEscaped, plainMessage } from "./history";

/// How often the timer looks for a schedule that is due.
const TICK_MS = 30_000;

const on = (): boolean => readAdmin((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).scheduledExports;

const FORMAT_LABELS: Record<ScheduleFormat, string> = { csv: "CSV", parquet: "Parquet", xlsx: "Excel (.xlsx)" };

export class ScheduledExports {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Set<string>();

  constructor(
    private readonly context: ExtensionContext,
    private readonly live: Pick<Live, "processes" | "runApart">,
  ) {
    context.subscriptions.push(
      commands.registerCommand(ADMIN_COMMANDS.addSchedule, () => this.add()),
      commands.registerCommand(ADMIN_COMMANDS.manageSchedules, () => this.manage()),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.export.schedule")) {
          this.sync();
        }
      }),
      { dispose: () => clearInterval(this.timer) },
    );
    this.sync();
  }

  /// The timer runs only while the feature is on.
  private sync(): void {
    clearInterval(this.timer);
    this.timer = on() ? setInterval(() => void this.tick(), TICK_MS) : undefined;
  }

  /// Whether the timer is running, for tests.
  get ticking(): boolean {
    return this.timer !== undefined;
  }

  list(): ScheduledExport[] {
    return parseSchedules(this.context.workspaceState.get<unknown>(SCHEDULES_KEY, []));
  }

  private async save(list: ScheduledExport[]): Promise<void> {
    await this.context.workspaceState.update(SCHEDULES_KEY, list);
  }

  /// Run each schedule due at `now`. What ran, for tests.
  async tick(now = new Date()): Promise<string[]> {
    if (!on()) {
      return [];
    }
    const ran: string[] = [];
    for (const { id } of this.list().filter((s) => isDue(s, now))) {
      // Asked again before each run: one before it may have taken long
      // enough for a later tick to run this one, or to be running it (#1089).
      const s = this.list().find((x) => x.id === id);
      if (s === undefined || !isDue(s, now) || this.running.has(id)) {
        continue;
      }
      // Turned off while an earlier one ran: the rest wait (#1296).
      if (!on()) {
        break;
      }
      await this.runOne(s, now);
      ran.push(id);
    }
    return ran;
  }

  /// Run `s` now and write its file; say a failure. Its new `last`.
  private async runOne(s: ScheduledExport, now: Date): Promise<string> {
    this.running.add(s.id);
    let last: string;
    try {
      const file = await this.export(s, now);
      last = `wrote ${file} at ${now.toLocaleString()}`;
    } catch (error) {
      last = `failed at ${now.toLocaleString()}: ${error instanceof Error ? error.message : String(error)}`;
      void window.showWarningMessage(plainMessage(`q-lint: the scheduled export ${scheduleText(s)} ${last}`));
    } finally {
      this.running.delete(s.id);
    }
    // Read again: the list may have changed while it ran.
    await this.save(this.list().map((x) => (x.id === s.id ? { ...x, since: now.getTime(), last } : x)));
    return last;
  }

  /// The file `s` writes at `now`, written. Throws why not.
  private async export(s: ScheduledExport, now: Date): Promise<string> {
    const saved = parseSaved(this.context.workspaceState.get<unknown>(SAVED_QUERIES_KEY, [])).find((q) => q.name === s.query);
    if (saved === undefined) {
      throw new Error(`there is no saved query named ${s.query}`);
    }
    const problem = scheduleProblem(saved.code);
    if (problem !== undefined) {
      throw new Error(`${s.query} was not run: ${problem}`);
    }
    const process = this.live.processes().find((p) => p.label === s.process);
    if (process === undefined) {
      throw new Error(`there is no q process labelled ${s.process}`);
    }
    const answer = await this.live.runApart(process, saved.code, undefined, { whole: true, unattended: true });
    if (!answer.ok) {
      throw new Error(`${s.process} answered '${answer.error}`);
    }
    if (answer.gridError !== undefined) {
      throw new Error(`the result could not be shaped: '${answer.gridError}`);
    }
    const payload = answer.grid ?? textPayload(answer.text);
    const cut = incomplete(payload);
    if (cut !== undefined) {
      throw new Error(`nothing was written: ${cut}`);
    }
    const configuration = workspace.getConfiguration("q-lint");
    const { gridDecimals } = readLive((key, fallback) => configuration.get(key, fallback));
    const data = s.format === "csv" ? Buffer.from(toCsv(toGrid(payload, gridDecimals)), "utf8") : exportResult(s.format, payload, gridDecimals).data;
    const file = outputPath(s.path, s.mode, now);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeWhole(file, data);
    return file;
  }

  /// Make a schedule, asking for each part; the schedule made.
  async add(): Promise<ScheduledExport | undefined> {
    if (!on()) {
      void window.showInformationMessage(plainMessage(adminOff("scheduledExports")));
      return undefined;
    }
    const queries = parseSaved(this.context.workspaceState.get<unknown>(SAVED_QUERIES_KEY, []));
    if (queries.length === 0) {
      void window.showInformationMessage("q-lint: a scheduled export runs a saved query, and there is none: Save Query saves one.");
      return undefined;
    }
    const query = await window.showQuickPick(
      queries.map((q) => ({ label: iconsEscaped(q.name), detail: iconsEscaped(q.code.split(/\r?\n/)[0]), name: q.name, problem: scheduleProblem(q.code) })),
      { title: "Scheduled export (1 of 6): which saved query?" },
    );
    if (query === undefined) {
      return undefined;
    }
    if (query.problem !== undefined) {
      void window.showInformationMessage(plainMessage(`q-lint: ${query.name} cannot be scheduled: ${query.problem}. Only read-only queries are run on a schedule.`));
      return undefined;
    }
    const process = await window.showQuickPick(
      this.live.processes().map((p) => ({ label: iconsEscaped(p.label), description: `${p.host}:${p.port}`, name: p.label })),
      { title: "Scheduled export (2 of 6): on which q process?" },
    );
    if (process === undefined) {
      return undefined;
    }
    const format = await window.showQuickPick(
      SCHEDULE_FORMATS.map((f) => ({ label: FORMAT_LABELS[f], format: f })),
      { title: "Scheduled export (3 of 6): as what?" },
    );
    if (format === undefined) {
      return undefined;
    }
    const when = await window.showInputBox({
      title: "Scheduled export (4 of 6): when?",
      prompt: "Times of day, HH:MM, comma separated (09:00, 17:30); or every N minutes as +N (+15). Runs only while VS Code is open.",
      validateInput: (v) => {
        const read = parseWhen(v);
        return "problem" in read ? read.problem : undefined;
      },
    });
    if (when === undefined) {
      return undefined;
    }
    const folder = workspace.workspaceFolders?.[0]?.uri;
    const target = await window.showSaveDialog({
      title: "Scheduled export (5 of 6): write to",
      defaultUri: folder === undefined ? undefined : Uri.joinPath(folder, `${query.name.replace(/[^\w.-]+/g, "_")}.${format.format}`),
      filters: { [FORMAT_LABELS[format.format]]: [format.format] },
    });
    if (target === undefined) {
      return undefined;
    }
    const mode = await window.showQuickPick(
      [
        { label: "Replace the file each run", detail: target.fsPath, mode: "replace" as const },
        { label: "Write a new file each run, named with its time", detail: outputPath(target.fsPath, "timestamped", new Date()), mode: "timestamped" as const },
      ],
      { title: "Scheduled export (6 of 6): each run" },
    );
    if (mode === undefined) {
      return undefined;
    }
    const read = parseWhen(when);
    if ("problem" in read) {
      return undefined;
    }
    const schedule: ScheduledExport = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      query: query.name,
      process: process.name,
      format: format.format,
      path: target.fsPath,
      ...read,
      mode: mode.mode,
      since: Date.now(),
    };
    await this.save([...this.list(), schedule]);
    void window.showInformationMessage(plainMessage(`q-lint: scheduled ${scheduleText(schedule)}, to ${target.fsPath}. It runs while VS Code is open.`));
    return schedule;
  }

  /// List the schedules; run one now, or remove it.
  async manage(): Promise<void> {
    if (!on()) {
      void window.showInformationMessage(plainMessage(adminOff("scheduledExports")));
      return;
    }
    const list = this.list();
    if (list.length === 0) {
      void window.showInformationMessage("q-lint: no scheduled export. Add Scheduled Export makes one.");
      return;
    }
    const picked = await window.showQuickPick(
      list.map((s) => ({ label: iconsEscaped(scheduleText(s)), description: iconsEscaped(s.path), detail: s.last ?? "not run yet", id: s.id, text: scheduleText(s) })),
      { title: "Scheduled exports" },
    );
    if (picked === undefined) {
      return;
    }
    const action = await window.showQuickPick(["Run Now", "Remove"], { title: picked.text });
    const s = this.list().find((x) => x.id === picked.id);
    if (action === undefined || s === undefined) {
      return;
    }
    if (action === "Remove") {
      await this.save(this.list().filter((x) => x.id !== s.id));
      void window.showInformationMessage(plainMessage(`q-lint: removed the scheduled export ${scheduleText(s)}.`));
      return;
    }
    if (this.running.has(s.id)) {
      void window.showInformationMessage(plainMessage(`q-lint: ${scheduleText(s)} is running; it was not started again.`));
      return;
    }
    const last = await this.runOne(s, new Date());
    if (last.startsWith("wrote")) {
      void window.showInformationMessage(plainMessage(`q-lint: ${scheduleText(s)}: ${last}.`));
    }
  }
}
