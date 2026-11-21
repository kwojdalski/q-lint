// What a query in grid or chart mode sends a q process, and how its answer
// becomes the rows and columns the result panel shows.
//
// `GRID` is `RUN` with one more field. It runs the statements the same way
// and answers the same `ok`type`text, so a result that is not tabular, or an
// error, is shown in the output exactly as in console mode. When the value is
// a table (keyed ones unkeyed with `0!`), a dictionary (as `key` and `value`
// columns; keyed by a table, as its key columns and a `value` column) or a
// list other than a string (as one `value` column), `grid`
// holds, for its first `limit` rows (its last when `limit` is negative, as
// a notebook's `q-lint.notebook.rowLimitFrom` can ask; all of them when it
// is infinite):
//
//   count  the rows the whole result has, as a float: it can pass 2^31
//   keys   how many of the leading columns are keys
//   names  the column names
//   types  each column's q type
//   cells  each column as q prints it in a table: `string` of a simple
//          column, `-3!` of each item of any other (cut at 200 characters).
//          `-3!` stops at the process's `\c` width, so a string item is
//          written here, each character escaped as `-3!` escapes it
//   raw    the column itself, made its underlying number - `"j"$` of a
//          timestamp, `"i"$` of a date - for the numeric, temporal and guid
//          types; `()` for the rest
//   rank   each row's value's place among the column's distinct values,
//          sorted by q (`iasc`), so equal values share one; `()` where q
//          cannot sort it
//
// Why this shape. The text is the process's own, so a timestamp keeps its
// nanoseconds and a long above 2^53 its last digits - a JavaScript number
// keeps neither, and node-q's codec turns temporals into Dates (whole
// milliseconds). The order is the process's too, so sorting a column sorts
// as `xasc` would, nulls first, symbols and guids included, with no
// comparison rewritten here. The raw numbers are what a cell's text cannot
// give: a float to the decimals `q-lint.query.gridDecimals` asks for, a value
// to chart, and nulls and infinities told apart exactly - node-q decodes the
// underlying integers and floats to null and +-Infinity, where it would make
// an infinite date an invalid Date with its sign lost. They also mend PeachQ,
// whose `string` writes an infinite int as 2147483647 and a null guid as "".
// Column by column, because a column is one q vector and arrives as one.
//
// Like `RUN`, it defines nothing on the process: every name in it is a local
// or a parameter. A partitioned table, which `sublist` refuses, is read by
// row index with `.Q.ind`. A value it cannot shape gives q's error as a
// string in `grid`, and the result is shown in the output instead.
import { TRAP, readAnswer, type Answer } from "./query";

export const GRID = [
  "{[s;size;limit]",
  ...TRAP,
  " $[r 0;",
  "   `ok`type`text`grid!(1b;type r 1;.Q.S[\"j\"$size;0j] r 1;.[{[v;n]",
  "     k:$[99h<>type v;0;98h=type key v;count cols key v;1];",
  "     e:{1_-1_-3!x} each \"c\"$til 256;",
  "     t:$[98h=type v;v;",
  "       99h=type v;$[98h<>type key v;flip`key`value!(key v;value v);",
  "         98h=type value v;0!v;",
  "         flip(cols[key v],`value)!value[flip key v],enlist value v];",
  "       (10h=type v)|not type[v] within 0 97h;();",
  "       flip(enlist`value)!enlist v];",
  "     $[98h<>type t;t;",
  "       [m:count t;",
  "        t:$[1b~.Q.qp t;[j:$[n<0;(m+n)|0;0]+til m&abs n;$[count j;.Q.ind[t;j];select from t where i<0]];n sublist t];",
  "        c:$[count[cols t]=count distinct cols t;t cols t;value flip t];",
  "        `count`keys`names`types`cells`raw`rank!(\"f\"$m;\"i\"$k;cols t;type each c;",
  "          {[e;x]$[type[x] within 1 76h;string x;{$[200<count x;(197#x),\"...\";x]} each",
  "            {[e;x]$[10h=type x;$[1=count x;\",\";\"\"],\"\\\"\",raze[e\"i\"$200 sublist x],\"\\\"\";-3!x]}[e] each x]}[e] each c;",
  "          {[c]u:type c;$[u in 12 16h;\"j\"$c;u in 13 14 17 18 19h;\"i\"$c;u=15h;\"f\"$c;u in 2 5 6 7 8 9h;c;()]} each c;",
  "          {@[{i:iasc x;\"i\"$@[count[x]#0;i;:;-1+sums differ x i]};x;{[e]()}]} each c)]]};",
  "     (r 1;\"j\"$limit);{[e]e}]);",
  "   `ok`error`trace!(0b;r 1;r 2)]}",
].join("\n");

