// How the query history shows an entry: its row's label and its tooltip.
// Free of any `vscode` import, so node tests it; `live.ts` is the VS Code
// around it.
import { contextSwitch } from "./statements";

/// `text` as Markdown that shows it as written: every character Markdown
/// could read as syntax is escaped.
export function markdownText(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|~<>&]/g, (c) => `\\${c}`);
}

/// The longest label a history row or Run Again's pick shows, in characters.
export const LABEL_LIMIT = 80;

/// The most code the query history holds, in characters, over all its
/// entries: it is written to `globalState` whole at every query and read at
/// every start, and 200 runs of a 1 MB file were over 200 MB there (#1880).
export const HISTORY_CHARS = 500_000;

/// The query history as a window shows and writes it (#1619): `entry`
/// first, then what `kept` - this window's copy, which a read just after a
/// write can be ahead of - and `stored` - the shared list, which every
/// window writes - hold between them, each entry once, newest first, none
/// ended at or before `cleared` (when Clear was last run, in any window): a
/// query still running at the Clear is recorded after it, and kept (#2555), at
/// most `limit`, and no more than `chars` characters of code between them:
/// the newest that fit. A query longer than `chars` by itself is left out,
/// never kept cut - Run Again would run something else (#1880).
export function mergedHistory<T extends { at: string; process: string; code: string; millis?: number }>(
  entry: T | undefined,
  kept: readonly T[],
  stored: readonly T[],
  cleared: string | undefined,
  limit: number,
  chars = HISTORY_CHARS,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of [...(entry === undefined ? [] : [entry]), ...kept, ...stored]) {
    if (e.code.length > chars) {
      continue;
    }
    const key = `${e.at}\u0000${e.process}\u0000${e.code}`;
    if (seen.has(key) || (cleared !== undefined && endedAt(e) <= cleared && e !== entry)) {
      continue;
    }
    seen.add(key);
    out.push(e);
  }
  // Stable: entries sent at the same moment keep their order.
  out.sort((a, b) => (a === entry ? -1 : b === entry ? 1 : a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  let room = chars;
  const fits = out.findIndex((e) => (room -= e.code.length) < 0);
  return out.slice(0, Math.min(limit, fits < 0 ? out.length : fits));
}

/// When an entry's query ended, as an ISO string: `at` and its `millis`
/// on; `at` itself when either cannot be read.
function endedAt(e: { at: string; millis?: number }): string {
  const sent = Date.parse(e.at);
  return Number.isNaN(sent) || typeof e.millis !== "number" || !Number.isFinite(e.millis) || e.millis <= 0
    ? e.at
    : new Date(sent + e.millis).toISOString();
}

/// The query history as `globalState` holds it: only entries that are
/// objects with a string `code`, `process` and `at`. One `null`, or one
/// without code, threw at every read and every query recorded after it, so
/// nothing new was ever stored (#2509); the REPL's history is read so too.
export function parseQueryHistory<T extends { at: string; process: string; code: string }>(stored: unknown): T[] {
  return Array.isArray(stored)
    ? stored.filter((e): e is T => {
        const entry = e as Record<string, unknown> | null;
        return typeof entry === "object" && entry !== null && typeof entry.code === "string" && typeof entry.process === "string" && typeof entry.at === "string";
      })
    : [];
}

/// When Clear was last run, as a window recording a query sent at `at`
/// reads the `stored` stamp at `now`; undefined when none is stored. A
/// stamp after `now` was written while the clock was ahead: every query
/// sent since it was put right is "at or before" that Clear, so the history
/// held only the last one until the date passed the stamp (#1882). Such a
/// stamp is read as the moment before the query, and the caller stores
/// that in its place: what was cleared stays cleared, and the query is kept.
export function clearedStamp(stored: unknown, at: string, now: Date): string | undefined {
  if (typeof stored !== "string") {
    return undefined;
  }
  if (!(stored > now.toISOString())) {
    return stored;
  }
  const sent = Date.parse(at);
  return new Date(Math.min(Number.isNaN(sent) ? Infinity : sent, now.getTime()) - 1).toISOString();
}

/// A query's label: its first line that is not blank, without the CR of a
/// CRLF file, cut to `LABEL_LIMIT` characters - never inside a surrogate
/// pair, which would show a replacement character. The `\d` a query is
/// kept behind is not the query: its label is the line after (#2915).
export function historyLabel(code: string): string {
  const lines = code.split(/\r?\n/).filter((line) => line.trim() !== "");
  const first = (lines.length > 1 && contextSwitch(lines[0]) !== undefined ? lines[1] : (lines[0] ?? "")).trim();
  const chars = Array.from(first);
  return chars.length > LABEL_LIMIT ? `${chars.slice(0, LABEL_LIMIT - 1).join("")}…` : first;
}

/// The Markdown above a history row's code: the process, when, how long, and
/// q's error, each shown as written.
export function historyHeading(entry: { process: string; millis: number; error?: string; agent?: true }, when: string): string {
  const heading = markdownText(`${entry.process}, ${when}, ${entry.millis} ms${entry.agent ? ", run by an agent" : ""}`);
  return entry.error === undefined ? heading : `${heading}\n\n${markdownText(`'${entry.error}`)}`;
}

/// `text` as the status bar and a quick pick show it as written: they draw
/// `$(name)` as an icon unless it is escaped.
export function iconsEscaped(text: string): string {
  return text.replace(/\$\(/g, "\\$(");
}

/// `text` as a notification shows it as written: VS Code makes
/// `[label](command:...)` in a message a link that runs the command, so a
/// q error or a process label could carry one. A zero-width space between
/// `]` and `(` leaves it text (#1306).
export function plainMessage(text: string): string {
  return text.replace(/\]\(/g, "]\u200b(");
}

/// `text` as a test run's output terminal shows it as written (#2661): it
/// wants CRLF line ends, and runs ESC and other control characters, so
/// each line end becomes CRLF and every other C0 control but tab, and DEL, is shown
/// as its Control Pictures symbol (ESC as U+241B).
export function terminalText(text: string): string {
  return text
    .replace(/\r?\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (c) => String.fromCharCode(c === "\u007f" ? 0x2421 : 0x2400 + c.charCodeAt(0)))
    .replace(/\n/g, "\r\n");
}
