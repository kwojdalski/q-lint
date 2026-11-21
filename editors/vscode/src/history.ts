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
