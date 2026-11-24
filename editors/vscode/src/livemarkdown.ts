// Live values in a notebook's Markdown cells (#949): `{{q: expr}}` in a
// cell's text shows the value of `expr` on the process, read when the code
// cell above it runs - or, for Markdown above every code cell, when the
// first one runs. Free of any `vscode` import, so a test can drive it.
//
// The cell's source is never touched. The values are kept in the cell's
// metadata under `LIVE_KEY`, by expression, and the Markdown renderer's
// extension `media/livemarkdown.js` shows each in place of its expression,
// escaped; an expression with no value yet shows as written. An export to
// HTML (`qnbconvert.ts`) puts them in the same way.
//
// `LIVE` evaluates the expressions with `value`, each on its own so one that
// fails does not lose the rest, and answers with `(1b;text)` or
// `(0b;error)` each: a string or a symbol as its characters, anything else
// as `-3!` writes its first `VALUE_LIMIT` items, cut to `VALUE_LIMIT`
// characters by the process.
// Nothing is defined there.

/// Where a Markdown cell's values are kept in its metadata.
export const LIVE_KEY = "q-lint.liveValues";

/// The most characters of one value the process sends.
export const VALUE_LIMIT = 200;

/// `y`, cut from `x`, with the attributes `x` has.
const ATTR = "{$[98h=type x;flip .z.s'[flip x;flip y];99h=type x;.z.s[key x;key y]!.z.s[value x;value y];(attr x)#y]}";

export const LIVE = [
  "{[es]",
  " {r:@[{(1b;value x)};x;{(0b;x)}];",
  "  if[not r 0;:r];",
  "  v:r 1;",
  // `-3!` of the first VALUE_LIMIT items only, never of a whole table
  // (#1559): each item writes at least one character, so the text kept is
  // the same. A list `sublist` refuses, such as a partitioned table, whole.
  // `sublist` drops an attribute, so the cut list, a table's columns and a
  // dictionary's keys and values get theirs back (#1718).
  `  (1b;${VALUE_LIMIT} sublist $[10h=abs type v;(),v;-11h=type v;string v;-3!$[(type v) within 0 99h;{@[${ATTR}x;y;y]}[v] @[${VALUE_LIMIT} sublist;v;v];v]])} each es}`,
].join("\n");

export type LiveValue = { text: string } | { error: string };

/// What follows a newline that ends a paragraph: a line that is blank.
const BLANK_AFTER = /^[ \t]*\r?\n/;

/// An expression as both sides key it: markdown-it hands the renderer a
/// blockquote's or a list item's lines without their `>` or indent, and
/// CRLF as LF, so each continuation line starts with one space here, as q
/// reads a continued expression (#1788).
export function liveKey(expr: string): string {
  return expr.replace(/\r?\n[ \t>]*/g, "\n ");
}

/// What `expr` stood in for, from text to its `}}`: the expression's start
/// and the index after the `}}`, or undefined when it is never closed.
/// Braces inside it - a lambda, a dictionary - must balance, and a brace in
/// a q string does not count. `media/livemarkdown.js` reads them the same.
export function scanLive(text: string, at: number): { expr: string; end: number } | undefined {
  if (!text.startsWith("{{q:", at)) {
    return undefined;
  }
  let depth = 0;
  let quoted = false;
  for (let i = at + 4; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") {
        i++;
      } else if (c === '"') {
        quoted = false;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === "\n" && BLANK_AFTER.test(text.slice(i + 1))) {
      // A blank line - empty, of spaces and tabs, or a CRLF one - ends a
      // paragraph, and the expression with it (#1468).
      return undefined;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      if (depth === 0) {
        if (text[i + 1] !== "}") {
          return undefined;
        }
        const expr = liveKey(text.slice(at + 4, i).trim());
        return expr === "" ? undefined : { expr, end: i + 2 };
      }
      depth--;
    }
  }
  return undefined;
}

/// An HTML tag, open or closing, as CommonMark reads one inline.
const TAG = /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>/y;

/// The live values, code spans and HTML tags of a line of Markdown's
/// inline text, left to right, as markdown-it reads them: whichever starts
/// first wins, so a q symbol's backtick inside `{{q: ...}}` opens no code
/// span, and a `{{q: ...}}` inside a code span or a tag (#1557) is text. A
/// backslash escapes the character after it.
export function inlineSpans(text: string): { kind: "live" | "code" | "html"; start: number; end: number; expr: string }[] {
  const spans: { kind: "live" | "code" | "html"; start: number; end: number; expr: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    TAG.lastIndex = i;
    const tag = c === "<" ? TAG.exec(text) : null;
    if (c === "\\") {
      i += 2;
    } else if (tag !== null) {
      spans.push({ kind: "html", start: i, end: i + tag[0].length, expr: tag[0] });
      i += tag[0].length;
    } else if (c === "{") {
      const live = scanLive(text, i);
      if (live !== undefined) {
        spans.push({ kind: "live", start: i, end: live.end, expr: live.expr });
        i = live.end;
      } else {
        i++;
      }
    } else if (c === "`") {
      let j = i;
      while (text[j] === "`") {
        j++;
      }
      const run = j - i;
      // The closing run is one exactly as long.
      let close = -1;
      for (let k = j; k < text.length; ) {
        if (text[k] !== "`") {
          k++;
          continue;
        }
        let e = k;
        while (text[e] === "`") {
          e++;
        }
        if (e - k === run) {
          close = k;
          break;
        }
        k = e;
      }
      if (close < 0) {
        i = j;
      } else {
        spans.push({ kind: "code", start: i, end: close + run, expr: text.slice(j, close) });
        i = close + run;
      }
    } else {
      i++;
    }
  }
  return spans;
}

