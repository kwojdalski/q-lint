// The sym file inspector (#1025): the size and count of the database's sym
// file, the columns that use the most of it, how it grew across the
// partitions, and a warning when it holds more than a threshold. Free of
// any `vscode` import, so node tests it; `dbtoolsview.ts` asks the process
// and opens the report.
//
// One read, defining nothing. The sym file is the root's (`system "cd"`,
// where the process loaded the database from): its bytes by `hcount`, its
// symbols by `count get`. The columns enumerated against it are read from
// at most `lim` partitions spread over the whole range, each in the
// directory q loaded it from (`.Q.pd`, so any segmenting is followed,
// #1977), and from every
// splayed table in the root: each column's distinct indexes over them is
// its share, and each partition's largest index is how big the file was,
// at least, when it was written - an enumeration only ever appends. A null
// symbol (index 0N) is no entry of the file, and a partition holding no
// symbol says nothing of its size, so both are left out (#1567, #1568); so
// is an index past the file's end, which is no symbol of it but is counted
// and warned of (#2143). Those
// columns' data is read, so `lim` is kept small. Works on kdb+ (KDB-X) and
// PeachQ; held there by dbtools_q.test.js.

import { PARTITION_DIRS } from "./partdir";
import { bytes } from "./tableinfo";

export const SYM_INSPECT = [
  "{[lim]",
  " r:hsym`$system\"cd\";f:` sv r,`sym;",
  " if[not -11h=type key f;:`sym`root!(0b;system\"cd\")];",
  " n:@[{count get x};f;0N];b:hcount f;",
  " pv:@[{.Q.pv};::;()];pt:@[{(),.Q.pt};::;`$()];",
  " m:\"j\"$lim;at:$[m>=count pv;til count pv;distinct\"j\"$(til m)*(count[pv]-1)%m-1];s:pv at;",
  ` pd:@[{.Q.pd};::;()];sd:${PARTITION_DIRS}[r;$[count[pd]=count pv;pd at;()];s];`,
  " o:((key r)except`$string pv)except`sym`par.txt;",
  " o:o where{@[{`.d in key x};x;0b]}each` sv'r,/:o;",
  " enc:{[d] cs:@[{(),get` sv x,`.d};d;`$()];cs where{@[{v:get x;$[type[v]within 20 76h;`sym~key v;0b]};x;0b]}each` sv'd,/:cs};",
  " one:{[enc;p;t;d] cs:enc d;([] part:(count cs)#p;tbl:(count cs)#t;col:cs;ix:{\"j\"$get` sv x,y}[d]each cs)};",
  " rows:raze raze{[one;enc;pt;p;b]{[one;enc;p;b;t]one[enc;`$string p;t;` sv b,t]}[one;enc;p;b]each pt}[one;enc;pt]'[s;sd];",
  " rows,:raze{[one;enc;r;t]one[enc;`;t;` sv r,t]}[one;enc;r]each o;",
  " w:$[null n;0W;n];kept:{[w;x]x where x within(0;w-1)}[w];",
  " c:$[count rows;0!select d:\"f\"$count distinct kept raze ix,p:\"f\"$sum w<=raze ix by tbl,col from rows;([] tbl:`$();col:`$();d:`float$();p:`float$())];",
  " g:$[count rows;select from(0!select x:\"f\"$1+max kept raze ix by part from rows where not null part)where x>0;([] part:`$();x:`float$())];",
  " `sym`root`count`bytes`partitions`sampled`ctable`ccol`cdistinct`cpast`gpart`gsize!(1b;system\"cd\";\"f\"$n;\"f\"$b;\"f\"$count pv;\"f\"$count s;",
  "  string c`tbl;string c`col;c`d;c`p;string g`part;g`x)}",
].join("\n");

/// Partitions the inspector reads, spread over the range.
export const SYM_PARTITIONS = 20;

export type SymAnswer =
  | { sym: false; root: string }
  | {
      sym: true;
      root: string;
      count: number | null;
      bytes: number | null;
      partitions: number;
      sampled: number;
      /// `past`: how many of a column's values index past the file's end.
      columns: { table: string; column: string; distinct: number; past: number }[];
      growth: { partition: string; size: number }[];
    };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (s === null || s === undefined ? "" : String(s))) : typeof v === "string" ? [v] : []);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => (typeof x === "number" ? x : NaN)) : typeof v === "number" ? [v] : []);

