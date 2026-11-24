// The inline text of a Markdown cell, block by block, as markdown-it hands
// it to the notebook's renderer (#2000): a paragraph's or a heading's lines
// less the markers and indent of the blockquotes and list items they are
// in. A code block, a fence, an HTML block and a rule have none, wherever
// they stand - in a quote or a list item as at the cell's top.
//
// What the renderer shows is markdown-it's reading, not CommonMark's, so
// the rules here are its block rules, in its order, with its line marks
// (`bMarks`, `tShift`, `sCount`, `bsCount`, `blkIndent`) and its quirks: a
// `>` continues an open quote however far in it stands, and a line after a
// quote's fence is no longer the quote's.
// Free of any `vscode` import, so a test can drive it.

/// One block's inline text.
export interface InlineText {
  /// As the renderer's inline rules are handed it.
  text: string;
  /// `text` from `from` to `to` as written in the source: a later line
  /// whole but for its blockquote markers, with the line end it has.
  written(from: number, to: number): string;
}

type Rule = (s: Blocks, startLine: number, endLine: number, silent: boolean) => boolean;

/// The deepest blocks nest, as markdown-it's `maxNesting`: deeper is not shown.
const MAX_NESTING = 100;

const isSpace = (c: string | undefined): boolean => c === " " || c === "\t";

/// markdown-it's block state: the source with LF line ends, and each line's
/// start (`bMarks`, after its blockquote markers), end, count of leading
/// blanks (`tShift`), indent in columns (`sCount`) and the columns before
/// its start (`bsCount`).
class Blocks {
  readonly src: string;
  readonly eols: string[] = [];
  readonly bMarks: number[] = [];
  readonly eMarks: number[] = [];
  readonly tShift: number[] = [];
  readonly sCount: number[] = [];
  readonly bsCount: number[] = [];
  blkIndent = 0;
  listIndent = -1;
  parent: "root" | "paragraph" | "reference" | "blockquote" | "list" = "root";
  level = 0;
  line = 0;
  lineMax: number;
  readonly found: InlineText[] = [];

  constructor(source: string) {
    const parts = source.split(/(\r\n?|\n)/);
    const lines: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      lines.push(parts[i]);
      this.eols.push(parts[i + 1] ?? "");
    }
    this.src = lines.join("\n");
    let start = 0;
    for (const line of lines) {
      let indent = 0;
      let offset = 0;
      for (; isSpace(line[indent]); indent++) {
        offset += line[indent] === "\t" ? 4 - (offset % 4) : 1;
      }
      this.mark(start, start + line.length, indent, offset);
      start += line.length + 1;
    }
    this.lineMax = lines.length;
    // A line past the last, empty, so the line after any is one to read.
    this.mark(this.src.length, this.src.length, 0, 0);
  }

  private mark(begin: number, end: number, indent: number, offset: number): void {
    this.bMarks.push(begin);
    this.eMarks.push(end);
    this.tShift.push(indent);
    this.sCount.push(offset);
    this.bsCount.push(0);
  }

  isEmpty(line: number): boolean {
    return this.bMarks[line] + this.tShift[line] >= this.eMarks[line];
  }

  /// The line from its first character that is not a blank.
  text(line: number): string {
    return this.src.slice(this.bMarks[line] + this.tShift[line], this.eMarks[line]);
  }

  /// The line less `indent` columns of indent, a tab cut in two as spaces.
  private shown(line: number, indent: number): string {
    const begin = this.bMarks[line];
    let first = begin;
    let lineIndent = 0;
    for (; first < this.eMarks[line] && lineIndent < indent; first++) {
      const c = this.src[first];
      if (c === "\t") {
        lineIndent += 4 - ((lineIndent + this.bsCount[line]) % 4);
      } else if (c === " " || first - begin < this.tShift[line]) {
        // A list item's marker is masked by `tShift`, and counts as blanks.
        lineIndent++;
      } else {
        break;
      }
    }
    return " ".repeat(Math.max(0, lineIndent - indent)) + this.src.slice(first, this.eMarks[line]);
  }

  /// Keep lines `from` up to `to` as one block's inline text.
  keep(from: number, to: number): void {
    const shown: string[] = [];
    const written: string[] = [];
    for (let line = from; line < to; line++) {
      shown.push(this.shown(line, this.blkIndent));
      written.push(this.src.slice(this.bMarks[line], this.eMarks[line]));
    }
    const eols = this.eols.slice(from, to);
    this.found.push({
      text: shown.join("\n"),
      written: (begin, end) => {
        let out = "";
        let at = 0;
        for (let k = 0; k < shown.length; at += shown[k++].length + 1) {
          const last = at + shown[k].length;
          if (end <= at || begin > last) {
            continue;
          }
          // Its first line from where it starts; a later one from its own.
          out += begin >= at ? shown[k].slice(begin - at, end - at) : written[k].slice(0, Math.max(0, written[k].length - Math.max(0, last - end)));
          out += end > last ? eols[k] : "";
        }
        return out;
      },
    });
  }

  /// Keep `text`, one line, as a block's inline text.
  keepLine(text: string): void {
    this.found.push({ text, written: (begin, end) => text.slice(begin, end) });
  }
}

