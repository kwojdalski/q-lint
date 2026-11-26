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
//   types  each column's q type, a mapped list's (77h-97h, an HDB's
//          splayed nested column) a general list's 0h, which it is to
//          `select` (#2084)
//   cells  each column as q prints it in a table: `string` of a simple
//          column, `-3!` of each item of any other (cut at 200 characters).
//          `-3!` stops at the process's `\c` width, so a string item is
//          written here, each character escaped as `-3!` escapes it
//   raw    the column itself, made its underlying number - `"j"$` of a
//          timestamp, `"i"$` of a date - for the numeric, temporal and guid
//          types, and a char column's bytes (`"x"$`): its cells are
//          decoded as UTF-8, which a byte past ASCII alone is not; a
//          symbol column's past ASCII, each symbol's bytes where it has
//          one past ASCII and `0b` where not, its cells read from them
//          (#2083), and an enumerated column's the same (#2463). For a
//          general column, each float or real item as a float, which `-3!`
//          writes to `\P` digits - a table column's rows too (#2085) -
//          and `0b` for any other item (not a null,
//          which the codec makes of `` ` ``) but one with floats or reals
//          inside: `("F";v)` or `("E";v)` for a list of them (a real as its
//          float), and `("l";v)` for a general list of at most 200, each
//          item `("f";x)`, `("e";x)`, such a pair, or its `-3!` text
//          (#1502); `("s";b)` and `("S";bs)` for a symbol or symbols
//          of a byte past ASCII, or of a character that ends a symbol in
//          `-3!`'s text (#3076), their bytes; `("u";text)` for a function
//          `-3!` writes as q does not read back - one defined in q, a
//          composition, a projection or a derived function of either -
//          its text (#3084); `("c";(t;n))` for a minute, second, time, datetime
//          or timestamp atom or vector of type `t` that `-3!` writes as q
//          cannot read back - past 99 hours (`**`), finer than a
//          millisecond, outside 1709-2290 - `n` its count (#2082); `()`
//          for the rest
//   rank   each row's value's place among the column's distinct values,
//          sorted by q (`iasc`), so equal values share one; `()` where q
//          cannot sort it. A copy of the column is sorted (`x til count
//          x`): `iasc` marks a vector already in order `s#` where it is,
//          and the column can be the user's own table's (#1863)
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
import { LAID_TEXT, readAnswer, trapLines, type Answer } from "./query";

/// The most nodes `GRID` sends of a dictionary or a nested list's tree.
export const TREE_NODES = 2000;

/// The name results cut at their limit are held under for paging (#922):
/// a dictionary from each client's handle to the token of its last such
/// result and the table, so a client pages only its own result, and only
/// the one it was given the token for (#2128). Entries of handles closed
/// since are dropped at each hold.
export const HELD = ".qlint.held";

/// Whether `token` can be written into q as a string literal as it is: a
/// result's hold token, which `newHoldToken` makes.
function holdLiteral(token: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(token)) {
    throw new Error(`not a hold token: ${token}`);
  }
  return `"${token}"`;
}

