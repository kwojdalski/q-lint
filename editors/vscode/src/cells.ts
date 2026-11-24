// Code cells in a q file (#956), and where the statement after the cursor's
// starts, for Smart Send (#957).
//
// A cell starts at a line that begins `/ %%` (or `/%%`) at column 0, as a
// Python file's cell starts at `# %%`. To q that line is a comment - a line
// starting with `/` - so a file of cells loads as it always did. The rules
// for what is a comment are those of `statements.ts`, which are q's: a line
// that is `/` alone opens a block comment that `\` alone closes, `\` alone
// outside one ends the script, and a first line starting `#!` is skipped.
// So a `/ %%` line inside a block comment, after the script's end, or
// indented (a continuation line) marks nothing. Nor does one between a
// statement and its indented continuation lines: q skips a comment there
// without ending the statement (`f:{x+` / `/ %%` / `  y}` defines f), and a
// cell cut there would send half a statement.

import { blockDepth } from "./statements";

/// The text after `%%` names the cell: `/ %% load the trades`.
const MARKER = /^\/\s*%%(.*)$/;

/// Whether `line` reads as a marker by its text alone: the cheap test for
/// whether a file has cells at all.
export function looksLikeMarker(line: string): boolean {
  return MARKER.test(line);
}

const trimEnd = (line: string): string => line.replace(/\s+$/, "");
const blank = (line: string): boolean => line.trim() === "";
const indented = (line: string): boolean => line.startsWith(" ") || line.startsWith("\t");

/// How q reads each line of `lines`: inside a comment (a block comment, the
/// shebang, after the script's end), a comment line, blank, a continuation
/// line, or code that starts a statement.
type LineKind = "commented" | "comment" | "blank" | "continues" | "starts";

function kinds(lines: string[]): LineKind[] {
  const out: LineKind[] = [];
  let depth = 0;
  let ended = false;
  let open = false;
  for (const [i, raw] of lines.entries()) {
    const line = trimEnd(raw);
    if (ended || (i === 0 && line.startsWith("#!"))) {
      out.push("commented");
    } else if (depth > 0 || line === "/") {
      out.push("commented");
      depth = blockDepth(depth, line);
    } else if (line === "\\") {
      out.push("commented");
      ended = true;
    } else if (blank(line)) {
      out.push("blank");
    } else if (indented(line) && open) {
      out.push("continues");
    } else if (line.startsWith("/")) {
      out.push("comment");
    } else {
      out.push("starts");
      open = true;
    }
  }
  return out;
}

export interface Cell {
  /// Lines, 0-based and inclusive. A cell with a marker starts at it.
  start: number;
  end: number;
  /// The marker's line, absent for the lines above the first marker.
  marker?: number;
  /// The text after `%%`, trimmed; "" when there is none.
  title: string;
}

/// The lines of `lines` that are cell markers, by q's reading of them.
export function markers(lines: string[]): number[] {
  const kind = kinds(lines);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (kind[i] !== "comment" || !MARKER.test(trimEnd(lines[i]))) {
      continue;
    }
    // A marker inside a statement - an indented line follows it, past
    // blanks, comments and block comments - is a comment in the statement,
    // not a cell.
    let next = i + 1;
    while (next < lines.length && (kind[next] === "blank" || kind[next] === "comment" || kind[next] === "commented")) {
      next++;
    }
    if (next < lines.length && kind[next] === "continues") {
      continue;
    }
    out.push(i);
  }
  return out;
}

/// The cells of `lines`: none when no line is a marker. The lines above
/// the first marker are a cell of their own when a statement starts there,
/// as code a later cell may need.
export function cells(lines: string[]): Cell[] {
  const at = markers(lines);
  if (at.length === 0) {
    return [];
  }
  const kind = kinds(lines);
  const out: Cell[] = [];
  if (kind.slice(0, at[0]).includes("starts")) {
    out.push({ start: 0, end: at[0] - 1, title: "" });
  }
  for (const [k, line] of at.entries()) {
    const end = (at[k + 1] ?? lines.length) - 1;
    out.push({ start: line, end, marker: line, title: (MARKER.exec(trimEnd(lines[line]))?.[1] ?? "").trim() });
  }
  return out;
}

/// The cell `line` is in; undefined when the file has no cells or the line
/// is above the first marker with no statement there.
export function cellAt(all: Cell[], line: number): Cell | undefined {
  return all.find((c) => c.start <= line && line <= c.end);
}

/// The code of `cell`, as the lines it spans.
export function cellCode(lines: string[], cell: Cell): string {
  return lines.slice(cell.start, cell.end + 1).join("\n");
}

/// A cell's code as the Interactive Window shows it: without its marker
/// line and the blank lines around it.
export function shownCode(code: string, cell: Pick<Cell, "marker">): string {
  const lines = code.split(/\r?\n/);
  const body = cell.marker === undefined ? lines : lines.slice(1);
  return body.join("\n").replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/// A cell's name for the Interactive Window and a lens's tooltip: its
/// title, else "Cell n" (1-based, counting the lines above the first
/// marker when they are one).
export function cellName(all: Cell[], cell: Cell): string {
  return cell.title !== "" ? cell.title : `Cell ${all.indexOf(cell) + 1}`;
}

/// The first line after `after` that starts a statement, as q reads the
/// file; undefined when none does. Smart Send moves the cursor there.
export function nextStatement(lines: string[], after: number): number | undefined {
  const kind = kinds(lines);
  for (let i = after + 1; i < lines.length; i++) {
    if (kind[i] === "starts") {
      return i;
    }
  }
  return undefined;
}

/// What Smart Send does with the cursor on `line`: the statement it sends
/// (lines, inclusive), none on a blank or comment line, and the line it
/// moves the cursor to - the next statement's first, or the line after
/// the last statement when no other follows.
export function smartStep(
  lines: string[],
  line: number,
  blockAt: (lines: string[], line: number) => { start: number; end: number } | undefined,
): { send?: { start: number; end: number }; next: number } {
  const send = blockAt(lines, line);
  const from = send?.end ?? line;
  const next = nextStatement(lines, from) ?? Math.min(from + 1, Math.max(lines.length - 1, 0));
  return send === undefined ? { next } : { send, next };
}
