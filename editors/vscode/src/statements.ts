// Code from the editor, cut into the statements q would run.
//
// A query sends q a list of statements, not the text: `value` reads one
// statement, and a newline inside the string does not end one, so
// `value "a:1\nb:a+1"` fails with 'b. The rules are those q applies when it
// loads a script, so a block that loads from a file runs the same as a query:
// a line that starts with a space or a tab continues the statement above it -
// a closing `}` at column 0 starts a new one, which q refuses, here as there -
// a line that starts with `/` is a comment, `/` alone opens a block comment
// that `\` alone closes - and block comments nest, so inside one a `/` alone
// opens another (checked on KDB-X) - and `\` alone outside one ends the
// script. A comment
// is skipped without ending the statement around it: an indented line after
// one still continues the statement above it. A first line starting `#!`
// is skipped too, as q skips a script's shebang line.

/// Whether `line` is read as part of the statement above it.
function continues(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("\t");
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

function blank(line: string): boolean {
  return line.trim() === "";
}

/// The statements of `text`, in order, each with its continuation lines
/// joined by newlines.
export function statements(text: string): string[] {
  const out: string[] = [];
  let current: string[] | undefined;
  // Whether a string is open at the end of the statement so far.
  let quoted = false;
  let depth = 0;
  const end = (): void => {
    if (current !== undefined) {
      out.push(current.join("\n"));
      current = undefined;
    }
  };
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+$/, "");
    if (i === 0 && line.startsWith("#!")) {
      continue;
    }
    if (depth > 0 || line === "/") {
      depth = blockDepth(depth, line);
      continue;
    }
    if (line === "\\") {
      // The end of the script: q reads nothing after it.
      break;
    }
    if (blank(line)) {
      // In a string a blank line is part of it, as q reads it (#1465).
      if (quoted && current !== undefined) {
        current.push(line);
      }
      continue;
    }
    if (continues(line) && current !== undefined) {
      current.push(line);
      quoted = stringOpen(quoted, line);
      continue;
    }
    if (line.startsWith("/")) {
      continue;
    }
    end();
    current = [continues(line) ? line.trimStart() : line];
    quoted = stringOpen(false, line);
  }
  end();
  return out;
}

/// The lines, 0-based and inclusive, of the statement the cursor's `line`
/// is in: from the unindented line that starts it (or the file's first code
/// line, indented or not) to its last continuation line. Undefined on a blank or comment line, or inside a block comment.
export function blockAt(lines: string[], line: number): { start: number; end: number } | undefined {
  const at = (i: number): string => (lines[i] ?? "").replace(/\s+$/, "");
  // Where block comments are, read from the top.
  const commented: boolean[] = [];
  let depth = 0;
  let ended = false;
  for (let i = 0; i < lines.length; i++) {
    const text = at(i);
    if (ended || (i === 0 && text.startsWith("#!"))) {
      commented.push(true);
    } else if (depth > 0 || text === "/") {
      commented.push(true);
      depth = blockDepth(depth, text);
    } else if (text === "\\") {
      commented.push(true);
      ended = true;
    } else {
      commented.push(false);
    }
  }
  const code = (i: number): boolean =>
    i >= 0 && i < lines.length && !commented[i] && !blank(at(i)) && !at(i).startsWith("/");
  // A comment inside a statement is skipped, as `statements` skips it.
  const skipped = (i: number): boolean => commented[i] || blank(at(i)) || at(i).startsWith("/");
  if (commented[line] ?? true) {
    return undefined;
  }
  if (blank(at(line))) {
    // A blank line is in a statement only when an indented line follows it.
    let next = line + 1;
    while (next < lines.length && skipped(next)) {
      next++;
    }
    if (next >= lines.length || !continues(at(next))) {
      return undefined;
    }
  } else if (!code(line) && !continues(at(line))) {
    return undefined;
  }
  let start = line;
  // Up past continuation lines and the blank and comment lines between
  // them, to the line that starts the statement.
  while (start >= 0) {
    if (!skipped(start) && !continues(at(start))) {
      break;
    }
    start--;
  }
  if (start < 0) {
    // No unindented line above: as `statements` does, q starts the first
    // statement at the first code line, indented or not (#1416).
    start = 0;
    while (start < line && !code(start)) {
      start++;
    }
    if (!code(start)) {
      return undefined;
    }
  } else if (!code(start)) {
    return undefined;
  }
  let end = line;
  for (let i = line + 1; i < lines.length; i++) {
    if (skipped(i)) {
      continue;
    }
    if (!continues(at(i))) {
      break;
    }
    end = i;
  }
  return { start, end };
}
