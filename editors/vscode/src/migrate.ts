// Schema migration from two tables' metas (#1027): the columns one table
// has that the other lacks, the ones it lacks, the ones whose type differs
// and the order, and the q that turns the first into the second - add, drop,
// cast and reorder - for review. Nothing is run. Free of any `vscode`
// import, so node tests it; `dbtoolsview.ts` reads the two metas
// (`tableinfo.ts`'s TABLE_INFO, from one process or two) and opens the
// script.
//
// A table in memory is changed by assigning it again (`t:update ... from
// t`). A table on disk is changed in every partition by the HDB column
// manager's script (`colmanager.ts`), which this writes as its steps. A
// column that is in both but renamed reads as one dropped and one added:
// the metas cannot tell a rename from that.
import { columnScriptOf, type ColumnOp } from "./colmanager";
import { plainName, symbolLiteral } from "./qliteral";
import type { TableInfo } from "./tableinfo";

export interface SchemaDiff {
  add: { name: string; type: string }[];
  drop: string[];
  cast: { name: string; from: string; to: string }[];
  /// The target's order, when the columns kept are in another one.
  order: string[] | undefined;
  attrs: { name: string; from: string; to: string }[];
  /// The target's keys, when a table in memory is keyed otherwise (#1579).
  keys: string[] | undefined;
}

/// What changes `from` into `to`. Key columns count as columns.
export function schemaDiff(from: TableInfo, to: TableInfo): SchemaDiff {
  const fromCols = new Map(from.columns.map((c) => [c.name, c]));
  const toCols = new Map(to.columns.map((c) => [c.name, c]));
  const add = to.columns.filter((c) => !fromCols.has(c.name)).map((c) => ({ name: c.name, type: c.type }));
  const drop = from.columns.filter((c) => !toCols.has(c.name)).map((c) => c.name);
  const cast = to.columns
    .filter((c) => fromCols.has(c.name) && fromCols.get(c.name)!.type !== c.type)
    .map((c) => ({ name: c.name, from: fromCols.get(c.name)!.type, to: c.type }));
  // A column added takes the target's attribute too, set after it is added (#2145).
  const attrs = to.columns
    .filter((c) => (fromCols.get(c.name)?.attr ?? "") !== c.attr)
    .map((c) => ({ name: c.name, from: fromCols.get(c.name)?.attr ?? "", to: c.attr }));
  // After adding at the end and dropping, is the order the target's?
  const after = [...from.columns.map((c) => c.name).filter((n) => toCols.has(n)), ...add.map((a) => a.name)];
  const want = to.columns.map((c) => c.name);
  // A table on disk is never keyed: its keys are not compared.
  const onDisk = from.kind === "partitioned" || from.kind === "splayed";
  const keys = !onDisk && from.keys.join(" ") !== to.keys.join(" ") ? to.keys : undefined;
  return { add, drop, cast, order: after.join(" ") === want.join(" ") ? undefined : want, attrs, keys };
}

export const sameSchema = (d: SchemaDiff): boolean => d.add.length + d.drop.length + d.cast.length + d.attrs.length === 0 && d.order === undefined && d.keys === undefined;

const NULLS: Record<string, string> = {
  b: "0b", g: "0Ng", x: "0x00", h: "0Nh", i: "0Ni", j: "0N", e: "0Ne", f: "0n", c: '" "', s: "`",
  p: "0Np", m: "0Nm", d: "0Nd", z: "0Nz", n: "0Nn", u: "0Nu", v: "0Nv", t: "0Nt",
};

/// q's null of a type character; for a nested type, an empty item.
export function nullOf(type: string): string {
  if (type === "C") return '""';
  if (type !== "" && type === type.toUpperCase() && NULLS[type.toLowerCase()] !== undefined) return `\`${typeNameOf(type.toLowerCase())}$()`;
  return NULLS[type] ?? "()";
}
const typeNameOf = (t: string) =>
  ({ b: "boolean", g: "guid", x: "byte", h: "short", i: "int", j: "long", e: "real", f: "float", c: "char", s: "symbol", p: "timestamp", m: "month", d: "date", z: "datetime", n: "timespan", u: "minute", v: "second", t: "time" })[t] ?? t;

const listType = (t: string) => t !== "" && t === t.toUpperCase();

/// The atom casts q refuses with 'type, by the type cast: a date's or a
/// month's to a time of day, and a time of day's to a date. A guid is cast
/// to and from nothing. Read off a real q, which dbtools_q.test.js holds
/// this to (#2012).
const NO_CAST: Record<string, string> = { m: "znuvt", d: "nuvt", n: "pmdz", u: "pmdz", v: "pmdz", t: "pmdz" };
const noCast = (from: string, to: string) => (from === "g") !== (to === "g") || (NO_CAST[from] ?? "").includes(to);

