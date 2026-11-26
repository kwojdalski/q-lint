// The log viewer's reading of a line (#1004), as data: no `vscode` import,
// so node tests it against lines captured from real TorQ and q processes.
//
// TorQ writes a line as `.lg.format` makes it (torq.q):
//   2026.11.07D12:43:29.643228000|host|proctype|procname|ERROR|id|message
// or, with `-jsonlogs`, `.j.j` of the same fields; and its usage log as
//   time|id|timer|zcmd|proctype|procname|"status"|ip|user|handle|cmd|...
// where status "e" is a failed call. Plain q writes what the code prints,
// so a timestamp and a level word near the start are read where they are,
// and an error is q's own: `'type` (PeachQ) or `'2026.11.21T20:41:03.930
// type` (KDB-X), followed by indented backtrace lines. An indented or blank
// line continues the entry before it.

export const LOG_SCHEME = "q-log";
export const LOG_COMMANDS = {
  open: "q-lint.openLog",
  levels: "q-lint.filterLogLevels",
  processes: "q-lint.filterLogProcesses",
  time: "q-lint.filterLogTime",
  text: "q-lint.filterLogText",
  clear: "q-lint.clearLogFilters",
  follow: "q-lint.toggleLogFollow",
} as const;

/// `q-lint.processes.logViewer.*`: whether the viewer is on, and how many
/// entries a view keeps.
export function readLogViewer(get: <T>(key: string, fallback: T) => T): { enabled: boolean; maxLines: number } {
  const max = get<unknown>("processes.logViewer.maxLines", 10000);
  return {
    enabled: get<unknown>("processes.logViewer.enable", true) !== false,
    maxLines: typeof max === "number" && Number.isInteger(max) && max >= 100 && max <= 1000000 ? max : 10000,
  };
}

export const LOG_VIEWER_OFF = "q-lint: The log viewer is turned off. Set q-lint.processes.logViewer.enable to true to turn it on.";

export type Level = "ERROR" | "WARN" | "INFO" | "DEBUG";
export const LEVELS: readonly Level[] = ["ERROR", "WARN", "INFO", "DEBUG"];

export interface Parsed {
  /// `cont`: a line that continues the entry before it.
  kind: "torq" | "torq-json" | "torq-usage" | "q" | "cont";
  level?: Level;
  /// The process named on the line (TorQ's procname).
  process?: string;
  /// Milliseconds since the epoch, the time on the line read as UTC.
  time?: number;
  /// Where the timestamp is on the line, for colouring.
  timeSpan?: [number, number];
  /// Where the level word is on the line, for colouring.
  levelSpan?: [number, number];
}

const LEVEL_WORDS: Record<string, Level> = {
  ERROR: "ERROR",
  ERR: "ERROR",
  FATAL: "ERROR",
  CRITICAL: "ERROR",
  WARN: "WARN",
  WARNING: "WARN",
  INFO: "INFO",
  INF: "INFO",
  DEBUG: "DEBUG",
  DBG: "DEBUG",
  TRACE: "DEBUG",
};

/// A level word as a level, ignoring case; undefined for any other word.
export function levelOf(word: string): Level | undefined {
  return LEVEL_WORDS[word.toUpperCase()];
}

const TS = String.raw`\d{4}[.-]\d{2}[.-]\d{2}(?:[DT ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?`;
const TORQ = new RegExp(String.raw`^(\d{4}\.\d{2}\.\d{2}D\d{2}:\d{2}:\d{2}(?:\.\d+)?)\|([^|]*)\|([^|]*)\|([^|]*)\|([A-Za-z]+)\|([^|]*)\|`);
const USAGE = new RegExp(String.raw`^(\d{4}\.\d{2}\.\d{2}D\d{2}:\d{2}:\d{2}(?:\.\d+)?)\|-?\d+\|[^|]*\|\x60?\w*\|\x60?([^|]*)\|\x60?([^|]*)\|"([a-z])"\|`);
const KDBX_ERROR = /^'(\d{4}\.\d{2}\.\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?) /;
const STAMP = new RegExp(String.raw`^\[?(${TS})\]?`);

