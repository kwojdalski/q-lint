// Live values in a notebook's Markdown cells (#949): `{{q: expr}}` in a
// cell's text shows the value of `expr` on the process, read when the code
// cell above it runs - or, for Markdown above every code cell, when the
// first one runs. Free of any `vscode` import, so a test can drive it.
//
// The cell's source is never touched. The values are kept in the cell's
// metadata under `LIVE_KEY`, by `liveKey`, and the Markdown renderer's
// extension `media/livemarkdown.js` shows each in place of its expression,
// escaped; an expression with no value yet shows as written. An export to
// HTML (`qnbconvert.ts`) puts them in the same way.
//
// `LIVE` evaluates the expressions with `value`, each on its own so one that
// fails does not lose the rest, and answers with `(1b;text)` or
// `(0b;error)` each: a string or a symbol as its characters, anything else
// as `-3!` writes its first `VALUE_LIMIT` items, cut to `VALUE_LIMIT`
// characters by the process - and not at its `\c`, where `-3!` itself
// stops: the text is `FULL_TEXT`'s (#1870).
// Nothing is defined there.

import { inlineTexts } from "./markdownblocks";
import { ESCAPE_CUT, FULL_TEXT, UTF8_CUT } from "./qtext";

/// Where a Markdown cell's values are kept in its metadata.
export const LIVE_KEY = "q-lint.liveValues";

/// The most characters of one value the process sends.
export const VALUE_LIMIT = 200;

/// `y`, cut from `x`, with the attributes `x` has: a sorted table's or
/// dictionary's own `` `s# `` too, which `flip` and `!` drop (#2708).
const ATTR = "{$[98h=type x;(attr x)#flip .z.s'[flip x;flip y];99h=type x;(attr x)#.z.s[key x;key y]!.z.s[value x;value y];(attr x)#y]}";

/// `LIVE`, each expression evaluated under `reval` when `readOnly` - with
/// `value` on a process without it - as `trapLines` evaluates statements.
function liveLambda(readOnly: boolean): string {
  return [
    "{[es]",
    ` {r:@[{(1b;${readOnly ? "$[`reval in key`.q;reval(value;x);value x]" : "value x"})};x;{(0b;x)}];`,
    "  if[not r 0;:r];",
    "  v:r 1;",
    // `-3!` of the first VALUE_LIMIT items only, never of a whole table
    // (#1559): each item writes at least one character, so the text kept is
    // the same. A list `sublist` refuses, such as a partitioned table, whole.
    // `sublist` drops an attribute, so the cut list, a table's columns and a
    // dictionary's keys and values get theirs back (#1718).
    // Cut on a character, never inside a UTF-8 one or an escape (#2071).
    `  (1b;$[10h=abs type v;${UTF8_CUT}[${VALUE_LIMIT};(),v];-11h=type v;${UTF8_CUT}[${VALUE_LIMIT};string v];${ESCAPE_CUT}[${VALUE_LIMIT};${FULL_TEXT}[${VALUE_LIMIT};$[(type v) within 0 99h;{@[${ATTR}x;y;y]}[v] @[${VALUE_LIMIT} sublist;v;v];v]]]])} each es}`,
  ].join("\n");
}

export const LIVE = liveLambda(false);
/// `LIVE` under `reval`.
export const LIVE_READ_ONLY = liveLambda(true);

export type LiveValue = { text: string } | { error: string };

/// What follows a newline that ends a paragraph: a line that is blank.
const BLANK_AFTER = /^[ \t]*\r?\n/;

/// An expression as both sides key it: markdown-it hands the renderer a
/// list item's lines without their indent, and CRLF as LF, so each
/// continuation line starts with one space here (#1788). The key is not
/// what is sent: that is the text as written (`liveQueries`).
export function liveKey(expr: string): string {
  return expr.replace(/\r?\n[ \t]*/g, "\n ");
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

/// An HTML tag, open or closing, as CommonMark reads one inline, or a
/// comment, a processing instruction, a declaration or a CDATA section.
const TAG = /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<\?[^]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[^]*?\]\]>/y;

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

const AUTOLINK = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+)>/;

