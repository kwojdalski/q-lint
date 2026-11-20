// Code from the editor, cut into the statements q would run.
//
// A query sends q a list of statements, not the text: `value` reads one
// statement, and a newline inside the string does not end one, so
// `value "a:1\nb:a+1"` fails with 'b. The rules are those q applies when it
// loads a script, so a block that loads from a file runs the same as a query:
// a line that starts with a space or a tab continues the statement above it -
// a closing `}` at column 0 starts a new one, which q refuses, here as there -
// a line that starts with `/` is a comment, `/` alone opens a block comment
// that `\` alone closes, and `\` alone outside one ends the script.

/// Whether `line` is read as part of the statement above it.
function continues(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("\t");
}

function blank(line: string): boolean {
  return line.trim() === "";
}

/// The statements of `text`, in order, each with its continuation lines
/// joined by newlines.
export function statements(text: string): string[] {
  const out: string[] = [];
  let current: string[] | undefined;
  let inBlock = false;
  const end = (): void => {
    if (current !== undefined) {
      out.push(current.join("\n"));
      current = undefined;
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (inBlock) {
      if (line === "\\") {
        inBlock = false;
      }
      continue;
    }
    if (line === "/") {
      end();
      inBlock = true;
      continue;
    }
    if (line === "\\") {
      // The end of the script: q reads nothing after it.
      break;
    }
    if (blank(line)) {
      continue;
    }
    if (continues(line) && current !== undefined) {
      current.push(line);
      continue;
    }
    if (line.startsWith("/")) {
      end();
      continue;
    }
    end();
    current = [continues(line) ? line.trimStart() : line];
  }
  end();
  return out;
}

/// The lines, 0-based and inclusive, of the statement the cursor's `line`
/// is in: from the unindented line that starts it to its last continuation
/// line. Undefined on a blank or comment line, or inside a block comment.
export function blockAt(lines: string[], line: number): { start: number; end: number } | undefined {
  const at = (i: number): string => (lines[i] ?? "").replace(/\s+$/, "");
  // Where block comments are, read from the top: `/` alone opens one only
  // outside another.
  const commented: boolean[] = [];
  let inBlock = false;
  let ended = false;
  for (let i = 0; i < lines.length; i++) {
    const text = at(i);
    if (ended) {
      commented.push(true);
    } else if (inBlock) {
      commented.push(true);
      inBlock = text !== "\\";
    } else if (text === "/") {
      commented.push(true);
      inBlock = true;
    } else if (text === "\\") {
      commented.push(true);
      ended = true;
    } else {
      commented.push(false);
    }
  }
  const code = (i: number): boolean =>
    i >= 0 && i < lines.length && !commented[i] && !blank(at(i)) && !at(i).startsWith("/");
  if (commented[line] ?? true) {
    return undefined;
  }
  if (blank(at(line))) {
    // A blank line is in a statement only when an indented line follows it.
    let next = line + 1;
    while (next < lines.length && !commented[next] && blank(at(next))) {
      next++;
    }
    if (next >= lines.length || commented[next] || !continues(at(next))) {
      return undefined;
    }
  } else if (!code(line) && !continues(at(line))) {
    return undefined;
  }
  let start = line;
  // Up past continuation lines and the blank lines between them, to the line
  // that starts the statement.
  while (start >= 0) {
    const text = at(start);
    if (commented[start]) {
      return undefined;
    }
    if (!blank(text) && !continues(text)) {
      break;
    }
    start--;
  }
  if (start < 0 || !code(start)) {
    return undefined;
  }
  let end = line;
  for (let i = line + 1; i < lines.length; i++) {
    const text = at(i);
    if (commented[i]) {
      break;
    }
    if (blank(text)) {
      continue;
    }
    if (!continues(text)) {
      break;
    }
    end = i;
  }
  return { start, end };
}
