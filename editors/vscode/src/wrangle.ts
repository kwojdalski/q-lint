// The Data Wrangler (#961) and grid cell edits (#964), as data: the q a
// step or an edit is written as. Free of any `vscode` import, so node tests
// it; `resulttools.ts` asks the user and sends it.
//
// A wrangle starts from a query whose answer is on show and records each
// step as q over the step before: a filter is `select from X where ...`, a
// sort `` `c xasc X ``, a rename `` (enlist[`c]!enlist`d) xcol X ``, a cast
// `update c:"j"$c from X` and a drop `delete c from X`. None of them changes
// the process: each works on a value, and the query that is run is the
// steps nested in one expression. So the query a wrangle starts from must
// be one expression; a script of several statements, an assignment or a
// system command cannot be nested and is refused.
//
// A cell edit is an `update` of the table the result came from, `` from `t ``
// - which changes it in place, so it is shown for review before it is sent,
// and the read-only guard reads it as any query. Its rows are found by the
// edited row's values: a keyed result's key columns, or every column of an
// unkeyed one, compared with `~\:` (so a null finds a null) - but a symbol
// or an enumerated column with `=`, as an enumeration does not match its
// symbol under `~`. Every row with those values is changed.
import { charKinds } from "./explorer";
import type { GridPayload } from "./grid";
import { atomLiteral, plainName, rawColumn, readable, symbolLiteral } from "./qliteral";
import { blockDepth, statements } from "./statements";