/// What `GRID`'s `grid` holds, as the IPC client decodes it.
export interface GridPayload {
  count: number;
  keys: number;
  names: string[];
  types: number[];
  cells: string[][];
  raw: unknown[][];
  rank: number[][];
}

export type GridAnswer = Answer & {
  /// The rows to show, when the value was tabular.
  grid?: GridPayload;
  /// Why a tabular value could not be shaped: q's error.
  gridError?: string;
};

/// The answer `GRID` gave. The `ok`type`text part is read as `readAnswer`
/// reads `RUN`'s, and throws as it does; a `grid` that is not one - `()`
/// for a value that is not tabular - is dropped, so the result is shown as
/// text.
export function readGridAnswer(raw: unknown): GridAnswer {
  const answer: GridAnswer = readAnswer(raw);
  const grid = (raw as Record<string, unknown>).grid;
  if (!answer.ok) {
    return answer;
  }
  if (typeof grid === "string") {
    return { ...answer, gridError: grid };
  }
  const g = grid as Record<string, unknown> | null;
  if (g === null || typeof g !== "object") {
    return answer;
  }
  const { names, types, cells } = g;
  if (
    !Array.isArray(names) ||
    !Array.isArray(types) ||
    !Array.isArray(cells) ||
    cells.length !== names.length ||
    !cells.every(Array.isArray)
  ) {
    return answer;
  }
  // One list per column, empty where the process sent none.
  const perColumn = (x: unknown): unknown[][] => names.map((_, i) => (Array.isArray(x) && Array.isArray(x[i]) ? x[i] : []));
  return {
    ...answer,
    grid: {
      count: typeof g.count === "number" ? g.count : (cells[0]?.length ?? 0),
      keys: typeof g.keys === "number" ? g.keys : 0,
      names: names.map((n) => (n === null ? "" : String(n))),
      types: types.map(Number),
      cells: (cells as unknown[][]).map((c) => c.map((x) => (typeof x === "string" ? x : String(x)))),
      raw: perColumn(g.raw),
      rank: perColumn(g.rank) as number[][],
    },
  };
  return answer;
}

/// q's name and letter for each type a column can have.
const TYPES: Record<number, [string, string]> = {
  0: ["list", ""],
  1: ["boolean", "b"],
  2: ["guid", "g"],
  4: ["byte", "x"],
  5: ["short", "h"],
  6: ["int", "i"],
  7: ["long", "j"],
  8: ["real", "e"],
  9: ["float", "f"],
  10: ["char", "c"],
  11: ["symbol", "s"],
  12: ["timestamp", "p"],
  13: ["month", "m"],
  14: ["date", "d"],
  15: ["datetime", "z"],
  16: ["timespan", "n"],
  17: ["minute", "u"],
  18: ["second", "v"],
  19: ["time", "t"],
};

/// What a column header says of its type: `long (j)`, `enum`, `list`.
export function typeName(type: number): string {
  const known = TYPES[type];
  if (known !== undefined) {
    return known[1] === "" ? known[0] : `${known[0]} (${known[1]})`;
  }
  return type >= 20 && type <= 76 ? "enum" : `type ${type}`;
}

const NUMERIC = new Set([5, 6, 7, 8, 9]);
const TEMPORAL = new Set([12, 13, 14, 15, 16, 17, 18, 19]);
/// The types whose infinity q writes `0w`: those held as floats.
const FLOATING = new Set([8, 9, 15]);
const NULL_GUID = "00000000-0000-0000-0000-000000000000";

