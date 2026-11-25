// The process explorer and live completion (#854): what one call asks the
// active process, how its answer becomes tree rows, and where a cursor sits
// in a qSQL statement. Free of any `vscode` import, so node tests it;
// `explorerview.ts` is the VS Code around it.
//
// Like a query (`query.ts`), the call is one lambda sent with its arguments,
// and nothing is defined on the process. It walks the namespaces breadth
// first from the root and `key \``, skipping the excluded ones (a root
// namespace, or a nested one as `ns.sub`) and any
// dotted root name that is not a dictionary of names (kdb+ lists `.cfg:42`
// in `key \``); below the root, a namespace is a dictionary of names whose
// first value is `::`, and one keyed by anything else (`1 2!(::;3)`) is a
// variable. It answers
//
//   rows    one per name: ns, name, kind (table, function or variable), type,
//           count, cols, keys, params, partitioned, and ncols, a table's
//           columns in all
//   spaces  one per namespace read: ns, total (its names, nested namespaces
//           not counted)
//   more    how many namespaces were left unread
//
// It stays bounded on a process with thousands of names: at most `lim 1`
// namespaces are read, and in each the first `lim 0` names in sorted order,
// and the first `lim 0` columns of a table. Counts are `count`, which is O(1)
// for a list and a table in memory, and a splayed table's maps one column.
// A partitioned table is never loaded to count it: `.Q.cn` reads each
// partition's count, and keeps it in `.Q.pn` - kdb+'s own cache, which
// `count` or a select on the table fills the same way - so a second refresh
// costs nothing. A row says when its count came that way; a table it
// cannot count (a partition missing its directory) is not counted.
//
// The limits arrive as floats, a JavaScript number being sent as one, and
// are made long there; counts go back as floats, which the IPC client reads
// as numbers rather than 64-bit objects. The excluded names arrive as one
// string, split on spaces: a list of one-character strings could reach q as
// a char vector.
//
// Works on kdb+ (KDB-X) and PeachQ, both of which have `.Q.qt`, `.Q.qp` and
// `.Q.cn`; held there by qclient.test.js.
import { SLOT_TEXT, slotParams } from "./paramcache";
import { RESERVED } from "./qliteral";

// A view (`v::expr`) has a lambda's type, 100h, and `value` of it is not a
// lambda's parts: its second item is the view's parse tree, where a lambda
// has its parameters, a symbol list. So parameters are read only when they
// are that, and anything else of type 100h is said to be a view (#1354).
// `value` of a view does not evaluate it.
export const GATHER = [
  "{[ex;lim]",
  " n:\"j\"$lim 0;m:\"j\"$lim 1;",
  " todo:`.,` sv'`,'asc(key`)except(`$\" \" vs ex),`;",
  " ex:` sv'`,'`$\" \" vs ex;",
  " todo:todo where{$[99h=type d:@[get;x;0];11h=type key d;0b]}each todo;",
  " seen:`$();rows:();spaces:();",
  " while[(count todo)&m>count seen;",
  "  ns:first todo;todo:1_todo;seen,:ns;",
  "  d:@[get;ns;{()!()}];",
  "  k:asc(key d)except`;",
  "  kids:$[ns~`.;`$();k where{$[99h=type x;$[11h=type key x;(::)~first x;0b];0b]}each d k];",
  "  todo,:(` sv'ns,'kids)except ex;",
  "  k:k except kids;",
  "  spaces,:enlist`ns`total!(ns;\"f\"$count k);",
  "  rows,:{[ns;n;nm;x]",
  "   t:type x;tb:$[98h=t;1b;.Q.qt x];fn:t within 100 112h;part:$[tb;1b~.Q.qp x;0b];",
  "   `ns`name`kind`type`count`cols`keys`params`partitioned`ncols`view`ptext!(ns;nm;",
  "    $[tb;`table;fn;`function;`variable];t;",
  "    \"f\"$$[fn;0N;part;@[{sum .Q.cn x};x;0n];count x];",
  "    $[tb;n sublist(),cols x;`$()];",
  "    $[tb&99h=t;(),keys x;`$()];",
  "    $[100h=t;@[{$[11h=type p:(value x)1;p;`$()]};x;{`$()}];`$()];",
  "    part;\"f\"$$[tb;count cols x;0];",
  "    $[100h=t;@[{not 11h=type(value x)1};x;0b];0b];",
  `    $[100h=t;@[${SLOT_TEXT};x;{""}];""])}[ns;n]'[n sublist k;d n sublist k]];`,
  " `rows`spaces`more!(rows;spaces;\"f\"$count todo)}",
].join("\n");

