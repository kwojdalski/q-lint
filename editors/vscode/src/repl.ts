// The input side of the q REPL pane (#959): when Enter runs what was typed
// and when it starts another line, how lines typed inside a bracket reach q,
// the word Tab completes and what it offers, and the history and its search.
// Nothing here touches VS Code or a process.

import { blockDepth } from "./statements";

/// Whether each `(`, `[` and `{` of `text` is closed and no string is left
/// open: then Enter runs it, else it starts a new line, as the Julia REPL
/// does. Brackets inside a string or a comment do not count: a string is
/// `"..."` with `\` escapes, and a comment runs from a `/` at the start of
/// a line, or after a space or a tab, to the line's end, as q reads it, or
/// a block from a line of `/` alone, outside any bracket, to one of `\`
/// alone - blocks nest, as q reads them.
export function isComplete(text: string): boolean {
  const { depth, inString } = scan(text);
  return depth <= 0 && !inString;
}

/// The open bracket depth at the end of `text`, and whether a string is
/// still open there.
function scan(text: string): { depth: number; inString: boolean } {
  let depth = 0;
  let inString = false;
  let inComment = false;
  let block = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      inComment = false;
      continue;
    }
    // A line of `/` alone opens a block comment, and one of `\` alone
    // closes it (#1111); inside one a `/` alone opens another (#1500).
    if ((i === 0 || text[i - 1] === "\n") && !inString) {
      const end = text.indexOf("\n", i);
      const line = text.slice(i, end < 0 ? text.length : end).trimEnd();
      if (block > 0 || (depth <= 0 && line === "/")) {
        const after = blockDepth(block, line);
        if (after !== block) {
          block = after;
          inComment = true;
          continue;
        }
      }
    }
    if (inComment || block > 0) {
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    const before = i === 0 ? "\n" : text[i - 1];
    if (ch === "/" && (before === "\n" || before === " " || before === "\t")) {
      inComment = true;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
    }
  }
  return { depth, inString };
}

/// `text` as a script q reads the way it was typed: a line that starts
/// inside an open bracket or string continues the statement above, so it
/// is indented - in a script a line at column 0 starts a new statement,
/// and `f:{x+` then `y}` would be two. Lines outside any bracket are left
/// as they are, each its own statement.
export function replScript(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let sofar = "";
  for (const [i, line] of lines.entries()) {
    const { depth, inString } = i === 0 ? { depth: 0, inString: false } : scan(sofar);
    const inside = depth > 0 || inString;
    out.push(inside && line !== "" && !line.startsWith(" ") && !line.startsWith("\t") ? ` ${line}` : line);
    sofar += (i === 0 ? "" : "\n") + line;
  }
  return out.join("\n");
}

const NAME = /[A-Za-z0-9_.]/;

/// The name being typed at `caret` in `text`: where it starts and what of
/// it is there. Undefined when the caret is not after a name's start - a
/// letter or a dot, which a q name begins with.
export function wordAt(text: string, caret: number): { start: number; prefix: string } | undefined {
  let start = caret;
  while (start > 0 && NAME.test(text[start - 1])) {
    start--;
  }
  const prefix = text.slice(start, caret);
  if (prefix === "" || !/^[A-Za-z.]/.test(prefix)) {
    return undefined;
  }
  return { start, prefix };
}

export interface Completion {
  label: string;
  /// Where it is from: "q", "workspace" or the process's label.
  detail: string;
}

/// The candidates that start with `prefix`, each label once (the first
/// source to give it wins), shortest first and then in order, at most
/// `limit` of them.
export function completionsFor(prefix: string, candidates: Completion[], limit = 50): Completion[] {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const c of candidates) {
    if (c.label.startsWith(prefix) && c.label !== prefix && !seen.has(c.label)) {
      seen.add(c.label);
      out.push(c);
    }
  }
  return out.sort((a, b) => a.label.length - b.label.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)).slice(0, limit);
}

/// How many inputs the REPL keeps.
export const HISTORY_LIMIT = 500;

/// `history` (newest first) with `code` added at the front: once, so
/// running the same line again does not fill the history with it.
export function pushHistory(history: string[], code: string, limit = HISTORY_LIMIT): string[] {
  const trimmed = code.replace(/\s+$/, "");
  if (trimmed === "") {
    return history;
  }
  return [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, limit);
}

/// The index of the first entry of `history` (newest first) from `from`
/// on that contains `query`, as a shell's reverse search finds; -1 when
/// none does. Ctrl+R again searches on from the one after.
export function searchHistory(history: string[], query: string, from = 0): number {
  if (query === "") {
    return -1;
  }
  for (let i = Math.max(0, from); i < history.length; i++) {
    if (history[i].includes(query)) {
      return i;
    }
  }
  return -1;
}
