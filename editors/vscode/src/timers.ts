// The Timers view (#1041), as data: the q that reads the connected
// process's timer in one call - its `\t` interval, and TorQ's `.timer.timer`
// jobs when it has them - and the q that changes them. No `vscode` import,
// so node tests it; `adminviews.ts` is the view, and every change goes
// through the read-only guard there.
//
// Each value is read into a string or a float on the process, as the
// Process Monitor reads its own; the first 200 jobs are listed.

export const TIMERS = [
  "{[]",
  " t:@[system;\"t\";0N];",
  " tm:@[get;`.timer.timer;()];",
  " tm:$[.Q.qt tm;200 sublist 0!tm;()];",
  " s:{$[10h=abs type x;x;-3!x]};",
  " r:$[.Q.qt tm;",
  "   `id`active`period`nextrun`lastrun`description`func!(\"f\"$tm`id;tm`active;s each tm`period;s each tm`nextrun;s each tm`lastrun;s each tm`description;{200 sublist -3!x}each tm`funcparam);",
  "   ()];",
  " `interval`ts`torq`timers!(\"f\"$t;@[{200 sublist -3!.z.ts};::;\"\"];.Q.qt tm;r)}",
].join("\n");

export interface TimerJob {
  id: number;
  active: boolean;
  period: string;
  nextrun: string;
  lastrun: string;
  description: string;
  func: string;
}

export interface TimerState {
  /// `\t` in milliseconds; 0: the timer is off.
  interval: number;
  /// `.z.ts`, as q writes it; empty when it is not set.
  ts: string;
  /// Whether the process has TorQ's `.timer.timer`.
  torq: boolean;
  jobs: TimerJob[];
}

const list = <T>(v: unknown, f: (x: unknown) => T): T[] => (Array.isArray(v) ? v.map(f) : v === undefined || v === null ? [] : [f(v)]);
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : list(v, (x) => (x === null || x === undefined ? "" : String(x))));

/// What `TIMERS` answered. Throws when the answer is not one.
export function readTimers(raw: unknown): TimerState {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || !("interval" in r)) {
    throw new Error("the process did not answer with its timer");
  }
  const t = r.timers as Record<string, unknown> | null;
  const jobs: TimerJob[] = [];
  if (t !== null && typeof t === "object" && !Array.isArray(t)) {
    const ids = list(t.id, Number);
    const active = list(t.active, (x) => x === true);
    const [period, nextrun, lastrun, description, func] = [t.period, t.nextrun, t.lastrun, t.description, t.func].map(strings);
    ids.forEach((id, i) =>
      jobs.push({ id, active: active[i] ?? false, period: period[i] ?? "", nextrun: nextrun[i] ?? "", lastrun: lastrun[i] ?? "", description: description[i] ?? "", func: func[i] ?? "" }),
    );
  }
  const interval = typeof r.interval === "number" && Number.isFinite(r.interval) ? r.interval : 0;
  return { interval, ts: typeof r.ts === "string" ? r.ts : "", torq: r.torq === true, jobs };
}

/// The q that turns TorQ job `id` on or off.
export function toggleCode(id: number, active: boolean): string {
  return `update active:${active ? "1b" : "0b"} from \`.timer.timer where id=${Math.trunc(id)}i`;
}

/// The q that sets `\t`; 0 turns the timer off.
export function intervalCode(ms: number): string {
  return `system "t ${Math.trunc(ms)}"`;
}

/// Why `text` is not a `\t` interval, or undefined when it is: whole
/// milliseconds, 0 to turn the timer off.
export function intervalProblem(text: string): string | undefined {
  return /^\d{1,9}$/.test(text.trim()) ? undefined : "Whole milliseconds; 0 turns the timer off.";
}
