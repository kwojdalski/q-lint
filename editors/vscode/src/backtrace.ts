// Clickable q backtraces (#983), as data: the frames of a backtrace as
// `.Q.sbt` prints it - in a query's output, from `.Q.trp`, and in a q
// console after an error under `\e 1` - and the file and line each points
// at. Free of any `vscode` import, so node tests it; `backtraceview.ts`
// makes the links.
//
// A frame is a header line, `  [n]  file:line: code`, the code's further
// lines, and a line holding only a `^` under where it failed. The two
// interpreters print it differently (captured from both):
//
//   KDB-X                                 PeachQ
//   [5]  /w/lib.q:5: mid:                 [4]  /w/lib.q:3: mid:{[a]
//     b:a+1;                                b:a+1;
//     c:b+`x;                               c:b+`x;
//        ^                                     ^
//     d:c*2;                                d:c*2;
//                                           d}
//
// KDB-X's line is the line that failed, and it shows a few lines around it;
// PeachQ's is the line the function starts on, and it shows all of it. So
// the line that failed is KDB-X's line, or PeachQ's plus the lines before
// the `^`: when the file can be read, whichever holds the text above the `^`
// is taken. A frame with no file - a function defined over IPC, `(.Q.trp)`,
// the console's own `[0]` - has none, but its name, when its code starts
// `name:`, can still be looked up.

export interface Frame {
  /// Its `[n]`.
  index: number;
  /// The line of the text it starts on, from 0.
  at: number;
  /// The file and the line (from 1) the header names, and where in the
  /// header line they are written.
  file?: string;
  line?: number;
  span?: { start: number; end: number };
  /// The name it was defined as, when its code starts `name:`.
  name?: string;
  /// Its code: the header's after `file:line: `, then the lines after it.
  code: string[];
  /// Which of `code` the `^` is under, and its column there.
  failed?: { index: number; column: number };
}

const HEADER = /^(\s*\[(\d+)\]\s\s)(.*)$/;
const LOCATED = /^(.+?):(\d+): (.*)$/;
const NAME = /^(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*:(?!:)/;
const CARET = /^(\s*)\^\s*$/;

/// The frames in `text`, in the order printed: innermost first.
export function parseBacktrace(text: string): Frame[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const frames: Frame[] = [];
  let current: { frame: Frame; prefix: number } | undefined;
  for (const [i, line] of lines.entries()) {
    const header = HEADER.exec(line);
    if (header !== null) {
      const rest = header[3];
      const located = LOCATED.exec(rest);
      const frame: Frame = { index: Number(header[2]), at: i, code: [] };
      let codeAt = header[1].length;
      if (located !== null && !located[1].startsWith("(")) {
        frame.file = located[1];
        frame.line = Number(located[2]);
        frame.span = { start: header[1].length, end: header[1].length + located[1].length + 1 + located[2].length };
        codeAt += located[1].length + located[2].length + 3;
        frame.code.push(located[3]);
      } else {
        frame.code.push(rest);
      }
      const name = NAME.exec(frame.code[0]);
      if (name !== null) {
        frame.name = name[1];
      }
      current = { frame, prefix: codeAt };
      frames.push(frame);
      continue;
    }
    if (current === undefined) {
      continue;
    }
    const caret = CARET.exec(line);
    if (caret !== null && current.frame.failed === undefined) {
      const index = current.frame.code.length - 1;
      current.frame.failed = { index, column: Math.max(0, caret[1].length - (index === 0 ? current.prefix : 0)) };
      continue;
    }
    if (line.trim() === "" && keepsBlank(lines, i)) {
      // A lambda's own blank line: q prints it, and code or the `^` follows
      // (#1124).
      current.frame.code.push(line);
      continue;
    }
    if (line.trim() === "" || /^q\)+/.test(line) || /^'/.test(line)) {
      // A blank line, a console prompt or the next error ends the frame.
      current = undefined;
      continue;
    }
    current.frame.code.push(line);
  }
  return frames;
}

/// Whether the blank line `i` is inside a frame: the next line that is not
/// blank is indented code or a `^`, not a header, a prompt or an error.
function keepsBlank(lines: string[], i: number): boolean {
  let j = i + 1;
  while (j < lines.length && lines[j].trim() === "") {
    j++;
  }
  return j < lines.length && !HEADER.test(lines[j]) && (/^\s/.test(lines[j]) || CARET.test(lines[j]));
}

/// The line that failed, from 0, in the file a frame names, whose text is
/// `file` when it could be read; and the column, when known.
export function failedAt(frame: Frame, file?: string): { line: number; character: number } {
  const named = Math.max(0, (frame.line ?? 1) - 1);
  if (frame.failed === undefined) {
    return { line: named, character: 0 };
  }
  const { index, column } = frame.failed;
  // The column is the line's only once the line is known: the header's own,
  // or one the file shows holds the text above the `^`.
  let line = named;
  let known = index === 0;
  if (file !== undefined && index > 0) {
    const lines = file.replace(/\r\n/g, "\n").split("\n");
    const want = frame.code[index].trim();
    if (lines[named]?.trim() === want) {
      known = true;
    } else if (lines[named + index]?.trim() === want) {
      line = named + index;
      known = true;
    }
  }
  return { line, character: known ? column : 0 };
}

/// Of `candidates` (paths), the one sharing the most trailing segments with
/// `path`, the file name at least; undefined when none does. A process on
/// another machine prints its own paths.
export function bestSuffixMatch(path: string, candidates: string[]): string | undefined {
  const segments = (p: string): string[] => p.split(/[\\/]+/).filter((s) => s !== "");
  const want = segments(path);
  let best: string | undefined;
  let score = 0;
  for (const candidate of candidates) {
    const have = segments(candidate);
    let n = 0;
    while (n < want.length && n < have.length && want[want.length - 1 - n] === have[have.length - 1 - n]) {
      n++;
    }
    if (n > score) {
      score = n;
      best = candidate;
    }
  }
  return best;
}

/// A link in one line of a terminal: where, and what it names.
export interface LineLink {
  start: number;
  length: number;
  file: string;
  line: number;
}

/// The `file:line` of a frame's header, when `line` is one: a terminal is
/// read a line at a time, so only the header's line is known there.
export function headerLink(line: string): LineLink | undefined {
  const frames = parseBacktrace(line);
  const frame = frames[0];
  if (frame?.file === undefined || frame.span === undefined || frame.line === undefined) {
    return undefined;
  }
  return { start: frame.span.start, length: frame.span.end - frame.span.start, file: frame.file, line: frame.line };
}