/// `text` with each indented code block (lines of four spaces or a tab in
/// front, not under a paragraph line or a list item) made spaces.
function blankIndented(text: string): string {
  let paragraph = false;
  let list = false;
  let code = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") {
        paragraph = false;
        return line;
      }
      const indented = /^(?: {4}|\t)/.test(line);
      if (indented && (code || (!paragraph && !list))) {
        code = true;
        return " ".repeat(line.length);
      }
      code = false;
      if (!indented) {
        list = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line);
      }
      // A heading, a rule or a setext underline ends what came before: an
      // indented line after it is code (#1558). An underline is one only
      // under a paragraph line; else `==` or `--` is a paragraph's (#1722).
      const ends = /^ {0,3}(?:#{1,6}(?:\s|$)|([-*_])(?:\s*\1){2,}\s*$)/.test(line) || (paragraph && /^ {0,3}(?:=+|-+)\s*$/.test(line));
      paragraph = indented || !ends;
      return line;
    })
    .join("\n");
}

/// The block-level tags that open an HTML block, which a paragraph's line
/// may too (CommonMark 4.6, kind 6).
const BLOCK_TAGS = new Set(
  ("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure " +
    "footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option " +
    "p param search section summary table tbody td tfoot th thead title tr track ul").split(" "),
);

/// `text` with each HTML block made spaces (#1557): one opened by `<pre`,
/// `<script`, `<style` or `<textarea` to the line closing it, and one
/// opened by a block-level tag, or by a tag alone on a line not under a
/// paragraph line, to a blank line.
function blankHtml(text: string): string {
  const lines = text.split("\n");
  let paragraph = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i.exec(line);
    const name = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s|\/?>|$)/.exec(line)?.[1].toLowerCase();
    TAG.lastIndex = line.indexOf("<");
    const alone = !paragraph && /^ {0,3}</.test(line) && TAG.exec(line) !== null && line.slice(TAG.lastIndex).trim() === "";
    if (raw !== null) {
      const close = new RegExp(`</${raw[1]}>`, "i");
      let j = i;
      while (j < lines.length - 1 && !close.test(lines[j])) {
        j++;
      }
      for (; i <= j; i++) {
        lines[i] = " ".repeat(lines[i].length);
      }
      i--;
      paragraph = false;
    } else if ((name !== undefined && BLOCK_TAGS.has(name)) || alone) {
      for (; i < lines.length && lines[i].trim() !== ""; i++) {
        lines[i] = " ".repeat(lines[i].length);
      }
      paragraph = false;
    } else {
      paragraph = line.trim() !== "";
    }
  }
  return lines.join("\n");
}

/// The expressions in a Markdown cell's `source`, each once, in order. Ones
/// in a code block, a code span, an HTML comment, an HTML block or a tag
/// are text, as the renderer shows them (#1429, #1557).
export function liveExpressions(source: string): string[] {
  // A fence closes at a line of its character, at least as many, and
  // blanks only after them (#1469): "``` text" inside is content.
  const fenced = source.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1(?:(?<=`)`|(?<=~)~)*[ \t]*\r?$|(?![\s\S]))/gm, (m) => " ".repeat(m.length));
  const prose = blankHtml(blankIndented(fenced)).replace(/<!--[\s\S]*?(?:-->|(?![\s\S]))/g, (m) => m.replace(/[^\n]/g, " "));
  const found: string[] = [];
  for (const span of inlineSpans(prose)) {
    if (span.kind === "live" && !found.includes(span.expr)) {
      found.push(span.expr);
    }
  }
  return found;
}

/// The values `LIVE` answered for `exprs`, by expression. Throws when the
/// answer is not one.
export function readLiveValues(exprs: string[], raw: unknown): Record<string, LiveValue> {
  if (!Array.isArray(raw) || raw.length !== exprs.length) {
    throw new Error(`the process answered something other than ${exprs.length} live values: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const values: Record<string, LiveValue> = {};
  raw.forEach((r, i) => {
    const pair = Array.isArray(r) ? r : [];
    const text = typeof pair[1] === "string" ? pair[1] : Array.isArray(pair[1]) ? pair[1].join("") : String(pair[1] ?? "");
    values[exprs[i]] = pair[0] === true ? { text } : { error: text };
  });
  return values;
}

/// The Markdown cells whose values are read after the code cell at `index`
/// runs: those after it up to the next code cell, and, when it is the first
/// code cell, those above it.
export function markdownAfter(cells: readonly { kind: "code" | "markdown" }[], index: number): number[] {
  const out: number[] = [];
  if (!cells.slice(0, index).some((c) => c.kind === "code")) {
    for (let i = 0; i < index; i++) {
      out.push(i);
    }
  }
  for (let i = index + 1; i < cells.length && cells[i].kind === "markdown"; i++) {
    out.push(i);
  }
  return out;
}

/// The values kept in a cell's metadata, or none.
export function storedValues(metadata: Record<string, unknown> | undefined): Record<string, LiveValue> {
  const v = metadata?.[LIVE_KEY];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, LiveValue>) : {};
}