/// How `GRID` writes each column's cells, raw numbers and ranks, given the
/// escapes `e`, the columns `c` and their types `y`; `PAGE` writes a page's
/// the same way. `y` is the type each column has in the whole table: q
/// makes a vector of a general column's rows when those cut are all of one
/// type, and they are written as a general column's all the same (#3068).
/// The ranks are dense. A float column's share one only where the values
/// are the same number, as `distinct` and `by` group them: `differ` takes
/// floats within q's comparison tolerance as equal (#3070).
const COLUMN_LINES = [
  "          {[e;u;x]$[u within 1 76h;string x;{$[200<count x;(197#x),\"...\";x]} each",
  "            {[e;x]$[10h=type x;$[1=count x;\",\";\"\"],\"\\\"\",raze[e\"i\"$200 sublist x],\"\\\"\";-3!x]}[e] each x]}[e]'[y;c];",
  "          {[u;c]$[u in 12 16h;\"j\"$c;u in 13 14 17 18 19h;\"i\"$c;u=15h;\"f\"$c;u=10h;\"x\"$c;u in 2 5 6 7 8 9h;c;",
  "            (u=11h)|u within 20 76h;$[any 127<\"i\"$\"x\"$raze s:string c;{$[any 127<\"i\"$\"x\"$x;\"x\"$x;0b]} each s;()];",
  "            (u=0h)|u within 77 98h;{[g;x]$[-9h=t:type x;$[null x;0b;x];-8h=t;$[null x;0b;\"f\"$x];g x]}[{$[-9h=t:type x;(\"f\";x);-8h=t;(\"e\";\"f\"$x);",
  "              (t in 8 9h)&200>=count x;($[t=9h;\"F\";\"E\"];\"f\"$x);(0h=t)&200>=count x;",
  "              $[all 0b~/:r:.z.s each x;0b;(\"l\";@[r;w;:;-3!'x w:where 0b~/:r])];",
  "              99h=t;$[0b~r:.z.s(key x;value x);0b;(\"d\";r 1)];98h=t;$[0b~r:.z.s flip x;0b;(\"t\";r)];",
  "              200<count x;0b;",
  "              -11h=t;$[any(s in\"`;)]}!$#\")|127<\"i\"$\"x\"$s:string x;(\"s\";\"x\"$s);0b];",
  "              11h=t;$[any(r in\"`;)]}!$#\")|127<\"i\"$\"x\"$r:raze s:string x;(\"S\";\"x\"$s);0b];",
  "              t within 100 111h;$[{$[100h=t:type x;\"k)\"~2#-3!x;105h=t;1b;104h=t;any .z.s each value x;t within 106 111h;.z.s value x;0h=t;any .z.s each x;0b]}x;(\"u\";-3!x);0b];",
  "              abs[t]within 17 19h;$[any(abs w:\"i\"$x)within(1+5999 359999 359999999 abs[t]-17),2147483646;(\"c\";(t;w));0b];",
  "              15h=abs t;$[any 0.001<abs m-\"j\"$m:86400000*\"f\"$x;(\"c\";(t;\"f\"$x));0b];",
  "              12h=abs t;$[all(null x)|(x in -0W 0Wp)|x within 1709.01.01D00:00 2290.12.31D23:59:59.999999999;0b;(\"c\";(t;\"j\"$x))];0b]}] each c;()]}'[y;c];",
  "          {@[{i:iasc x:x til count x;\"i\"$@[count[x]#0;i;:;$[type[x]in 8 9 15h;{(-1+sums g=til count g)g:x?x};{-1+sums differ x}]x i]};x;{[e]()}]} each c;",
];

/// `GRID`, with the tree (`tree`) or without it (`()`): a tree is asked for
/// only by the result panel, and only while `q-lint.results.tree.enable` is
/// on, so nothing else sends its code. With `hold`, a token, a table cut
/// at its limit is kept on the process in `HELD` for this client under
/// that token, for `PAGE` to send more of, and this client's entry is
/// dropped when it is not cut: only the result panel asks for that, while
/// `q-lint.results.paging.enable` is on. `readOnly`: the statements are
/// evaluated under `reval` (`trapLines`); what shapes the value is not.
export function gridLambda(tree: boolean, hold?: string, readOnly = false): string {
  const lines = [
  "{[s;size;limit]",
  ...trapLines(readOnly),
  " $[r 0;",
  `   \`ok\`type\`text\`grid!(1b;type r 1;${LAID_TEXT}[size;r 1];.[{[v;n]`,
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
  "       s:$[t:(99h=u)&not d;\"keyed\";x|u in 98 99h;\"\";10h=u;$[1=count v;\",\";\"\"],\"\\\"\",raze[e\"i\"$200 sublist v],\"\\\"\",$[200<count v;\"...\";\"\"];f -3!v];",
  "       (k;s;$[t;98h;u];count v;$[m;g[g;e;c]'[l;$[d;m#value v;m#v]];()])};"]),
  "     $[98h<>type t;t;",
  "       [m:count t;",
  ...(hold !== undefined
    ? [
        `        h:@[value;\`${HELD};()!()];h:$[99h=type h;@[{(key[x] inter key .z.W)#x};h;h];()!()];`,
        `        ${HELD}:$[(n>0)&m>n;h,(enlist .z.w)!enlist(${holdLiteral(hold)};t);(enlist .z.w)_h];`,
      ]
    : []),
  "        y:$[p:1b~.Q.qp t;();type each $[count[cols t]=count distinct cols t;t cols t;value flip t]];",
  "        t:$[p;[j:$[n<0;(m+n)|0;0]+til m&abs n;$[count j;.Q.ind[t;j];select from t where i<0]];n sublist t];",
  "        c:$[count[cols t]=count distinct cols t;t cols t;value flip t];if[p;y:type each c];",
  "        `count`keys`names`types`cells`raw`rank`tree!(\"f\"$m;\"i\"$k;$[any 127<\"i\"$\"x\"$raze nm:string cols t;{$[any 127<\"i\"$\"x\"$x;\"x\"$x;`$x]} each nm;cols t];{$[x within 77 97h;0h;x]}each y;",
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
/// `GRID` and `GRID_TREE` under `reval`.
export const GRID_READ_ONLY = gridLambda(false, undefined, true);
export const GRID_TREE_READ_ONLY = gridLambda(true, undefined, true);

