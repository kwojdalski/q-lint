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
//   tree   for a dictionary (not keyed by a table) or a general list, the
//          value as nested nodes, `(key;text;type;count;children)`: a
//          dictionary's children are its entries, a list's its items, and
//          a simple list other than a string is opened into its atoms. At
//          most `TREE_NODES` nodes in all, each node's share divided among
//          its children, so a wide value is cut at every level rather than
//          drawn whole at the first. `text` is `-3!` of a leaf (a string
//          escaped as a cell is), and "" for a node with children. `()`
//          for any other value
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

/// The most nodes `GRID` sends of a dictionary or a nested list's tree.
export const TREE_NODES = 2000;

/// The name a result cut at its limit is held under for paging (#922).
export const HELD = ".qlint.held";

/// How `GRID` writes each column's cells, raw numbers and ranks, given the
/// escapes `e` and the columns `c`; `PAGE` writes a page's the same way.
const COLUMN_LINES = [
  "          {[e;x]$[type[x] within 1 76h;string x;{$[200<count x;(197#x),\"...\";x]} each",
  "            {[e;x]$[10h=type x;$[1=count x;\",\";\"\"],\"\\\"\",raze[e\"i\"$200 sublist x],\"\\\"\";-3!x]}[e] each x]}[e] each c;",
  "          {[c]u:type c;$[u in 12 16h;\"j\"$c;u in 13 14 17 18 19h;\"i\"$c;u=15h;\"f\"$c;u in 2 5 6 7 8 9h;c;()]} each c;",
  "          {@[{i:iasc x;\"i\"$@[count[x]#0;i;:;-1+sums differ x i]};x;{[e]()}]} each c;",
];

/// `GRID`, with the tree (`tree`) or without it (`()`): a tree is asked for
/// only by the result panel, and only while `q-lint.results.tree.enable` is
/// on, so nothing else sends its code. With `hold`, a table cut at its
/// limit is kept on the process as `HELD`, for `PAGE` to send more of, and
/// `HELD` is emptied when it is not cut: only the result panel asks for
/// that, while `q-lint.results.paging.enable` is on.
export function gridLambda(tree: boolean, hold = false): string {
  const lines = [
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
  ...(!tree ? [] : [
  "     g:{[g;e;b;k;v]u:type v;d:$[99h=u;98h<>type key v;0b];x:d|(0h=u)|(u within 1 76h)&u<>10h;",
  "       m:$[x;count[v]&0|b-1;0];c:$[m;(b-1) div m;0];f:{$[200<count x;(197#x),\"...\";x]};",
  "       l:$[d;{[f;x]$[-11h=type x;string x;f -3!x]}[f] each m#key v;string til m];",
  "       s:$[x|u in 98 99h;\"\";10h=u;$[1=count v;\",\";\"\"],\"\\\"\",raze[e\"i\"$200 sublist v],\"\\\"\",$[200<count v;\"...\";\"\"];f -3!v];",
  "       (k;s;u;count v;$[m;g[g;e;c]'[l;$[d;m#value v;m#v]];()])};"]),
  "     $[98h<>type t;t;",
  "       [m:count t;",
  ...(hold ? [`        ${HELD}:$[(n>0)&m>n;t;()];`] : []),
  "        t:$[1b~.Q.qp t;[j:$[n<0;(m+n)|0;0]+til m&abs n;$[count j;.Q.ind[t;j];select from t where i<0]];n sublist t];",
  "        c:$[count[cols t]=count distinct cols t;t cols t;value flip t];",
  "        `count`keys`names`types`cells`raw`rank`tree!(\"f\"$m;\"i\"$k;cols t;type each c;",
  ...COLUMN_LINES,
  tree ? `          $[(0h=type v)|$[99h=type v;98h<>type key v;0b];g[g;e;${TREE_NODES};"";v];()])]]};` : "          ())]]};",
  "     (r 1;\"j\"$limit);{[e]e}]);",
  "   `ok`error`trace!(0b;r 1;r 2)]}",
  ];
  return lines.join("\n");
}

export const GRID = gridLambda(false);
/// `GRID` with a dictionary's or a nested list's tree.
export const GRID_TREE = gridLambda(true);

/// The rows `off` to `off+n` of the table `GRID` held, as `GRID`'s `grid`
/// writes them but for its `keys` and `tree`: `count` is the rows held,
/// and the ranks are the page's own. q's error as a string when nothing is
/// held, as after the process restarted or another result replaced it.
export const PAGE = [
  "{[off;n]",
  " .[{[off;n]",
  `   t:${HELD};if[not 98h=type t;'\`held];m:count t;e:{1_-1_-3!x} each "c"$til 256;`,
  "   j:(\"j\"$off)+til 0|(\"j\"$n)&m-\"j\"$off;",
  "   t:$[1b~.Q.qp t;$[count j;.Q.ind[t;j];select from t where i<0];t j];",
  "   c:$[count[cols t]=count distinct cols t;t cols t;value flip t];",
  "   `count`names`types`cells`raw`rank!(\"f\"$m;cols t;type each c;",
  ...COLUMN_LINES.map((line, i) => line.replace(/^ {7}/, "").replace(/;$/, i === COLUMN_LINES.length - 1 ? ")};" : ";")),
  "   (off;n);{x}]}",
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
  /// A dictionary or a general list as a tree, when it was one.
  tree?: TreeNode;
}

/// One node of a value's tree: its key in its parent (a dictionary's key,
/// a list's index), q's text of it when it is a leaf, its type and count,
/// and the children sent - fewer than `count` when the tree was cut.
export interface TreeNode {
  key: string;
  text: string;
  type: number;
  count: number;
  children: TreeNode[];
}

