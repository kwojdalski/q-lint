// What the schema and lint agent tools answer (#951), what the @q chat
// participant asks the model (#952), and how English to qSQL drafts a
// query (#953). Free of any `vscode` import, so node tests it; the VS Code
// around it is `assisttools.ts`, `chat.ts` and `qsqldraft.ts`.
//
// Every call to a process here reads only, with a lambda sent with its
// arguments as the explorer's is: the explorer's own `GATHER` for the
// tables, `TABLE_INFO` for one table's schema, and `DESCRIBE` for what a
// name holds. None of these sends code a model wrote. Code a model wants
// run goes through the Run q Query tool, which the user confirms, and a
// drafted query is only shown: the user runs it, or not.
import type { Gathered } from "./explorer";
import { FULL_TEXT } from "./qtext";
import type { TableInfo } from "./tableinfo";

export const QSQL_COMMANDS = { draft: "q-lint.draftQsql" } as const;

/// What each of `nms` (one string, names split by spaces) holds: missing, a
/// lambda and its text, another function as q prints it, a table and its
/// columns, a view, which is named and not evaluated (#1133), or a
/// variable: its type, count and its first ten items as q prints them. Texts
/// are `FULL_TEXT`'s, whole whatever the process's `\c`, cut at 300
/// characters (#1908), and nothing is counted or
/// read whole: a table's rows are not counted. The value is taken by `get`
/// straight into a local: PeachQ loads a partitioned table put in a list,
/// and it would no longer read as partitioned. Works on KDB-X and PeachQ.
export const DESCRIBE = [
  "{[nms]",
  ` F:${FULL_TEXT};`,
  " n:\" \" vs(),nms;",
  " r:{[F;x]s:`$x;",
  "  if[s in views[];:(`view;0h;0n;\"\")];",
  "  if[not @[{get x;1b};s;0b];:(`missing;0h;0n;\"\")];",
  "  v:get s;t:type v;",
  "  $[100h=t;(`lambda;t;0n;last value v);",
  "   t within 101 112h;(`function;t;0n;300 sublist F[300;v]);",
  "   .Q.qt v;($[1b~p:.Q.qp v;`partitioned;0b~p;`splayed;99h=t;`keyed;`table];t;0n;300 sublist\" \"sv{s:string x;$[all s in .Q.an;s;\"`$\",-3!s]}each cols v);",
  "   (`variable;t;\"f\"$count v;300 sublist F[300;$[0>t;v;10 sublist v]])]}[F]each n;",
  " `name`kind`type`count`text!(n;r[;0];r[;1];r[;2];r[;3])}",
].join("\n");

/// Names `DESCRIBE` is asked about at once.
export const DESCRIBE_LIMIT = 20;

