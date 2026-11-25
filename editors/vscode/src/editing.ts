// The language configuration q editors get at run time rather than from
// `language-configuration.json`, which VS Code reads once and offers no
// switch for: the continuation indent on Enter (#1161) and dotted names as
// one word (#1162), and what makes a blank line's comment toggle safe
// (#1970). Free of any `vscode` import, so node tests the patterns;
// `editingview.ts` registers what is on.
//
// A q script ends a definition at a line that starts at column 0, so Enter
// inside a lambda or an open bracket must never leave the cursor there: a
// line that leaves a bracket open is followed by an indented one. VS Code
// already keeps an indented line's indentation. Nothing here outdents: a
// closing line cannot tell which bracket it closes, and one that drops to
// column 0 inside a lambda (`}` at the margin is a `'{` on KDB-X) breaks it.

/// A character that is neither a bracket nor a quote, or a whole string,
/// whatever brackets it holds (`"("`).
const PLAIN = String.raw`[^{}\[\]()"]|"(?:[^"\\]|\\.)*"`;

/// What closes on the line: `PLAIN`, or brackets that open and close on it,
/// nested up to `depth` deep (`a[b[1]]`, `(1;(2;3))`). A regular expression
/// cannot count, and VS Code takes only one; four deep is past what a line
/// that opens a lambda holds.
function settled(depth: number): string {
  if (depth === 0) {
    return `(?:${PLAIN})`;
  }
  const inner = settled(depth - 1);
  return String.raw`(?:${PLAIN}|\[${inner}*\]|\(${inner}*\)|\{${inner}*\})`;
}
const SETTLED = settled(4);

/// A line, before the cursor, with a bracket left open: an opening bracket
/// and nothing after it that closes it. `f:{[x]`, `select from t where x in (1;2`,
/// and `f:{` before a `}` the cursor sits on. A bracket in a trailing
/// comment (` / see (a`) opens nothing; a comment after one that is open
/// (`f:{ / doc`) leaves it open, and a string before it (`s:"a /b";f:{`)
/// starts no comment (#1375). A line that ends inside a string it opened
/// (`f:{x,"abc`, `s:"a`) is continued the same way: the rest of the string at
/// column 0 would end the statement there (#2303). A line that closes a string
/// opened above looks the same and is indented too, which q does not mind.
export const OPENS = new RegExp(String.raw`^(?:"(?:[^"\\]|\\.)*"|(?!\s/)[^"])*(?:[{\[(]${SETTLED}*(?:\s/.*)?|"(?:[^"\\]|\\.)*)$`);

/// A comment line: what follows it is not a continuation of it. A `/` alone
/// opens a block comment, and the line after it is text, not q.
export const COMMENT = /^\s*\//;

/// A q name, dots and all - `.ns.util.f`, `x.y`, `.z.p` - or a number or
/// temporal literal (`1.5`, `1e-3`, `0x1f`, `2024.01.02`, `0D00:00:01`,
/// `2024.01.02D10:00:00.000`, through its colons). A dot that starts
/// a name stays with it, so `x+.y` is `x` and `.y`; a dot that ends one does
/// not, so `f.` is `f`. A segment after a dot may start with `_` or a digit,
/// as q reads `.ns.__f` (#2300). A number takes the dot it starts with (`.5`)
/// and ends at a `_`, as q reads it: `1_til 5` is `1` and `til` (#1992).
/// It takes a colon only after two digits: one digit before a colon is a
/// file verb, so `0:.h.tx` is `0` and `.h.tx` (#2301).
export const WORD = /(\.?\d[\d.]*(?:[DT][\d.]*)?(?:(?<=\d\d):[\d.]+)*(?:e[+-]?\d+)?[A-Za-z0-9]*)|(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)/;

export interface EnterRule {
  beforeText: RegExp;
  action: "indent" | "none";
}

