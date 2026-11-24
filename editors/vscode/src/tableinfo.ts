// A table's details for a hover (#930): its columns with their types,
// foreign keys and attributes (`meta`), its rows, and for a table in memory
// the bytes it would take serialized (`-22!`). Free of any `vscode` import,
// so node tests it; the explorer's tooltip and the editor's hover ask for it.
//
// Nothing is loaded whole. A partitioned table is counted by `.Q.cn`, as the
// explorer counts it, and its `meta` reads the last partition's schema; a
// splayed table is counted by `count`, which maps one column. Neither gets
// `-22!`, which would walk its columns: it says so instead. At most `lim`
// columns are sent. Works on kdb+ (KDB-X) and PeachQ; held there by
// funcsource_q.test.js.
import { markdownText } from "./history";

export const TABLE_INFO = [
  "{[nm;lim]",
  " t:get`$(),nm;",
  " if[not .Q.qt t;'\"not a table\"];",
  " p:.Q.qp t;part:1b~p;disk:part|0b~p;",
  " m:(\"j\"$lim)sublist 0!meta t;",
  " `kind`rows`bytes`partitions`keys`ncols`cols`types`fkeys`attrs!(",
  "  $[part;`partitioned;disk;`splayed;99h=type t;`keyed;`table];",
  "  \"f\"$$[part;@[{sum .Q.cn x};t;0n];count t];",
  "  \"f\"$$[disk;0n;@[-22!;t;0n]];",
  "  \"f\"$$[part;count .Q.pv;0n];",
  "  $[99h=type t;(),keys t;`$()];",
  "  \"f\"$count cols t;",
  "  (),m`c;{$[null x;\"\";enlist x]}each m`t;string m`f;string m`a)}",
].join("\n");

/// Columns a hover lists at most.
export const HOVER_COLUMNS = 30;

export interface TableInfo {
  kind: "table" | "keyed" | "splayed" | "partitioned";
  rows: number | null;
  bytes: number | null;
  partitions: number | null;
  keys: string[];
  ncols: number;
  columns: { name: string; type: string; fkey: string; attr: string }[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (s === null ? "" : String(s))) : typeof v === "string" ? [v] : []);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const KINDS = new Set(["table", "keyed", "splayed", "partitioned"]);

/// What `TABLE_INFO` answered. Throws when it is not that.
export function readTableInfo(raw: unknown): TableInfo {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || !KINDS.has(String(r.kind))) {
    throw new Error(`the process answered something other than a table's details: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const names = strings(r.cols);
  const types = strings(r.types);
  const fkeys = strings(r.fkeys);
  const attrs = strings(r.attrs);
  return {
    kind: r.kind as TableInfo["kind"],
    rows: number(r.rows),
    bytes: number(r.bytes),
    partitions: number(r.partitions),
    keys: strings(r.keys),
    ncols: number(r.ncols) ?? names.length,
    columns: names.map((name, i) => ({ name, type: (types[i] ?? "").trim(), fkey: fkeys[i] ?? "", attr: attrs[i] ?? "" })),
  };
}

/// `n` bytes as people read them: B, KB, MB, GB, in powers of 1024. The
/// unit is picked after rounding: 1048575 is 1.0 MB, not 1024 KB (#1584).
export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const shown = (v: number, i: number) => (i === 0 ? String(Math.round(v)) : Number(v.toFixed(1)) < 10 ? v.toFixed(1) : v.toFixed(0));
  let i = 0;
  let v = n;
  while ((v >= 1024 || Number(shown(v, i)) >= 1024) && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${shown(v, i)} ${units[i]}`;
}

const ATTRIBUTES: Record<string, string> = { s: "sorted", u: "unique", p: "parted", g: "grouped" };
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/// The hover's Markdown: a line of what the table is, then its first `limit`
/// columns as a table of name, type, attribute and foreign key. Every name
/// is escaped.
export function tableMarkdown(name: string, process: string, info: TableInfo, limit = HOVER_COLUMNS): string {
  const kind = { table: "table", keyed: "keyed table", splayed: "splayed table", partitioned: "partitioned table" }[info.kind];
  const facts = [
    info.rows === null ? "rows not counted" : count(info.rows, "row"),
    count(info.ncols, "column"),
    ...(info.partitions !== null ? [count(info.partitions, "partition")] : []),
    info.bytes !== null ? `${bytes(info.bytes)} in memory (-22!)` : info.kind === "splayed" || info.kind === "partitioned" ? "on disk, not measured" : "",
  ].filter((f) => f !== "");
  // markdownText escapes `|` too, which a Markdown table cell needs.
  const cell = markdownText;
  const rows = info.columns.slice(0, limit).map((c) => {
    const key = info.keys.includes(c.name) ? " (key)" : "";
    return `| ${cell(c.name)}${key} | ${c.type === "" ? "" : `\`${c.type}\``} | ${c.attr === "" ? "" : `\`${c.attr}\` ${ATTRIBUTES[c.attr] ?? ""}`} | ${cell(c.fkey)} |`;
  });
  const more = info.ncols > rows.length ? [`\n${count(info.ncols - rows.length, "more column")} not shown.`] : [];
  return [
    `**${markdownText(name)}** on ${markdownText(process)}: ${kind}, ${facts.join(", ")}`,
    "",
    ...(rows.length > 0 ? ["| column | type | attribute | foreign key |", "|---|---|---|---|", ...rows] : []),
    ...more,
  ].join("\n");
}
