// The language configuration q editors get at run time rather than from
// `language-configuration.json`, which VS Code reads once and offers no
// switch for: the continuation indent on Enter (#1161) and dotted names as
// one word (#1162). Free of any `vscode` import, so node tests the patterns;
// `editingview.ts` registers what is on.
//
// A q script ends a definition at a line that starts at column 0, so Enter
// inside a lambda or an open bracket must never leave the cursor there: a
// line that leaves a bracket open is followed by an indented one. VS Code
// already keeps an indented line's indentation. Nothing here outdents: a
// closing line cannot tell which bracket it closes, and one that drops to
// column 0 inside a lambda (`}` at the margin is a `'{` on KDB-X) breaks it.

/// One level of brackets that close on the line, or a character that is
/// neither a bracket nor a quote.
const SETTLED = String.raw`(?:[^{}\[\]()"]|\[[^{}\[\]()"]*\]|\([^{}\[\]()"]*\)|\{[^{}\[\]()"]*\})`;

/// A line, before the cursor, with a bracket left open: an opening bracket
/// and nothing after it that closes it. `f:{[x]`, `select from t where x in (1;2`,
/// and `f:{` before a `}` the cursor sits on. A bracket in a trailing
/// comment (` / see (a`) opens nothing; a comment after one that is open
/// (`f:{ / doc`) leaves it open.
export const OPENS = new RegExp(String.raw`^(?:(?!\s/).)*[{\[(]${SETTLED}*(?:\s/.*)?$`);

/// A comment line: what follows it is not a continuation of it. A `/` alone
/// opens a block comment, and the line after it is text, not q.
export const COMMENT = /^\s*\//;

/// A q name, dots and all - `.ns.util.f`, `x.y`, `.z.p` - or a number or
/// temporal literal (`1.5`, `1e-3`, `0x1f`, `2024.01.02`). A dot that starts
/// a name stays with it, so `x+.y` is `x` and `.y`; a dot that ends one does
/// not, so `f.` is `f`.
export const WORD = /(\d[\d.]*(?:e[+-]?\d+)?\w*)|(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)/;

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
