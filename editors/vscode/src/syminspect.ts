// The sym file inspector (#1025): the size and count of the database's sym
// file, the columns that use the most of it, how it grew across the
// partitions, and a warning when it holds more than a threshold. Free of
// any `vscode` import, so node tests it; `dbtoolsview.ts` asks the process
// and opens the report.
//
// One read, defining nothing. The sym file is the root's (`system "cd"`,
// where the process loaded the database from): its bytes by `hcount`, its
// symbols by `count get`. So is each other file of the root that holds a
// symbol list some column is enumerated against - `.Q.ens[d;t;`mysym]`
// writes one, and a column can have a domain of its own - each inspected as
// sym is (#2146). The columns enumerated against it are read from
// at most `lim` partitions spread over the whole range - those on disk
// (`.Q.PV`), a `.Q.view` hiding none of them (#2533) - each in the
// directory q loaded it from (`.Q.pd`, so any segmenting is followed,
// #1977) and for every table directory it holds, not only those of q's own
// list (`.Q.pt`, the newest partition's: a table that one lacks still has
// its symbols in the file, #3050), and from every
// splayed table in the root: each column's distinct indexes over them is
// its share, and each partition's largest index is how big the file was,
// at least, when it was written - an enumeration only ever appends. A null
// symbol (index 0N) is no entry of the file, and a partition holding no
// symbol says nothing of its size, so both are left out (#1567, #1568); so
// is an index past the file's end, which is no symbol of it but is counted
// and warned of (#2143). A nested column of enumerations (77h, a list of
// symbols a row) is enumerated against its items' domain, and its indexes
// are all its items' (#2530). Those
// columns' data is read, so `lim` is kept small. Works on kdb+ (KDB-X) and
// PeachQ; held there by dbtools_q.test.js.

import { PARTITION_DIRS } from "./partdir";
import { bytes } from "./tableinfo";

export const SYM_INSPECT = [
  "{[lim]",
  " r:hsym`$system\"cd\";",
  " pv:@[get;`.Q.PV;{@[{.Q.pv};::;()]}];pt:@[{(),.Q.pt};::;`$()];",
  " fs:((key r)except`$string pv)except`par.txt;",
  " dm:fs where{@[{11h=type get x};x;0b]}each` sv'r,/:fs;",
  " m:\"j\"$lim;at:$[m>=count pv;til count pv;distinct\"j\"$(til m)*(count[pv]-1)%m-1];s:pv at;",
  ` pd:@[get;\`.Q.PD;{@[{.Q.pd};::;()]}];sd:${PARTITION_DIRS}[r;$[count[pd]=count pv;pd at;()];s];`,
  " pt:distinct pt,raze{k:key x;$[11h=type k;k;`$()]}each sd;",
  " o:(fs except dm)where{@[{`.d in key x};x;0b]}each` sv'r,/:fs except dm;",
  " enc:{[dm;d] cs:@[{(),get` sv x,`.d};d;`$()];k:{[dm;x]@[{[dm;x]v:get x;v:$[(type[v]>=77h)&count v;first v;v];$[type[v]within 20 76h;$[(key v)in dm;key v;`];`]}[dm];x;`]}[dm]each` sv'd,/:cs;(cs;k)}[dm];",
  " one:{[enc;p;t;d] e:enc d;w:where not null e 1;([] part:(count w)#p;tbl:(count w)#t;col:e[0]w;dom:e[1]w;ix:{v:get` sv x,y;\"j\"$$[type[v]>=77h;raze v;v]}[d]each e[0]w)};",
  " rows:raze raze{[one;enc;pt;p;b]{[one;enc;p;b;t]one[enc;`$string p;t;` sv b,t]}[one;enc;p;b]each pt}[one;enc;pt]'[s;sd];",
  " rows,:raze{[one;enc;r;t]one[enc;`;t;` sv r,t]}[one;enc;r]each o;",
  " ds:distinct(((),`sym)inter dm),$[count rows;exec dom from rows;`$()];",
  " if[0=count ds;:`sym`root!(0b;system\"cd\")];",
  " sz:{[r;x]@[{count get x};` sv r,x;0N]}[r]each ds;bs:{[r;x]hcount` sv r,x}[r]each ds;",
  " kept:{[w;x]x where x within(0;w-1)};",
  " rows:$[count rows;update w:0W^(ds!sz)dom from rows;([] part:`$();tbl:`$();col:`$();dom:`$();ix:();w:`long$())];",
  " c:0!select d:\"f\"$count distinct kept[first w]raze ix,p:\"f\"$sum first[w]<=raze ix by dom,tbl,col from rows;",
  " g:select from(0!select x:\"f\"$1+max kept[first w]raze ix by dom,part from rows where not null part)where x>0;",
  " `sym`root`count`bytes`partitions`sampled`dnames`dcounts`dbytes`cdom`ctable`ccol`cdistinct`cpast`gdom`gpart`gsize!(1b;system\"cd\";\"f\"$first sz;\"f\"$first bs;\"f\"$count pv;\"f\"$count s;",
  "  string ds;\"f\"$sz;\"f\"$bs;string c`dom;string c`tbl;string c`col;c`d;c`p;string g`dom;string g`part;g`x)}",
].join("\n");

/// Partitions the inspector reads, spread over the range.
export const SYM_PARTITIONS = 20;

