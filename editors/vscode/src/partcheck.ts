// The partition consistency check (#1024): for a process that has loaded a
// partitioned database, the problems q would trip on or hide - dates missing
// from the range, a table missing from a partition, a missing `.d` or column
// file, a column or type that differs from the table's other partitions, a
// symbol column enumerated against a domain the root does not hold or past
// its end, and partitions whose rows are far from the rest - as a report
// naming each problem's partitions. Free of any `vscode` import, so node
// tests it; `dbtoolsview.ts` asks the process and opens the report.
//
// One read, defining nothing. Each table directory of the newest `lim`
// partitions is looked at through its `.d` and its column files' headers
// (`type get`, which maps the file and reads none of its data) and counted
// by its first column's header. Only a full check (`deep`) reads data: the
// largest index of every symbol column, to find one past its own domain's
// end (#1103), as a float: a long arrives as an object, which reads as none.
// A nested column (type 77h on), or one whose file q cannot read, without
// its `c#` data file is missing `c#`: q fails on it at select (#1577).
// Works on kdb+ (KDB-X) and PeachQ; held there by dbtools_q.test.js.

export const PARTITION_CHECK = [
  "{[lim;deep]",
  " if[not@[{0<count .Q.pv};::;0b];:`hdb`root!(0b;system\"cd\")];",
  " r:hsym`$system\"cd\";pv:(neg\"j\"$lim)sublist .Q.pv;pt:(),.Q.pt;",
  " fs:((key r)except`$string .Q.pv)except`par.txt;",
  " dom:fs!{@[{$[11h=type v:get x;count v;0N]};x;0N]}each` sv'r,/:fs;dom:(where not null dom)#dom;",
  " one:{[r;deep;t;p] d:.Q.par[r;p;t];k:key d;",
  "  e:`tbl`part`dir`dotd`cols`missing`types`enums`maxidx`rows!(string t;string p;0b;0b;();();`short$();();`float$();0n);",
  "  if[(not 11h=abs type k)|0=count k;:e];",
  "  if[-11h=type k;:e];",
  "  if[not`.d in k;:@[e;`dir;:;1b]];",
  "  cs:(),get` sv d,`.d;have:cs where cs in k;",
  "  ty:{[d;c]@[{type get x};` sv d,c;0Nh]}[d]each have;",
  "  en:{[d;c;y]$[y within 20 76h;@[{key get x};` sv d,c;`];`]}[d]'[have;ty];",
  "  mx:\"f\"${[d;deep;c;y]$[deep&y within 20 76h;@[{max\"j\"$get x};` sv d,c;0N];0N]}[d;deep]'[have;ty];",
  "  n:$[count have;@[{\"f\"$count get x};` sv d,first have;0n];0n];",
  "  nh:{`$string[x],\"#\"}each have;nh:nh where(not nh in k)&(ty>=77h)|null ty;",
  "  @[e;`dir`dotd`cols`missing`types`enums`maxidx`rows;:;(1b;1b;string cs;string(cs except have),nh;\"h\"$ty;string en;mx;n)]};",
  " rows:raze{[one;r;deep;pt;p]one[r;deep;;p]each pt}[one;r;deep;pt]each pv;",
  " `hdb`pf`root`all`checked`tables`domains`domainsizes`rows!(1b;string .Q.pf;system\"cd\";string .Q.pv;\"f\"$count pv;string pt;",
  "  string key dom;\"f\"$value dom;$[count rows;flip rows;()])}",
].join("\n");

/// Partitions a check looks at, newest first.
export const CHECK_PARTITIONS = 1000;

export interface PartRow {
  table: string;
  partition: string;
  dir: boolean;
  dotd: boolean;
  columns: string[];
  missing: string[];
  types: number[];
  enums: string[];
  /// The largest index of each column that has a file, by `columns` less
  /// `missing`: null for one not enumerated, or in a quick check.
  maxIndexes: (number | null)[];
  rows: number | null;
}

export type PartAnswer =
  | { hdb: false; root: string }
  | { hdb: true; field: string; root: string; all: string[]; checked: number; tables: string[]; domains: Map<string, number | null>; rows: PartRow[] };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (s === null || s === undefined ? "" : String(s))) : typeof v === "string" ? [v] : []);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
/// A list of lists that can come as one list when there is one row.
const each = (v: unknown, n: number): unknown[] => (n === 1 && !(Array.isArray(v) && (v.length === 0 || Array.isArray(v[0]) || typeof v[0] === "string")) ? [v] : list(v));