export interface Column {
  name: string;
  type: number;
  /// As `typeName` writes it, for the header's tooltip.
  typeName: string;
  /// One of the leading key columns of a keyed table or a dictionary.
  key: boolean;
  /// short, int, long, real or float: what a chart can plot.
  numeric: boolean;
  /// timestamp to time: what a scatter can put on its x axis.
  temporal: boolean;
}

/// One result, as the panel shows it. Column by column, as it came.
export interface Grid {
  columns: Column[];
  /// What each cell shows.
  cells: string[][];
  /// Each row's value's place among its column's distinct values sorted
  /// ascending, so equal values share one and a sort either way can keep
  /// them in their order; null where q could not sort the column, which the
  /// panel then sorts by text.
  rank: (number[] | null)[];
  /// A numeric or temporal column's values as numbers (temporals in their
  /// own unit since 2000.01.01, as q holds them), null for a null or an
  /// infinity; null for any other column.
  values: ((number | null)[] | null)[];
  /// The rows the whole result has; more than are here when it was cut.
  total: number;
}

/// What one cell shows: q's text, except that a null or an infinity is
/// written as kdb+ writes it in a table, and a float or real with the
/// decimals asked for (`decimals` < 0: as q wrote it).
export function cellText(type: number, text: string, raw: unknown, decimals: number): string {
  if (raw === undefined) {
    return text;
  }
  if (raw === null) {
    return type === 2 ? NULL_GUID : "";
  }
  if (raw === Infinity || raw === -Infinity) {
    return `${raw < 0 ? "-" : ""}0${FLOATING.has(type) ? "w" : "W"}`;
  }
  if ((type === 8 || type === 9) && decimals >= 0 && typeof raw === "number") {
    return raw.toFixed(Math.min(decimals, 100));
  }
  return text;
}

/// The grid a `GRID` payload shows, floats to `decimals` places.
export function toGrid(payload: GridPayload, decimals: number): Grid {
  const columns = payload.names.map((name, i): Column => {
    const type = payload.types[i];
    return {
      name,
      type,
      typeName: typeName(type),
      key: i < payload.keys,
      numeric: NUMERIC.has(type),
      temporal: TEMPORAL.has(type),
    };
  });
  const cells = payload.cells.map((column, i) => {
    const raw = payload.raw[i];
    const type = columns[i].type;
    return raw.length === column.length ? column.map((text, r) => cellText(type, text, raw[r], decimals)) : column;
  });
  const values = columns.map((column, i) => {
    const raw = payload.raw[i];
    if (!(column.numeric || column.temporal) || raw.length !== cells[i].length) {
      return null;
    }
    // A long arrives as a Long, which Number reads; null and the
    // infinities as themselves.
    return raw.map((x) => {
      const n = x === null ? NaN : Number(x);
      return Number.isFinite(n) ? n : null;
    });
  });
  const rank = payload.rank.map((r, i) => (r.length === cells[i].length && r.every((x) => typeof x === "number") ? r : null));
  return { columns, cells, rank, values, total: payload.count };
}

/// The rows a grid holds.
export function rowCount(grid: Grid): number {
  return grid.cells[0]?.length ?? 0;
}

/// One CSV field, quoted when it holds a comma, a quote or a line break
/// (RFC 4180), with its quotes doubled.
export function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/// Text a spreadsheet opening the CSV would run as a formula - one that
/// starts with `=`, `+`, `-`, `@`, a tab or a carriage return, but is not a
/// number - with a leading `'`, so it is shown as the text it is.
export function csvText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) && !/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text) ? `'${text}` : text;
}

/// The grid as CSV: a header of the column names, then `rows` (indices, in
/// the order shown) as their cells show them. Lines end in `\n`. Names
/// and every cell go through `csvText`: a symbol or a string can be
/// anything, and a numeric or temporal column holds `-0W` and `-0D01:00`,
/// which are no number either.
export function toCsv(grid: Grid, rows?: number[]): string {
  const order = rows ?? [...Array(rowCount(grid)).keys()];
  const lines = [grid.columns.map((c) => csvField(csvText(c.name))).join(",")];
  for (const r of order) {
    lines.push(grid.cells.map((column) => csvField(csvText(column[r] ?? ""))).join(","));
  }
  return lines.join("\n") + "\n";
}