/// Read the blocks of lines `startLine` up to `endLine`, to where a line
/// stands out of the container being read.
function tokenize(s: Blocks, startLine: number, endLine: number): void {
  let line = startLine;
  while (line < endLine) {
    while (line < endLine && s.isEmpty(line)) {
      line++;
    }
    s.line = line;
    if (line >= endLine || s.sCount[line] < s.blkIndent) {
      break;
    }
    if (s.level >= MAX_NESTING) {
      s.line = endLine;
      break;
    }
    // The paragraph rule takes any line, so one always does.
    RULES.some((rule) => rule(s, line, endLine, false));
    line = s.line;
  }
}

const code: Rule = (s, startLine, endLine) => {
  if (s.sCount[startLine] - s.blkIndent < 4) {
    return false;
  }
  let last = startLine + 1;
  for (let nextLine = last; nextLine < endLine; ) {
    if (s.isEmpty(nextLine)) {
      nextLine++;
    } else if (s.sCount[nextLine] - s.blkIndent >= 4) {
      last = ++nextLine;
    } else {
      break;
    }
  }
  s.line = last;
  return true;
};

const fence: Rule = (s, startLine, endLine, silent) => {
  const open = /^(`{3,}|~{3,})([^]*)$/.exec(s.text(startLine));
  if (s.sCount[startLine] - s.blkIndent >= 4 || open === null || (open[1][0] === "`" && open[2].includes("`"))) {
    return false;
  }
  if (silent) {
    return true;
  }
  // Closed by a run of its character, at least as long, with blanks only
  // after it (#1469), less than four columns in; or by its container's end.
  let nextLine = startLine + 1;
  for (; nextLine < endLine; nextLine++) {
    if (!s.isEmpty(nextLine) && s.sCount[nextLine] < s.blkIndent) {
      break;
    }
    const close = /^(`+|~+)[ \t]*$/.exec(s.text(nextLine));
    if (close !== null && close[1][0] === open[1][0] && close[1].length >= open[1].length && s.sCount[nextLine] - s.blkIndent < 4) {
      nextLine++;
      break;
    }
  }
  s.line = nextLine;
  return true;
};

