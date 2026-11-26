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

/// A system command's line, other than `\t` and `\ts`, which time q code:
/// the command's own text to its end, where no bracket, quote or comment is
/// q's (`\l /data/x.q`, `\grep -c '(' f`).
export const COMMAND_LINE = /^\\(?!ts?(?:[:\s]|$))\S/;

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

/// How q reads the last of `lines`, a file's lines from its first, before
/// any of its own text: what a reader of one line - a hover, a command at
/// the cursor - needs of the lines above it. `commented`: the whole line is
/// no code, inside a block comment, a `/` or `\` alone that opens or closes
/// one, or at or after a `\` alone that ends the script. `quoted`: it starts
/// inside a string its statement's lines above left open, as the second
/// line of `s:"select` / `  from t"` does.
export function lineContext(lines: string[]): { commented: boolean; quoted: boolean } {
  let depth = 0;
  let quoted = false;
  for (const [i, raw] of lines.entries()) {
    const line = trimBlanks(raw);
    const last = i === lines.length - 1;
    if (depth === 0 && line === "\\") {
      return { commented: true, quoted: false };
    }
    const after = blockDepth(depth, line);
    if (depth > 0 || after > 0) {
      if (last) {
        return { commented: true, quoted: false };
      }
    } else if (continues(line)) {
      if (last) {
        return { commented: false, quoted };
      }
      quoted = stringOpen(quoted, line);
    } else if (line !== "" && !line.startsWith("/")) {
      // It starts a statement, and no string of the one above reaches it.
      quoted = stringOpen(false, line);
    }
    depth = after;
  }
  return { commented: false, quoted: false };
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

/// What `text`, selected in `lines` (a document's) from line `start`, runs:
/// read as the document reads there (#2287). Inside a block comment its
/// lines up to the one that closes it are no code, and after the script's
/// end nothing is.
export function selectionCode(lines: string[], start: number, text: string): string {
  let depth = 0;
  for (let i = 0; i < start && i < lines.length; i++) {
    const line = trimBlanks(lines[i]);
    if (i === 0 && line.startsWith("#!")) {
      continue;
    }
    if (depth > 0 || line === "/") {
      depth = blockDepth(depth, line);
    } else if (line === "\\") {
      return "";
    }
  }
  // Those lines are made blank, so each line keeps its number.
  return text
    .split("\n")
    .map((line) => {
      if (depth === 0) {
        return line;
      }
      depth = blockDepth(depth, trimBlanks(line));
      return "";
    })
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

// After any `q)` prompts, and before a trailing comment, as q reads it
// (#2785). A context's name may start with a digit or an underscore, at any
// level: KDB-X switches to `.1a` and `.a._b` (#2916).
const CONTEXT = /^(?:q\))*\\d\s+(\.\w+(?:\.\w+)*|\.)(?:[ \t]+\/.*)?\s*$/;
// The `q)` prompts a statement opens with, which q reads its code after.
const PROMPTS = /^(?:q\))*/;
// `system "d .ns"` with a literal argument switches as `\d .ns` does, as the
// language server reads it (#261), in brackets too, `system["d .ns"]`; a
// computed one leaves the context as it was.
const SYSTEM_D = /system[ \t]*(?:"d[ \t]+(\.\w+(?:\.\w+)*|\.)[ \t]*"|\[[ \t]*"d[ \t]+(\.\w+(?:\.\w+)*|\.)[ \t]*"[ \t]*\])/y;

/// The literal `system "d .ns"` call that starts at `at` of `text`: the
/// context it names, and where the call ends.
function systemContext(text: string, at: number): { context: string; end: number } | undefined {
  SYSTEM_D.lastIndex = at;
  const m = SYSTEM_D.exec(text);
  return m === null ? undefined : { context: m[1] ?? m[2], end: SYSTEM_D.lastIndex };
}

/// The context `statement` switches to - `.ns`, or `.` for the root - when
/// it is a `\d` line or a `system "d .ns"` with a literal name, and nothing
/// else.
export function contextSwitch(statement: string): string | undefined {
  if (statement.includes("\n")) {
    return undefined;
  }
  const line = statement.trim();
  const call = systemContext(line, PROMPTS.exec(line)![0].length);
  return CONTEXT.exec(line)?.[1] ?? (call !== undefined && /^\s*;?\s*(?:\s\/.*)?$/.test(line.slice(call.end)) ? call.context : undefined);
}

/// The context running `statement` leaves q in, when it switches one: a
/// `contextSwitch`, or the last literal `system "d .ns"` among the
/// expressions `;` separates at its top level, as `a:1;system "d .ns"`
/// (#2916). Not one in a lambda or a bracket, which may not run, nor in a
/// string or a comment.
export function contextLeft(statement: string): string | undefined {
  const whole = contextSwitch(statement);
  if (whole !== undefined || statement.startsWith("\\")) {
    return whole;
  }
  let left: string | undefined;
  let depth = 0;
  for (let i = PROMPTS.exec(statement)![0].length; i < statement.length; i++) {
    const c = statement[i];
    const before = statement[i - 1] ?? "\n";
    if (c === '"') {
      for (i++; i < statement.length && statement[i] !== '"'; i++) {
        i += statement[i] === "\\" ? 1 : 0;
      }
    } else if (c === "/" && (before === " " || before === "\t" || before === "\n")) {
      // A comment, to its line's end.
      const end = statement.indexOf("\n", i);
      i = end < 0 ? statement.length : end;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
    } else if (depth === 0 && c === "s" && !/[\w.`]/.test(before)) {
      const call = systemContext(statement, i);
      if (call !== undefined) {
        // `system "d .a",x` is a computed one.
        left = /^[ \t]*(?:;|\n|$|[ \t]\/)/.test(statement.slice(call.end)) ? call.context : left;
        i = call.end - 1;
      }
    }
  }
  return left;
}

/// The context running `code` leaves, started in `context`: q's console
/// keeps a `\d` for the lines typed after it, and a script for the lines
/// after it, where a query is read afresh in the root (#2286).
export function contextAfter(code: string, context = "."): string {
  for (const statement of statements(code)) {
    context = contextLeft(statement) ?? context;
  }
  return context;
}

/// `cut`, statements to run, run in `context` as its text would be after
/// what left that context: a `\d` in front of them. q reads each query in
/// the root again, so no `\d .` is needed after them.
export function inContext(cut: string[], context: string): string[] {
  return context === "." ? cut : [`\\d ${context}`, ...cut];
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
