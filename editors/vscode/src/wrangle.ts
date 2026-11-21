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
import type { GridPayload } from "./grid";
import { atomLiteral, plainName, rawColumn, symbolLiteral } from "./qliteral";
import { statements } from "./statements";

export const FILTER_OPS = ["=", "<>", "<", ">", "<=", ">=", "like", "in", "null", "not null"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export type Step =
  | { kind: "filter"; column: string; op: FilterOp; value: string }
  | { kind: "sort"; column: string; descending: boolean }
  | { kind: "rename"; column: string; to: string }
  /// `strings`: the column holds strings, which are parsed rather than cast.
  | { kind: "cast"; column: string; to: string; strings?: boolean }
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
      const v = enlisted(step.value.trim());
      const test =
        step.op === "null" ? `null ${c}` : step.op === "not null" ? `not null ${c}` : step.op === "in" ? `${c} in ${v}` : `${c}${step.op === "like" ? " like " : step.op}${v}`;
      return `select from ${x} where ${test}`;
    }
    case "sort":
      return `${symbolLiteral(c)} ${step.descending ? "xdesc" : "xasc"} ${x}`;
    case "rename":
      return `(enlist[${symbolLiteral(c)}]!enlist ${symbolLiteral(step.to)}) xcol ${x}`;
    case "cast":
      return `update ${c}:${castCode(c, step.to, step.strings === true)} from ${x}`;
    case "drop":
      return `delete ${c} from ${x}`;
  }
}

/// A cast of column `c` to `letter`. A column of strings is parsed, by the
/// letter in upper case (`"J"$c`), and made symbols with `` `$c ``; any other
/// is cast (`"j"$c`). `*` writes each item as a string.
export function castCode(c: string, letter: string, strings = false): string {
  if (letter === "*") {
    return `string ${c}`;
  }
  if (strings) {
    return letter === "s" ? `\`$${c}` : `"${letter.toUpperCase()}"$${c}`;
  }
  return `"${letter}"$${c}`;
}

/// Whether column `i` of the payload holds strings: a general column whose
/// cells q wrote as strings.
export function stringColumn(payload: GridPayload, i: number): boolean {
  return payload.types[i] === 0 && (payload.cells[i] ?? []).every((t) => t === "" || /^,?"/.test(t));
}

/// The steps nested in one expression over `base`.
export function wrangleQuery(base: string, steps: Step[]): string {
  return steps.reduce((x, step) => stepCode(step, `(${x})`), base.trim());
}

/// The steps as a script to keep: one line each, over a local `w`, in a
/// lambda run at once so nothing is assigned on the process.
export function wrangleScript(base: string, steps: Step[], process: string): string {
  const first = base.trim().split(/\r?\n/);
  return [
    `/ Wrangled on ${process} by q-lint: ${steps.length} step${steps.length === 1 ? "" : "s"}`,
    "{[]",
    `  w:${first.join("\n    ")};`,
    ...steps.map((s) => `  w:${stepCode(s, "w")};`),
    "  w}[]",
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
/// the name after `from` in a select, exec, update or delete.
export function guessTable(code: string): string | undefined {
  const parts = statements(code);
  if (parts.length !== 1) {
    return undefined;
  }
  const only = parts[0].trim();
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
      return { error: `the cell in ${names[i]} was cut at 200 characters, so the row cannot be found by it` };
    }
    const enumerated = type === 11 || (type >= 20 && type <= 76);
    tests.push(enumerated ? `(${names[i]}=${atom.literal})` : `(${names[i]}~\\:(${enlisted(atom.literal)}))`);
  }
  const c = names[column];
  // A general column takes a list as long as the rows found.
  const v = enlisted(value.trim());
  const set = payload.types[column] === 0 ? `(count i)#enlist ${v}` : `(${v})`;
  return { code: `update ${c}:${set} from ${symbolLiteral(table)} where ${tests.join(",")}`, matchedBy: by.map((i) => names[i]) };
}

/// `code` with each monadic `,` - at its start, or after `(` or `;`,
/// outside a string - written `enlist `: q-sql splits a clause at a `,`
/// right after a `(` (`where c~\:(,"z")` is refused, on kdb+ and PeachQ).
export function enlisted(code: string): string {
  let out = "";
  let inString = false;
  let last = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += code[++i] ?? "";
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "," && (last === "" || last === "(" || last === ";")) {
      out += "enlist ";
      last = " ";
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) {
      last = ch;
    }
  }
  return out;
}

/// The cell at `column`, `row` as the literal an edit starts from.
export function cellLiteral(payload: GridPayload, column: number, row: number): string {
  const raw = rawColumn(payload, column);
  return atomLiteral(payload.types[column], payload.cells[column]?.[row] ?? "", raw === undefined ? undefined : raw[row]).literal;
}