const blockquote: Rule = (s, startLine, endLine, silent) => {
  if (s.sCount[startLine] - s.blkIndent >= 4 || s.src[s.bMarks[startLine] + s.tShift[startLine]] !== ">") {
    return false;
  }
  if (silent) {
    return true;
  }
  const oldLineMax = s.lineMax;
  const old: number[][] = [];
  const save = (line: number): void => {
    old.push([line, s.bMarks[line], s.bsCount[line], s.sCount[line], s.tShift[line]]);
  };
  const oldParent = s.parent;
  s.parent = "blockquote";
  let lastLineEmpty = false;
  let nextLine = startLine;
  // The quote's lines: each begun by a `>`, and each after one that neither
  // follows an empty line nor begins a block that ends a quote.
  for (; nextLine < endLine; nextLine++) {
    const outdented = s.sCount[nextLine] < s.blkIndent;
    let pos = s.bMarks[nextLine] + s.tShift[nextLine];
    const max = s.eMarks[nextLine];
    if (pos >= max) {
      break;
    }
    if (s.src[pos++] === ">" && !outdented) {
      // The marker and one blank after it are the quote's.
      let initial = s.sCount[nextLine] + 1;
      let spaceAfter = false;
      let adjustTab = false;
      if (s.src[pos] === " ") {
        pos++;
        initial++;
        spaceAfter = true;
      } else if (s.src[pos] === "\t") {
        spaceAfter = true;
        if ((s.bsCount[nextLine] + initial) % 4 === 3) {
          pos++;
          initial++;
        } else {
          adjustTab = true;
        }
      }
      let offset = initial;
      save(nextLine);
      s.bMarks[nextLine] = pos;
      for (; pos < max && isSpace(s.src[pos]); pos++) {
        offset += s.src[pos] === "\t" ? 4 - ((offset + s.bsCount[nextLine] + (adjustTab ? 1 : 0)) % 4) : 1;
      }
      lastLineEmpty = pos >= max;
      s.bsCount[nextLine] = s.sCount[nextLine] + 1 + (spaceAfter ? 1 : 0);
      s.sCount[nextLine] = offset - initial;
      s.tShift[nextLine] = pos - s.bMarks[nextLine];
      continue;
    }
    if (lastLineEmpty) {
      break;
    }
    if (ENDS.blockquote.some((end) => end(s, nextLine, endLine, true))) {
      // A paragraph of the quote's must not read on past this line.
      s.lineMax = nextLine;
      if (s.blkIndent !== 0) {
        save(nextLine);
        s.sCount[nextLine] -= s.blkIndent;
      }
      break;
    }
    // A paragraph's continuation, to the rules inside: an indent below any.
    save(nextLine);
    s.sCount[nextLine] = -1;
  }
  const oldIndent = s.blkIndent;
  s.blkIndent = 0;
  s.level++;
  tokenize(s, startLine, nextLine);
  s.level--;
  s.lineMax = oldLineMax;
  s.parent = oldParent;
  for (const [line, b, bs, sc, t] of old) {
    s.bMarks[line] = b;
    s.bsCount[line] = bs;
    s.sCount[line] = sc;
    s.tShift[line] = t;
  }
  s.blkIndent = oldIndent;
  return true;
};

const hr: Rule = (s, startLine, _endLine, silent) => {
  if (s.sCount[startLine] - s.blkIndent >= 4 || !/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(s.text(startLine))) {
    return false;
  }
  if (!silent) {
    s.line = startLine + 1;
  }
  return true;
};

/// The index after a list item's marker on `line`, or undefined: a bullet,
/// or up to nine digits and a `.` or `)`, then a blank or the line's end.
function afterMarker(s: Blocks, line: number): { after: number; ordered: boolean } | undefined {
  const m = /^(?:[-*+]|(\d{1,9})[.)])(?=[ \t]|$)/.exec(s.text(line));
  return m === null ? undefined : { after: s.bMarks[line] + s.tShift[line] + m[0].length, ordered: m[1] !== undefined };
}