/// Why a cast from `from` to `to` is not written, or undefined when it is:
/// a list column's items are not atoms, nor an atom column's lists, so a
/// cast between them does nothing or fails - but for text, parsed or made
/// symbols (`C` to an atom type but `c`), and atoms made text (`C`).
/// A symbol to a char, its first character, is made in memory only (#1578).
/// Between atom columns it is q that has no cast, but through a symbol's
/// text, and between two list columns the cast is the atoms', made in each
/// item (#2013). A mixed column's cast is written - whether q makes it is
/// its values' to say, and an empty table's untyped column is one - and no
/// cast makes a mixed column of another.
export function castProblem(from: string, to: string, onDisk: boolean): string | undefined {
  if (from === "") return undefined;
  if (to === "") return "no cast makes a mixed column";
  const [f, t] = [from.toLowerCase(), to.toLowerCase()];
  if (listType(from) !== listType(to)) {
    if (to === "C") return undefined;
    if (from === "C") return to === "c" ? "a column of strings holds lists, not chars" : undefined;
    return "a list column's items are lists, an atom column's are not";
  }
  if (from === "s" && to === "c" && onDisk) return "the column manager makes no symbol into a char";
  if (f !== "s" && t !== "s" && noCast(f, t)) return `q has no cast from ${typeNameOf(f)} to ${typeNameOf(t)}`;
  return undefined;
}

/// The expression that casts column `c` from type `from` to type `to`.
export function castOf(c: string, from: string, to: string): string {
  if (listType(from) && listType(to)) {
    // A plain cast goes through the items; any other is made in each, and a
    // symbol's first character of none is a char still.
    const [f, t] = [from.toLowerCase(), to.toLowerCase()];
    const item = castOf("x", f, t);
    return item === `"${t}"$x` ? `"${t}"$${c}` : `{${f === "s" && t === "c" ? '"c"$' : ""}${item}} each ${c}`;
  }
  if (to === "c" && from === "s") return `first each string ${c}`;
  if (to === "s" && from === "C") return `\`$${c}`;
  if (to === "C") return `string ${c}`;
  if (to === "s") return `\`$string ${c}`;
  // Text, or a symbol's text, to an atomic type is parsed: a cast would give
  // the character codes, or 'type (#1096).
  if ((from === "C" || from === "s") && to.length === 1 && to !== "c" && to === to.toLowerCase()) return `"${to.toUpperCase()}"$${from === "s" ? "string " : ""}${c}`;
  return `"${to}"$${c}`;
}

/// Why the attribute of column `c` is not written: an added column holds
/// one null in every row, which `u#` refuses on more than one row.
function attrProblem(d: SchemaDiff, c: { name: string; to: string }, rows: number | null): string | undefined {
  return c.to === "u" && d.add.some((a) => a.name === c.name) && (rows === null || rows > 1) ? "it is added with one null in every row, which u# refuses" : undefined;
}