/// Names read in each namespace, and namespaces read: `GATHER`'s `lim`.
/// At most 50,000 rows, of a few dozen bytes each.
export const LIMITS: [number, number] = [500, 100];

export const EXPLORER = {
  view: "q-lint.processExplorer",
  refresh: "q-lint.refreshProcessExplorer",
  preview: "q-lint.previewProcessExplorerItem",
  toggleAutoRefresh: "q-lint.toggleProcessExplorerAutoRefresh",
} as const;

export interface ExplorerSettings {
  excludedNamespaces: string[];
  previewLimit: number;
  autoRefresh: boolean;
}

/// The explorer's settings, read with `get` as `readLive` reads the query
/// settings. A preview limit that is not a positive whole number is 5. A
/// namespace is its bare name, written `.zz` or as the symbol `` `zz `` too:
/// the names are sent joined, and the IPC client sends text that starts
/// with a backtick as a symbol, which the lambdas cannot cut (#1965).
export function readExplorer(get: <T>(key: string, fallback: T) => T): ExplorerSettings {
  const excluded = get<unknown>("processExplorer.excludedNamespaces", ["q", "Q", "h", "j", "o", "s"]);
  const limit = get<unknown>("processExplorer.previewLimit", 5);
  return {
    excludedNamespaces: Array.isArray(excluded)
      ? excluded.map((n) => String(n).trim().replace(/^`*\.?/, "")).filter((n) => n !== "" && !/\s/.test(n))
      : [],
    // At most 2^53-1: 1e21 is written `1e+21`, which `til` refuses (#1852).
    previewLimit: typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, Number.MAX_SAFE_INTEGER) : 5,
    autoRefresh: get<unknown>("processExplorer.autoRefresh", false) === true,
  };
}

export interface Entry {
  /// `.` for the root, else `.ns` or `.ns.sub`.
  ns: string;
  name: string;
  kind: "table" | "function" | "variable";
  type: number;
  /// Rows of a table, items of a variable; null for a function.
  count: number | null;
  cols: string[];
  keys: string[];
  params: string[];
  /// A view, `v::expr`: among the functions by its type, with no parameters.
  view?: true;
  partitioned: boolean;
  /// A table's columns in all, when that is more than `cols` holds.
  allCols?: number;
}

export interface Gathered {
  entries: Entry[];
  spaces: { ns: string; total: number }[];
  /// Namespaces left unread.
  more: number;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const KINDS = new Set(["table", "function", "variable"]);

/// What `GATHER` answered, as the IPC client decodes it. Throws when it is
/// not that: a process can redefine `.Q.qt` or `key`.
export function readGathered(raw: unknown): Gathered {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || !Array.isArray(r.rows) || !Array.isArray(r.spaces)) {
    throw new Error(`the process answered something other than its names: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const entries = r.rows.flatMap((row: Record<string, unknown>): Entry[] =>
    row !== null && typeof row === "object" && typeof row.ns === "string" && typeof row.name === "string" && KINDS.has(String(row.kind))
      ? [
          {
            ns: row.ns,
            name: row.name,
            kind: row.kind as Entry["kind"],
            type: number(row.type) ?? 0,
            count: number(row.count),
            cols: strings(row.cols),
            keys: strings(row.keys),
            // A typed or pattern slot as written, not KDB-X's synthetic `0` (#2333).
            params: slotParams(strings(row.params), typeof row.ptext === "string" ? row.ptext : undefined),
            ...(row.view === true ? { view: true as const } : {}),
            partitioned: row.partitioned === true,
            ...(number(row.ncols) !== null && number(row.ncols)! > strings(row.cols).length ? { allCols: number(row.ncols)! } : {}),
          },
        ]
      : [],
  );
  const spaces = r.spaces.flatMap((s: Record<string, unknown>) =>
    s !== null && typeof s === "object" && typeof s.ns === "string" ? [{ ns: s.ns, total: number(s.total) ?? 0 }] : [],
  );
  return { entries, spaces, more: number(r.more) ?? 0 };
}

/// How q code names `entry`: `t` in the root, `.ns.t` elsewhere.
export const fullName = (entry: { ns: string; name: string }): string =>
  entry.ns === "." ? entry.name : `${entry.ns}.${entry.name}`;

const TYPES = [
  "list", "boolean", "guid", "", "byte", "short", "int", "long", "real", "float", "char", "symbol",
  "timestamp", "month", "date", "datetime", "timespan", "minute", "second", "time",
];
const FUNCTIONS: Record<number, string> = {
  100: "lambda",
  101: "unary primitive",
  102: "operator",
  103: "iterator",
  104: "projection",
  105: "composition",
  112: "dynamic load",
};

/// q's name for a type number, as `type` gives it.
export function typeName(t: number): string {
  if (t === 10) {
    return "string";
  }
  if (t >= -19 && t <= -1 && TYPES[-t] !== "") {
    return TYPES[-t];
  }
  if (t >= 1 && t <= 19 && TYPES[t] !== "") {
    return `${TYPES[t]} list`;
  }
  if (t === 0) {
    return "list";
  }
  if (t >= 20 && t <= 76) {
    return "enumeration";
  }
  if (t <= -20 && t >= -76) {
    return "enumerated symbol";
  }
  if (t >= 77 && t <= 97) {
    return "mapped list";
  }
  if (t === 98) {
    return "table";
  }
  if (t === 99) {
    return "dictionary";
  }
  if (t >= 106 && t <= 111) {
    return "derived function";
  }
  return FUNCTIONS[t] ?? `type ${t}`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/// A row of the explorer. `name` is the q expression naming a table or a
/// variable, what Preview shows, or a function, what Open Function Source
/// and Find Callers read.
export interface Node {
  kind: "namespace" | "group" | "table" | "column" | "function" | "variable" | "note";
  label: string;
  description?: string;
  tooltip?: string;
  name?: string;
  partitioned?: boolean;
  children?: Node[];
}

function tableNode(e: Entry): Node {
  const rows = e.count === null ? "rows not counted" : plural(e.count, "row");
  const how = e.partitioned && e.count !== null ? " (partitioned, counted by .Q.cn)" : "";
  const all = e.allCols ?? e.cols.length;
  return {
    kind: "table",
    label: e.name,
    description: `${rows}${how} · ${plural(all, "column")}`,
    tooltip: `${fullName(e)}: ${typeName(e.type) === "dictionary" ? "keyed table" : "table"}, ${rows}${how}`,
    name: fullName(e),
    partitioned: e.partitioned,
    children: [
      ...e.cols.map((c): Node => ({
        kind: "column",
        label: c,
        ...(e.keys.includes(c) ? { description: "key" } : {}),
      })),
      ...(all > e.cols.length
        ? [{ kind: "note" as const, label: `${plural(all - e.cols.length, "more column")} not shown`, description: `the first ${e.cols.length} are` }]
        : []),
    ],
  };
}

/// What a function is shown as: a lambda by its parameters, a view as one,
/// any other by its type's name.
const shape = (e: Entry): string => (e.view ? "view" : e.type === 100 ? `[${e.params.join(";")}]` : typeName(e.type));

function functionNode(e: Entry): Node {
  return {
    kind: "function",
    label: e.name,
    description: shape(e),
    tooltip: `${fullName(e)}${e.type === 100 && !e.view ? shape(e) : `: ${shape(e)}`}`,
    name: fullName(e),
  };
}

function variableNode(e: Entry): Node {
  const t = typeName(e.type);
  // An atom's count is 1, which says nothing.
  const count = e.type < 0 || e.count === null ? "" : ` · ${plural(e.count, "item")}`;
  return { kind: "variable", label: e.name, description: `${t}${count}`, tooltip: `${fullName(e)}: ${t}${count}`, name: fullName(e) };
}

/// Whether `ns` is an excluded namespace (`q`, `ns.sub`) or nested in one.
const excludedBy = (ns: string, excluded: string[]): boolean =>
  excluded.some((e) => ns === `.${e}` || ns.startsWith(`.${e}.`));

/// The explorer's tree from what `GATHER` answered: a row per namespace,
/// sorted, the root first; under each, Tables, Functions and Variables, each
/// only when it has something. Namespaces under `excluded` are left out
/// here too, so a changed setting shows before the next refresh does.
export function explorerTree(g: Gathered, excluded: string[]): Node[] {
  const spaces = g.spaces
    .filter((s) => !excludedBy(s.ns, excluded))
    .sort((a, b) => (a.ns === "." ? -1 : b.ns === "." ? 1 : a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
  const nodes = spaces.map((space): Node => {
    const here = g.entries.filter((e) => e.ns === space.ns);
    const group = (label: string, kind: Entry["kind"], make: (e: Entry) => Node): Node[] => {
      const of = here.filter((e) => e.kind === kind);
      return of.length === 0 ? [] : [{ kind: "group", label, description: String(of.length), children: of.map(make) }];
    };
    const shown = here.length;
    const children = [
      ...group("Tables", "table", tableNode),
      ...group("Functions", "function", functionNode),
      ...group("Variables", "variable", variableNode),
      ...(shown < space.total
        ? [{ kind: "note" as const, label: `${plural(space.total - shown, "more name")} not shown`, description: `the first ${shown} in order are` }]
        : []),
    ];
    return {
      kind: "namespace",
      label: space.ns,
      description: space.ns === "." ? `root · ${plural(space.total, "name")}` : plural(space.total, "name"),
      children,
    };
  });
  if (g.more > 0) {
    nodes.push({ kind: "note", label: `${plural(g.more, "more namespace")} not read` });
  }
  return nodes;
}

/// The code Preview runs: the first `limit` rows of a table, or a variable
/// whole - the output cuts it to the console size. A partitioned table is
/// read by `.Q.ind`, since `sublist` and `select[n]` refuse one, and only
/// those rows are read. A name q cannot parse is read by its symbol.
export function previewCode(node: Pick<Node, "kind" | "name" | "partitioned">, limit: number): string | undefined {
  if (node.name === undefined) {
    return undefined;
  }
  const name = qName(node.name);
  if (node.kind === "table") {
    return node.partitioned ? `.Q.ind[${name};til ${limit}&count ${name}]` : `${limit} sublist ${name}`;
  }
  return node.kind === "variable" ? name : undefined;
}

/// `name` as q code reads it: as written when q parses it as a name, else
/// by its symbol - `set` makes a name of any symbol, `café` or `a b` - and
/// so is one of q's words, which as written is the builtin (`count`) or
/// q-sql (`select`), not the name (#1587).
export function qName(name: string): string {
  return /^\.?[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(name) && !RESERVED.has(name)
    ? name
    : `get\`$"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/// What each character of q `text` is: `c` code, `s` inside a string (from
/// its opening quote; the closing one is code), `y` a symbol, `m` a comment
/// - a line from a `/` that starts it or follows a space or tab.
export function charKinds(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const lineStart = i === 0 || text[i - 1] === "\n";
    if (ch === "/" && (lineStart || text[i - 1] === " " || text[i - 1] === "\t")) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += "m".repeat(stop - i);
      i = stop;
    } else if (ch === "\"") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\"") {
        j += text[j] === "\\" ? 2 : 1;
      }
      j = Math.min(j, text.length);
      out += "s".repeat(j - i) + (j < text.length ? "c" : "");
      i = j + 1;
    } else if (ch === "`") {
      let j = i + 1;
      while (j < text.length && /[\w.:/]/.test(text[j])) {
        j++;
      }
      out += "y".repeat(j - i);
      i = j;
    } else {
      out += "c";
      i++;
    }
  }
  return out;
}

/// Whether the cursor at `offset` in `text` is typing code: not inside a
/// string or a comment.
export function inCode(text: string, offset: number): boolean {
  const kind = charKinds(text.slice(0, offset)).slice(-1);
  return kind !== "s" && kind !== "m";
}

/// The table a qSQL statement reads, when `offset` is inside one in `text`:
/// the nearest `select`, `exec`, `update` or `delete` before the cursor
/// whose statement the cursor is in, and the first `from t` after it in the
/// same statement, which may come before the cursor or after it (`select |
/// from t`). Undefined outside a statement. A statement ends at a `;` at
/// its own bracket depth, or at a bracket that closes one opened before it:
/// past `(exec s from u)`, the cursor is in the statement around it.
/// Strings, symbols and comments are not read: `\`delete` and `"update"`
/// are no keyword, and a `;` in a string ends nothing.
export function qsqlTable(text: string, offset: number): string | undefined {
  const kinds = charKinds(text);
  // By UTF-16 unit, as `kinds` and `offset` count: an emoji is two (#1372).
  const code = text.split("").map((ch, i) => (kinds[i] === "c" ? ch : " ")).join("");
  const keywords = [...code.slice(0, offset).matchAll(/(?<![\w.])(select|exec|update|delete)(?![\w.])/g)];
  for (const keyword of keywords.reverse()) {
    const start = keyword.index + keyword[0].length;
    let depth = 0;
    let end = code.length;
    for (let i = start; i < code.length; i++) {
      const ch = code[i];
      if ("([{".includes(ch)) {
        depth++;
      } else if (")]}".includes(ch) && --depth < 0) {
        end = i;
        break;
      } else if (ch === ";" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end >= offset) {
      const from = /(?<![\w.])from\s+(\.?[A-Za-z][\w.]*)/.exec(code.slice(start, end));
      return from === null ? undefined : from[1];
    }
  }
  return undefined;
}

/// The columns of the table `name` names, as q code would name it there.
export function columnsOf(g: Gathered, name: string): string[] | undefined {
  const dot = name.lastIndexOf(".");
  const ns = dot <= 0 ? "." : name.slice(0, dot);
  const short = dot <= 0 ? name : name.slice(dot + 1);
  return g.entries.find((e) => e.kind === "table" && e.ns === ns && e.name === short)?.cols;
}

export interface Completion {
  label: string;
  kind: Entry["kind"] | "column";
  detail: string;
}

/// What completion offers from the process: every name read, under the name
/// q code calls it by, and the columns of `table` when the cursor is in a
/// qSQL statement reading it.
export function liveCompletions(g: Gathered, process: string, table?: string): Completion[] {
  const columns = table === undefined ? [] : (columnsOf(g, table) ?? []);
  return [
    ...columns.map((c): Completion => ({ label: c, kind: "column", detail: `column of ${table} (${process})` })),
    ...g.entries.map((e): Completion => ({
      label: fullName(e),
      kind: e.kind,
      detail:
        e.kind === "function"
          ? `${shape(e)} (${process})`
          : e.kind === "table"
            ? `table, ${e.count === null ? "not counted" : plural(e.count, "row")} (${process})`
            : `${typeName(e.type)} (${process})`,
    })),
  ];
}

/// The table `word` names among what was gathered, for a hover: as q code
/// names it, `t` in the root or `.ns.t`.
export function tableNamed(g: Gathered, word: string): Entry | undefined {
  return g.entries.find((e) => e.kind === "table" && fullName(e) === word);
}