const list: Rule = (s, startLine, endLine, silent) => {
  let nextLine = startLine;
  if (s.sCount[nextLine] - s.blkIndent >= 4) {
    return false;
  }
  // An item four columns in from its list's is its paragraph's line.
  if (s.listIndent >= 0 && s.sCount[nextLine] - s.listIndent >= 4 && s.sCount[nextLine] < s.blkIndent) {
    return false;
  }
  let marker = afterMarker(s, nextLine);
  if (marker === undefined) {
    return false;
  }
  // Under a paragraph's line only an item with text begins a list, and an
  // ordered one only at 1.
  if (silent && s.parent === "paragraph" && s.sCount[nextLine] >= s.blkIndent) {
    const item = s.text(nextLine);
    if ((marker.ordered && Number(/^\d+/.exec(item)?.[0]) !== 1) || /^[ \t]*$/.test(s.src.slice(marker.after, s.eMarks[nextLine]))) {
      return false;
    }
  }
  if (silent) {
    return true;
  }
  const first = marker;
  const oldParent = s.parent;
  s.parent = "list";
  s.level++;
  while (nextLine < endLine) {
    let pos = marker.after;
    const max = s.eMarks[nextLine];
    const initial = s.sCount[nextLine] + marker.after - (s.bMarks[nextLine] + s.tShift[nextLine]);
    let offset = initial;
    for (; pos < max && isSpace(s.src[pos]); pos++) {
      offset += s.src[pos] === "\t" ? 4 - ((offset + s.bsCount[nextLine]) % 4) : 1;
    }
    // The item's text starts one column after its marker when the line
    // has none, or when it is more than four on, which is a code block's.
    let indentAfter = pos >= max ? 1 : offset - initial;
    if (indentAfter > 4) {
      indentAfter = 1;
    }
    const oldTShift = s.tShift[nextLine];
    const oldSCount = s.sCount[nextLine];
    const oldListIndent = s.listIndent;
    s.listIndent = s.blkIndent;
    s.blkIndent = initial + indentAfter;
    s.tShift[nextLine] = pos - s.bMarks[nextLine];
    s.sCount[nextLine] = offset;
    if (pos >= max && s.isEmpty(nextLine + 1)) {
      // An item with no text, then an empty line: the list ends there.
      s.line = Math.min(s.line + 2, endLine);
    } else {
      s.level++;
      tokenize(s, nextLine, endLine);
      s.level--;
    }
    s.blkIndent = s.listIndent;
    s.listIndent = oldListIndent;
    s.tShift[nextLine] = oldTShift;
    s.sCount[nextLine] = oldSCount;
    nextLine = s.line;
    if (nextLine >= endLine || s.sCount[nextLine] < s.blkIndent || s.sCount[nextLine] - s.blkIndent >= 4) {
      break;
    }
    if (ENDS.list.some((end) => end(s, nextLine, endLine, true))) {
      break;
    }
    const next = afterMarker(s, nextLine);
    if (next === undefined || next.ordered !== first.ordered || s.src[next.after - 1] !== s.src[first.after - 1]) {
      break;
    }
    marker = next;
  }
  s.level--;
  s.line = nextLine;
  s.parent = oldParent;
  return true;
};

/// The index after a link's destination in `text` at `from`, or undefined:
/// one in `<` and `>` on a line, or a run with no blank whose parentheses
/// balance.
function destinationEnd(text: string, from: number): number | undefined {
  let pos = from;
  if (text[pos] === "<") {
    for (pos++; pos < text.length; pos++) {
      if (text[pos] === "\n" || text[pos] === "<") {
        return undefined;
      }
      if (text[pos] === ">") {
        return pos + 1;
      }
      if (text[pos] === "\\") {
        pos++;
      }
    }
    return undefined;
  }
  let depth = 0;
  for (; pos < text.length && text[pos] > " " && text[pos] !== "\x7f"; pos++) {
    if (text[pos] === "\\" && pos + 1 < text.length) {
      pos += text[pos + 1] === " " ? 0 : 1;
    } else if (text[pos] === "(" && ++depth > 32) {
      return undefined;
    } else if (text[pos] === ")" && depth-- === 0) {
      break;
    }
  }
  return pos === from || depth > 0 ? undefined : pos;
}

