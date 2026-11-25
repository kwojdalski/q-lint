// Code from the editor, cut into the statements q would run.
//
// A query sends q a list of statements, not the text: `value` reads one
// statement, and a newline inside the string does not end one, so
// `value "a:1\nb:a+1"` fails with 'b. The rules are those of q's loader, what
// `\l` of the same text runs (checked on KDB-X), so code runs the same as a
// query as it does loaded from a file. Every feature that reads q text - a
// query, a cell, the terminal, the REPL, a test, line timings, drift - reads
// it here, so they cannot read it differently:
//
// - q's blanks are the space, the tab and the carriage return, nothing else:
//   a no-break space or a form feed is a character like any other (#2279).
// - A line that starts with a blank continues the statement above it - a
//   closing `}` at column 0 starts a new one, which q refuses, here as there.
//   A continuation line's leading tab is read as a space, as q reads it
//   (#2280).
// - A line that starts with `/` is a comment; `/` alone opens a block comment
//   that `\` alone closes - and block comments nest, so inside one a `/`
//   alone opens another - and `\` alone outside one ends the script.
// - The blank and comment lines between a statement's lines stay in it, as q
//   keeps them (a lambda's text holds them), a block comment's lines made
//   comment lines as q makes them (#2282). So a comment line inside an open
//   string reaches `value`, which refuses it as `\l` does (#2281).
// - In a script, indented lines before the first statement are skipped
//   (#2278), and so is a first line starting `#!`, as q skips a shebang.
//
// Code that is not a whole script - a selection, a block, a typed query - may
// start with an indented line, a piece of a statement: that line starts the
// first statement, its indent dropped unless that would make it a command
// (`  \\` is no exit in a script, and must not become one).

/// Whether `line` is read as part of the statement above it.
function continues(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("\t");
}

/// `line` without the trailing blanks q drops: spaces, tabs and carriage
/// returns, and no other whitespace (#2279). A loop, not a regular
/// expression, which takes time quadratic in a long run of blanks.
export function trimBlanks(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t" || line[end - 1] === "\r")) {
    end--;
  }
  return line.slice(0, end);
}

/// Whether `line` is blank to q: nothing but spaces, tabs and carriage
/// returns.
export function isBlankLine(line: string): boolean {
  return trimBlanks(line) === "";
}

/// The block-comment depth after `line`, its trailing blanks trimmed, read
/// at `depth` (0 outside every block comment): `/` alone opens one, inside
/// another too, as q nests them, and `\` alone inside one closes the
/// innermost. A `\` alone at depth 0 is the script's end, which is the
/// caller's to handle. Every reader of block comments steps through this.
export function blockDepth(depth: number, line: string): number {
  if (line === "/") {
    return depth + 1;
  }
  return depth > 0 && line === "\\" ? depth - 1 : depth;
}

/// Whether a string is open after `line`, given whether one was open before
/// it: a `"` opens or closes one, `\\` in one escapes the character after it,
/// and a comment - a `/` after a blank outside a string - ends the line.
export function stringOpen(open: boolean, line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (open) {
      if (c === "\\") {
        i++;
      } else if (c === '"') {
        open = false;
      }
    } else if (c === '"') {
      open = true;
    } else if (c === "/" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      break;
    }
  }
  return open;
}

/// How q reads each line of a script: inside a comment (a block comment,
/// the shebang, after the script's end, or an indented line before the
/// first statement), a comment line, blank, a continuation line, or code
/// that starts a statement.
export type LineKind = "commented" | "comment" | "blank" | "continues" | "starts";

/// The kind of each of `lines`, a whole script read from its top.
export function lineKinds(lines: string[]): LineKind[] {
  const out: LineKind[] = [];
  let depth = 0;
  let ended = false;
  let open = false;
  for (const [i, raw] of lines.entries()) {
    const line = trimBlanks(raw);
    if (ended || (i === 0 && line.startsWith("#!"))) {
      out.push("commented");
    } else if (depth > 0 || line === "/") {
      out.push("commented");
      depth = blockDepth(depth, line);
    } else if (line === "\\") {
      out.push("commented");
      ended = true;
    } else if (line === "") {
      out.push("blank");
    } else if (continues(line)) {
      // Before the first statement q skips it (#2278).
      out.push(open ? "continues" : "commented");
    } else if (line.startsWith("/")) {
      out.push("comment");
    } else {
      out.push("starts");
      open = true;
    }
  }
  return out;
}

/// `text`, a whole script, as code that reads the same however it is cut:
/// the indented lines before its first statement, which q skips, made
/// blank (#2278). Running a file sends this.
export function scriptCode(text: string): string {
  const lines = text.split("\n");
  const kinds = lineKinds(lines);
  const first = kinds.indexOf("starts");
  return lines
    .map((line, i) => ((first < 0 || i < first) && kinds[i] === "commented" && continues(trimBlanks(line)) ? "" : line))
    .join("\n");
}

