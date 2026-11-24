// The attribute advisor (#1026): for each column of a table, whether `s#`,
// `u#`, `p#` or `g#` would help, why, and about what it would cost in
// memory - from the column's cardinality and order, and from how often the
// saved queries and the query history filter on it. It only advises:
// nothing is ever applied. Free of any `vscode` import, so node tests it;
// `dbtoolsview.ts` asks the process and opens the advice.
//
// One read, defining nothing, of at most `lim` rows: the first rows of a
// table in memory or of a splayed one, and of a partitioned table the
// first rows of its last partition, mapped from its directory (`.Q.par`) so
// the partition is not read whole. The current attributes are `meta`'s.
// Works on kdb+ (KDB-X) and PeachQ; held there by dbtools_q.test.js.
//
// The costs are KX's figures for the structures an attribute keeps, in
// bytes: none for `s#`, about 16 a distinct value for `u#`, 24 for `p#`,
// and 8 a row plus 16 a distinct value for `g#`. kdb+ allocates in powers
// of two, so a real one can be up to twice that.

import { bytes } from "./tableinfo";

export const ATTRIBUTE_SAMPLE = [
  "{[nm;lim]",
  " t:get`$nm;if[not .Q.qt t;'\"not a table\"];",
  " p:.Q.qp t;part:1b~p;m:\"j\"$lim;",
  " n:\"f\"$$[part;@[{sum .Q.cn x};t;0n];count t];",
  " s:$[part;m sublist get .Q.par[hsym`$system\"cd\";last .Q.pv;`$nm];m sublist 0!t];",
  " mt:0!meta t;cs:(cols s)except$[part;.Q.pf;`$()];",
  " one:{[x] nested:0h=type x;",
  "  `d`runs`sorted!(\"f\"$count distinct x;\"f\"$$[nested;0n;sum differ x];$[nested;0b;x~asc x])};",
  " st:one each s cs;",
  " `kind`rows`sampled`partitions`cols`types`attrs`distinct`runs`sorted!(",
  "  string$[part;`partitioned;0b~p;`splayed;99h=type t;`keyed;`table];n;\"f\"$count s;",
  "  \"f\"$$[part;count .Q.pv;1];string cs;",
  "  {$[null x;enlist\" \";enlist x]}each(exec c!t from mt)cs;string(exec c!a from mt)cs;",
  "  st`d;st`runs;st`sorted)}",
].join("\n");

/// Rows the advisor samples.
export const ATTRIBUTE_ROWS = 100_000;

export interface ColumnSample {
  name: string;
  type: string;
  attr: string;
  distinct: number;
  runs: number | null;
  sorted: boolean;
}

export interface AttributeSample {
  kind: string;
  rows: number | null;
  sampled: number;
  partitions: number;
  columns: ColumnSample[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (s === null || s === undefined ? "" : String(s))) : typeof v === "string" ? [v] : []);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

