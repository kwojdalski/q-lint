// Scheduled exports (#1039), as data: a saved query run on a process at set
// times while VS Code is open, its result written to CSV, Parquet or Excel.
// No `vscode` import, so node tests it; `scheduleview.ts` keeps the timer.
//
// Off unless turned on, as it runs queries on its own. Only a read-only
// query is run: one the read-only guard's reading finds no write in
// (`writes`), on any process, guarded or not, and one with no `{{name}}`
// placeholder, which nobody is there to fill in. The file is replaced each
// run, or a new one written with the run's time in its name - chosen when
// the schedule is made, which is the asking.
import { writes } from "./guard";
import { placeholderNames } from "./placeholders";

export const SCHEDULES_KEY = "q-lint.scheduledExports";
export const SCHEDULE_FORMATS = ["csv", "parquet", "xlsx"] as const;
export type ScheduleFormat = (typeof SCHEDULE_FORMATS)[number];

export interface ScheduledExport {
  id: string;
  /// The saved query's name.
  query: string;
  /// The process's label.
  process: string;
  format: ScheduleFormat;
  path: string;
  /// Each day at these local times, `HH:MM`; or every `every` minutes.
  times?: string[];
  every?: number;
  /// Replace the file each run, or write one named with the run's time.
  mode: "replace" | "timestamped";
  /// When it last ran, or was made (ms since the epoch): a run is due
  /// after it.
  since: number;
  /// How the last run went.
  last?: string;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/// `"09:00, 17:30"` as sorted `HH:MM` times, or why not.
export function parseTimes(text: string): string[] | { problem: string } {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length === 0) {
    return { problem: "Give at least one time, HH:MM." };
  }
  const bad = parts.find((p) => !TIME.test(p));
  if (bad !== undefined) {
    return { problem: `${bad} is not a time of day, HH:MM.` };
  }
  return [...new Set(parts.map((p) => p.padStart(5, "0")))].sort();
}

/// Minutes between runs, 1 to a day, or why not.
export function everyProblem(text: string): string | undefined {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= 1440 ? undefined : "Whole minutes, 1 to 1440.";
}

/// When a schedule runs, as typed: times of day (`09:00, 17:30`), or
/// every N minutes as `+N`; or why it is neither.
export function parseWhen(text: string): { times: string[] } | { every: number } | { problem: string } {
  const t = text.trim();
  if (t.startsWith("+")) {
    const problem = everyProblem(t.slice(1));
    return problem === undefined ? { every: Number(t.slice(1)) } : { problem };
  }
  const times = parseTimes(t);
  return Array.isArray(times) ? { times } : times;
}

/// The schedules as stored, an entry that is not one dropped.
export function parseSchedules(stored: unknown): ScheduledExport[] {
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored.flatMap((e): ScheduledExport[] => {
    const s = e as Record<string, unknown> | null;
    if (s === null || typeof s !== "object") return [];
    const text = (k: string): string | undefined => (typeof s[k] === "string" && (s[k] as string).trim() !== "" ? (s[k] as string) : undefined);
    const format = SCHEDULE_FORMATS.find((f) => f === s.format);
    const times = Array.isArray(s.times) ? parseTimes(s.times.filter((t) => typeof t === "string").join(",")) : undefined;
    const every = typeof s.every === "number" && everyProblem(String(s.every)) === undefined ? s.every : undefined;
    const id = text("id");
    const query = text("query");
    const process = text("process");
    const path = text("path");
    if (id === undefined || query === undefined || process === undefined || path === undefined || format === undefined) return [];
    const when = Array.isArray(times) ? { times } : every !== undefined ? { every } : undefined;
    if (when === undefined) return [];
    return [
      {
        id,
        query,
        process,
        format,
        path,
        ...when,
        mode: s.mode === "timestamped" ? "timestamped" : "replace",
        since: typeof s.since === "number" ? s.since : 0,
        ...(typeof s.last === "string" ? { last: s.last } : {}),
      },
    ];
  });
}

/// The schedules once the saved query `from` is renamed `to` (#1413), or
/// deleted (`to` undefined): its schedules name the new name, or are gone.
export function renamedSchedules(list: ScheduledExport[], from: string, to: string | undefined): ScheduledExport[] {
  return list.flatMap((s) => (s.query !== from ? [s] : to === undefined ? [] : [{ ...s, query: to }]));
}

/// Whether `s` is due at `now`: its interval has passed since it last ran,
/// or one of today's times has come since then.
export function isDue(s: Pick<ScheduledExport, "times" | "every" | "since">, now: Date): boolean {
  if (s.every !== undefined) {
    return now.getTime() - s.since >= s.every * 60_000;
  }
  return (s.times ?? []).some((t) => {
    const [h, m] = t.split(":").map(Number);
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime();
    return at <= now.getTime() && at > s.since;
  });
}

/// The file a run at `now` writes: `path`, or with `-YYYYMMDD-HHMMSS`
/// before its extension.
export function outputPath(path: string, mode: ScheduledExport["mode"], now: Date): string {
  if (mode === "replace") {
    return path;
  }
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)}-${stamp}${path.slice(dot)}` : `${path}-${stamp}`;
}

/// Why `payload` is not the whole result - fewer rows came back than it
/// has - or undefined when it is all there (#1613).
export function incomplete(payload: { count: number; cells: string[][] }): string | undefined {
  const rows = payload.cells[0]?.length ?? 0;
  return payload.cells.length > 0 && rows < payload.count ? `only ${rows} of its ${payload.count} rows came back` : undefined;
}

/// Why `code` may not be scheduled, or undefined when it may: it would
/// change the process, or asks for placeholders.
export function scheduleProblem(code: string): string | undefined {
  const w = writes(code);
  if (w.length > 0) {
    return `it is not read-only: it ${w.slice(0, 3).join(", ")}`;
  }
  const names = placeholderNames(code);
  return names.length > 0 ? `it asks for ${names.map((n) => `{{${n}}}`).join(", ")}, and a scheduled run has nobody to ask` : undefined;
}

/// How a schedule is described in lists.
export function scheduleText(s: Pick<ScheduledExport, "query" | "process" | "format" | "times" | "every">): string {
  const when = s.every !== undefined ? `every ${s.every} min` : `daily at ${(s.times ?? []).join(", ")}`;
  return `${s.query} on ${s.process}, ${when}, as ${s.format}`;
}