/// The rows `off` to `off+n` of the table `GRID` held for this client
/// under the token `tok`, as `GRID`'s `grid` writes them but for its `keys`
/// and `tree`: `count` is the rows held, and the ranks are the page's own.
/// A general column holding other than strings is ranked over every row up
/// to the page's last instead: q orders it by its values, which no cell's
/// text sorts as (#3082), a char atom before the strings (#3069). Not a
/// partitioned table's, read by row index.
/// q's error as a string when it is not held, as after the process
/// restarted or another result of this client replaced it.
export const PAGE = [
  "{[tok;off;n]",
  " .[{[tok;off;n]",
  `   h:@[value;\`${HELD};()!()];h:$[99h=type h;$[.z.w in key h;h .z.w;()];()];if[not tok~first h;'\`held];`,
  `   t:last h;if[not 98h=type t;'\`held];m:count t;e:{1_-1_-3!x} each "c"$til 256;`,
  "   j:(\"j\"$off)+til 0|(\"j\"$n)&m-\"j\"$off;",
  "   y:type each d:$[p:1b~.Q.qp t;();$[count[cols t]=count distinct cols t;t cols t;value flip t]];",
  "   t:$[p;$[count j;.Q.ind[t;j];select from t where i<0];t j];",
  "   c:$[count[cols t]=count distinct cols t;t cols t;value flip t];if[p;y:type each c];",
  "   r:$[p;c;{[k;u;x;d]$[(u=0h)|u within 77 97h;$[all 10h=type each d:k sublist d;x;d];x]}[(\"j\"$off)+count j]'[y;c;d]];",
  "   `count`names`types`cells`raw`rank!(\"f\"$m;$[any 127<\"i\"$\"x\"$raze nm:string cols t;{$[any 127<\"i\"$\"x\"$x;\"x\"$x;`$x]} each nm;cols t];{$[x within 77 97h;0h;x]}each y;",
  ...COLUMN_LINES.map((line, i) => (i === COLUMN_LINES.length - 1 ? line.replace(/^ {7}/, "").replace(/ each c;$/, " each r)};") : line.replace(/^ {7}/, ""))),
  "   (tok;off;n);{x}]}",
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
  /// Each name's bytes, null for one with none past ASCII; absent when no
  /// name has one (#2467).
  nameBytes?: (number[] | null)[];
}

/// One node of a value's tree: its key in its parent (a dictionary's key,
/// a list's index), q's text of it when it is a leaf, its type and count,
/// and the children sent - fewer than `count` when the tree was cut.
/// A keyed table is a leaf of type 98 with the text `keyed`, not a
/// dictionary that has no children to open (#2503).
export interface TreeNode {
  key: string;
  text: string;
  type: number;
  count: number;
  children: TreeNode[];
}

