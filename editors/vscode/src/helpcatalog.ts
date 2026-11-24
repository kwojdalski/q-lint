// The help pages for q's builtins (#971), their runnable examples (#972)
// and the cheat sheet (#973), read from the extension's `help/` files. Free
// of any `vscode` import, so node tests it; `helpview.ts` shows them.
//
// `help/builtins.json` is the language server's own catalogue
// (`src/builtins.json`), copied byte for byte so a page says what a hover
// says: test/helpcatalog.test.js fails when the two differ. The examples
// and related names (`help/examples.json`) and the cheat sheet
// (`help/cheatsheet.json`) are this extension's, written from what q does,
// and test/help_q.test.js runs every one on a real q.
import { inStringOrComment } from "./temporal";

export interface Builtin {
  name: string;
  kind: string;
  syntax: string;
  params: string[];
  summary: string;
  /// The reference page it is described on: names sharing one are related.
  page?: string;
}

export interface Example {
  code: string;
  /// A q expression giving the same value as `code`, as it is shown.
  result: string;
}

export interface HelpPage extends Builtin {
  examples: Example[];
  /// Related builtins: those named in examples.json, then those on the same
  /// reference page.
  related: string[];
}

export interface CheatItem {
  label: string;
  insert: string;
  description: string;
  example?: string;
  result?: string;
}

export interface CheatSection {
  section: string;
  items: CheatItem[];
}

/// Show Help and Try Example (`helpview.ts`).
export const HELP = {
  show: "q-lint.showHelp",
  tryExample: "q-lint.tryExample",
} as const;

/// The cheat sheet's view and commands (`cheatsheetview.ts`).
export const CHEAT_SHEET = {
  view: "q-lint.cheatSheet",
  insert: "q-lint.insertCheatSheetEntry",
  show: "q-lint.showCheatSheet",
} as const;

/// Where the KX reference describes a builtin.
export const REFERENCE = "https://code.kx.com/q/ref/";

export class HelpCatalog {
  private readonly byName = new Map<string, Builtin>();
  private readonly extra: Record<string, { examples: Example[]; see: string[] }>;

  constructor(builtinsJson: string, examplesJson: string) {
    for (const b of JSON.parse(builtinsJson) as Builtin[]) {
      this.byName.set(b.name, b);
    }
    this.extra = JSON.parse(examplesJson) as Record<string, { examples: Example[]; see: string[] }>;
  }

  /// Every builtin's name, in the catalogue's order.
  names(): string[] {
    return [...this.byName.keys()];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /// A builtin's page, or undefined for a name q does not define.
  page(name: string): HelpPage | undefined {
    const b = this.byName.get(name);
    if (b === undefined) {
      return undefined;
    }
    const extra = this.extra[name];
    const samePage = b.page === undefined ? [] : [...this.byName.values()].filter((o) => o.page === b.page && o.name !== name).map((o) => o.name);
    const related = [...new Set([...(extra?.see ?? []), ...samePage])].filter((n) => n !== name && this.byName.has(n));
    return { ...b, examples: extra?.examples ?? [], related };
  }

  /// The builtins with examples, for the hover.
  examples(name: string): Example[] {
    return this.byName.has(name) ? (this.extra[name]?.examples ?? []) : [];
  }
}

/// The cheat sheet's sections, any malformed item left out.
export function readCheatSheet(text: string): CheatSection[] {
  const raw = JSON.parse(text) as { section?: unknown; items?: unknown }[];
  return raw
    .filter((s) => typeof s.section === "string" && Array.isArray(s.items))
    .map((s) => ({
      section: s.section as string,
      items: (s.items as CheatItem[]).filter((i) => typeof i?.label === "string" && typeof i.insert === "string" && typeof i.description === "string"),
    }));
}

/// Text made safe for HTML.
export function html(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/// A `command:` link's target, its arguments in the query as VS Code reads them.
export function commandUri(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

/// Code in a Markdown fence longer than any run of backticks in it.
function fence(code: string, language = "q"): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}${language}\n${code}\n${f}`;
}

/// An inline code span that holds `text` whatever backticks it has.
export function span(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${f}${pad}${text}${pad}${f}`;
}

/// The hover's examples: each in a code block with its result, a Try it
/// link to run it when `tryCommand` is given, and a link to the page when
/// `helpCommand` is.
export function examplesMarkdown(name: string, examples: Example[], tryCommand?: string, helpCommand?: string): string {
  const out = [`**Examples of ${span(name)}**`];
  for (const e of examples) {
    out.push("", fence(e.code), `gives ${span(e.result)}${tryCommand === undefined ? "" : ` · [Try it](${commandUri(tryCommand, [e.code])} "Run on the connected q process")`}`);
  }
  if (helpCommand !== undefined) {
    out.push("", `[Open the help page](${commandUri(helpCommand, [name])})`);
  }
  return out.join("\n");
}

/// A help page's HTML body: syntax, summary, examples (with Try it links
/// when `tryCommand` is given), related builtins as links to their pages,
/// and the reference page. Everything shown is escaped.
export function pageHtml(page: HelpPage, helpCommand: string, tryCommand?: string): string {
  const parts = [
    `<h1><code>${html(page.name)}</code> <span class="kind">${html(page.kind)}</span></h1>`,
    `<pre class="syntax"><code>${html(page.syntax)}</code></pre>`,
    `<p>${html(page.summary)}</p>`,
  ];
  if (page.examples.length > 0) {
    parts.push("<h2>Examples</h2>");
    for (const e of page.examples) {
      const run = tryCommand === undefined ? "" : ` <a class="try" href="${html(commandUri(tryCommand, [e.code]))}" title="Run on the connected q process">Try it</a>`;
      parts.push(`<pre><code>${html(e.code)}</code></pre>`, `<p class="result">gives <code>${html(e.result)}</code>${run}</p>`);
    }
  }
  if (page.related.length > 0) {
    parts.push("<h2>Related</h2>", `<p class="related">${page.related.map((n) => `<a href="${html(commandUri(helpCommand, [n]))}"><code>${html(n)}</code></a>`).join(" ")}</p>`);
  }
  if (page.page !== undefined) {
    parts.push(`<p class="reference">The KX reference: <a href="${html(REFERENCE + page.page)}">${html(REFERENCE + page.page)}</a></p>`);
  }
  return parts.join("\n");
}

/// The q name, or glyph, at `character` of `line`: `.Q.s1`, `xbar`, `/:`.
/// Undefined in a string or a comment.
export function nameAt(line: string, character: number): { name: string; start: number; end: number } | undefined {
  // Glyphs are cut as q cuts them, an operator and then its iterator:
  // `a:-1` is `:` and `-`, `x,/:y` is `,` and `/:`. A dot is a glyph only
  // where no name starts: `:.Q.s1` is `:` and `.Q.s1`. A symbol, `` `max ``
  // or `` `:db/t ``, is taken whole, and is no name.
  const re = /`[\w.]*(?::[\w.:/]*)?|\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*|<>|<=|>=|::|':|\/:|\\:|[+\-*%&|^=<>~!#_$?@,'/\\:]|\.(?![A-Za-z])/g;
  // The token the cursor is on, or failing that the one it is just after.
  let found: { name: string; start: number; end: number } | undefined;
  for (const m of line.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (start > character) {
      break;
    }
    if (character <= end) {
      found = { name: m[0], start, end };
      if (character < end) {
        break;
      }
    }
  }
  // Through `start` itself: a `/` after a blank starts a comment.
  return found === undefined || found.name.startsWith("`") || inStringOrComment(line, found.start + 1) ? undefined : found;
}
