// How the query history shows an entry: its tooltip.
// Free of any `vscode` import, so node tests it; `live.ts` is the VS Code
// around it.

/// `text` as Markdown that shows it as written: every character Markdown
/// could read as syntax is escaped.
export function markdownText(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|~<>&]/g, (c) => `\\${c}`);
}

/// The Markdown above a history row's code: the process, when, how long, and
/// q's error, each shown as written.
export function historyHeading(entry: { process: string; millis: number; error?: string; agent?: true }, when: string): string {
  const heading = markdownText(`${entry.process}, ${when}, ${entry.millis} ms${entry.agent ? ", run by an agent" : ""}`);
  return entry.error === undefined ? heading : `${heading}\n\n${markdownText(`'${entry.error}`)}`;
}