/// A link reference definition, `[label]: destination "title"`, which is
/// never shown (#1827): its lines, read on as a paragraph's are while the
/// label, the destination or the title is open. What follows it begins a
/// block of its own, so a line four columns in is code.
const reference: Rule = (s, startLine, _endLine, silent) => {
  if (s.sCount[startLine] - s.blkIndent >= 4 || s.src[s.bMarks[startLine] + s.tShift[startLine]] !== "[") {
    return false;
  }
  let nextLine = startLine + 1;
  let str = s.src.slice(s.bMarks[startLine] + s.tShift[startLine], s.eMarks[startLine] + 1);
  // Take the next line too, when a paragraph begun here would.
  const more = (): boolean => {
    const line = nextLine;
    if (line >= s.lineMax || s.isEmpty(line)) {
      return false;
    }
    if (s.sCount[line] - s.blkIndent <= 3 && s.sCount[line] >= 0) {
      const oldParent = s.parent;
      s.parent = "reference";
      const ends = ENDS.paragraph.some((end) => end(s, line, s.lineMax, true));
      s.parent = oldParent;
      if (ends) {
        return false;
      }
    }
    str += s.src.slice(s.bMarks[line] + s.tShift[line], s.eMarks[line] + 1);
    nextLine++;
    return true;
  };
  let labelEnd = -1;
  let pos = 1;
  for (; pos < str.length; pos++) {
    if (str[pos] === "[") {
      return false;
    }
    if (str[pos] === "]") {
      labelEnd = pos;
      break;
    }
    if (str[pos] === "\n" || (str[pos] === "\\" && str[++pos] === "\n")) {
      more();
    }
  }
  if (labelEnd < 0 || str[labelEnd + 1] !== ":") {
    return false;
  }
  const blanks = (): void => {
    for (; pos < str.length && (str[pos] === "\n" ? more() || true : isSpace(str[pos])); pos++);
  };
  pos = labelEnd + 2;
  blanks();
  const destination = destinationEnd(str, pos);
  // A destination the renderer refuses is no definition.
  if (destination === undefined || /^<?\s*(?:vbscript|javascript|file|data):(?!image\/(?:gif|png|jpeg|webp);)/i.test(str.slice(pos, destination))) {
    return false;
  }
  const destLine = nextLine;
  pos = destination;
  blanks();
  // The title, in quotes or parentheses, which may go on over lines.
  const close = pos > destination ? { '"': '"', "'": "'", "(": ")" }[str[pos]] : undefined;
  let titled = false;
  if (close !== undefined) {
    const from = ++pos;
    for (; ; pos++) {
      if (pos >= str.length && !more()) {
        break;
      }
      if (str[pos] === close) {
        titled = true;
        break;
      }
      if (str[pos] === "(" && close === ")") {
        break;
      }
      if (str[pos] === "\\" && pos + 1 < str.length) {
        pos++;
      }
    }
    const empty = pos === from;
    pos++;
    for (; titled && pos < str.length && isSpace(str[pos]); pos++);
    // A title with text after it, or never closed, is not one: the
    // definition ends at its destination when that ends a line.
    if (!titled || (pos < str.length && str[pos] !== "\n" && !empty)) {
      titled = false;
    } else if (pos < str.length && str[pos] !== "\n") {
      return false;
    }
  }
  if (!titled) {
    pos = destination;
    nextLine = destLine;
    for (; pos < str.length && isSpace(str[pos]); pos++);
    if (pos < str.length && str[pos] !== "\n") {
      return false;
    }
  }
  if (str.slice(1, labelEnd).trim() === "") {
    return false;
  }
  if (!silent) {
    s.line = nextLine;
  }
  return true;
};

/// The block-level tags that open an HTML block, which a paragraph's line
/// may too (CommonMark 4.6, kind 6).
const BLOCK_TAGS =
  "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure " +
  "footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option " +
  "p param search section summary table tbody td tfoot th thead title tr track ul";