/// What `ATTRIBUTE_SAMPLE` answered. Throws when it is not that.
export function readAttributeSample(raw: unknown): AttributeSample {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || !("distinct" in r) || !("cols" in r)) {
    throw new Error(`the process answered something other than a table's columns: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const names = strings(r.cols);
  const types = strings(r.types);
  const attrs = strings(r.attrs);
  const distinct = list(r.distinct);
  const runs = list(r.runs);
  const sorted = list(r.sorted);
  return {
    kind: strings(r.kind).join(""),
    rows: number(r.rows),
    sampled: number(r.sampled) ?? 0,
    partitions: number(r.partitions) ?? 1,
    columns: names.map((name, i) => ({
      name,
      type: (types[i] ?? "").trim(),
      attr: attrs[i] ?? "",
      distinct: number(distinct[i]) ?? 0,
      runs: number(runs[i]),
      sorted: sorted[i] === true,
    })),
  };
}

/// How many of `queries` filter on each of `columns` of `table`: name it in
/// a `where` clause, or in a `?[...]` functional select, and name the table.
export function filterCounts(queries: string[], table: string, columns: string[]): Map<string, number> {
  const out = new Map(columns.map((c) => [c, 0]));
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = (w: string) => new RegExp(`(?<![\\w.\`])${escape(w)}(?![\\w])`);
  // A namespaced table is named whole, its leading dot included (#1113).
  const tableWord = table.startsWith(".") ? new RegExp(`(?<![\\w\`])${escape(table)}(?![\\w.])`) : word(table);
  // A functional select names its columns by symbol, whole (#1373), and may
  // name its table so too (#1374).
  const symbol = (w: string) => new RegExp(`\`${escape(w)}(?![\\w.])`);
  const tableSymbol = symbol(table);
  for (const q of queries) {
    const clauses = [...q.matchAll(/\bwhere\b([^\n]*)/g)].map((m) => m[1]);
    const functional = [...q.matchAll(/\?\[[^\]]*\]/g)].map((m) => m[0]);
    if (!tableWord.test(q) && !functional.some((f) => tableSymbol.test(f))) continue;
    const text = [...clauses, ...functional].join(" ");
    if (text === "") continue;
    const fn = functional.join(" ");
    // A where clause names a column bare; `x=`sym` compares to a value (#1373).
    for (const c of columns) {
      if (word(c).test(text) || symbol(c).test(fn)) out.set(c, (out.get(c) ?? 0) + 1);
    }
  }
  return out;
}

export interface Advice {
  column: string;
  current: string;
  suggest: "" | "s" | "u" | "p" | "g";
  reason: string;
  /// Bytes the suggested attribute would keep, about; null for none.
  cost: number | null;
  filters: number;
}

/// The attribute each column would do best with, and why. A column the
/// queries never filter on is suggested one only when it costs nothing
/// (`s#`) or the data already has its shape and it is the table's first.
export function advise(s: AttributeSample, filters: Map<string, number> = new Map()): Advice[] {
  const rows = s.rows ?? s.sampled;
  const perPartition = s.partitions > 0 ? rows / s.partitions : rows;
  const full = s.sampled >= rows;
  return s.columns.map((c, i): Advice => {
    const f = filters.get(c.name) ?? 0;
    const used = f > 0 ? `${f} saved or recent ${f === 1 ? "query filters" : "queries filter"} on it` : "no saved or recent query filters on it";
    const base = { column: c.name, current: c.attr, filters: f };
    if (c.type === "" || c.type === c.type.toUpperCase()) {
      return { ...base, suggest: "", reason: "a nested or mixed column takes no attribute that helps a filter", cost: null };
    }
    if (s.sampled < 2) {
      return { ...base, suggest: "", reason: "too few rows to tell", cost: null };
    }
    const unique = c.distinct === s.sampled;
    const parted = c.runs !== null && c.runs === c.distinct && c.distinct < s.sampled;
    const few = c.distinct / s.sampled <= 0.1;
    const sample = full ? "" : ` (in ${s.sampled.toLocaleString("en-US")} rows sampled)`;
    if (c.sorted && (f > 0 || i === 0 || ["p", "n", "t", "z", "d", "v", "u", "m"].includes(c.type))) {
      return { ...base, suggest: "s", reason: `already in ascending order${sample}: s# lets a filter or an asof join search it by halves; ${used}`, cost: 0 };
    }
    if (unique && f > 0) {
      return { ...base, suggest: "u", reason: `every value distinct${sample}: u# makes a lookup by value a hash lookup; ${used}`, cost: 16 * rows };
    }
    if (parted && (f > 0 || i === 0)) {
      const where = s.kind === "partitioned" ? "in each partition" : "in the table";
      return {
        ...base,
        suggest: "p",
        reason: `each value's rows are together${sample}, ${c.distinct.toLocaleString("en-US")} distinct values: p# finds them as one range ${where}; ${used}`,
        cost: 24 * c.distinct * (s.kind === "partitioned" ? s.partitions : 1),
      };
    }
    if (few && f > 0) {
      return {
        ...base,
        suggest: "g",
        reason: `${c.distinct.toLocaleString("en-US")} distinct values${sample}, not grouped together: g# keeps each value's rows${s.kind === "partitioned" ? " (on disk, per partition; for one in memory, as on an RDB)" : ""}; ${used}`,
        cost: s.kind === "partitioned" ? (8 * perPartition + 16 * c.distinct) * s.partitions : 8 * rows + 16 * c.distinct,
      };
    }
    const why = unique ? "every value distinct" : parted ? "each value's rows together" : few ? `${c.distinct.toLocaleString("en-US")} distinct values` : `${c.distinct.toLocaleString("en-US")} distinct values in ${s.sampled.toLocaleString("en-US")} rows, not in order`;
    return { ...base, suggest: "", reason: `${why}${sample}, and ${used}: an attribute would cost memory and help no query seen`, cost: null };
  });
}

const md = (s: string) => s.replace(/([\\`*_{}[\]<>|#])/g, "\\$1");
const size = bytes;

/// The advice as Markdown: a table, the reasons, and a reminder that
/// nothing was applied.
export function adviceReport(table: string, process: string, s: AttributeSample, advice: Advice[], queries: number): string {
  const out = [
    `# Attributes for ${md(table)} on ${md(process)}`,
    "",
    `A ${md(s.kind)} table of ${s.rows === null ? "an unknown number of" : s.rows.toLocaleString("en-US")} rows; ${s.sampled.toLocaleString("en-US")} rows sampled${s.kind === "partitioned" ? " from its last partition" : ""}; ${queries} saved and recent queries read for filters.`,
    "",
    "| column | now | suggested | memory, about | filtered by |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const a of advice) {
    out.push(`| ${md(a.column)} | ${a.current ? `${a.current}#` : ""} | ${a.suggest ? `${a.suggest}#` : "none"} | ${a.cost === null ? "" : size(a.cost)} | ${a.filters} |`);
  }
  out.push("", "## Why", "");
  for (const a of advice) {
    const keep = a.current && a.current === a.suggest ? " It already has it." : a.current && a.suggest === "" ? ` It has ${a.current}#: drop it only if no query needs it.` : "";
    out.push(`- **${md(a.column)}**: ${md(a.reason)}.${keep}`);
  }
  out.push(
    "",
    "Nothing was applied. Memory is KX's figure for what an attribute keeps (kdb+ allocates in powers of two, so up to twice that). On a partitioned table, an attribute is set on each partition's column on disk.",
    "",
  );
  return out.join("\n");
}
