// Inline results after Run Line (#1047), as data: the short form of a
// query's answer, drawn at the end of the line it came from, and which
// drawn results an edit wipes. Free of any `vscode` import, so node tests
// it; `inlineresultview.ts` draws them.
import type { GridAnswer } from "./grid";

/// The most characters a result shows at the end of a line.
export const INLINE_WIDTH = 80;

/// An answer to a query run from an editor's line or selection, and where.
export interface Answered {
  process: string;
  answer: GridAnswer;
  millis: number;
  uri: string;
  /// 0-based: the line the result is drawn at the end of.
  line: number;
  /// The document's version when it was sent: edits since move the line.
  version?: number;
}

/// The answer as one short line: q's console text joined, or the error.
export function shortForm(answer: GridAnswer, width = INLINE_WIDTH): string {
  let text: string;
  if (!answer.ok) {
    text = `'${answer.error}`;
  } else {
    const joined = answer.text
      .map((l) => l.trim())
      .filter((l) => l !== "" && !/^-+$/.test(l))
      .join("  ");
    text = joined !== "" ? joined : answer.grid !== undefined ? `${answer.grid.count} row${answer.grid.count === 1 ? "" : "s"}` : "::";
  }
  const one = text.replace(/\s+/g, " ");
  // Counted and cut by code points, so no surrogate pair is split (#1428).
  const chars = Array.from(one);
  return chars.length > width ? `${chars.slice(0, width - 3).join("")}...` : one;
}

/// The most characters of q's output the hover shows.
export const HOVER_WIDTH = 2000;

/// The hover's code block: q's output, its first `HOVER_WIDTH` characters
/// - by code point, as the short form cuts (#1810) - or the error. Twice
/// as many UTF-16 units always hold them, so no more are split.
export function hoverForm(answer: GridAnswer): string {
  return answer.ok ? Array.from(answer.text.join("\n").slice(0, 2 * HOVER_WIDTH)).slice(0, HOVER_WIDTH).join("") : `'${answer.error}`;
}

/// The lines an edit from line `start` to `end` (0-based, inclusive) that
/// adds `added` line breaks leaves results on: each drawn line it does not
/// touch, moved by the lines it added or removed. A touched line's result
/// is gone.
export function shiftLines(lines: number[], start: number, end: number, added: number): number[] {
  const delta = added - (end - start);
  return lines.filter((l) => l < start || l > end).map((l) => (l > end ? l + delta : l));
}