/// A node as `GRID` sends it, `(key;text;type;count;children)`, or
/// undefined when it is not one. Cut 64 levels down: a node there is kept
/// with its children not read, as one whose children were not sent, not
/// dropped with the whole tree (#1654).
export function readTree(raw: unknown, depth = 0): TreeNode | undefined {
  if (!Array.isArray(raw) || raw.length !== 5) {
    return undefined;
  }
  const [key, text, type, count, children] = raw;
  const kids = Array.isArray(children) && depth < 64 ? children.map((c) => readTree(c, depth + 1)) : [];
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
/// A real's raw number as the shortest decimal that reads back as the same
/// float32. The codec widens a real's four bytes to the nearest double, so
/// 0.1e arrives as 0.10000000149011612 - a number q neither holds nor
/// prints, which an export would write and an `=` rule never match (#1488).
export function realValue(x: unknown): unknown {
  // -0 too keeps its sign, which `toPrecision` drops (#2089).
  if (typeof x !== "number" || !Number.isFinite(x) || x === 0) {
    return x;
  }
  // Nine digits are always enough for a float32 (#1734).
  for (let digits = 1; digits <= 9; digits++) {
    const n = Number(x.toPrecision(digits));
    if (Math.fround(n) === x) {
      return n;
    }
  }
  return x;
}

/// Bytes as text: UTF-8 where they are, and each byte that is part of no
/// UTF-8 character its Latin-1 character, spoiling none of the others
/// (#1737). Undefined when `raw` is no list of bytes.
export function bytesText(raw: unknown): string | undefined {
  if (!Array.isArray(raw) && !(raw instanceof Uint8Array)) {
    return undefined;
  }
  const bytes = Buffer.from(raw as number[]);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    // The character the byte at `i` leads, by its length; latin1 if it is none.
    const b = bytes[i];
    const length = b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let char: string | undefined;
    try {
      char = length > 0 && i + length <= bytes.length ? utf8.decode(bytes.subarray(i, i + length)) : undefined;
    } catch {
      char = undefined;
    }
    out += char ?? bytes.toString("latin1", i, i + 1);
    i += char === undefined ? 1 : length;
  }
  return out;
}

/// The column names `GRID` or `PAGE` sent: where one has a byte past
/// ASCII, each such name's bytes and the rest as symbols. A name is read
/// from its bytes, as a symbol cell is, and they are kept for Copy as q
/// (#2467).
function sentNames(sent: unknown[]): { names: string[]; nameBytes?: (number[] | null)[] } {
  const bytes = sent.map((n) => (Array.isArray(n) || n instanceof Uint8Array ? Array.from(n as ArrayLike<number>) : null));
  const names = sent.map((n, i) => (bytes[i] !== null ? bytesText(bytes[i])! : n === null ? "" : String(n)));
  return bytes.some((b) => b !== null) ? { names, nameBytes: bytes } : { names };
}

/// Whether a column of type `type` is of symbols: plain or enumerated.
export const symbolType = (type: number): boolean => type === 11 || (type >= 20 && type <= 76);