/// What a q editor's language configuration adds, with each feature on or
/// off; undefined when all are off, and VS Code's own behaviour is left.
export function languageConfiguration(on: { continuation: boolean; dotted: boolean }):
  | { onEnterRules?: EnterRule[]; wordPattern?: RegExp }
  | undefined {
  if (!on.continuation && !on.dotted) {
    return undefined;
  }
  return {
    // The first rule that matches decides: a comment is never indented after.
    ...(on.continuation
      ? {
          onEnterRules: [
            { beforeText: COMMENT, action: "none" },
            { beforeText: OPENS, action: "indent" },
          ],
        }
      : {}),
    ...(on.dotted ? { wordPattern: WORD } : {}),
  };
}

/// The words of `line` as `WORD` reads them, for a test.
export function words(line: string): string[] {
  return [...line.matchAll(new RegExp(WORD.source, "g"))].map((m) => m[0]);
}

/// One change of a document change event, as VS Code reports it: `text` in
/// place of the `rangeLength` characters from `character` of `line`, which
/// ended on `endLine`.
export interface LineChange {
  line: number;
  endLine: number;
  character: number;
  rangeLength: number;
  text: string;
}

/// What to do at `character` of `line`: `mark` writes a `.` there, and
/// `clear` takes the one there away.
export interface BlankCommentFix {
  line: number;
  character: number;
  kind: "mark" | "clear";
}

/// The line comment token and the blank VS Code writes after it
/// (`editor.comments.insertSpace`, on by default).
const TOGGLED = "/ ";

/// Toggle Line Comment on a blank line writes `/ ` and nothing else, and q
/// reads a line holding only `/` and blanks as the opening of a block
/// comment: every line below it, to a lone `\` or the end of the file, stops
/// running, with no error (#1970). `language-configuration.json` can name the
/// token and nothing about blank lines, and VS Code's own
/// `editor.comments.ignoreEmptyLines` skips them only beside a line that is
/// not blank, so the change is answered instead: the line becomes `/ .`,
/// which q reads as a comment. The toggle back, which leaves that `.` alone
/// on its line, is answered by taking it away.
///
/// `changes` are one event's, and `lineAt` the text of a line after it. Only
/// the toggle's own shape is answered - the whole `/ ` put in at once, or
/// taken out at once from before a lone `.` - so a `/` typed on a blank line
/// stays what was typed: a comment being started, or a block comment meant.
/// With `editor.comments.insertSpace` off the toggle writes that same lone
/// `/`, which cannot be told from typing and is left.
export function blankCommentFixes(changes: readonly LineChange[], lineAt: (line: number) => string): BlankCommentFix[] {
  // A change that adds or removes a line moves the lines the others name.
  if (changes.some((c) => c.line !== c.endLine || /[\r\n]/.test(c.text))) {
    return [];
  }
  const fixes: BlankCommentFix[] = [];
  for (const c of changes) {
    if (changes.some((other) => other !== c && other.line === c.line)) {
      continue;
    }
    const text = lineAt(c.line);
    if (c.rangeLength === 0 && c.text === TOGGLED && /^[ \t]*\/[ \t]*$/.test(text) && text.startsWith(TOGGLED, c.character)) {
      fixes.push({ line: c.line, character: c.character + TOGGLED.length, kind: "mark" });
    } else if (c.rangeLength === TOGGLED.length && c.text === "" && /^[ \t]*\.[ \t]*$/.test(text) && text[c.character] === ".") {
      fixes.push({ line: c.line, character: c.character, kind: "clear" });
    }
  }
  return fixes;
}

/// `text` with `fixes` applied, for a test.
export function withBlankCommentFixes(text: string, fixes: readonly BlankCommentFix[]): string {
  const lines = text.split("\n");
  for (const { line, character, kind } of fixes) {
    lines[line] = kind === "mark" ? `${lines[line].slice(0, character)}.${lines[line].slice(character)}` : lines[line].slice(0, character) + lines[line].slice(character + 1);
  }
  return lines.join("\n");
}