/// `text` - `2026.11.07D00:00:00.266014000`, `2026.11.21T20:41:03.930`,
/// `2026-11-21 20:41:03`, `2026.11.21` - as milliseconds since the epoch,
/// read as UTC; undefined if it is none of those.
export function timeOf(text: string): number | undefined {
  const m = /^(\d{4})[.-](\d{2})[.-](\d{2})(?:[DT ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(text.trim());
  if (m === null) {
    return undefined;
  }
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "0"] = m;
  const ms = Number(`0.${frac}`) * 1000;
  const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  // Date.UTC rolls 30 February over to March, 25:61 to the next day: a
  // field it moved was out of range, and is no time (#1436).
  const fields = [at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()];
  if (Number.isNaN(at.getTime()) || fields.some((f, i) => f !== Number([y, mo, d, h, mi, s][i]))) {
    return undefined;
  }
  return at.getTime() + Math.floor(ms);
}

/// `text` as `timeOf` reads it, but as this host's local time: KDB-X stamps
/// an uncaught error with local time, where TorQ's `.lg` lines are UTC
/// (#2595). The offset is the one at that moment, so a stamp either side of
/// a change to or from summer time reads right.
export function localTimeOf(text: string): number | undefined {
  const t = timeOf(text);
  if (t === undefined) {
    return undefined;
  }
  const guess = t + new Date(t).getTimezoneOffset() * 60_000;
  return t + new Date(guess).getTimezoneOffset() * 60_000;
}

/// A time of day, `HH:MM[:SS[.fff]]`, as milliseconds after midnight.
export function timeOfDay(text: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(text.trim());
  if (m === null) {
    return undefined;
  }
  const [, h, mi, s = "0", frac = "0"] = m;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    return undefined;
  }
  return ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Math.floor(Number(`0.${frac}`) * 1000);
}

/// What one line of a log says.
export function parseLine(line: string): Parsed {
  if (line.trim() === "" || /^[ \t]/.test(line)) {
    return { kind: "cont" };
  }
  let m = TORQ.exec(line);
  if (m !== null) {
    const level = levelOf(m[5]);
    const at = m[1].length + m[2].length + m[3].length + m[4].length + 4;
    return {
      kind: "torq",
      ...(level ? { level } : {}),
      process: m[4],
      time: timeOf(m[1]),
      timeSpan: [0, m[1].length],
      levelSpan: [at, at + m[5].length],
    };
  }
  m = USAGE.exec(line);
  if (m !== null) {
    return { kind: "torq-usage", level: m[4] === "e" ? "ERROR" : "INFO", process: m[3], time: timeOf(m[1]), timeSpan: [0, m[1].length] };
  }
  if (line.startsWith("{") && line.includes('"loglevel"')) {
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const level = typeof j.loglevel === "string" ? levelOf(j.loglevel) : undefined;
      const time = typeof j.time === "string" ? timeOf(j.time.replace(/Z$/, "")) : undefined;
      return {
        kind: "torq-json",
        ...(level ? { level } : {}),
        ...(typeof j.proc === "string" ? { process: j.proc } : {}),
        ...(time !== undefined ? { time } : {}),
      };
    } catch {
      // Not JSON after all: read as plain text below.
    }
  }
  m = KDBX_ERROR.exec(line);
  if (m !== null) {
    return { kind: "q", level: "ERROR", time: localTimeOf(m[1]), timeSpan: [1, 1 + m[1].length], levelSpan: [0, line.length] };
  }
  if (line.startsWith("'")) {
    return { kind: "q", level: "ERROR", levelSpan: [0, line.length] };
  }
  const out: Parsed = { kind: "q" };
  let rest = 0;
  const stamp = STAMP.exec(line);
  if (stamp !== null) {
    const t = timeOf(stamp[1]);
    if (t !== undefined) {
      out.time = t;
      const start = line.indexOf(stamp[1]);
      out.timeSpan = [start, start + stamp[1].length];
      rest = stamp[0].length;
    }
  }
  // A level word among the first three words after the timestamp: in
  // capitals, or in brackets or after `level=` in any case.
  const words = /[A-Za-z]+/g;
  words.lastIndex = rest;
  for (let i = 0; i < 3; i++) {
    const w = words.exec(line);
    if (w === null) {
      break;
    }
    const level = levelOf(w[0]);
    const before = line.slice(Math.max(0, w.index - 6), w.index);
    if (level && (w[0] === w[0].toUpperCase() || /(\[|<|level=)$/i.test(before))) {
      out.level = level;
      out.levelSpan = [w.index, w.index + w[0].length];
      break;
    }
  }
  return out;
}

/// The process a log file is from, by TorQ's names for its logs -
/// `out_rdb1_2026_11_05_00_00_00_175.log`, `err_rdb1.log`,
/// `usage_rdb1_2026.11.05.log` - else the file's name without extension.
export function processFromFile(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  const m = /^(?:out|err|usage)_(.+?)(?:_\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{3}|_\d{4}\.\d{2}\.\d{2})?\.log$/.exec(name);
  if (m !== null) {
    return m[1];
  }
  return name.replace(/\.[^.]*$/, "") || name;
}

/// One entry of a log: its first line and the lines that continue it.
export interface Entry {
  lines: string[];
  level?: Level;
  process: string;
  time?: number;
  /// The file it is from.
  file: string;
  kind: Parsed["kind"];
  timeSpan?: [number, number];
  levelSpan?: [number, number];
}

