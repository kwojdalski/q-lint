// The test data generator (#1028): random rows shaped as a table's meta -
// the right type in every column, the number of rows, the symbols drawn
// from, the range numbers are drawn from and the column kept in order all
// chosen - as q code to run on a local process, or as CSV. Free of any
// `vscode` import, so node tests it; `dbtoolsview.ts` reads the meta
// (`tableinfo.ts`'s TABLE_INFO) and opens the result.
//
// The q is self-contained: it sets the random seed (`\S`), so it makes the
// same rows each time, and defines only the table. The CSV is drawn here
// by a seeded generator, as q would read it back with `0:`: times as q
// writes them, symbols bare, strings quoted when they need to be.
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

/// The q expression of `n` random values of type `type` (a meta type
/// character), with `o`'s pool and range.
export function generator(type: string, o: TestDataOptions): string {
  const lo = o.low;
  const span = o.high - o.low;
  const whole = Math.max(1, Math.round(span));
  const pool = o.symbols.length === 1 ? `enlist\`${o.symbols[0]}` : o.symbols.map((s) => `\`${s}`).join("");
  switch (type) {
    case "b": return "n?0b";
    case "g": return "n?0Ng";
    case "x": return "`byte$n?256";
    case "h": return `"h"$${Math.round(lo)}+n?${Math.min(whole, 32767)}`;
    case "i": return `"i"$${Math.round(lo)}+n?${whole}`;
    case "j": return `${Math.round(lo)}+n?${whole}`;
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
    default: return "n#enlist()";
  }
}

/// The q that makes the rows, named `name`.
export function testDataQ(info: TableInfo, name: string, o: TestDataOptions): string {
  const cols = info.columns.map((c) => {
    const g = generator(c.type, o);
    return `${c.name}:${c.name === o.sorted ? `asc ${g}` : g}`;
  });
  const keys = info.keys.filter((k) => info.columns.some((c) => c.name === k));
  return [
    `/ q-lint: ${o.rows.toLocaleString("en-US")} rows of test data shaped as ${name}. Run it on a local process.`,
    `\\S ${o.seed}`,
    `n:${o.rows}`,
    `${name}:${keys.length > 0 ? `${keys.map((k) => `\`${k}`).join("")} xkey ` : ""}([] ${cols.join("; ")})`,
    `delete n from \`.`,
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
    case "x": return `0x${Math.floor(r * 256).toString(16).padStart(2, "0")}`;
    case "h":
    case "i":
    case "j": return String(Math.round(lo) + Math.floor(r * Math.max(1, Math.round(span))));
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
    default: return "";
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