/// The cells `GRID` or `PAGE` sent, a symbol of bytes past ASCII read from
/// them: its text alone is U+FFFD where they are no UTF-8 (#2083), in a
/// symbol or an enumerated column (#2463), on every page (#2462), and as a
/// general list's item, `("s";b)` or `("S";bs)` (#2464).
function sentCells(cells: unknown[][], types: number[], raw: unknown[][]): string[][] {
  return cells.map((c, i) =>
    c.map((x, r) => {
      const text = typeof x === "string" ? x : String(x);
      const sent = raw[i]?.[r];
      if (symbolType(types[i])) {
        return bytesText(sent) ?? text;
      }
      if (types[i] === 0 && Array.isArray(sent) && sent.length === 2 && !text.endsWith("...")) {
        const [tag, v] = sent;
        if (tag === "s" && Array.isArray(v)) {
          return `\`${bytesText(v)}`;
        }
        if (tag === "S" && Array.isArray(v) && v.every(Array.isArray)) {
          return `${v.length === 1 ? "," : ""}${v.map((b) => `\`${bytesText(b)}`).join("")}`;
        }
      }
      return text;
    }),
  );
}

/// Each column's raw numbers, a real column's made `realValue`s.
function rawColumns(raw: unknown[][], types: number[]): unknown[][] {
  return raw.map((c, i) => (types[i] === 8 ? c.map(realValue) : c));
}

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
      ...sentNames(names),
      types: types.map(Number),
      cells: sentCells(cells as unknown[][], types.map(Number), perColumn(g.raw)),
      raw: rawColumns(perColumn(g.raw), types.map(Number)),
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
  /// For a general column holding float or real vectors, each cell's
  /// numbers as `GRID` sent them (`("F";v)`), whole where its text was cut
  /// at the process's `\c` width; null for a cell or a column with none
  /// (#2465). Absent when no column has any.
  vectors?: (((number | null)[] | null)[] | null)[];
}

/// A char column's cell from its byte when sent: one past ASCII is no UTF-8
/// character alone, so its decoded text is U+FFFD whatever the byte was.
/// It is the Latin-1 character, as `plainItem` reads such a byte (#1962).
export function charText(text: string, raw: unknown): string {
  return typeof raw === "number" && raw >= 128 && raw <= 255 ? String.fromCharCode(raw) : text;
}

/// What one cell shows: q's text, except that a null or an infinity is
/// written as kdb+ writes it in a table, a char past ASCII is its own
/// character, and a float or real has the decimals asked for (`decimals`
/// < 0: as q wrote it).
export function cellText(type: number, text: string, raw: unknown, decimals: number): string {
  if (raw === undefined) {
    return text;
  }
  if (type === 10) {
    return charText(text, raw);
  }
  if (raw === null) {
    return type === 2 ? NULL_GUID : "";
  }
  // A general list's item is a float or a real, which q's text already
  // writes as 0w or -0we (#1733).
  if ((raw === Infinity || raw === -Infinity) && type !== 0) {
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
  const vectors = payload.types.map((type, i) => {
    const raw = payload.raw[i];
    if (type !== 0 || raw.length !== cells[i].length) {
      return null;
    }
    const v = raw.map(floatVector);
    return v.some((x) => x !== null) ? v : null;
  });
  return { columns, cells, rank, values, total: payload.count, ...(vectors.some((v) => v !== null) ? { vectors } : {}) };
}

/// A general list's item `GRID` sent as `("F";v)` or `("E";v)` as its
/// numbers, a null or an infinity as null; null for any other item.
function floatVector(x: unknown): (number | null)[] | null {
  if (!Array.isArray(x) || x.length !== 2 || (x[0] !== "F" && x[0] !== "E") || !Array.isArray(x[1])) {
    return null;
  }
  return (x[1] as unknown[]).map((n) => {
    const v = n === null ? NaN : Number(x[0] === "E" ? realValue(n) : n);
    return Number.isFinite(v) ? v : null;
  });
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
/// and a cell that is the user's text go through `csvText`: a symbol or a
/// string can be anything. A numeric or temporal column's cell is q's own
/// text or a name's format of it, and no formula: its `-0W`, `-0D01:00`
/// and `-5.00%` are written as they are, as the rows above zero are
/// (#3075, #3088).
export function toCsv(grid: Grid, rows?: number[]): string {
  return csvLines(grid, rows).join("");
}

/// `toCsv`'s lines, each with its `\n`: what a file is written from with
/// `textBuffer`, as a big result's CSV is past the longest string V8 makes.
export function csvLines(grid: Grid, rows?: number[]): string[] {
  const order = rows ?? [...Array(rowCount(grid)).keys()];
  const lines = [grid.columns.map((c) => csvField(csvText(c.name))).join(",") + "\n"];
  const own = grid.columns.map((c) => c.numeric || c.temporal);
  for (const r of order) {
    lines.push(grid.cells.map((column, i) => csvField(own[i] ? (column[r] ?? "") : csvText(column[r] ?? ""))).join(",") + "\n");
  }
  return lines;
}

/// `parts` one after another as UTF-8, joined a few megabytes at a time: a
/// result of a million rows by fifty columns is more text than V8's longest
/// string (about 536M characters), which one `join` would throw on
/// (#1855). A `Buffer` holds it.
export function textBuffer(parts: Iterable<string>): Buffer {
  const chunks: Buffer[] = [];
  let pending: string[] = [];
  let size = 0;
  for (const part of parts) {
    pending.push(part);
    size += part.length;
    if (size >= 1 << 24) {
      chunks.push(Buffer.from(pending.join(""), "utf8"));
      pending = [];
      size = 0;
    }
  }
  chunks.push(Buffer.from(pending.join(""), "utf8"));
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

/// The most text a copy puts on the clipboard, in bytes: past it the text
/// is no use pasted and nears what a string can hold.
export const CLIPBOARD_LIMIT = 64 * 1024 * 1024;

/// Why `data` is not copied - too big for the clipboard - or undefined
/// when it can be.
export function tooBigToCopy(data: Buffer, rows: number): string | undefined {
  return data.length > CLIPBOARD_LIMIT
    ? `q-lint: ${rows.toLocaleString("en-US")} row(s) are ${Math.ceil(data.length / 1024 / 1024).toLocaleString("en-US")} MB of text, more than the ${CLIPBOARD_LIMIT / 1024 / 1024} MB a copy puts on the clipboard. Export them to a file instead.`
    : undefined;
}

/// `payload` with only the columns at `columns`, in that order: what the
/// grid draws under its layout, for an export of it (#1639). The key
/// columns stay keys while they lead.
export function pickColumns(payload: GridPayload, columns: number[]): GridPayload {
  let keys = 0;
  while (keys < columns.length && columns[keys] < payload.keys) {
    keys++;
  }
  const pick = <T>(of: T[][]): T[][] => columns.map((i) => of[i] ?? []);
  const nameBytes = payload.nameBytes;
  return {
    ...payload,
    keys,
    names: columns.map((i) => payload.names[i]),
    types: columns.map((i) => payload.types[i]),
    cells: pick(payload.cells),
    raw: pick(payload.raw),
    rank: pick(payload.rank),
    ...(nameBytes !== undefined ? { nameBytes: columns.map((i) => nameBytes[i] ?? null) } : {}),
  };
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
  const { names } = sentNames(g.names as unknown[]);
  const perColumn = (x: unknown): unknown[][] => names.map((_, i) => (Array.isArray(x) && Array.isArray(x[i]) ? x[i] : []));
  const types = Array.isArray(g.types) ? g.types.map(Number) : [];
  return {
    count: typeof g.count === "number" ? g.count : 0,
    names,
    types,
    cells: sentCells(perColumn(g.cells), types, perColumn(g.raw)),
    raw: rawColumns(perColumn(g.raw), types),
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
/// sorts among the others as `iasc` puts it (#1126). One `GRID` cut at 197
/// characters and "..." has no closing quote: its characters up to the cut
/// (#1643).
export function sortText(cell: string): string {
  const m = /^,?"((?:[^"\\]|\\.)*)(?:"|\\?\.\.\.)$/s.exec(cell);
  if (m === null) {
    return cell;
  }
  const named: Record<string, string> = { n: "\n", r: "\r", t: "\t" };
  return m[1].replace(/\\([0-7]{3}|.)/gs, (_, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : (named[e] ?? e)));
}

/// Two texts in code point order, as q sorts a symbol or a string by its
/// UTF-8 bytes: JavaScript's `<` compares UTF-16 units, which puts an
/// astral character (an emoji) before U+E000-U+FFFF (#1642).
export function codePointOrder(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      // A surrogate is half of an astral character: after every BMP one.
      const sx = x >= 0xd800 && x <= 0xdfff;
      const sy = y >= 0xd800 && y <= 0xdfff;
      return sx !== sy ? (sx ? 1 : -1) : x < y ? -1 : 1;
    }
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
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

/// Rank arrays `mergeRank` made, so already known to agree with the column's
/// order: the next page need not check them again.
const merged = new WeakSet<readonly number[]>();

/// The dense ranks over `n` rows when the first `held` already have theirs in
/// `heldRank`: the page's rows are sorted alone and each distinct value is
/// placed among the held ones by binary search, so a page costs its own sort
/// plus one pass of integer arithmetic over the rows held, not a sort of
/// every row (#1854). Held ranks this did not make are checked first - in
/// range, no gap, in the order `compare` gives - and ranked again from
/// scratch if not, so the answer is `denseRank`'s. Rows sharing a held rank
/// are taken as equal: `compare` sees one row per rank, so a column's sort
/// keys need not all be worked out.
export function mergeRank(held: number, heldRank: readonly number[], n: number, compare: (a: number, b: number) => number): number[] {
  const all = new Int32Array(held).fill(-1);
  let distinct = 0;
  for (let row = 0; row < held; row++) {
    const r = heldRank[row];
    if (!Number.isInteger(r) || r < 0 || r >= held) {
      return remember(denseRank(n, compare));
    }
    if (all[r] === -1) {
      all[r] = row;
      distinct = Math.max(distinct, r + 1);
    }
  }
  const reps = all.subarray(0, distinct);
  if (!merged.has(heldRank)) {
    for (let r = 0; r < reps.length; r++) {
      if (reps[r] === -1 || (r > 0 && compare(reps[r - 1], reps[r]) >= 0)) {
        return remember(denseRank(n, compare));
      }
    }
  }
  const order: number[] = [];
  for (let row = held; row < n; row++) {
    order.push(row);
  }
  order.sort((a, b) => compare(a, b) || a - b);
  const pageRank = new Int32Array(n - held);
  // shift[r]: the page's new values that sort before held rank r.
  const shift = new Int32Array(reps.length + 1);
  let added = 0;
  let last = -1;
  let lastRank = -1;
  for (const row of order) {
    if (last !== -1 && compare(last, row) === 0) {
      pageRank[row - held] = lastRank;
      continue;
    }
    let lo = 0;
    let hi = reps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compare(reps[mid], row) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo < reps.length && compare(reps[lo], row) === 0) {
      // A held value: its rank once the new values before it are counted.
      lastRank = lo + added;
    } else {
      lastRank = lo + added;
      shift[lo] += 1;
      added += 1;
    }
    last = row;
    pageRank[row - held] = lastRank;
  }
  for (let r = 1; r <= reps.length; r++) {
    shift[r] += shift[r - 1];
  }
  const rank: number[] = [];
  for (let row = 0; row < held; row++) {
    const r = heldRank[row];
    rank.push(r + shift[r]);
  }
  for (const r of pageRank) {
    rank.push(r);
  }
  return remember(rank);
}

function remember(rank: number[]): number[] {
  merged.add(rank);
  return rank;
}

/// `payload` with `page`'s rows after its own. The ranks are ranked again
/// over both - by the raw numbers where there are some, by the text where q
/// sorts by it (symbols, chars, booleans, bytes, guids) - and are dropped
/// for a column q could not sort. A general column `PAGE` ranked over every
/// row takes those ranks. A page whose columns are not the payload's is
/// refused.
export function appendPage(payload: GridPayload, page: GridPage): GridPayload {
  if (page.names.length !== payload.names.length || page.names.some((n, i) => n !== payload.names[i] || page.types[i] !== payload.types[i])) {
    throw new Error("the rows held on the process are not this result's");
  }
  const cells = payload.cells.map((c, i) => c.concat(page.cells[i]));
  // A symbol column's bytes are sent only by an answer with one past
  // ASCII: the other's are each `0b`, none past it (#2461).
  const raw = payload.raw.map((held, i) => {
    const pad = (r: unknown[], n: number, other: unknown[]): unknown[] => (symbolType(payload.types[i]) && r.length === 0 && n > 0 && other.length > 0 ? new Array(n).fill(false) : r);
    const r = pad(held, payload.cells[i].length, page.raw[i]);
    const p = pad(page.raw[i], page.cells[i].length, held);
    return r.length === payload.cells[i].length && p.length === page.cells[i].length ? r.concat(p) : [];
  });
  const rank = cells.map((column, i) => {
    const held = payload.cells[i].length;
    // `PAGE` ranked a general column of other than strings over the rows
    // held and its own (#3082).
    if (payload.types[i] === 0 && held > 0 && page.rank[i].length === column.length) {
      return page.rank[i];
    }
    const ranked = payload.rank[i].length === held && page.rank[i].length === page.cells[i].length;
    // A general column of other than strings q ranked by its values, which
    // no cell's text sorts as (#2452): unranked when the page ranked only
    // its own rows, as one q could not sort.
    if (!ranked || (payload.types[i] === 0 && column.some((cell) => !/^,?"/.test(cell)))) {
      return [];
    }
    // A char by its byte, always sent: one past ASCII is U+FFFD as text (#2453).
    const byNumber = NUMERIC.has(payload.types[i]) || TEMPORAL.has(payload.types[i]) || payload.types[i] === 10;
    // Each row's key is worked out when it is first compared.
    const byValue = byNumber && raw[i].length === column.length && raw[i].length > 0;
    const keys = new Array<number | bigint | string | undefined>(column.length);
    const key = byValue
      ? (k: number) => (keys[k] ??= sortKey(raw[i][k])) as number | bigint
      : (k: number) => (keys[k] ??= sortText(column[k])) as string;
    const compare = byValue
      ? (a: number, b: number) => {
          const x = key(a);
          const y = key(b);
          return x < y ? -1 : x > y ? 1 : 0;
        }
      : (a: number, b: number) => codePointOrder(key(a) as string, key(b) as string);
    return mergeRank(held, payload.rank[i], column.length, compare);
  });
  return { ...payload, count: page.count, cells, raw, rank };
}