/// The index after the `)` closing a link's destination and title, read
/// from just after its `(`; undefined when it is not one.
function linkTargetEnd(text: string, from: number): number | undefined {
  let j = from;
  const space = (): void => {
    while (j < text.length && /[ \t\n]/.test(text[j])) j++;
  };
  space();
  if (text[j] === "<") {
    const close = text.slice(j).search(/[>\n]/);
    if (close < 0 || text[j + close] !== ">") return undefined;
    j += close + 1;
  } else {
    for (let depth = 0; j < text.length && !/[\s\x00-\x1f]/.test(text[j]); j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === "(") depth++;
      else if (text[j] === ")" && depth-- === 0) break;
    }
  }
  space();
  const quote = text[j];
  if (quote === '"' || quote === "'" || quote === "(") {
    const close = text.indexOf(quote === "(" ? ")" : quote, j + 1);
    if (close < 0) return undefined;
    j = close + 1;
    space();
  }
  return text[j] === ")" ? j + 1 : undefined;
}

/// `text` with what markdown-it reads as a link's target, never through its
/// inline rules, made spaces (#1827): an inline link's or image's
/// destination and title, a reference link's `[ref]`, an image's alt text,
/// and an autolink. The renderer never draws a live value in one, so none
/// is run. (A link reference definition is no inline text: `inlineTexts`.)
/// Over-reading here only leaves a value shown as written, never runs one.
function blankLinkTargets(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (out[k] !== "\n") {
        out[k] = " ";
      }
    }
  };
  // Autolinks, links and images, left to right as markdown-it reads them: a
  // live value, a code span or a tag met first is that, and is skipped whole.
  const spans = new Map(inlineSpans(text).map((sp) => [sp.start, sp.end]));
  const skip = (k: number): number => spans.get(k) ?? (text[k] === "\\" ? k + 2 : k + 1);
  for (let i = 0; i < text.length; ) {
    const autolink = text[i] === "<" ? AUTOLINK.exec(text.slice(i)) : null;
    if (autolink !== null) {
      blank(i, i + autolink[0].length);
      i += autolink[0].length;
      continue;
    }
    const image = text[i] === "!" && text[i + 1] === "[";
    if (spans.has(i) || (text[i] !== "[" && !image)) {
      i = skip(i);
      continue;
    }
    // The label's `]`, brackets in it balanced.
    let j = image ? i + 2 : i + 1;
    for (let depth = 0; j < text.length; j = skip(j)) {
      if (spans.has(j)) continue;
      if (text[j] === "[") depth++;
      else if (text[j] === "]" && depth-- === 0) break;
    }
    // A reference link's `[ref]` is never drawn either, when it resolves.
    const ref = text[j] === "]" && text[j + 1] === "[" ? /^\[(?:[^\[\]\\]|\\.)*\]/.exec(text.slice(j + 1)) : null;
    const end = ref !== null ? j + 1 + ref[0].length : text[j] === "]" && text[j + 1] === "(" ? linkTargetEnd(text, j + 2) : undefined;
    if (end === undefined) {
      i = image ? i + 2 : i + 1;
      continue;
    }
    // An image's alt text is drawn as plain text, without the live rule.
    blank(image ? i : j, end);
    i = image ? end : i + 1;
  }
  return out.join("");
}

/// The live values in a Markdown cell's `source`, each once, in order: the
/// `key` its value is kept and shown by, and the `expr` sent to the process
/// for it (#1993). Ones in a code block, a code span, an HTML comment, an
/// HTML block, a tag or a link's target are text, as the renderer shows
/// them (#1429, #1557, #1827) - in a blockquote or a list item too (#2000):
/// each block's inline text is read as `inlineTexts` finds it.
export function liveQueries(source: string): { key: string; expr: string }[] {
  const found: { key: string; expr: string }[] = [];
  for (const block of inlineTexts(source)) {
    const prose = blankLinkTargets(block.text);
    for (const span of inlineSpans(prose)) {
      if (span.kind === "live" && !found.some((f) => f.key === span.expr)) {
        found.push({ key: span.expr, expr: block.written(span.start + 4, span.end - 2).trim() });
      }
    }
  }
  return found;
}

/// The keys of `source`'s live values, each once, in order.
export function liveExpressions(source: string): string[] {
  return liveQueries(source).map((q) => q.key);
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
