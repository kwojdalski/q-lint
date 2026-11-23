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
import type { TableInfo } from "./tableinfo";

export interface SchemaDiff {
  add: { name: string; type: string }[];
  drop: string[];
  cast: { name: string; from: string; to: string }[];
  /// The target's order, when the columns kept are in another one.
  order: string[] | undefined;
  attrs: { name: string; from: string; to: string }[];
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
  const attrs = to.columns
    .filter((c) => fromCols.has(c.name) && fromCols.get(c.name)!.attr !== c.attr)
    .map((c) => ({ name: c.name, from: fromCols.get(c.name)!.attr, to: c.attr }));
  // After adding at the end and dropping, is the order the target's?
  const after = [...from.columns.map((c) => c.name).filter((n) => toCols.has(n)), ...add.map((a) => a.name)];
  const want = to.columns.map((c) => c.name);
  return { add, drop, cast, order: after.join(" ") === want.join(" ") ? undefined : want, attrs };
}

export const sameSchema = (d: SchemaDiff): boolean => d.add.length + d.drop.length + d.cast.length + d.attrs.length === 0 && d.order === undefined;

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

/// The expression that casts column `c` from type `from` to type `to`.
export function castOf(c: string, from: string, to: string): string {
  if (to === "s" && from === "C") return `\`$${c}`;
  if (to === "C") return `string ${c}`;
  if (to === "s") return `\`$string ${c}`;
  // Text, or a symbol's text, to an atomic type is parsed: a cast would give
  // the character codes, or 'type (#1096).
  if ((from === "C" || from === "s") && to.length === 1 && to !== "c" && to === to.toLowerCase()) return `"${to.toUpperCase()}"$${from === "s" ? "string " : ""}${c}`;
  return `"${to}"$${c}`;
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
  ];
  if (sameSchema(d)) {
    return [...head, "/ The two schemas are the same: there is nothing to change."].join("\n") + "\n";
  }
  if (from.kind === "partitioned" || from.kind === "splayed") {
    const ops: ColumnOp[] = [
      ...d.drop.map((column): ColumnOp => ({ op: "delete", column })),
      ...d.add.map((a): ColumnOp => ({ op: "add", column: a.name, value: nullOf(a.type) })),
      ...d.cast.filter((c) => c.to.length === 1 && c.to === c.to.toLowerCase()).map((c): ColumnOp => ({ op: "cast", column: c.name, type: c.to })),
      ...d.attrs.map((c): ColumnOp => ({ op: "attr", column: c.name, attr: c.to as "" | "s" | "u" | "p" | "g" })),
      ...(d.order ? [{ op: "reorder", order: d.order } as ColumnOp] : []),
    ];
    const skipped = d.cast.filter((c) => !(c.to.length === 1 && c.to === c.to.toLowerCase()));
    return [
      ...head,
      ...skipped.map((c) => `/ not written: a cast of ${c.name} to the nested type ${c.to}, which the column manager does not make on disk`),
      columnScriptOf(name, ops, process, `migrate ${name} to the schema of ${toWhere}`),
    ].join("\n") + "\n";
  }
  const t = name;
  const keyed = from.keys.length > 0;
  const lines = [...head];
  if (keyed) lines.push(`${t}:0!${t}`);
  for (const c of d.drop) lines.push(`${t}:delete ${c} from ${t}`);
  // A nested or mixed column takes its empty item once a row: `m:()` is 'length (#1097).
  for (const a of d.add) lines.push(a.type === a.type.toUpperCase() ? `${t}:update ${a.name}:count[i]#enlist ${nullOf(a.type)} from ${t}` : `${t}:update ${a.name}:${nullOf(a.type)} from ${t}`);
  for (const c of d.cast) lines.push(`${t}:update ${c.name}:${castOf(c.name, c.from, c.to)} from ${t}`);
  for (const c of d.attrs) lines.push(`${t}:update ${c.name}:${c.to ? `\`${c.to}#` : "`#"}${c.name} from ${t}`);
  if (d.order) lines.push(`${t}:${d.order.map((c) => `\`${c}`).join("")} xcols ${t}`);
  const keys = to.keys.filter((k) => to.columns.some((c) => c.name === k));
  if (keys.length > 0) lines.push(`${t}:${keys.map((k) => `\`${k}`).join("")} xkey ${t}`);
  else if (keyed) lines.push(`/ ${t} was keyed by ${from.keys.join(", ")}; the target is not, so it is left unkeyed`);
  return lines.join("\n") + "\n";
}
