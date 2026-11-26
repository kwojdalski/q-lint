// The notebook variables view's data (#946): the globals a notebook's cells
// left in the root namespace of the process they ran on, with each one's
// type, count and size. Free of any `vscode` import, so a test can drive
// it; `notebookvarsview.ts` is the view.
//
// `VARS` is sent as one lambda and defines nothing. A name that cannot be
// read answers with its type as 101h (`::`), and a count or size that
// cannot be had answers null. A view (`v::expr`) is not read at all -
// `value` of its name would evaluate it after every cell - and answers as a
// view, with its own type, 100h, and no count or size (#1865). A size is `-22!`'s, the
// bytes the value takes serialized; a function and a partitioned table -
// whose `-22!` would read every partition - have none. At most `limit`
// names are sent, with how many there are.
//
//   `names`types`counts`sizes`total`views`keyed!(names;types;counts;sizes;count of all;which are views;which are keyed tables)
import { typeName } from "./grid";

/// The most globals the view lists.
export const VARIABLE_LIMIT = 1000;

export const VARS = [
  "{[lim]",
  " a:(key `.) except `;",
  " n:(\"j\"$lim) sublist a;",
  " w:n in views[];",
  " v:{[x;w] $[w;(::);@[value;x;{(::)}]]}'[n;w];",
  " qp:{$[`qp in key `.Q;@[.Q.qp;x;{0b}];0b]} each v;",
  " sz:{[x;p] $[(99h<type x)|1b~p;0N;@[-22!;x;{0N}]]}'[v;qp];",
  " kt:{$[99h=type x;98h=type key x;0b]} each v;",
  " `names`types`counts`sizes`total`views`keyed!(n;@[type each v;where w;:;100h];@[{@[count;x;{0N}]} each v;where w;:;0N];sz;count a;w;kt)}",
].join("\n");

export interface Variable {
  name: string;
  type: number;
  /// Undefined when q could not count it.
  count?: number;
  /// Bytes, serialized; undefined for a function or a partitioned table.
  size?: number;
  /// A view, which was not evaluated: it has no count and no size.
  view?: true;
  /// A keyed table, a dictionary of two tables (#2384).
  keyed?: true;
}

/// A q long as a number, or undefined for a null: the IPC client decodes
/// one as a `Long`, or as a number, and a null as null or NaN.
const long = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof (v as { toNumber?: unknown } | null)?.toNumber === "function" ? (v as { toNumber: () => number }).toNumber() : undefined;
  return n === undefined || !Number.isFinite(n) || n <= Number.MIN_SAFE_INTEGER ? undefined : n;
};

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/// What `VARS` answered. Throws when it is not its answer.
export function readVariables(raw: unknown): { variables: Variable[]; total: number } {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || !("names" in r)) {
    throw new Error(`the process answered something other than its globals: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const names = list(r.names).map(String);
  const types = list(r.types);
  const counts = list(r.counts);
  const sizes = list(r.sizes);
  const views = list(r.views);
  const keyed = list(r.keyed);
  const variables = names.map((name, i): Variable => {
    const count = long(counts[i]);
    const size = long(sizes[i]);
    return { name, type: long(types[i]) ?? 0, ...(count !== undefined ? { count } : {}), ...(size !== undefined ? { size } : {}), ...(views[i] === true ? { view: true as const } : {}), ...(keyed[i] === true ? { keyed: true as const } : {}) };
  });
  return { variables, total: long(r.total) ?? variables.length };
}

/// `bytes` as people read them: 512 B, 1.5 KB, 3.2 MB.
export function bytesText(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  // As rounded: 1048575 B is 1.0 MB, not 1024 KB, and 10239 B 10 KB (#1495).
  const shown = (): string => {
    const one = n.toFixed(1);
    return u === 0 ? String(n) : Number(one) < 10 ? one : String(Math.round(n));
  };
  while (Number(shown()) >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${shown()} ${units[u]}`;
}

/// What a variable's kind is called: q's type name, a table, a function, a
/// view.
export function kindText(type: number, view = false, keyed = false): string {
  if (view) {
    return "view";
  }
  if (type === 98) {
    return "table";
  }
  if (type === 99 && keyed) {
    return "keyed table";
  }
  // A list mapped from a file with get: 77, or 77 plus its items' type (#2385).
  if (type >= 77 && type <= 96) {
    return type === 77 ? "mapped list" : `mapped ${typeName(type - 77).replace(/ \(.\)$/, "")} list`;
  }
  if (type === 99) {
    return "dictionary";
  }
  if (type >= 100 && type <= 112) {
    return type === 101 ? "(::) or unreadable" : "function";
  }
  if (type === 0) {
    return "list";
  }
  // `long`, not `long (j)`: the view has room for the word only.
  const name = typeName(Math.abs(type)).replace(/ \(.\)$/, "");
  return type === 10 ? "string" : type < 0 ? name : `${name} list`;
}

/// A variable's line in the view, after its name: its kind, count and size.
export function describeVariable(v: Variable): string {
  return [
    kindText(v.type, v.view, v.keyed),
    ...(v.count !== undefined && v.type >= 0 && v.type < 100 ? [`${v.count.toLocaleString("en")} ${v.type === 98 || v.keyed ? "rows" : "items"}`] : []),
    ...(v.size !== undefined ? [bytesText(v.size)] : []),
  ].join(" · ");
}