export interface Described {
  name: string;
  kind: "missing" | "lambda" | "function" | "table" | "keyed" | "splayed" | "partitioned" | "variable" | "view";
  type: number;
  count: number | null;
  text: string;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const KINDS = new Set(["missing", "lambda", "function", "table", "keyed", "splayed", "partitioned", "variable", "view"]);

/// What `DESCRIBE` answered. Throws when it is not that.
export function readDescribed(raw: unknown): Described[] {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || r.name === undefined || r.kind === undefined) {
    throw new Error(`the process answered something other than what its names hold: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const kinds = list(r.kind).map(String);
  const types = list(r.type);
  const counts = list(r.count);
  const texts = list(r.text);
  return list(r.name).map((name, i) => ({
    name: String(name),
    kind: (KINDS.has(kinds[i]) ? kinds[i] : "missing") as Described["kind"],
    type: typeof types[i] === "number" ? (types[i] as number) : 0,
    count: typeof counts[i] === "number" && Number.isFinite(counts[i]) ? (counts[i] as number) : null,
    text: typeof texts[i] === "string" ? (texts[i] as string) : "",
  }));
}

/// The words q gives meaning to that an expression most often holds: not
/// worth asking the process about.
const WORDS = new Set(
  (
    "select exec update delete from where by insert upsert each over scan prior peach " +
    "if do while not and or neg abs til count first last sum avg min max asc desc " +
    "get set value key keys cols meta type string raze enlist flip distinct group where " +
    "within like in except inter union til xbar xasc xdesc xkey xcol lj ij aj uj pj wj " +
    "show exit system null all any fills reverse sublist ss ssr vs sv mod div exp log sqrt"
  ).split(" "),
);

/// Where `name` is first written as code in `text` - not in a string or a
/// comment (#1631), nor as the head of a dotted name, which `namesIn`
/// reads as another name (#1912); -1 when it is not.
export function codeOffset(text: string, kinds: string, name: string): number {
  for (const m of text.matchAll(new RegExp(`(?<![\\w.])${name.replace(/\./g, "\\.")}(?![\\w]|\\.[A-Za-z])`, "g"))) {
    if (kinds[m.index] === "c") {
      return m.index;
    }
  }
  return -1;
}

interface At {
  line: number;
  character: number;
}

/// A diagnostic, as much of VS Code's as `findingsIn` reads.
export interface Reported {
  range: { start: At; end: At };
  code?: string | number | { value: string | number };
  source?: string;
  message: string;
}

/// q-lint's findings on `range`, a line of the prompt each (#1917): the
/// server's (`q-lint`, `qls`) and the process warnings, not what another
/// extension says of the file. One that only touches the range - on the
/// line after whole lines selected, which end at the next line's column 0
/// - is not on it; one without a width is where it starts. The line is
/// counted from the range's first, and one that starts above is on that.
export function findingsIn(diagnostics: readonly Reported[], range: { start: At; end: At }): string[] {
  const before = (a: At, b: At): boolean => a.line < b.line || (a.line === b.line && a.character < b.character);
  return diagnostics
    .filter((d) => {
      if (d.source !== "qls" && d.source?.startsWith("q-lint") !== true) {
        return false;
      }
      const { start, end } = d.range;
      return before(start, end) ? before(start, range.end) && before(range.start, end) : !before(start, range.start) && before(start, range.end);
    })
    .map((d) => `line ${Math.max(d.range.start.line - range.start.line, 0) + 1}: ${d.code !== undefined ? `${typeof d.code === "object" ? d.code.value : d.code} ` : ""}${d.message}`);
}

/// The names `expression` uses that the process could hold: written as
/// code, not in a string, a symbol or a comment, and not one of q's common
/// words. At most `DESCRIBE_LIMIT`, in order of first use.
export function namesIn(expression: string, kinds: string): string[] {
  const out: string[] = [];
  for (const m of expression.matchAll(/(?<![\w.])\.?[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)*/g)) {
    const name = m[0];
    if (kinds[m.index] !== "c" || WORDS.has(name) || out.includes(name)) {
      continue;
    }
    out.push(name);
    if (out.length >= DESCRIBE_LIMIT) {
      break;
    }
  }
  return out;
}

/// The q type a `meta` type character names: `j` long, `J` a list of longs.
const META_TYPES: Record<string, string> = {
  b: "boolean", g: "guid", x: "byte", h: "short", i: "int", j: "long", e: "real", f: "float",
  c: "char", s: "symbol", p: "timestamp", m: "month", d: "date", z: "datetime", n: "timespan",
  u: "minute", v: "second", t: "time",
};

export function metaType(c: string): string {
  if (c === "") {
    return "mixed list";
  }
  const lower = c.toLowerCase();
  const name = META_TYPES[lower];
  if (name === undefined) {
    return c;
  }
  return c === lower ? name : `${name} lists`;
}

/// The tables a schema tool lists at most, and the columns of each.
export const TABLE_LIMIT = 200;
export const LISTED_COLUMNS = 50;

export interface TableSummary {
  name: string;
  kind: "table" | "keyed" | "partitioned";
  rows: number | null;
  keys?: string[];
  columns: string[];
  /// The columns it has, when that is more than `columns` holds.
  columnCount?: number;
}

/// The tables the explorer's `GATHER` read, each by the name a query uses.
export function tablesOf(gathered: Gathered): { tables: TableSummary[]; more: number } {
  const all = gathered.entries.filter((e) => e.kind === "table");
  const tables = all.slice(0, TABLE_LIMIT).map((e): TableSummary => {
    const name = e.ns === "." ? e.name : `${e.ns}.${e.name}`;
    const columns = e.cols.slice(0, LISTED_COLUMNS);
    const width = e.allCols ?? e.cols.length;
    return {
      name,
      kind: e.partitioned ? "partitioned" : e.keys.length > 0 ? "keyed" : "table",
      rows: e.count,
      ...(e.keys.length > 0 ? { keys: e.keys } : {}),
      columns,
      ...(width > columns.length ? { columnCount: width } : {}),
    };
  });
  return { tables, more: all.length - tables.length };
}

export interface TableSchema {
  name: string;
  kind: TableInfo["kind"];
  rows: number | null;
  partitions?: number;
  keys: string[];
  columns: { name: string; type: string; attribute?: string; foreignKey?: string }[];
  columnCount?: number;
}

const ATTRIBUTES: Record<string, string> = { s: "sorted", u: "unique", p: "parted", g: "grouped" };

/// One table's schema as the tool answers it, from `TABLE_INFO`.
export function schemaOf(name: string, info: TableInfo): TableSchema {
  return {
    name,
    kind: info.kind,
    rows: info.rows,
    ...(info.partitions !== null ? { partitions: info.partitions } : {}),
    keys: info.keys,
    columns: info.columns.map((c) => ({
      name: c.name,
      type: metaType(c.type),
      ...(c.attr !== "" ? { attribute: ATTRIBUTES[c.attr] ?? c.attr } : {}),
      ...(c.fkey !== "" ? { foreignKey: c.fkey } : {}),
    })),
    ...(info.ncols > info.columns.length ? { columnCount: info.ncols } : {}),
  };
}

export interface LintFinding {
  line: number;
  column: number;
  code: string;
  rule: string;
  severity: string;
  message: string;
}

/// The findings `qlinter --format json` printed. Throws when it printed
/// something else.
export function readLint(stdout: string): LintFinding[] {
  const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("qlinter printed something other than a list of findings");
  }
  return parsed.map((f: Record<string, unknown>) => ({
    line: typeof f.line === "number" ? f.line : 0,
    column: typeof f.column === "number" ? f.column : 0,
    code: String(f.code ?? ""),
    rule: String(f.rule ?? ""),
    severity: String(f.severity ?? ""),
    message: [f.detail, f.why].filter((x) => typeof x === "string" && x !== "").join(" - "),
  }));
}

/// What the Lint q Code tool passes qlinter ahead of `lintArgs`, from the
/// arguments the language server is started with (`serverArgs`): the same
/// profile, configuration file and flags, less `--lsp`, and `style` where
/// neither a profile nor the configuration names one - `--lsp`'s default,
/// where the command line's is `uqf` (#2292). `--default-profile` yields to
/// a project's `profile`, which `--profile style` would outrank.
export function lintToolArgs(serverArgs: string[]): string[] {
  return ["--default-profile", "style", ...serverArgs.filter((a) => a !== "--lsp" && a !== "--stdio")];
}

/// The arguments qlinter lints standard input with, as the file `name`.
export function lintArgs(name: string): string[] {
  return ["--format", "json", "--color", "never", "--stdin-filename", name];
}

/// `text` fenced as a code block, with a fence longer than any run of
/// backticks in it.
export function fence(text: string, language = "q"): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${language}\n${text}\n${f}`;
}

/// The longest text of one item the model is given: a function's source,
/// an error's code.
const CUT = 4000;
/// `text` cut to `CUT` UTF-16 units, one less when the cut would split a
/// surrogate pair and send half a character (#1622).
export const cut = (text: string): string => {
  if (text.length <= CUT) {
    return text;
  }
  const end = /[\uD800-\uDBFF]/.test(text[CUT - 1]) ? CUT - 1 : CUT;
  return `${text.slice(0, end)}\n... (${text.length - end} more characters)`;
};

/// What the language server and the process say about an expression.
export interface ExplainContext {
  expression: string;
  /// The process it was read from, if any.
  process?: string;
  /// The language server's hovers on its names: name and Markdown.
  hovers: { name: string; text: string }[];
  /// The language server's findings in it.
  diagnostics: string[];
  described: Described[];
}

const RULES =
  "You are a q (kdb+) expert in VS Code's q-lint extension. Remember that q evaluates right to left with no operator precedence. " +
  "Answer in Markdown, briefly, with q in ```q blocks.";

function describedText(d: Described): string {
  switch (d.kind) {
    case "missing":
      return `- \`${d.name}\`: not defined on the process`;
    case "lambda":
      return `- \`${d.name}\`: a function defined on the process as:\n${fence(cut(d.text))}`;
    case "function":
      return `- \`${d.name}\`: a function value (type ${d.type}): \`${d.text}\``;
    case "view":
      return `- \`${d.name}\`: a view on the process (not evaluated, so its value is not known)`;
    case "variable":
      return `- \`${d.name}\`: a variable of type ${d.type}, count ${d.count ?? "?"}, starting \`${d.text}\``;
    default:
      return `- \`${d.name}\`: a ${d.kind} table with columns ${d.text}`;
  }
}

/// The prompt for explaining an expression, with what the language server
/// and the process say about its names.
export function explainPrompt(c: ExplainContext, question: string): string {
  const parts = [RULES, "Explain what this q code does, step by step, right to left:", fence(cut(c.expression))];
  if (question.trim() !== "" && question.trim() !== c.expression.trim()) {
    parts.push(`The user asks: ${question.trim()}`);
  }
  if (c.diagnostics.length > 0) {
    parts.push(`The q-lint linter reports:\n${c.diagnostics.map((d) => `- ${d}`).join("\n")}`);
  }
  if (c.hovers.length > 0) {
    parts.push(`The q-lint language server documents:\n${c.hovers.map((h) => `- \`${h.name}\`: ${cut(h.text)}`).join("\n")}`);
  }
  const known = c.described.filter((d) => d.kind !== "missing" || c.process !== undefined);
  if (c.process !== undefined && known.length > 0) {
    parts.push(`On the connected q process ${c.process}:\n${known.map(describedText).join("\n")}`);
  } else if (c.process === undefined) {
    parts.push("No q process is connected, so its definitions are not known.");
  }
  return parts.join("\n\n");
}

export interface ErrorContext {
  error: string;
  code?: string;
  process?: string;
  described: Described[];
}

/// The prompt for explaining a q error.
export function errorPrompt(c: ErrorContext, question: string): string {
  const parts = [RULES, `Explain this q error and how to fix it: \`'${c.error.replace(/^'/, "")}\``];
  if (c.code !== undefined) {
    parts.push(`It came from this code${c.process === undefined ? "" : `, run on ${c.process}`}:\n${fence(cut(c.code))}`);
  }
  if (question.trim() !== "") {
    parts.push(`The user asks: ${question.trim()}`);
  }
  if (c.described.length > 0 && c.process !== undefined) {
    parts.push(`On ${c.process}:\n${c.described.map(describedText).join("\n")}`);
  }
  return parts.join("\n\n");
}

/// The prompt that drafts qSQL from `description`, given the process's
/// tables, or none.
export function qsqlPrompt(description: string, tables: TableSummary[], process: string | undefined): string {
  const schema =
    tables.length === 0
      ? process === undefined
        ? "No q process is connected, so no table is known: use the names the description gives."
        : `The q process ${process} has no tables in memory or on disk that q-lint could read.`
      : `The q process ${process} has these tables (columns in order${tables.some((t) => t.keys !== undefined) ? "; keys are the leading columns of a keyed table" : ""}):\n` +
        tables
          .map((t) => `- ${t.name} (${t.kind}${t.rows === null ? "" : `, ${t.rows} rows`}): ${t.columns.join(", ")}${t.columnCount !== undefined ? `, and ${t.columnCount - t.columns.length} more` : ""}`)
          .join("\n");
  return [
    "You write q (kdb+) qSQL queries. Answer with one query only, in a single ```q block, and nothing else.",
    "Prefer a query that only reads: select or exec, with where clauses first that narrow most (on a partitioned table, the partition column first).",
    schema,
    `Write a query for: ${description.trim()}`,
  ].join("\n\n");
}

/// The q code in a model's reply: its first fenced block, or all of it
/// when it has none. A block closes only at a fence starting a line, so
/// backticks in the code (```a, a symbol list) stay in it; a block on one
/// line - ```q select from t``` - loses its fences too (#1627). A fence is
/// ``` or ~~~; its closing line may go on after a space (``` done), and a
/// block the reply was cut before closing runs to the reply's end (#1913).
export function extractCode(reply: string): string {
  const block = /(`{3,}|~{3,})[^\n`]*\n([\s\S]*?)^[ \t]*\1(?:[ \t][^\n]*)?$/m.exec(reply);
  if (block !== null) {
    return block[2].trim();
  }
  const line = /(`{3,})(?:(?:q|k|kdb|qsql)(?=[ \t]))?[ \t]*([^\n]*?)[ \t]*\1(?!`)/.exec(reply);
  if (line !== null && line[2] !== "") {
    return line[2].trim();
  }
  const open = /^[ \t]*(?:`{3,}|~{3,})[^\n`]*\n([\s\S]*)$/m.exec(reply);
  return (open !== null ? open[1] : reply).trim();
}

/// The draft a qSQL preview shows: a comment saying where it came from,
/// then the query. A comment line is skipped when it runs.
export function draftDocument(description: string, model: string, code: string): string {
  const said = description.trim().replace(/\s+/g, " ");
  return `/ Drafted by ${model} from: ${said}\n/ Review it: nothing has run. Run it with q-lint's query commands, or edit it first.\n${code}\n`;
}

/// The query in a draft document: without the comment lines it starts with.
export function draftCode(document: string): string {
  const lines = document.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].startsWith("/ ")) {
    i++;
  }
  return lines.slice(i).join("\n").trim();
}