/// What `PARTITION_CHECK` answered. Throws when it is not that.
export function readPartitions(raw: unknown): PartAnswer {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || typeof r.hdb !== "boolean") {
    throw new Error(`the process answered something other than its partitions: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const root = strings(r.root).join("");
  if (!r.hdb) {
    return { hdb: false, root };
  }
  const rows = (r.rows ?? {}) as Record<string, unknown>;
  const tbl = strings(rows.tbl);
  const n = tbl.length;
  // A one-row answer's columns are one-item lists already: only a bare
  // scalar is wrapped (#1102).
  const one = (v: unknown) => (n === 1 && !Array.isArray(v) ? [v] : list(v));
  const part = strings(rows.part);
  const cols = each(rows.cols, n);
  const missing = each(rows.missing, n);
  const types = each(rows.types, n);
  const enums = each(rows.enums, n);
  const dirs = one(rows.dir);
  const dotd = one(rows.dotd);
  const maxIdx = each(rows.maxidx, n);
  const counts = one(rows.rows);
  const names = strings(r.domains);
  const sizes = list(r.domainsizes);
  return {
    hdb: true,
    field: strings(r.pf).join(""),
    root,
    all: strings(r.all),
    checked: number(r.checked) ?? 0,
    tables: strings(r.tables),
    domains: new Map(names.map((d, i) => [d, number(sizes[i])])),
    rows: tbl.map((table, i) => ({
      table,
      partition: part[i] ?? "",
      dir: dirs[i] === true,
      dotd: dotd[i] === true,
      columns: strings(cols[i]),
      missing: strings(missing[i]),
      types: list(types[i]).map((t) => (typeof t === "number" ? t : NaN)),
      enums: strings(enums[i]),
      maxIndexes: list(maxIdx[i]).map(number),
      rows: number(counts[i]),
    })),
  };
}

export interface Problem {
  kind: "missing dates" | "missing table" | "missing .d" | "missing column file" | "different columns" | "different types" | "enumeration" | "row count";
  table: string;
  what: string;
  partitions: string[];
}

const day = 86_400_000;
const parseDate = (s: string): number | undefined => {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : undefined;
};
const dateText = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, ".");

/// The weekdays between the first and the last date that are not among
/// `dates`; weekends are not counted missing.
export function missingWeekdays(dates: string[]): string[] {
  const have = new Set(dates);
  const ms = dates.map(parseDate).filter((d): d is number => d !== undefined);
  if (ms.length < 2) return [];
  const lo = Math.min(...ms);
  const hi = Math.max(...ms);
  const out: string[] = [];
  for (let d = lo; d <= hi; d += day) {
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6 && !have.has(dateText(d))) out.push(dateText(d));
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/// A row count is an outlier when it is empty while the median is not, or
/// more than `factor` times from the median either way.
export const OUTLIER_FACTOR = 10;

/// Every problem the answer shows, table by table.
export function partitionProblems(a: Extract<PartAnswer, { hdb: true }>): Problem[] {
  const out: Problem[] = [];
  if (a.field === "date") {
    const gaps = missingWeekdays(a.all);
    if (gaps.length > 0) out.push({ kind: "missing dates", table: "", what: `${gaps.length} weekday${gaps.length === 1 ? "" : "s"} between ${a.all[0]} and ${a.all[a.all.length - 1]} with no partition`, partitions: gaps });
  }
  for (const table of a.tables) {
    const rows = a.rows.filter((r) => r.table === table);
    const add = (kind: Problem["kind"], what: string, partitions: string[]) => partitions.length > 0 && out.push({ kind, table, what, partitions });
    add("missing table", `no ${table} directory`, rows.filter((r) => !r.dir).map((r) => r.partition));
    add("missing .d", `${table} has no .d file`, rows.filter((r) => r.dir && !r.dotd).map((r) => r.partition));
    const good = rows.filter((r) => r.dotd);
    for (const col of [...new Set(good.flatMap((r) => r.missing))]) {
      const what = col.endsWith("#") ? `${table}.${col.slice(0, -1)} has no ${col} data file` : `${table}.${col} is in .d but has no file`;
      add("missing column file", what, good.filter((r) => r.missing.includes(col)).map((r) => r.partition));
    }
    // The schema most partitions have is the table's; the others differ.
    const signature = (r: PartRow) => r.columns.join(" ");
    const common = mode(good.map(signature));
    if (common !== undefined) {
      const differ = good.filter((r) => signature(r) !== common);
      for (const r of differ) {
        const want = common.split(" ");
        const extra = r.columns.filter((c) => !want.includes(c));
        const lack = want.filter((c) => !r.columns.includes(c));
        const what = [extra.length ? `has ${extra.join(", ")}` : "", lack.length ? `lacks ${lack.join(", ")}` : "", !extra.length && !lack.length ? "columns in another order" : ""].filter(Boolean).join("; ");
        add("different columns", `${table}: ${what} (most partitions: ${common})`, [r.partition]);
      }
      // Types by column, over the partitions that have it.
      for (const col of common.split(" ")) {
        const typeOf = (r: PartRow) => {
          const at = r.columns.filter((c) => !r.missing.includes(c)).indexOf(col);
          return at < 0 ? undefined : r.types[at];
        };
        const seen = good.map((r) => ({ r, t: typeOf(r) })).filter((x) => x.t !== undefined && !Number.isNaN(x.t));
        const usual = mode(seen.map((x) => String(x.t)));
        const odd = seen.filter((x) => String(x.t) !== usual);
        for (const t of [...new Set(odd.map((x) => x.t))]) {
          add("different types", `${table}.${col} is type ${t} here, ${usual} in most partitions`, odd.filter((x) => x.t === t).map((x) => x.r.partition));
        }
      }
    }
    // Enumerations: a domain the root has no file for, or an index past its end.
    const enumCols = (r: PartRow) => r.columns.filter((c) => !r.missing.includes(c)).map((c, i) => ({ c, d: r.enums[i] ?? "", t: r.types[i], max: r.maxIndexes[i] ?? null })).filter((x) => x.t >= 20 && x.t <= 76);
    const noDomain = new Map<string, string[]>();
    for (const r of good) {
      for (const { c, d } of enumCols(r)) {
        if (d === "" || !a.domains.has(d)) {
          const key = `${c}|${d}`;
          noDomain.set(key, [...(noDomain.get(key) ?? []), r.partition]);
        }
      }
    }
    for (const [key, parts] of noDomain) {
      const [c, d] = key.split("|");
      add("enumeration", `${table}.${c} is enumerated against ${d || "an unknown domain"}, which the root has no file for`, parts);
    }
    // Each column's largest index against its own domain's size.
    const past = new Map<string, string[]>();
    for (const r of good) {
      for (const { c, d, max } of enumCols(r)) {
        const size = a.domains.get(d);
        if (max !== null && typeof size === "number" && max >= size) {
          const key = `${c}|${d}`;
          past.set(key, [...(past.get(key) ?? []), r.partition]);
        }
      }
    }
    for (const [key, parts] of past) {
      const [c, d] = key.split("|");
      add("enumeration", `${table}.${c} has a symbol index past the end of ${d}`, parts);
    }
    const counted = good.filter((r) => r.rows !== null);
    const mid = median(counted.map((r) => r.rows!));
    if (counted.length >= 3 && mid > 0) {
      add("row count", `${table}: empty, while the median partition has ${mid.toLocaleString("en-US")} rows`, counted.filter((r) => r.rows === 0).map((r) => r.partition));
      add(
        "row count",
        `${table}: more than ${OUTLIER_FACTOR} times from the median of ${mid.toLocaleString("en-US")} rows`,
        counted.filter((r) => r.rows! > 0 && (r.rows! > mid * OUTLIER_FACTOR || r.rows! * OUTLIER_FACTOR < mid)).map((r) => `${r.partition} (${r.rows!.toLocaleString("en-US")})`),
      );
    }
  }
  return out;
}

function mode(xs: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | undefined;
  let n = 0;
  for (const [x, c] of counts) {
    if (c > n) {
      best = x;
      n = c;
    }
  }
  return best;
}

const md = (s: string) => s.replace(/([\\`*_{}[\]<>|#])/g, "\\$1");

/// The report, as Markdown: what was checked, then each problem with the
/// partitions it is in (at most `shown` of them listed).
export function partitionReport(a: PartAnswer, process: string, deep: boolean, shown = 50): string {
  if (!a.hdb) {
    return `# Partition check of ${md(process)}\n\n${md(process)} has no partitioned database loaded (its directory is ${md(a.root)}).\n`;
  }
  const problems = partitionProblems(a);
  const out = [
    `# Partition check of ${md(process)}`,
    "",
    `${md(a.root)}, partitioned by ${md(a.field)}: ${a.all.length.toLocaleString("en-US")} partitions, the newest ${a.checked.toLocaleString("en-US")} checked, tables ${a.tables.map(md).join(", ") || "none"}.`,
    deep ? "A full check: every symbol column was read for its largest index." : "A quick check: no column data was read, so symbol indexes past their domain's end are not looked for.",
    "",
  ];
  if (problems.length === 0) {
    out.push("No problems found.");
    return out.join("\n") + "\n";
  }
  out.push(`${problems.length} problem${problems.length === 1 ? "" : "s"}:`, "");
  for (const p of problems) {
    const more = p.partitions.length > shown ? `, and ${p.partitions.length - shown} more` : "";
    out.push(`- **${p.kind}**: ${md(p.what)} - ${p.partitions.length} partition${p.partitions.length === 1 ? "" : "s"}: ${p.partitions.slice(0, shown).map(md).join(", ")}${more}`);
  }
  return out.join("\n") + "\n";
}