/// One enumeration domain: a file in the root that holds a symbol list.
export interface SymDomain {
  domain: string;
  count: number | null;
  bytes: number | null;
  /// `past`: how many of a column's values index past the file's end.
  columns: { table: string; column: string; distinct: number; past: number }[];
  growth: { partition: string; size: number }[];
}

/// The answer's own fields are the first domain's - `sym` where the root has
/// it - and `others` are the rest a column is enumerated against (#2146).
export type SymAnswer = { sym: false; root: string } | (SymDomain & { sym: true; root: string; partitions: number; sampled: number; others: SymDomain[] });

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (s === null || s === undefined ? "" : String(s))) : typeof v === "string" ? [v] : []);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
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
  const cdom = strings(r.cdom);
  const parts = strings(r.gpart);
  const sizes = numbers(r.gsize);
  const gdom = strings(r.gdom);
  const names = strings(r.dnames);
  const counts = list(r.dcounts);
  const sizesOf = list(r.dbytes);
  const domains = names.length > 0 ? names : ["sym"];
  // Partitions in order by number, so int partitions 8 9 10 grow in that order (#1128).
  const of = (domain: string, i: number): SymDomain => ({
    domain,
    count: i === 0 ? number(r.count) : number(counts[i]),
    bytes: i === 0 ? number(r.bytes) : number(sizesOf[i]),
    columns: tables
      .map((table, k) => ({ table, column: cols[k] ?? "", distinct: distinct[k] ?? 0, past: past[k] || 0, domain: cdom[k] ?? domains[0] }))
      .filter((c) => c.domain === domain)
      .map(({ domain: _, ...c }) => c)
      .sort((a, b) => b.distinct - a.distinct),
    growth: parts
      .map((partition, k) => ({ partition, size: sizes[k] ?? 0, domain: gdom[k] ?? domains[0] }))
      .filter((g) => g.domain === domain)
      .map(({ domain: _, ...g }) => g)
      .sort((a, b) => a.partition.localeCompare(b.partition, "en", { numeric: true })),
  });
  const [first, ...others] = domains.map(of);
  return { sym: true, root, partitions: number(r.partitions) ?? 0, sampled: number(r.sampled) ?? 0, ...first, others };
}

const md = (s: string) => s.replace(/([\\`*_{}[\]<>|#])/g, "\\$1");
const n = (x: number) => x.toLocaleString("en-US");

/// `n` bytes as people read them (#1584).
const size = bytes;

/// The report, as Markdown. `warnAbove`: a sym file with more symbols than
/// this is warned about.
export function symReport(a: SymAnswer, process: string, warnAbove: number): string {
  if (!a.sym) {
    return `# Sym file of ${md(process)}\n\n${md(process)} has no sym file, nor any other file of symbols a column is enumerated against, in its directory (${md(a.root)}).\n`;
  }
  const out = [`# Sym file of ${md(process)}`, ""];
  domainReport(out, a, a, "##", warnAbove);
  // Each further domain a column is enumerated against, as the first (#2146).
  for (const d of a.others) {
    out.push(`## ${md(d.domain)}`, "");
    domainReport(out, a, d, "###", warnAbove);
  }
  return out.join("\n");
}

function domainReport(out: string[], a: Extract<SymAnswer, { sym: true }>, d: SymDomain, h: string, warnAbove: number): void {
  const file = md(d.domain);
  out.push(`${md(a.root)}/${file}: ${d.count === null ? "unreadable" : `${n(d.count)} symbols`}, ${d.bytes === null ? "size unknown" : size(d.bytes)}.`, "");
  if (d.count !== null && d.count > warnAbove) {
    out.push(
      `**Warning:** more than ${n(warnAbove)} symbols (q-lint.hdbBrowser.symInspector.warnAbove). Every process that loads this database holds them all in memory, and the file only grows: a column of mostly distinct values (an order id, a free-text field) is better kept as strings.`,
      "",
    );
  }
  out.push(
    `${h} By column`,
    "",
    `Distinct symbols each column uses, over ${n(a.sampled)} of ${n(a.partitions)} partitions spread over the range, and the splayed tables in the root.`,
    "",
  );
  if (d.columns.length === 0) {
    out.push(`No column enumerated against ${file} was found.`, "");
  } else {
    out.push("| table | column | distinct symbols | share of the file |", "| --- | --- | --- | --- |");
    for (const c of d.columns) {
      out.push(`| ${md(c.table)} | ${md(c.column)} | ${n(c.distinct)} | ${d.count ? `${((100 * c.distinct) / d.count).toFixed(1)}%` : ""} |`);
    }
    out.push("");
  }
  const corrupt = d.columns.filter((c) => c.past > 0);
  if (corrupt.length > 0) {
    out.push(
      `**Warning:** ${corrupt.map((c) => `${md(c.table)}.${md(c.column)} has ${n(c.past)} value${c.past === 1 ? "" : "s"}`).join(", ")} whose index is past the end of ${file}: no symbol of the file, so they are left out of the counts here. Partition Check's full check names the partitions.`,
      "",
    );
  }
  if (d.growth.length > 0) {
    out.push(
      `${h} Growth`,
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
    d.growth.forEach((g, i) => {
      const at = Math.max(most, g.size);
      out.push(`| ${md(g.partition)} | ${n(at)} | ${i === 0 ? "" : n(at - most)} |`);
      most = at;
    });
    out.push("");
  }
}
