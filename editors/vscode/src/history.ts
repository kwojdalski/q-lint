// How the query history shows an entry: its row's label and its tooltip.
// Free of any `vscode` import, so node tests it; `live.ts` is the VS Code
// around it.

/// `text` as Markdown that shows it as written: every character Markdown
/// could read as syntax is escaped.
export function markdownText(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|~<>&]/g, (c) => `\\${c}`);
}

/// The longest label a history row or Run Again's pick shows, in characters.
export const LABEL_LIMIT = 80;

/// The query history as a window shows and writes it (#1619): `entry`
/// first, then what `kept` - this window's copy, which a read just after a
/// write can be ahead of - and `stored` - the shared list, which every
/// window writes - hold between them, each entry once, newest first, none
/// sent at or before `cleared` (when Clear was last run, in any window), at
/// most `limit`.
export function mergedHistory<T extends { at: string; process: string; code: string }>(entry: T | undefined, kept: readonly T[], stored: readonly T[], cleared: string | undefined, limit: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of [...(entry === undefined ? [] : [entry]), ...kept, ...stored]) {
    const key = `${e.at}\u0000${e.process}\u0000${e.code}`;
    if (seen.has(key) || (cleared !== undefined && e.at <= cleared && e !== entry)) {
      continue;
    }
    seen.add(key);
    out.push(e);
  }
  // Stable: entries sent at the same moment keep their order.
  return out.sort((a, b) => (a === entry ? -1 : b === entry ? 1 : a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

/// A query's label: its first line that is not blank, without the CR of a
/// CRLF file, cut to `LABEL_LIMIT` characters - never inside a surrogate
/// pair, which would show a replacement character.
export function historyLabel(code: string): string {
  const first = code.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
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
