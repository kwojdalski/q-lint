// The test data generator (#1028): random rows shaped as a table's meta -
// the right type in every column, the number of rows, the symbols drawn
// from, the range numbers are drawn from and the column kept in order all
// chosen - as q code to run on a local process, or as CSV. Free of any
// `vscode` import, so node tests it; `dbtoolsview.ts` reads the meta
// (`tableinfo.ts`'s TABLE_INFO) and opens the result.
//
// The q is self-contained: it sets the random seed (`\S`), so it makes the
// same rows each time, and defines only the table - the row count is a
// lambda's parameter, no global of the process's (#2016). The CSV is drawn here
// by a seeded generator, as q would read it back with `0:`: times as q
// writes them, symbols bare, strings quoted when they need to be.
import { plainName, qString, symbolLiteral } from "./qliteral";
import type { TableInfo } from "./tableinfo";

export interface TestDataOptions {
  rows: number;
  /// The symbols a symbol column takes.
  symbols: string[];
  /// The range a numeric column is drawn from, [lo, hi).
  low: number;
  high: number;
  /// A column kept in ascending order, or none.
  sorted?: string;
  seed: number;
}

/// The symbols a pool asks for: a number `n` is `sym1` ... `symn`, else the
/// names given, separated by spaces or commas or backticks.
export function symbolPool(text: string): string[] | undefined {
  const t = text.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 100_000 ? Array.from({ length: n }, (_, i) => `sym${i + 1}`) : undefined;
  }
  const names = t.split(/[\s,`]+/).filter(Boolean);
  return names.length > 0 && names.every((s) => /^[A-Za-z0-9_.:/]+$/.test(s)) ? names : undefined;
}

/// A range written `lo hi` or `lo..hi`, lo below hi.
export function rangeOf(text: string): [number, number] | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:\.\.|\s|,)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return undefined;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  return lo < hi ? [lo, hi] : undefined;
}

const DAY = "2026.01.02";

/// The largest finite short and int: one more is the type's infinity, and
/// past that `"H"$` and `"I"$` read a number as a null (#1499). A long is
/// held to 2^52, the whole numbers a JavaScript number holds one by one:
/// past 2^63 the count is a number q cannot read, and from 1e21 it prints
/// as a float (#1904).
const WHOLE_LIMIT: Record<string, number> = { h: 32766, i: 2147483646, j: 2 ** 52 };

/// The first whole number a column of type `type` takes from `o`'s range
/// and how many follow it: the range rounded, and cut to the values the
/// type holds (a long, to those written exactly), so the q and the CSV
/// draw alike.
export function wholeRange(type: string, o: TestDataOptions): [number, number] {
  let lo = Math.round(o.low);
  let hi = lo + Math.max(1, Math.round(o.high - o.low));
  const m = WHOLE_LIMIT[type];
  if (m !== undefined) {
    lo = Math.min(Math.max(lo, -m), m);
    hi = Math.min(Math.max(hi, lo + 1), m + 1);
  }
  return [lo, hi - lo];
}

/// The meta types of a column that holds a list of one type in each row:
/// a book's sizes (`J`), its prices (`F`), tags (`S`). `C`, a string, has
/// its own generator.
const NESTED = /^[BGXHIJEFSPMDZNUVT]$/;

/// The q expression of `n` random values of type `type` (a meta type
/// character), with `o`'s pool and range.
export function generator(type: string, o: TestDataOptions): string {
  const lo = o.low;
  const span = o.high - o.low;
  // A symbol a bare one cannot write (`a/b` is `a` over `b`, '/) goes
  // through `$ (#1279).
  const bare = o.symbols.every((s) => symbolLiteral(s) === `\`${s}`);
  const pool =
    o.symbols.length === 1 ? `enlist${symbolLiteral(o.symbols[0])}` : bare ? o.symbols.map((s) => `\`${s}`).join("") : `\`$(${o.symbols.map(qString).join(";")})`;
  switch (type) {
    case "b": return "n?0b";
    case "g": return "n?0Ng";
    case "x": return "`byte$n?256";
    case "h":
    case "i":
    case "j": {
      const [from, count] = wholeRange(type, o);
      return `${type === "j" ? "" : `"${type}"$`}${from}+n?${count}`;
    }
    case "e": return `"e"$${lo}+n?${span}e`;
    case "f": return `${lo}+n?${span}f`;
    case "c": return "n?.Q.a";
    case "s": return `n?${pool}`;
    case "p": return `${DAY}D+n?1D`;
    case "m": return "2026.01m+n?12";
    case "d": return `${DAY}+n?30`;
    case "z": return `${DAY}T00:00:00.000+n?1f`;
    case "n": return "n?1D";
    case "u": return '"u"$n?1440';
    case "v": return '"v"$n?86400';
    case "t": return '"t"$n?86400000';
    case "C": return "{(1+x mod 10)?.Q.a}each til n";
    // A nested column is one to five of its atom's values a row, drawn as
    // the atom is, so meta reads its type back: `n#enlist()` made every
    // row an empty generic list and the column a mixed one (#3051).
    default: return NESTED.test(type) ? `{[n] ${generator(type.toLowerCase(), o)}}each 1+(til n)mod 5` : "n#enlist()";
  }
}

/// The columns one lambda of the script makes, well inside what q lets a
/// lambda hold (`dbtools_q.test.js` runs a script of a thousand).
const LAMBDA_COLUMNS = 100;

/// The q that makes the rows, named `name`: that name is all it defines.
export function testDataQ(info: TableInfo, name: string, o: TestDataOptions): string {
  const gens = info.columns.map((c) => {
    const g = generator(c.type, o);
    return c.name === o.sorted ? `asc ${g}` : g;
  });
  const keys = info.keys.filter((k) => info.columns.some((c) => c.name === k));
  // A name q cannot parse (`my t`, `px bid`) by its symbol: the table set,
  // its columns flipped from a dictionary (#1583).
  const symbols = (names: string[]) => {
    const each = names.map(symbolLiteral);
    return each.every((s) => !s.startsWith("`$")) ? each.join("") : each.length === 1 ? `(${each[0]})` : `(${each.join(";")})`;
  };
  const by = symbols(keys);
  const plain = info.columns.every((c) => plainName(c.name));
  // The count is the parameter `n` of a lambda, which holds so many columns
  // and no more ('stack past some 250, 'limit sooner): a wider table is
  // made of several, their columns joined.
  const parts: string[] = [];
  for (let i = 0; i < info.columns.length; i += LAMBDA_COLUMNS) {
    const columns = info.columns.slice(i, i + LAMBDA_COLUMNS).map((c) => c.name);
    const g = gens.slice(i, i + LAMBDA_COLUMNS);
    const table = plain
      ? `([] ${columns.map((c, j) => `${c}:${g[j]}`).join("; ")})`
      : `flip ${columns.length === 1 ? `(enlist ${symbolLiteral(columns[0])})!enlist ${g[0]}` : `${symbols(columns)}!(${g.join(";")})`}`;
    parts.push(`{[n] ${table}}[${o.rows}]`);
  }
  const rows = parts.length === 1 ? parts[0] : `flip ${parts.map((p) => `(flip ${p})`).join(",")}`;
  const assign = (e: string) => (plainName(name) ? `${name}:${e}` : `(${symbolLiteral(name)}) set ${e}`);
  return [
    `/ q-lint: ${keys.length > 0 ? "up to " : ""}${o.rows.toLocaleString("en-US")} rows of test data shaped as ${name}. Run it on a local process.`,
    `\\S ${o.seed}`,
    // A keyed table keeps the first row of each key drawn: a key is one row (#1282).
    assign(keys.length > 0 ? `${by} xkey {x where(til count x)=k?k:((),y)#x}[${rows};${by}]` : rows),
    "",
  ].join("\n");
}

/// A small seeded generator (mulberry32): the same seed, the same rows.
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const dateText = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
};
const timeText = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
};
const BASE = Date.UTC(2026, 0, 2);
const DAY_MS = 86_400_000;
const csv = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/// The value one random draw `r` (and `next` for more) gives a column of
/// type `type`, as CSV text.
function csvValue(type: string, o: TestDataOptions, next: () => number): string {
  const r = next();
  const lo = o.low;
  const span = o.high - o.low;
  switch (type) {
    case "b": return r < 0.5 ? "0" : "1";
    case "g": return [8, 4, 4, 4, 12].map((w) => Array.from({ length: w }, () => Math.floor(next() * 16).toString(16)).join("")).join("-");
    // Bare hex: `"X"$` reads `0x7b` as 0x00 (#1278).
    case "x": return Math.floor(r * 256).toString(16).padStart(2, "0");
    case "h":
    case "i":
    case "j": {
      const [from, count] = wholeRange(type, o);
      return String(from + Math.floor(r * count));
    }
    case "e":
    case "f": return String(+(lo + r * span).toFixed(6));
    case "c": return String.fromCharCode(97 + Math.floor(r * 26));
    case "s": return o.symbols[Math.floor(r * o.symbols.length)];
    case "p": { const ms = BASE + Math.floor(r * DAY_MS); return `${dateText(ms)}D${timeText(ms)}000000`; }
    case "m": { const m = Math.floor(r * 12); return `2026.${pad(m + 1)}`; }
    case "d": return dateText(BASE + Math.floor(r * 30) * DAY_MS);
    case "z": { const ms = BASE + Math.floor(r * DAY_MS); return `${dateText(ms)}T${timeText(ms)}`; }
    case "n": { const ms = Math.floor(r * DAY_MS); return `0D${timeText(ms)}000000`; }
    case "u": return timeText(Math.floor(r * 1440) * 60_000).slice(0, 5);
    case "v": return timeText(Math.floor(r * 86_400) * 1000).slice(0, 8);
    case "t": return timeText(Math.floor(r * DAY_MS));
    case "C": return csv(Array.from({ length: 1 + Math.floor(r * 10) }, () => String.fromCharCode(97 + Math.floor(next() * 26))).join(""));
    // A nested column's row, its values a blank apart, as q writes a list (#3051).
    default: return NESTED.test(type) ? Array.from({ length: 1 + Math.floor(r * 5) }, () => csvValue(type.toLowerCase(), o, next)).join(" ") : "";
  }
}

/// The rows as CSV, with a header, and the sorted column in order.
export function testDataCsv(info: TableInfo, o: TestDataOptions): string {
  const next = random(o.seed);
  const cols = info.columns.map((c) => Array.from({ length: o.rows }, () => csvValue(c.type, o, next)));
  const at = info.columns.findIndex((c) => c.name === o.sorted);
  if (at >= 0) {
    const t = info.columns[at].type;
    const numeric = "hijef".includes(t) && t !== "";
    cols[at].sort(numeric ? (a, b) => Number(a) - Number(b) : undefined);
  }
  const lines = [info.columns.map((c) => csv(c.name)).join(",")];
  for (let r = 0; r < o.rows; r++) lines.push(cols.map((c) => c[r]).join(","));
  return lines.join("\n") + "\n";
}

/// The `0:` type string that reads the CSV back: q's load types by meta.
export function loadTypes(info: TableInfo): string {
  const map: Record<string, string> = { b: "B", g: "G", x: "X", h: "H", i: "I", j: "J", e: "E", f: "F", c: "C", s: "S", p: "P", m: "M", d: "D", z: "Z", n: "N", u: "U", v: "V", t: "T", C: "*" };
  return info.columns.map((c) => map[c.type] ?? "*").join("");
}