/// An HTML tag alone on its line, open or closing.
const LONE_TAG = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9:._-]*(?:\s*=\s*(?:[^"'=<>`\x00-\x20]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;

/// What opens each kind of HTML block (#1557), what closes it - a line
/// holding that, or for the last two an empty one - and whether it may
/// begin under a paragraph's line.
const HTML_BLOCKS: [RegExp, RegExp, boolean][] = [
  [/^<(script|pre|style|textarea)(?=(\s|>|$))/i, /<\/(script|pre|style|textarea)>/i, true],
  [/^<!--/, /-->/, true],
  [/^<\?/, /\?>/, true],
  [/^<![A-Za-z]/, />/, true],
  [/^<!\[CDATA\[/, /\]\]>/, true],
  [new RegExp(`^</?(${BLOCK_TAGS.split(" ").join("|")})(?=(\\s|/?>|$))`, "i"), /^$/, true],
  [LONE_TAG, /^$/, false],
];

const htmlBlock: Rule = (s, startLine, endLine, silent) => {
  const text = s.text(startLine);
  const kind = s.sCount[startLine] - s.blkIndent >= 4 || text[0] !== "<" ? undefined : HTML_BLOCKS.find(([open]) => open.test(text));
  if (kind === undefined) {
    return false;
  }
  if (silent) {
    return kind[2];
  }
  let nextLine = startLine + 1;
  // One an empty line closes ends where its container does; another reads
  // on over a container's empty lines.
  const blank = kind[1].test("");
  if (!kind[1].test(text)) {
    for (; nextLine < endLine && !(s.sCount[nextLine] < s.blkIndent && (blank || !s.isEmpty(nextLine))); nextLine++) {
      const line = s.text(nextLine);
      if (kind[1].test(line)) {
        nextLine += line.length !== 0 ? 1 : 0;
        break;
      }
    }
  }
  s.line = nextLine;
  return true;
};

const heading: Rule = (s, startLine, _endLine, silent) => {
  const m = /^#{1,6}(?=[ \t]|$)/.exec(s.text(startLine));
  if (s.sCount[startLine] - s.blkIndent >= 4 || m === null) {
    return false;
  }
  if (!silent) {
    // One line, less the `#`s closing it.
    s.keepLine(
      s
        .text(startLine)
        .slice(m[0].length)
        .replace(/[ \t]+#+[ \t]*$/, "")
        .trim(),
    );
    s.line = startLine + 1;
  }
  return true;
};

/// A paragraph, or a heading by the line of `=` or `-` under it (#1558,
/// #1722): its lines to an empty one or to a block that ends a paragraph.
/// A line four columns in, and one a quote took for its own, go on with it.
const paragraph: Rule = (s, startLine, endLine) => {
  const oldParent = s.parent;
  s.parent = "paragraph";
  let nextLine = startLine + 1;
  let underlined = false;
  for (; nextLine < endLine && !s.isEmpty(nextLine); nextLine++) {
    if (s.sCount[nextLine] - s.blkIndent > 3) {
      continue;
    }
    if (s.sCount[startLine] - s.blkIndent < 4 && s.sCount[nextLine] >= s.blkIndent && /^(?:=+|-+)[ \t]*$/.test(s.text(nextLine))) {
      underlined = true;
      break;
    }
    if (s.sCount[nextLine] < 0) {
      continue;
    }
    if (ENDS.paragraph.some((end) => end(s, nextLine, endLine, true))) {
      break;
    }
  }
  s.parent = oldParent;
  s.keep(startLine, nextLine);
  s.line = nextLine + (underlined ? 1 : 0);
  return true;
};

const RULES: Rule[] = [code, fence, blockquote, hr, list, reference, htmlBlock, heading, paragraph];

/// The blocks that end a paragraph, a blockquote and a list without an
/// empty line before them.
const ENDS = {
  paragraph: [fence, blockquote, hr, list, htmlBlock, heading],
  blockquote: [fence, blockquote, hr, list, htmlBlock, heading],
  list: [fence, blockquote, hr],
};

/// The inline text of each block of `source` that has any, in order.
export function inlineTexts(source: string): InlineText[] {
  const s = new Blocks(source);
  tokenize(s, 0, s.lineMax);
  return s.found;
}