/// What `SYM_INSPECT` answered. Throws when it is not that.
export function readSym(raw: unknown): SymAnswer {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || typeof r.sym !== "boolean") {
    throw new Error(`the process answered something other than its sym file: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const root = strings(r.root).join("");
  if (!r.sym) {
    return { sym: false, root };
  }
  const tables = strings(r.ctable);
  const cols = strings(r.ccol);
  const distinct = numbers(r.cdistinct);
  const past = numbers(r.cpast);
  const parts = strings(r.gpart);
  const sizes = numbers(r.gsize);
  // Partitions in order by number, so int partitions 8 9 10 grow in that order (#1128).
  return {
    sym: true,
    root,
    count: number(r.count),
    bytes: number(r.bytes),
    partitions: number(r.partitions) ?? 0,
    sampled: number(r.sampled) ?? 0,
    columns: tables.map((table, i) => ({ table, column: cols[i] ?? "", distinct: distinct[i] ?? 0, past: past[i] || 0 })).sort((a, b) => b.distinct - a.distinct),
    growth: parts.map((partition, i) => ({ partition, size: sizes[i] ?? 0 })).sort((a, b) => a.partition.localeCompare(b.partition, "en", { numeric: true })),
  };
}

const md = (s: string) => s.replace(/([\\`*_{}[\]<>|#])/g, "\\$1");
const n = (x: number) => x.toLocaleString("en-US");

/// `n` bytes as people read them (#1584).
const size = bytes;

/// The report, as Markdown. `warnAbove`: a sym file with more symbols than
/// this is warned about.
export function symReport(a: SymAnswer, process: string, warnAbove: number): string {
  if (!a.sym) {
    return `# Sym file of ${md(process)}\n\n${md(process)} has no sym file in its directory (${md(a.root)}).\n`;
  }
  const out = [`# Sym file of ${md(process)}`, "", `${md(a.root)}/sym: ${a.count === null ? "unreadable" : `${n(a.count)} symbols`}, ${a.bytes === null ? "size unknown" : size(a.bytes)}.`, ""];
  if (a.count !== null && a.count > warnAbove) {
    out.push(
      `**Warning:** more than ${n(warnAbove)} symbols (q-lint.hdbBrowser.symInspector.warnAbove). Every process that loads this database holds them all in memory, and the file only grows: a column of mostly distinct values (an order id, a free-text field) is better kept as strings.`,
      "",
    );
  }
  out.push(
    "## By column",
    "",
    `Distinct symbols each column uses, over ${n(a.sampled)} of ${n(a.partitions)} partitions spread over the range, and the splayed tables in the root.`,
    "",
  );
  if (a.columns.length === 0) {
    out.push("No column enumerated against sym was found.", "");
  } else {
    out.push("| table | column | distinct symbols | share of the file |", "| --- | --- | --- | --- |");
    for (const c of a.columns) {
      out.push(`| ${md(c.table)} | ${md(c.column)} | ${n(c.distinct)} | ${a.count ? `${((100 * c.distinct) / a.count).toFixed(1)}%` : ""} |`);
    }
    out.push("");
  }
  const corrupt = a.columns.filter((c) => c.past > 0);
  if (corrupt.length > 0) {
    out.push(
      `**Warning:** ${corrupt.map((c) => `${md(c.table)}.${md(c.column)} has ${n(c.past)} value${c.past === 1 ? "" : "s"}`).join(", ")} whose index is past the end of sym: no symbol of the file, so they are left out of the counts here. Partition Check's full check names the partitions.`,
      "",
    );
  }
  if (a.growth.length > 0) {
    out.push(
      "## Growth",
      "",
      "The file's size when each partition was written, at least: one more than the largest index its columns use, or than an earlier partition's, as the file only grows.",
      "",
      "| partition | symbols | added since the one before |",
      "| --- | --- | --- |",
    );
    // A partition that uses only the first symbols says the file was at
    // least that big, not that it shrank: the size so far is the largest
    // yet, and what is added is counted from it (#2142).
    let most = 0;
    a.growth.forEach((g, i) => {
      const at = Math.max(most, g.size);
      out.push(`| ${md(g.partition)} | ${n(at)} | ${i === 0 ? "" : n(at - most)} |`);
      most = at;
    });
    out.push("");
  }
  return out.join("\n");
}