/// What a log view shows: entries of these levels and processes (empty: any),
/// at or after `from` and at or before `to` (each a full time or a time of
/// day), and with `text` in a line.
export interface Filter {
  levels: Level[];
  processes: string[];
  from?: string;
  to?: string;
  text?: string;
}

export const NO_FILTER: Filter = { levels: [], processes: [] };

/// `bound` (a time or time of day, as typed) compared with `time`: -1 if
/// `time` is before it, 0 at, 1 after; undefined if it cannot be read.
function compare(time: number, bound: string): number | undefined {
  const full = timeOf(bound);
  if (full !== undefined) {
    return Math.sign(time - full);
  }
  const day = timeOfDay(bound);
  if (day !== undefined) {
    const msOfDay = ((time % 86400000) + 86400000) % 86400000;
    return Math.sign(msOfDay - day);
  }
  return undefined;
}

/// Whether a time filter's bound is one this reads.
export function validBound(bound: string): boolean {
  return bound.trim() === "" || timeOf(bound) !== undefined || timeOfDay(bound) !== undefined;
}

/// Whether `entry` passes `filter`. An entry with no level is left out by a
/// level filter, and one with no time by a time filter.
export function matches(entry: Entry, filter: Filter): boolean {
  if (filter.levels.length > 0 && (entry.level === undefined || !filter.levels.includes(entry.level))) {
    return false;
  }
  if (filter.processes.length > 0 && !filter.processes.includes(entry.process)) {
    return false;
  }
  for (const [bound, after] of [
    [filter.from, true],
    [filter.to, false],
  ] as const) {
    if (bound === undefined || bound.trim() === "") {
      continue;
    }
    if (entry.time === undefined) {
      return false;
    }
    const c = compare(entry.time, bound);
    if (c !== undefined && (after ? c < 0 : c > 0)) {
      return false;
    }
  }
  if (filter.text && !entry.lines.some((l) => l.toLowerCase().includes(filter.text!.toLowerCase()))) {
    return false;
  }
  return true;
}

/// The filter in words, for the status bar; empty when there is none.
export function filterText(filter: Filter): string {
  const parts: string[] = [];
  if (filter.levels.length > 0) parts.push(filter.levels.join(","));
  if (filter.processes.length > 0) parts.push(filter.processes.join(","));
  if (filter.from || filter.to) parts.push(`${filter.from || "..."}-${filter.to || "..."}`);
  if (filter.text) parts.push(`"${filter.text}"`);
  return parts.join(" · ");
}

/// Builds entries from the lines of one file as they come: a line either
/// starts an entry or continues the last. `done` gets each entry once it is
/// complete - when the next starts, or on `flush`.
export class EntryBuilder {
  private current: Entry | undefined;
  /// Called with each entry as it starts, before any line continues it.
  onStart: ((entry: Entry) => void) | undefined;
  constructor(
    private readonly file: string,
    private readonly done: (entry: Entry) => void,
    private readonly fileProcess = processFromFile(file),
  ) {}

  push(line: string): void {
    const p = parseLine(line);
    if (p.kind === "cont" && this.current !== undefined) {
      this.current.lines.push(line);
      return;
    }
    this.flush();
    this.current = {
      lines: [line],
      process: p.process ?? this.fileProcess,
      file: this.file,
      kind: p.kind === "cont" ? "q" : p.kind,
      ...(p.level ? { level: p.level } : {}),
      ...(p.time !== undefined ? { time: p.time } : {}),
      ...(p.timeSpan ? { timeSpan: p.timeSpan } : {}),
      ...(p.levelSpan ? { levelSpan: p.levelSpan } : {}),
    };
    this.onStart?.(this.current);
  }

  /// The entry being built, which later lines may still continue.
  get open(): Entry | undefined {
    return this.current;
  }

  flush(): void {
    if (this.current !== undefined) {
      this.done(this.current);
      this.current = undefined;
    }
  }
}

/// Entries from several files in time order: each file's own order kept,
/// an entry with no time after the one before it in its file.
export function merge(lists: Entry[][]): Entry[] {
  if (lists.length === 1) {
    return lists[0];
  }
  const keyed = lists.map((list) => {
    let last = -Infinity;
    return list.map((e) => ((last = e.time ?? last), { e, t: last }));
  });
  const at = keyed.map(() => 0);
  const out: Entry[] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < keyed.length; i++) {
      if (at[i] < keyed[i].length && (best < 0 || keyed[i][at[i]].t < keyed[best][at[best]].t)) {
        best = i;
      }
    }
    if (best < 0) {
      return out;
    }
    out.push(keyed[best][at[best]++].e);
  }
}