/// A control character q refuses with 'char wherever it is in a script
/// before its end, in a comment too: all but the tab, the line feed, the
/// form feed and the carriage return (checked on KDB-X).
const REFUSED = /[\x00-\x08\x0b\x0e-\x1f]/;

/// One statement: its text, as q runs it, and its first and last lines.
export interface Span {
  text: string;
  start: number;
  end: number;
}

/// The statements of `text`, in order, each with the lines it covers counted
/// from `firstLine`.
export function statementSpans(text: string, firstLine = 0): Span[] {
  const out: Span[] = [];
  let current: Span | undefined;
  // The blank and comment lines since the statement's last line: in it only
  // when a continuation line follows, as q keeps them.
  let pending: string[] = [];
  // A comment line q refuses (`REFUSED`), as the statement it is to
  // `value`, which refuses it too: q stops there, and so does the query.
  let refused: Span | undefined;
  let depth = 0;
  const end = (): void => {
    if (current !== undefined) {
      out.push(current);
      current = undefined;
    }
    if (refused !== undefined) {
      out.push(refused);
      refused = undefined;
    }
    pending = [];
  };
  for (const [i, raw] of text.split("\n").entries()) {
    const line = trimBlanks(raw);
    const at = firstLine + i;
    if (i === 0 && line.startsWith("#!")) {
      continue;
    }
    const comment = depth > 0 || line.startsWith("/") || (current === undefined && continues(line) && line.trimStart().startsWith("/"));
    if (comment && refused === undefined && REFUSED.test(line)) {
      refused = { text: depth > 0 || line === "/" ? `/${line}` : line.trimStart(), start: at, end: at };
      if (current === undefined) {
        end();
      }
    }
    if (depth > 0 || line === "/") {
      // q keeps a block comment in the statement around it as comment
      // lines: `/` and `\` alone as `/`, any other line with a `/` before it.
      if (current !== undefined) {
        pending.push(line === "/" || line === "\\" ? "/" : `/${line.replace(/^\t/, " ")}`);
      }
      depth = blockDepth(depth, line);
      continue;
    }
    if (line === "\\") {
      // The end of the script: q reads nothing after it.
      break;
    }
    if (line === "" || (line.startsWith("/") && current !== undefined)) {
      if (current !== undefined) {
        pending.push(line);
      }
      continue;
    }
    if (continues(line) && current !== undefined) {
      current.text += `\n${[...pending, line.replace(/^\t/, " ")].join("\n")}`;
      current.end = at;
      pending = [];
      // A refused comment line among them is in the statement now.
      refused = undefined;
      continue;
    }
    if (line.startsWith("/")) {
      continue;
    }
    let first = line;
    if (continues(line)) {
      // A piece of a statement, not a script: its indent goes, unless the
      // line would then be a comment or a command.
      const bare = line.trimStart();
      if (bare.startsWith("/")) {
        continue;
      }
      first = bare.startsWith("\\") ? line : bare;
    }
    end();
    current = { text: first, start: at, end: at };
  }
  end();
  return out;
}

/// The statements of `text`, in order, each with its continuation lines
/// joined by newlines.
export function statements(text: string): string[] {
  return statementSpans(text).map((s) => s.text);
}

/// The lines, 0-based and inclusive, of the statement the cursor's `line`
/// is in: from the unindented line that starts it to its last continuation
/// line. Undefined on a comment line, inside a block comment, before the
/// script's first statement, and on a blank line no continuation line
/// follows.
export function blockAt(lines: string[], line: number): { start: number; end: number } | undefined {
  const kind = lineKinds(lines);
  // A comment inside a statement is skipped, as `statements` skips it.
  const skipped = (i: number): boolean => kind[i] === "commented" || kind[i] === "blank" || kind[i] === "comment";
  const at = kind[line];
  if (at === undefined || at === "commented" || at === "comment") {
    return undefined;
  }
  if (at === "blank") {
    // A blank line is in a statement only when an indented line follows it.
    let next = line + 1;
    while (next < lines.length && skipped(next)) {
      next++;
    }
    if (kind[next] !== "continues") {
      return undefined;
    }
  }
  let start = line;
  // Up past continuation lines and the blank and comment lines between
  // them, to the line that starts the statement.
  while (start >= 0 && kind[start] !== "starts") {
    start--;
  }
  if (start < 0) {
    return undefined;
  }
  let end = line;
  for (let i = line + 1; i < lines.length; i++) {
    if (skipped(i)) {
      continue;
    }
    if (kind[i] !== "continues") {
      break;
    }
    end = i;
  }
  return { start, end };
}
