// Send a result to a q notebook or a Markdown report (#1021), as data: the
// Markdown a result becomes, and where a report's chart image goes. No
// `vscode` import, so node tests it; `resultpanel.ts` does the sending.
//
// A result becomes a line saying where and when it ran, its code in a
// fenced block, its rows shown as a Markdown table (the first MAX_ROWS, the
// cells as the grid shows them), and its chart as an image when one was
// asked for: in a notebook a PNG data URL, which a Markdown cell shows; in a
// report an SVG file beside it, linked by its relative path.
import { toMarkdown } from "./resultexport";
import type { GridPayload } from "./grid";

/// The most rows a result's table is sent with.
export const MAX_ROWS = 500;

export interface ReportResult {
  process: string;
  code: string;
  /// When it ran.
  at: number;
  payload: GridPayload;
  /// The rows shown, in order; all of them when undefined.
  rows?: number[];
  decimals: number;
  /// The cells as their columns' formats show them (#1639).
  formats?: boolean;
}

/// Text as Markdown that shows it as written: its Markdown punctuation
/// escaped, its line breaks spaces.
export function markdownText(text: string): string {
  return text.replace(/\r?\n|\r/g, " ").replace(/([\\`*_{}[\]()#+\-.!|<>~])/g, "\\$1");
}

/// A fence that `code` cannot close: three backticks, or more than the
/// longest run of them in it.
export function fenceFor(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/// The Markdown a result becomes, ending in a blank line, and how many of
/// its rows the table holds. `image`: the chart's link, already a path or a
/// data URL.
export function resultMarkdown(result: ReportResult, image?: string): { text: string; rows: number; total: number } {
  const order = result.rows ?? [...Array(result.payload.cells[0]?.length ?? 0).keys()];
  const shown = order.slice(0, MAX_ROWS);
  const when = new Date(result.at).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const fence = fenceFor(result.code);
  const lines = [`**Result** from ${markdownText(result.process)} at ${when}`, "", `${fence}q`, result.code.replace(/\s+$/, ""), fence, ""];
  // A cell's text is shown as text: its `<` is escaped and starts no HTML.
  lines.push(toMarkdown(result.payload, result.decimals, shown, result.formats === true).replace(/\n$/, ""));
  const held = result.payload.cells[0]?.length ?? 0;
  if (shown.length < order.length || result.payload.count > held) {
    const of = Math.max(order.length, result.payload.count);
    lines.push("", `_The first ${shown.length.toLocaleString("en-US")} of ${of.toLocaleString("en-US")} rows._`);
  }
  if (image !== undefined) {
    lines.push("", `![chart](${image})`);
  }
  lines.push("", "");
  return { text: lines.join("\n"), rows: shown.length, total: Math.max(order.length, result.payload.count) };
}

/// Where a report's chart image goes: `<report>-images/chart-<stamp>.svg`
/// beside the report, its stamp the time, with `-2`, `-3` ... when `taken`
/// says the name is used: the path relative to the report's folder, with
/// `/`.
export function imagePath(report: string, at: number, taken: (relative: string) => boolean): string {
  const base = report.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "") || "report";
  const stamp = new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  for (let n = 1; ; n++) {
    const relative = `${base}-images/chart-${stamp}${n > 1 ? `-${n}` : ""}.svg`;
    if (!taken(relative)) {
      return relative;
    }
  }
}

/// A path as a Markdown link's target: each segment percent-encoded, its
/// parentheses too, so a space, `#` or `?` in a name is no fragment or
/// query (#1418).
export function linkTarget(relative: string): string {
  return relative
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29"))
    .join("/");
}