export const FILTER_OPS = ["=", "<>", "<", ">", "<=", ">=", "like", "in", "null", "not null"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/// The tests offered on a column: one of strings has no ordering, which q
/// makes character by character, 'length against a string of another length.
export const filterOps = (strings: boolean): FilterOp[] => FILTER_OPS.filter((o) => !strings || !["<", ">", "<=", ">="].includes(o));

export type Step =
  /// `strings`: the column holds strings, which are matched whole (#2014).
  | { kind: "filter"; column: string; op: FilterOp; value: string; strings?: boolean }
  | { kind: "sort"; column: string; descending: boolean }
  | { kind: "rename"; column: string; to: string }
  /// `strings`: the column holds strings, which are parsed rather than cast.
  /// `type`: the column's q type, so a symbol or enum is parsed too (#1571).
  | { kind: "cast"; column: string; to: string; strings?: boolean; type?: number }
  | { kind: "drop"; column: string };

/// The types a column can be cast to, by the letter `$` takes; `*` is a
/// string of each item.
export const CAST_TYPES: { letter: string; name: string }[] = [
  { letter: "b", name: "boolean" },
  { letter: "h", name: "short" },
  { letter: "i", name: "int" },
  { letter: "j", name: "long" },
  { letter: "e", name: "real" },
  { letter: "f", name: "float" },
  { letter: "s", name: "symbol" },
  { letter: "*", name: "string" },
  { letter: "p", name: "timestamp" },
  { letter: "d", name: "date" },
  { letter: "m", name: "month" },
  { letter: "n", name: "timespan" },
  { letter: "u", name: "minute" },
  { letter: "v", name: "second" },
  { letter: "t", name: "time" },
];

/// Why `code` cannot be the start of a wrangle, or undefined when it can:
/// one statement that is an expression.
export function wrangleBase(code: string): string | undefined {
  const parts = statements(code);
  if (parts.length !== 1) {
    return parts.length === 0 ? "the query is empty" : "the query has more than one statement, and only one expression can be wrangled";
  }
  const only = parts[0].trim();
  if (only.startsWith("\\")) {
    return "the query is a system command";
  }
  if (only.endsWith(";")) {
    return "the query ends with ';', so it answers nothing";
  }
  if (/^[.A-Za-z][.\w]*\s*(\[[^\]]*\])?\s*[-+*%&|^=<>$,#_~!?@.]?::?(?!:)/.test(only)) {
    return "the query assigns a name";
  }
  return undefined;
}

/// Why `name` cannot be written in q-sql as a column, or undefined.
export function columnProblem(name: string): string | undefined {
  return plainName(name) ? undefined : `the column ${name} cannot be named in q-sql (it is not a plain name, or it is a reserved word)`;
}

/// A step as q over the expression `x`.
export function stepCode(step: Step, x: string): string {
  const c = step.column;
  switch (step.kind) {
    case "filter": {
      // In parentheses where it has a comma: q-sql splits a where clause at
      // its commas: s in `a,`b is two tests (#1412).
      const r = readable(step.value.trim());
      const v = r.includes(",") ? `(${r})` : r;
      // A string is equal as a whole, and null when it is empty: `=` and
      // `null` ask each of its characters, 'length and 'type here (#2014).
      const whole: Partial<Record<FilterOp, string>> =
        step.strings === true ? { "=": `${c}~\\:${v}`, "<>": `not ${c}~\\:${v}`, null: `0=count each ${c}`, "not null": `0<count each ${c}` } : {};
      const test =
        whole[step.op] ?? (step.op === "null" ? `null ${c}` : step.op === "not null" ? `not null ${c}` : step.op === "in" ? `${c} in ${v}` : `${c}${step.op === "like" ? " like " : step.op}${v}`);
      return `select from ${x} where ${test}`;
    }
    case "sort":
      return `${symbolLiteral(c)} ${step.descending ? "xdesc" : "xasc"} ${x}`;
    case "rename":
      return `(enlist[${symbolLiteral(c)}]!enlist ${symbolLiteral(step.to)}) xcol ${x}`;
    case "cast":
      return `update ${c}:${castCode(c, step.to, step.strings === true, step.type)} from ${x}`;
    case "drop":
      return `delete ${c} from ${x}`;
  }
}

/// A cast of column `c` to `letter`. A column of strings is parsed, by the
/// letter in upper case (`"J"$c`), and made symbols with `` `$c ``; any other
/// is cast (`"j"$c`). `*` writes each item as a string: a string is left as
/// it is, which `string` would split into characters (#1281). A symbol or
/// enumerated column (`type` 11, 20-76) is parsed from its text, as a cast
/// fails with 'type or gives an enum's indexes; and any column is made
/// symbols from its text, which `"s"$` refuses (#1571). Text or a symbol
/// made a char is its first character, as the migration makes it: `"C"$`
/// gives a blank for text longer than one (#1720).
export function castCode(c: string, letter: string, strings = false, type?: number): string {
  if (letter === "*") {
    return strings ? `{$[10h=type x;x;string x]}each ${c}` : `string ${c}`;
  }
  const symbols = type !== undefined && (Math.abs(type) === 11 || (type >= 20 && type <= 76));
  if (letter === "c" && (strings || symbols)) {
    return `first each ${strings ? "" : "string "}${c}`;
  }
  if (strings) {
    return letter === "s" ? `\`$${c}` : `"${letter.toUpperCase()}"$${c}`;
  }
  if (letter === "s") {
    return type === 11 ? c : `\`$string ${c}`;
  }
  return symbols ? `"${letter.toUpperCase()}"$string ${c}` : `"${letter}"$${c}`;
}

/// Whether column `i` of the payload holds strings: a general column whose
/// cells q wrote as strings.
export function stringColumn(payload: GridPayload, i: number): boolean {
  return payload.types[i] === 0 && (payload.cells[i] ?? []).every((t) => t === "" || /^,?"/.test(t));
}

/// `base` without its comments: each line cut at a `/` after whitespace
/// outside a string, so nesting it does not leave the `)` or `;` that
/// follows in a comment (#1072). A line left empty is dropped, and so is a
/// block comment - `/` alone to `\` alone - and all after a `\` alone, as q
/// reads a script (#1280).
function uncommented(base: string): string {
  const cut = (line: string): string => {
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === "\\") {
          i++;
        } else if (c === '"') {
          quoted = false;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === "/" && (i === 0 || /\s/.test(line[i - 1]))) {
        return line.slice(0, i).trimEnd();
      }
    }
    return line.trimEnd();
  };
  const lines: string[] = [];
  let depth = 0;
  for (const line of base.trim().split(/\r?\n/)) {
    const bare = line.trimEnd();
    if (depth > 0 || bare === "/") {
      depth = blockDepth(depth, bare);
    } else if (bare === "\\") {
      break;
    } else {
      lines.push(line);
    }
  }
  return lines.map(cut).filter((l) => l.trim() !== "").join("\n");
}

/// A table's name read alone can be a partitioned table, which the grid
/// shows by row index; a sort, a cast or a drop of one fails 'par and a
/// rename leaves its columns as they were. Reading every partition into
/// memory to make them could exhaust the process, so before any step but a
/// filter the wrangle signals instead, naming the fix: a filter first - on
/// the partition column, say - reads only the partitions it keeps and
/// answers a table in memory, which every later step works on. Whether a
/// table is partitioned is the process's to say, so it is asked in the q
/// sent (#2147). Any other base answers a table in memory already.
export const NOT_PARTITIONED = `{$[1b~@[.Q.qp;x;0b];'"a partitioned table: filter it first, on ",string[.Q.pf]," for one, so that only the partitions it keeps are read";x]}`;
function startOf(base: string, steps: Step[]): string {
  const code = uncommented(base);
  return steps.length > 0 && steps[0].kind !== "filter" && /^\.?[A-Za-z]\w*(\.[A-Za-z]\w*)*$/.test(code.trim()) ? `${NOT_PARTITIONED}${code.trim()}` : code;
}

/// The steps nested in one expression over `base`.
export function wrangleQuery(base: string, steps: Step[]): string {
  return steps.reduce((x, step) => stepCode(step, `(${x})`), startOf(base, steps));
}

