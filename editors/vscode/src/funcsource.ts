// A function's source from the process (#929), redefining it there after an
// edit, and the loaded functions that call a name (#935). Free of any
// `vscode` import, so node tests it; `funcsourceview.ts` is the VS Code
// around it.
//
// Each call is one lambda sent with its arguments, as the explorer's is, and
// only Redefine changes the process - by the one `set` the user confirmed.
// Names arrive as strings and are made symbols there: a string starting with
// a backtick would reach q as a symbol, and one of a single character as a
// char atom, so each is `(),`'d first.
//
// A lambda's source is `last value f`, the text it was defined from. Its
// context - the `\d` it was defined in - is the first of its globals,
// `(value f)3`: a global `g` in a lambda defined in `.ns` is `.ns.g`, so
// Redefine parses the new text in that context, as the original was, and
// restores the process's own context before it assigns. It refuses when the
// function on the process is no longer the text the editor started from,
// and answers the text the process keeps for the new one - the lambda alone,
// without a blank before it or a comment after - which is what the next
// Redefine is checked against (#1895).
//
// Callers are read from what q parsed, not from text: each lambda's globals
// (`(value f)3`, resolved in its context), and those of the lambdas nested
// in it, are what it calls; a symbol among its tokens (`-4!` of its text)
// that names the function is a mention - `value`, `@` or `.` by name, which
// q resolves when it runs, from the root, whatever the lambda's context. A
// local, a parameter, a string or a comment that spells the name is neither.
// A view (`v::expr`) has a lambda's type too, and `get` of its name
// evaluates it: the root's views (`views[]`) are not read (#1864).
// Works on kdb+ (KDB-X) and PeachQ; held there by funcsource_q.test.js.
import { isProduction } from "./agent";
import type { Process } from "./processes";
import { FULL_TEXT, TEXT_LIMIT } from "./qtext";

export const SOURCE_COMMANDS = {
  open: "q-lint.openFunctionSource",
  edit: "q-lint.editFunctionSource",
  redefine: "q-lint.redefineFunction",
  callers: "q-lint.findCallers",
} as const;

export const SOURCE = [
  "{[nm]",
  " if[(`$(),nm)in views[];'\"a view, not a function\"];",
  " f:get`$(),nm;t:type f;",
  " if[not t within 100 112h;'\"not a function\"];",
  " v:$[100h=t;value f;()];",
  ` \`type\`text\`ctx\`params!("f"$t;$[100h=t;last v;${FULL_TEXT}[${TEXT_LIMIT};f]];$[100h=t;string first v 3;""];$[100h=t;(),v 1;\`$()])}`,
].join("\n");

export const REDEFINE = [
  "{[nm;was;src]",
  " nm:`$(),nm;if[nm in views[];'\"not a lambda on the process\"];old:get nm;src:(),src;",
  " if[not 10h=type src;'\"the text is not a string\"];",
  " if[not 100h=type old;'\"not a lambda on the process\"];",
  " if[not((),was)~last value old;'\"changed on the process since it was opened\"];",
  " c:first(value old)3;d:system\"d\";",
  " system\"d \",$[null c;\".\";\".\",string c];",
  " r:@[{(1b;value x)};src;{(0b;x)}];",
  " system\"d \",string d;",
  " if[not first r;'last r];",
  " if[not 100h=type last r;'\"the text is not a function\"];",
  " nm set last r;",
  " last value last r}",
].join("\n");

export const CALLERS = [
  "{[ex;nm;lim]",
  " nm:`$(),nm;m:\"j\"$lim;",
  " todo:`.,` sv'`,'asc(key`)except(`$\" \" vs ex),`;",
  " ex:` sv'`,'`$\" \" vs ex;",
  " todo:todo where{$[99h=type d:@[get;x;0];11h=type key d;0b]}each todo;",
  " seen:`$();fns:`$();",
  " while[(count todo)&m>count seen;",
  "  ns:first todo;todo:1_todo;seen,:ns;",
  "  d:@[get;ns;{()!()}];",
  "  k:asc(key d)except`;",
  "  kids:$[ns~`.;`$();k where{$[99h=type x;$[11h=type key x;(::)~first x;0b];0b]}each d k];",
  "  todo,:(` sv'ns,'kids)except ex;",
  "  k:k where 100h=type each d k;",
  "  fns,:$[ns~`.;k except views[];` sv'ns,'k]];",
  " rs:{[c;x]$[(null c)|\".\"=first string x;x;` sv`,c,x]};",
  " calls:{[rs;f]v:value f;g:v 3;(rs[first g]each(1_g)except`),raze .z.s[rs]each v where 100h=type each v}[rs];",
  " says:{[f]k:@[-4!;last value f;{()}];raze{`$1_\"`\"vs x}each k where\"`\"=first each k};",
  " how:{[calls;says;nm;n]f:get n;$[nm in @[calls;f;`$()];`calls;nm in @[says;f;`$()];`mentions;`]}[calls;says;nm]each fns;",
  " w:where not null how;",
  " `rows`scanned`more!(flip`name`params`how!(fns w;{(),(value get x)1}each fns w;how w);\"f\"$count fns;\"f\"$count todo)}",
].join("\n");

/// Namespaces `CALLERS` reads at most.
export const CALLER_NAMESPACES = 1000;

