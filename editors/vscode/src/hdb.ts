// The HDB browser (#931): for a process that has loaded a partitioned
// database, its partitions, their date range, the rows of each table in
// each partition, its segments and the size of its sym file. Free of any
// `vscode` import, so node tests it; `infoview.ts` shows it.
//
// No data is read. The partitions are `.Q.pv` and the tables `.Q.pt`, both
// set when the database was loaded; the rows per partition are `.Q.cn`,
// which reads each partition's count from a column's file header and keeps
// it in `.Q.pn` - as the explorer counts a partitioned table, and as `count`
// would - so a second look costs nothing. The sym file's size is `hcount`,
// of the file in the directory the database was loaded from. Only the
// newest `lim` partitions' counts are sent; the totals cover them all. A
// table missing from a partition fails `.Q.cn`: its counts are null, and
// so is its total, not the 0 `sum` makes of nulls (#1566).
//
// A process with no partitions and no partitioned tables has loaded no
// partitioned database - kdb+ has no `.Q.pv` then, PeachQ an empty one - and
// the answer says so, with its working directory. Works on kdb+ (KDB-X) and PeachQ;
// held there by funcsource_q.test.js.
import type { InfoNode } from "./monitor";
import { bytes } from "./tableinfo";

export const HDB = [
  "{[lim]",
  " m:\"j\"$lim;",
  " if[not@[{(0<count .Q.pv)|0<count .Q.pt};::;0b];:`hdb`root!(0b;system\"cd\")];",
  " pv:.Q.pv;pt:(),.Q.pt;",
  " c:{[n;t]@[{\"f\"$.Q.cn get x};t;{[n;e]n#0n}n]}[count pv]each pt;",
  " o:(tables`.)except pt;",
  " o:o where{@[{0b~.Q.qp get x};x;0b]}each o;",
  " `hdb`pf`root`segments`symbytes`npart`parts`tables`counts`totals`others`otherrows!(",
  "  1b;string .Q.pf;system\"cd\";",
  "  @[{string distinct .Q.PD};::;()];",
  "  \"f\"$@[hcount;`:sym;0n];",
  "  \"f\"$count pv;string(neg m)sublist pv;",
  "  string pt;(neg m)sublist'c;{$[all null x;0n;sum x]}each c;",
  "  string o;\"f\"${@[{count get x};x;0n]}each o)}",
].join("\n");

/// Partitions whose counts the browser shows, newest first.
export const HDB_PARTITIONS = 1000;

export type Hdb =
  | { hdb: false; root: string }
  | {
      hdb: true;
      field: string;
      root: string;
      segments: string[];
      symBytes: number | null;
      partitionCount: number;
      /// The newest partitions, oldest first, and per table their rows in
      /// each of them; `totals` is over every partition.
      partitions: string[];
      tables: { name: string; counts: (number | null)[]; total: number | null }[];
      splayed: { name: string; rows: number | null }[];
    };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (s === null ? "" : String(s))) : typeof v === "string" ? [v] : []);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const numbers = (v: unknown): (number | null)[] => (Array.isArray(v) ? v.map(number) : typeof v === "number" ? [number(v)] : []);

/// What `HDB` answered. Throws when it is not that.
export function readHdb(raw: unknown): Hdb {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || typeof r.hdb !== "boolean") {
    throw new Error(`the process answered something other than its database: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const root = strings(r.root).join("");
  if (!r.hdb) {
    return { hdb: false, root };
  }
  const names = strings(r.tables);
  // One table's counts can come as a flat list.
  const counts = Array.isArray(r.counts) && names.length === 1 && !Array.isArray(r.counts[0]) ? [r.counts] : Array.isArray(r.counts) ? r.counts : [];
  const totals = numbers(r.totals);
  const others = strings(r.others);
  const otherRows = numbers(r.otherrows);
  return {
    hdb: true,
    field: strings(r.pf).join(""),
    root,
    segments: strings(r.segments),
    symBytes: number(r.symbytes),
    partitionCount: number(r.npart) ?? 0,
    partitions: strings(r.parts),
    tables: names.map((name, i) => ({ name, counts: numbers(counts[i]), total: totals[i] ?? null })),
    splayed: others.map((name, i) => ({ name, rows: otherRows[i] ?? null })),
  };
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const rows = (n: number | null) => (n === null ? "not counted" : count(n, "row"));

/// The browser's tree. A process with no partitioned database is one row
/// that says so.
export function hdbTree(h: Hdb, process: string): InfoNode[] {
  if (!h.hdb) {
    return [
      {
        label: `${process} has no partitioned database loaded`,
        description: h.root,
        tooltip: "No .Q.pv: the process has not loaded a partitioned database (\\l of a directory with partitions).",
        icon: "info",
      },
    ];
  }
  const first = h.partitions[0];
  const last = h.partitions[h.partitions.length - 1];
  const shown = h.partitions.length;
  const range = shown === 0 ? "no partitions" : shown === h.partitionCount ? `${first} – ${last}` : `… ${last}`;
  const database: InfoNode = {
    label: "Database",
    description: `${h.field} · ${h.root}`,
    icon: "database",
    children: [
      { label: "partition field", description: h.field },
      { label: "root", description: h.root, tooltip: h.root },
      { label: "partitions", description: count(h.partitionCount, "partition") },
      ...(shown > 0 && shown === h.partitionCount ? [{ label: "range", description: `${first} – ${last}` }] : []),
      { label: "sym file", description: h.symBytes === null ? "none in the root" : bytes(h.symBytes) },
      ...(h.segments.length > 1 || (h.segments.length === 1 && h.segments[0] !== ":.")
        ? [{ label: "segments", description: String(h.segments.length), children: h.segments.map((s): InfoNode => ({ label: s.replace(/^:/, "") })) }]
        : []),
    ],
  };
  const newest = [...h.partitions.keys()].reverse();
  const partitions: InfoNode = {
    label: "Partitions",
    description: `${count(h.partitionCount, "partition")} · ${range}`,
    icon: "calendar",
    children: [
      ...newest.map((i): InfoNode => {
        const each = h.tables.map((t) => `${t.name} ${t.counts[i] === null || t.counts[i] === undefined ? "?" : t.counts[i]!.toLocaleString("en-US")}`);
        return { label: h.partitions[i], description: each.join(" · "), tooltip: `${h.field} ${h.partitions[i]}\n${each.join("\n")}` };
      }),
      ...(h.partitionCount > shown ? [{ label: `${count(h.partitionCount - shown, "older partition")} not shown`, icon: "info" }] : []),
    ],
  };
  const tables: InfoNode = {
    label: "Tables",
    description: String(h.tables.length + h.splayed.length),
    icon: "table",
    children: [
      ...h.tables.map((t): InfoNode => {
        const empty = t.counts.filter((n) => n === 0).length;
        return {
          label: t.name,
          description: `partitioned · ${rows(t.total)}${empty > 0 ? ` · empty in ${count(empty, "partition")} shown` : ""}`,
          icon: "table",
        };
      }),
      ...h.splayed.map((t): InfoNode => ({ label: t.name, description: `splayed · ${rows(t.rows)}`, icon: "table" })),
    ],
  };
  return [database, partitions, tables];
}