/// The steps as a script to keep: one line each, over a local `w`, in a
/// lambda run at once so nothing is assigned on the process. A name
/// assigned in a lambda is local all through it, so where the query names
/// a `w` of its own the local is `w1`, or the first such name it does not
/// (#2466).
export function wrangleScript(base: string, steps: Step[], process: string): string {
  const start = startOf(base, steps);
  const text = [start, ...steps.map((s) => stepCode(s, "x"))].join("\n");
  const used = (n: string) => new RegExp(`(?<![\\w.])${n}(?![\\w])`).test(text);
  let w = "w";
  for (let k = 1; used(w); k++) {
    w = `w${k}`;
  }
  const first = start.split(/\r?\n/);
  return [
    `/ Wrangled on ${process} by q-lint: ${steps.length} step${steps.length === 1 ? "" : "s"}`,
    "{[]",
    `  ${w}:${first.join("\n    ")};`,
    ...steps.map((s) => `  ${w}:${stepCode(s, w)};`),
    `  ${w}}[]`,
    "",
  ].join("\n");
}

/// A step in words, for a list of them.
export function stepText(step: Step): string {
  switch (step.kind) {
    case "filter":
      return `keep rows where ${step.column} ${step.op}${step.op === "null" || step.op === "not null" ? "" : ` ${step.value}`}`;
    case "sort":
      return `sort by ${step.column}, ${step.descending ? "descending" : "ascending"}`;
    case "rename":
      return `rename ${step.column} to ${step.to}`;
    case "cast":
      return `cast ${step.column} to ${CAST_TYPES.find((t) => t.letter === step.to)?.name ?? step.to}`;
    case "drop":
      return `drop ${step.column}`;
  }
}

/// The table a query reads, when it plainly reads one: a name alone, or
/// the name after `from` in a select, exec, update or delete. Strings and
/// comments are read as blanks: a `from` in one names nothing (#1467).
export function guessTable(code: string): string | undefined {
  const parts = statements(code);
  if (parts.length !== 1) {
    return undefined;
  }
  const kinds = charKinds(parts[0]);
  const only = parts[0].split("").map((ch, i) => (kinds[i] === "s" || kinds[i] === "m" ? " " : ch)).join("").trim();
  const name = /^(\.?[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)*)$/.exec(only) ?? /\bfrom\s+(\.?[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)*)\s*(?:where\b|$)/.exec(only);
  return name?.[1];
}

export interface CellEdit {
  /// The statement, ready to send.
  code: string;
  /// The columns its rows are found by.
  matchedBy: string[];
}

/// The `update` that sets the cell at `column`, `row` of the payload to
/// `value` (a q expression) in `table`, or why it cannot be written.
export function editStatement(payload: GridPayload, column: number, row: number, table: string, value: string): CellEdit | { error: string } {
  const names = payload.names;
  if (column < 0 || column >= names.length || row < 0 || row >= (payload.cells[column]?.length ?? 0)) {
    return { error: "the cell is not in the result on show" };
  }
  if (value.trim() === "") {
    return { error: "no new value was given" };
  }
  if (!/^\.?[A-Za-z][\w]*(\.[A-Za-z][\w]*)*$/.test(table)) {
    return { error: `${table} is not a table's name` };
  }
  const by = payload.keys > 0 ? names.slice(0, payload.keys).map((_, i) => i) : names.map((_, i) => i);
  for (const i of [column, ...by]) {
    const problem = columnProblem(names[i]);
    if (problem !== undefined) {
      return { error: problem };
    }
  }
  const tests: string[] = [];
  for (const i of by) {
    const raw = rawColumn(payload, i);
    const type = payload.types[i];
    const atom = atomLiteral(type, payload.cells[i][row] ?? "", raw === undefined ? undefined : raw[row]);
    if (atom.cut) {
      return { error: `the cell in ${names[i]} was cut at 200 characters or at the process's \\c width, so the row cannot be found by it` };
    }
    const enumerated = type === 11 || (type >= 20 && type <= 76);
    tests.push(enumerated ? `(${names[i]}=${atom.literal})` : `(${names[i]}~\\:(${readable(atom.literal)}))`);
  }
  const c = names[column];
  // A general column takes a list as long as the rows found.
  const v = readable(value.trim());
  const set = payload.types[column] === 0 ? `(count i)#enlist ${v}` : `(${v})`;
  return { code: `update ${c}:${set} from ${symbolLiteral(table)} where ${tests.join(",")}`, matchedBy: by.map((i) => names[i]) };
}

/// The cell at `column`, `row` as the literal an edit starts from.
export function cellLiteral(payload: GridPayload, column: number, row: number): string {
  const raw = rawColumn(payload, column);
  return atomLiteral(payload.types[column], payload.cells[column]?.[row] ?? "", raw === undefined ? undefined : raw[row]).literal;
}