/// A node as `GRID` sends it, `(key;text;type;count;children)`, or
/// undefined when it is not one.
export function readTree(raw: unknown, depth = 0): TreeNode | undefined {
  if (!Array.isArray(raw) || raw.length !== 5 || depth > 64) {
    return undefined;
  }
  const [key, text, type, count, children] = raw;
  const kids = Array.isArray(children) ? children.map((c) => readTree(c, depth + 1)) : [];
  if (kids.some((k) => k === undefined)) {
    return undefined;
  }
  const str = (x: unknown): string => (typeof x === "string" ? x : Array.isArray(x) && x.length === 0 ? "" : String(x ?? ""));
  return { key: str(key), text: str(text), type: Number(type), count: Number(count), children: kids as TreeNode[] };
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
  const tree = readTree(g.tree);
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
      ...(tree !== undefined ? { tree } : {}),
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

/// A page `PAGE` sent: the rows held, and the page's columns as `GRID`'s.
export interface GridPage {
  count: number;
  names: string[];
  types: number[];
  cells: string[][];
  raw: unknown[][];
  rank: number[][];
}

/// What `PAGE` answered: a page, or q's error as a string.
export function readPage(raw: unknown): GridPage | string {
  if (typeof raw === "string") {
    return raw;
  }
  const g = raw as Record<string, unknown> | null;
  if (g === null || typeof g !== "object" || !Array.isArray(g.names) || !Array.isArray(g.cells) || g.cells.length !== g.names.length) {
    return `the process answered something other than a page: ${JSON.stringify(raw)?.slice(0, 200)}`;
  }
  const names = (g.names as unknown[]).map((n) => (n === null ? "" : String(n)));
  const perColumn = (x: unknown): unknown[][] => names.map((_, i) => (Array.isArray(x) && Array.isArray(x[i]) ? x[i] : []));
  return {
    count: typeof g.count === "number" ? g.count : 0,
    names,
    types: Array.isArray(g.types) ? g.types.map(Number) : [],
    cells: perColumn(g.cells).map((c) => c.map((x) => (typeof x === "string" ? x : String(x)))),
    raw: perColumn(g.raw),
    rank: perColumn(g.rank) as number[][],
  };
}

/// A raw number as it sorts: a long, timestamp or timespan exactly, as a
/// bigint; q's null before everything, its infinities at either end.
export function sortKey(x: unknown): number | bigint {
  if (x === null || x === undefined) {
    return -Infinity;
  }
  if (typeof x === "number") {
    // -Infinity is the null's: an infinity sorts just after it.
    return x === -Infinity ? -Number.MAX_VALUE : x;
  }
  try {
    return BigInt(String(x));
  } catch {
    return Number(x);
  }
}

/// A cell's text as it sorts: a string item, which `GRID` writes quoted and
/// escaped as `-3!` does, as its characters, so a one-character one (`,"b"`)
/// sorts among the others as `iasc` puts it (#1126).
export function sortText(cell: string): string {
  const m = /^,?"((?:[^"\\]|\\.)*)"$/s.exec(cell);
  if (m === null) {
    return cell;
  }
  const named: Record<string, string> = { n: "\n", r: "\r", t: "\t" };
  return m[1].replace(/\\([0-7]{3}|.)/gs, (_, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : (named[e] ?? e)));
}

/// Ranks over a whole column, as `GRID` gives them: equal values share one.
export function denseRank(n: number, compare: (a: number, b: number) => number): number[] {
  const order = [...Array(n).keys()].sort((a, b) => compare(a, b) || a - b);
  const rank = new Array<number>(n);
  let r = -1;
  order.forEach((row, k) => {
    if (k === 0 || compare(order[k - 1], row) !== 0) {
      r += 1;
    }
    rank[row] = r;
  });
  return rank;
}

/// `payload` with `page`'s rows after its own. The ranks are ranked again
/// over both - by the raw numbers where there are some, by the text where q
/// sorts by it (symbols, chars, booleans, bytes, guids) - and are dropped
/// for a column q could not sort. A page whose columns are not the
/// payload's is refused.
export function appendPage(payload: GridPayload, page: GridPage): GridPayload {
  if (page.names.length !== payload.names.length || page.names.some((n, i) => n !== payload.names[i] || page.types[i] !== payload.types[i])) {
    throw new Error("the rows held on the process are not this result's");
  }
  const cells = payload.cells.map((c, i) => c.concat(page.cells[i]));
  const raw = payload.raw.map((r, i) => (r.length === payload.cells[i].length && page.raw[i].length === page.cells[i].length ? r.concat(page.raw[i]) : []));
  const rank = cells.map((column, i) => {
    const ranked = payload.rank[i].length === payload.cells[i].length && page.rank[i].length === page.cells[i].length;
    if (!ranked) {
      return [];
    }
    const byNumber = NUMERIC.has(payload.types[i]) || TEMPORAL.has(payload.types[i]);
    const values = byNumber && raw[i].length === column.length && raw[i].length > 0 ? raw[i].map(sortKey) : undefined;
    const texts = values === undefined ? column.map(sortText) : [];
    const compare = values !== undefined
      ? (a: number, b: number) => (values[a] < values[b] ? -1 : values[a] > values[b] ? 1 : 0)
      : (a: number, b: number) => (texts[a] < texts[b] ? -1 : texts[a] > texts[b] ? 1 : 0);
    return denseRank(column.length, compare);
  });
  return { ...payload, count: page.count, cells, raw, rank };
}