/// The script, for review: what differs, as comments, then the q.
export function migrationScript(name: string, fromInfo: TableInfo, fromWhere: string, toInfo: TableInfo, toWhere: string, process: string): string {
  // A partitioned table's first column is its partition field, which is in
  // no partition's files: it is not compared.
  const field = (t: TableInfo) => (t.kind === "partitioned" ? t.columns[0]?.name : undefined);
  const skip = new Set([field(fromInfo), field(toInfo)].filter((f): f is string => f !== undefined));
  const from = { ...fromInfo, columns: fromInfo.columns.filter((c) => !skip.has(c.name)) };
  const to = { ...toInfo, columns: toInfo.columns.filter((c) => !skip.has(c.name)) };
  const d = schemaDiff(from, to);
  const head = [
    `/ q-lint: schema migration of ${name} (${fromWhere}) to the schema of ${toWhere}.`,
    "/ Review it: nothing has been run.",
    ...d.add.map((a) => `/ add    ${a.name} (${a.type || "mixed"})`),
    ...d.drop.map((c) => `/ drop   ${c}`),
    ...d.cast.map((c) => `/ cast   ${c.name} from ${c.from || "mixed"} to ${c.to || "mixed"}`),
    ...d.attrs.map((c) => `/ attr   ${c.name} from ${c.from ? `${c.from}#` : "none"} to ${c.to ? `${c.to}#` : "none"}`),
    ...(d.order ? [`/ order  ${d.order.join(" ")}`] : []),
    ...(d.keys ? [`/ keys   ${d.keys.length > 0 ? d.keys.join(" ") : "none"}`] : []),
  ];
  if (sameSchema(d)) {
    return [...head, "/ The two schemas are the same: there is nothing to change."].join("\n") + "\n";
  }
  if (from.kind === "partitioned" || from.kind === "splayed") {
    const ops: ColumnOp[] = [
      ...d.drop.map((column): ColumnOp => ({ op: "delete", column })),
      ...d.add.map((a): ColumnOp => ({ op: "add", column: a.name, value: nullOf(a.type) })),
      ...d.cast.filter((c) => !listType(c.to) && castProblem(c.from, c.to, true) === undefined).map((c): ColumnOp => ({ op: "cast", column: c.name, type: c.to })),
      ...d.attrs.filter((c) => attrProblem(d, c, from.rows) === undefined).map((c): ColumnOp => ({ op: "attr", column: c.name, attr: c.to as "" | "s" | "u" | "p" | "g" })),
      ...(d.order ? [{ op: "reorder", order: d.order } as ColumnOp] : []),
    ];
    const skipped = d.cast.filter((c) => listType(c.to));
    const refused = d.cast.filter((c) => !skipped.includes(c) && castProblem(c.from, c.to, true) !== undefined);
    return [
      ...head,
      ...skipped.map((c) => `/ not written: a cast of ${c.name} to the nested type ${c.to}, which the column manager does not make on disk`),
      ...refused.map((c) => `/ not written: a cast of ${c.name} from ${c.from} to ${c.to || "mixed"}: ${castProblem(c.from, c.to, true)}`),
      ...d.attrs.filter((c) => attrProblem(d, c, from.rows) !== undefined).map((c) => `/ not written: ${c.to}# on ${c.name}: ${attrProblem(d, c, from.rows)}`),
      columnScriptOf(name, ops, process, `migrate ${name} to the schema of ${toWhere}`),
    ].join("\n") + "\n";
  }
  // A table q cannot parse by name (`my t`) is read with get and assigned
  // with set; a column q-sql cannot name is dropped and added functionally,
  // so the order and keys after it find it (#1719), and left as a comment
  // otherwise (#1583).
  const t = plainName(name) ? name : `get${symbolLiteral(name)}`;
  const assign = (e: string) => (plainName(name) ? `${name}:${e}` : `(${symbolLiteral(name)}) set ${e}`);
  const symbols = (names: string[]) => {
    const each = names.map(symbolLiteral);
    return each.every((s) => !s.startsWith("`$")) ? each.join("") : `(${each.join(";")})`;
  };
  const odd = (c: string, what: string) => `/ not written: ${what} ${c}, whose name q-sql cannot write`;
  const keyed = from.keys.length > 0;
  const lines = [...head];
  if (keyed) lines.push(assign(`0!${t}`));
  for (const c of d.drop) lines.push(plainName(c) ? assign(`delete ${c} from ${t}`) : assign(`![${t};();0b;enlist ${symbolLiteral(c)}]`));
  // A nested or mixed column takes its empty item once a row: `m:()` is 'length (#1097).
  for (const a of d.add)
    lines.push(!plainName(a.name) ? assign(`{@[x;y;:;count[x]#enlist z]}[${t};${symbolLiteral(a.name)};${nullOf(a.type)}]`) : a.type === a.type.toUpperCase() ? assign(`update ${a.name}:count[i]#enlist ${nullOf(a.type)} from ${t}`) : assign(`update ${a.name}:${nullOf(a.type)} from ${t}`));
  for (const c of d.cast) {
    const problem = castProblem(c.from, c.to, false);
    lines.push(!plainName(c.name) ? odd(c.name, "the cast of") : problem === undefined ? assign(`update ${c.name}:${castOf(c.name, c.from, c.to)} from ${t}`) : `/ not written: a cast of ${c.name} from ${c.from} to ${c.to || "mixed"}: ${problem}`);
  }
  for (const c of d.attrs) {
    const problem = attrProblem(d, c, from.rows);
    lines.push(!plainName(c.name) ? odd(c.name, "the attribute of") : problem !== undefined ? `/ not written: ${c.to}# on ${c.name}: ${problem}` : assign(`update ${c.name}:${c.to ? `\`${c.to}#` : "`#"}${c.name} from ${t}`));
  }
  if (d.order) lines.push(assign(`${symbols(d.order)} xcols ${t}`));
  const keys = to.keys.filter((k) => to.columns.some((c) => c.name === k));
  if (keys.length > 0) lines.push(assign(`${symbols(keys)} xkey ${t}`));
  else if (keyed) lines.push(`/ ${name} was keyed by ${from.keys.join(", ")}; the target is not, so it is left unkeyed`);
  return lines.join("\n") + "\n";
}