export interface Source {
  type: number;
  text: string;
  /// The context the lambda was defined in: `` for the root, `ns`.
  ctx: string;
  params: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

/// What `SOURCE` answered. Throws when it is not that.
export function readSource(raw: unknown): Source {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || typeof r.type !== "number" || typeof r.text !== "string") {
    throw new Error(`the process answered something other than a function's source: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  return { type: r.type, text: r.text, ctx: typeof r.ctx === "string" ? r.ctx : "", params: strings(r.params) };
}

/// Whether Redefine can replace the function: only a lambda has a text to
/// edit; a projection or a composition is shown as `-3!` writes it.
export const editable = (source: Source): boolean => source.type === 100;

export interface Caller {
  name: string;
  params: string[];
  /// `calls`: the name is among its globals; `mentions`: a symbol in its
  /// text names it, and nothing calls it directly.
  how: "calls" | "mentions";
}

export interface Callers {
  callers: Caller[];
  /// Lambdas read, and namespaces left unread.
  scanned: number;
  more: number;
}

/// What `CALLERS` answered. Throws when it is not that.
export function readCallers(raw: unknown): Callers {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || !Array.isArray(r.rows)) {
    throw new Error(`the process answered something other than its callers: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const callers = r.rows.flatMap((row: Record<string, unknown>): Caller[] =>
    row !== null && typeof row === "object" && typeof row.name === "string" && (row.how === "calls" || row.how === "mentions")
      ? [{ name: row.name, params: strings(row.params), how: row.how }]
      : [],
  );
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { callers, scanned: n(r.scanned), more: n(r.more) };
}

/// The name of the function at `offset` in `line`, dots and all, or
/// undefined when the cursor is on no name.
export function nameAt(line: string, offset: number): string | undefined {
  const before = /[.\w]*$/.exec(line.slice(0, offset))?.[0] ?? "";
  const after = /^[.\w]*/.exec(line.slice(offset))?.[0] ?? "";
  const name = (before + after).replace(/\.+$/, "");
  return /^\.?[A-Za-z][\w]*(\.[A-Za-z][\w]*)*$/.test(name) ? name : undefined;
}

/// Where `name` is written in `text` as code - not in a string, a symbol or
/// a comment, nor as part of a longer name: the offset of its first
/// occurrence, or of its short name (`f` of `.ns.f`) when only that is
/// written, as in a lambda defined in `.ns`. -1 when neither is.
export function firstUse(text: string, name: string, kinds: string): number {
  const short = name.replace(/^\.[A-Za-z]\w*\./, "");
  for (const word of short === name ? [name] : [name, short]) {
    const escaped = word.replace(/[.]/g, "\\.");
    for (const m of text.matchAll(new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`, "g"))) {
      if (kinds[m.index] === "c") {
        return m.index;
      }
    }
  }
  // A mention by symbol: its backtick.
  for (const word of short === name ? [name] : [name, short]) {
    const m = new RegExp(`\`${word.replace(/[.]/g, "\\.")}(?![\\w.])`).exec(text);
    if (m !== null) {
      return m.index;
    }
  }
  return -1;
}

/// The URI path a function's source is shown under, and back: `/<name>.q`,
/// the process in the query, so a tab is titled by the function.
export function sourcePath(name: string): string {
  return `/${name}.q`;
}

export function nameFromPath(path: string): string {
  return path.replace(/^\//, "").replace(/\.q$/, "");
}

/// The source as a read-only document shows it: a header comment naming the
/// function, its process and its context, then the text as the process has
/// it. A comment line in q is one starting with `/`, which the language
/// server reads past.
export function sourceDocument(name: string, process: string, source: Source): string {
  const ctx = source.type !== 100 ? "" : source.ctx === "" ? ", defined in the root" : `, defined in .${source.ctx}`;
  const what = source.type === 100 ? "" : " (not a lambda: not editable)";
  return `/ ${name} on ${process}${ctx}${what}\n${source.text}\n`;
}

/// The text to redefine from an edited document: everything below the
/// header comment `sourceDocument` wrote, without the newline it ended with.
export function editedText(document: string): string {
  const lines = document.split(/\r?\n/);
  const body = lines[0]?.startsWith("/ ") ? lines.slice(1) : lines;
  return body.join("\n").replace(/\s+$/, "");
}

/// What the user is asked before Redefine replaces `name` on `target`: a
/// modal's message and detail, with the production warning the agent's
/// query carries (`agent.ts`) for a process tagged prod.
/// `guarded`: the tags the read-only guard (#918) guards it by, when it does.
export function redefineConfirmation(name: string, target: Process, guarded: string[] = []): { message: string; detail: string } {
  const warning =
    guarded.length > 0
      ? `${target.label} is tagged ${guarded.join(", ")}, which q-lint.processes.readOnlyGuard.tags guards: Redefine assigns ${name} there. `
      : isProduction(target)
        ? `${target.label} is a production process (tagged ${target.tags.join(", ")}). `
        : "";
  return {
    message: guarded.length > 0 ? `Redefine ${name} on the read-only process ${target.label}?` : `Redefine ${name} on ${target.label}?`,
    detail:
      `${warning}The edited text replaces ${name} on ${target.label} for every caller, parsed in the namespace it was defined in. ` +
      "Nothing is saved to a file: a restart of the process brings back the old definition.",
  };
}
