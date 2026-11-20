// A q value formatted here, from what node-q's codec decoded, for the two
// cases where the process does not format it: an unwrapped query, whose
// answer is whatever the process returns, and an unlimited one, whose simple
// lists are sent whole because KDB-X's `-3!` cuts them at its `\c` width.
//
// The codec keeps less than q knows, so this is q's console as nearly as is
// practical, not exactly:
// - The q type of the whole value is known when the caller passes it (the
//   type byte of an uncompressed answer, or `type` sent beside the value),
//   and then an atom or a simple list is written as q writes it, suffix and
//   all. Inside a table, a dictionary or a general list the codec gives
//   plain JavaScript values, and the type is guessed from them: a symbol and
//   a string are both strings, and a date, a month and a datetime all Dates.
// - A long and a timespan are exact (the codec gives a Long). A timestamp
//   arrives as a float of nanoseconds, exact only to 256 ns, so it is shown
//   to the microsecond, its last three digits 0.
// - The infinity of a date, month, datetime or time arrives as an invalid
//   Date, its sign lost, so a negative one is written as a positive one.
// - A function arrives as the word "func": its text is not sent.
// - An empty table arrives with no columns, so they cannot be shown.
import type { GridPayload } from "./grid";

/// q's generic null, `(::)`.
const NULL_TYPE = 101;
/// 2000.01.01 in milliseconds since 1970.01.01, where q counts from.
const EPOCH_MS = 946_684_800_000;
const DAY_MS = 86_400_000;
const NULL_GUID = "00000000-0000-0000-0000-000000000000";

/// A Long from the codec (long.js): a 64-bit integer as two halves.
interface LongLike {
  high: number;
  low: number;
  toString(): string;
}

function isLong(x: unknown): x is LongLike {
  return typeof x === "object" && x !== null && "high" in x && "low" in x && typeof (x as LongLike).toString === "function";
}

function isRow(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && !(x instanceof Date) && !isLong(x);
}

/// Whether `x` is a table as the codec decodes one: a list of rows, each an
/// object with the same columns.
function isTable(x: unknown): x is Record<string, unknown>[] {
  if (!Array.isArray(x) || x.length === 0 || !x.every(isRow)) {
    return false;
  }
  const names = Object.keys(x[0]).join("\u0000");
  return x.every((row) => Object.keys(row).join("\u0000") === names);
}

/// A keyed table as the codec decodes one: `[keys, values]`, two tables of
/// as many rows.
function isKeyed(x: unknown): x is [Record<string, unknown>[], Record<string, unknown>[]] {
  return Array.isArray(x) && x.length === 2 && isTable(x[0]) && isTable(x[1]) && x[0].length === x[1].length;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const pad3 = (n: number): string => String(n).padStart(3, "0");

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}.${pad2(d.getUTCMonth() + 1)}.${pad2(d.getUTCDate())}`;
}

function hms(d: Date): string {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/// A float as q writes it at its default `\P` of 7 significant digits.
export function floatText(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e15) {
    return String(x);
  }
  return String(Number(x.toPrecision(7)));
}

/// A time of day, or a span, from milliseconds or nanoseconds: `hh:mm`,
/// `hh:mm:ss` or `hh:mm:ss.mmm`, the hours past 23 when there are more.
function clock(total: number, unit: "minute" | "second" | "milli"): string {
  const sign = total < 0 ? "-" : "";
  let t = Math.abs(Math.round(total));
  const ms = unit === "milli" ? t % 1000 : 0;
  if (unit === "milli") {
    t = Math.floor(t / 1000);
  }
  if (unit === "minute") {
    return `${sign}${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
  }
  const text = `${sign}${pad2(Math.floor(t / 3600))}:${pad2(Math.floor(t / 60) % 60)}:${pad2(t % 60)}`;
  return unit === "milli" ? `${text}.${pad3(ms)}` : text;
}

/// Whether `x` is an infinity as the codec gives one: a number, or an
/// invalid Date for a date, month, datetime or time, whose sign it loses.
function infinite(x: unknown): boolean {
  return x === Infinity || x === -Infinity || (x instanceof Date && Number.isNaN(x.getTime()));
}

/// Milliseconds since 2000.01.01 of a Date the codec made of a q time.
const sinceEpoch = (d: Date): number => d.getTime() - EPOCH_MS;

/// A timespan of `ns` nanoseconds: `0D01:02:03.000000001`.
function spanText(ns: bigint): string {
  const sign = ns < 0n ? "-" : "";
  let t = ns < 0n ? -ns : ns;
  const nanos = t % 1_000_000_000n;
  t /= 1_000_000_000n;
  const days = t / 86_400n;
  t %= 86_400n;
  const h = Number(t / 3600n);
  const m = Number((t / 60n) % 60n);
  const s = Number(t % 60n);
  return `${sign}${days}D${pad2(h)}:${pad2(m)}:${pad2(s)}.${nanos.toString().padStart(9, "0")}`;
}

/// A timestamp from the codec's float of nanoseconds since 1970.01.01.
/// A float that large is exact only to 256 ns, so the nanoseconds are
/// rounded to whole microseconds: `.500000000` rather than `.500000256`.
function timestampText(ns: number): string {
  const micros = Math.round(ns / 1000);
  const seconds = Math.floor(micros / 1e6);
  const d = new Date(seconds * 1000);
  return `${ymd(d)}D${hms(d)}.${String((micros - seconds * 1e6) * 1000).padStart(9, "0")}`;
}

/// One item of a simple list, or an atom, of q type `t` (positive), without
/// the suffix a list or an atom ends with. Undefined for a null, which the
/// caller writes.
function itemText(x: unknown, t: number): string | undefined {
  if (x === null || x === undefined) {
    return undefined;
  }
  if (infinite(x)) {
    const w = t === 8 || t === 9 || t === 15 ? "w" : "W";
    return `${x === -Infinity ? "-" : ""}0${w}`;
  }
  switch (t) {
    case 1:
      return x ? "1" : "0";
    case 2:
      return String(x);
    case 4:
      return Number(x).toString(16).padStart(2, "0");
    case 5:
    case 6:
    case 7:
      return String(x);
    case 8:
    case 9:
      return floatText(Number(x));
    case 10:
      return String(x);
    case 11:
      return String(x);
    case 12:
      return timestampText(Number(x));
    case 16:
      return spanText(BigInt(String(x)));
  }
  if (!(x instanceof Date)) {
    return String(x);
  }
  switch (t) {
    case 13:
      return `${x.getUTCFullYear()}.${pad2(x.getUTCMonth() + 1)}`;
    case 14:
      return ymd(x);
    case 15:
      return `${ymd(x)}T${hms(x)}.${pad3(x.getUTCMilliseconds())}`;
    case 17:
      return clock(sinceEpoch(x) / 60_000, "minute");
    case 18:
      return clock(sinceEpoch(x) / 1000, "second");
    case 19:
      return clock(sinceEpoch(x), "milli");
  }
  return String(x);
}

/// How q writes a null of type `t` in a list.
function nullText(t: number): string {
  return t === 8 || t === 9 ? "0n" : t === 2 ? NULL_GUID : t === 11 ? "" : t === 10 ? " " : "0N";
}

const SUFFIX: Record<number, string> = { 5: "h", 6: "i", 8: "e", 13: "m" };
const NAMES: Record<number, string> = {
  1: "boolean", 2: "guid", 4: "byte", 5: "short", 6: "int", 7: "long", 8: "real", 9: "float", 10: "char",
  11: "symbol", 12: "timestamp", 13: "month", 14: "date", 15: "datetime", 16: "timespan", 17: "minute",
  18: "second", 19: "time",
};

function quoted(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/// A simple list of q type `t` (1 to 19) as q's console writes it:
/// `1 2 3i`, `101b`, `` `a`b ``, `"abc"`, `,1` for one item.
export function vectorText(values: unknown, t: number): string {
  if (t === 10) {
    const s = typeof values === "string" ? values : Array.isArray(values) ? values.join("") : String(values);
    return s.length === 1 ? `,${quoted(s)}` : quoted(s);
  }
  const items = Array.isArray(values) ? values : [values];
  if (items.length === 0) {
    return `\`${NAMES[t] ?? "list"}$()`;
  }
  const one = items.length === 1 ? "," : "";
  if (t === 11) {
    return one + items.map((s) => `\`${s ?? ""}`).join("");
  }
  const texts = items.map((x) => itemText(x, t) ?? nullText(t));
  if (t === 1) {
    return `${one}${texts.join("")}b`;
  }
  if (t === 4) {
    return `${one}0x${texts.join("")}`;
  }
  let suffix = SUFFIX[t] ?? "";
  if (t === 9 && texts.every((s) => /^-?\d+$/.test(s))) {
    suffix = "f";
  }
  return `${one}${texts.join(" ")}${suffix}`;
}

/// An atom of q type `t` (-1 to -19) as q's console writes it.
export function atomText(x: unknown, t: number): string {
  const p = -t;
  if (p === 10) {
    return quoted(x === null ? " " : String(x));
  }
  if (p === 11) {
    return `\`${x ?? ""}`;
  }
  const text = itemText(x, p);
  if (text === undefined) {
    return p === 9 ? "0n" : p === 8 ? "0Ne" : p === 2 ? NULL_GUID : p === 7 ? "0N" : `0N${letter(p)}`;
  }
  if (p === 1) {
    return `${text}b`;
  }
  if (p === 4) {
    return `0x${text}`;
  }
  if (p === 9 && /^-?\d+$/.test(text)) {
    return `${text}f`;
  }
  // A temporal infinity says its type, as a null does: `0Wp`, `0wz`.
  if (p >= 12 && p <= 19 && p !== 13 && infinite(x)) {
    return text + letter(p);
  }
  return text + (SUFFIX[p] ?? "");
}

/// q's letter for a type, as a typed null is written: `0Nj`, `0Nd`.
function letter(t: number): string {
  return " bg xhijefcspmdznuvt"[t]?.trim() ?? "";
}

/// One value inside a table, a dictionary or a general list, its type
/// guessed from what the codec gave: a string as itself, a list of strings
/// as symbols, a Date at midnight as a date.
export function cellText(x: unknown): string {
  if (x === null || x === undefined) {
    return "";
  }
  if (infinite(x)) {
    return `${x === -Infinity ? "-" : ""}0W`;
  }
  if (typeof x === "boolean") {
    return x ? "1" : "0";
  }
  if (typeof x === "number") {
    return floatText(x);
  }
  if (typeof x === "string") {
    return x;
  }
  if (isLong(x)) {
    return x.toString();
  }
  if (x instanceof Date) {
    return x.getTime() % DAY_MS === 0 ? ymd(x) : `${ymd(x)}T${hms(x)}.${pad3(x.getUTCMilliseconds())}`;
  }
  if (Array.isArray(x)) {
    if (x.length > 0 && x.every((s) => typeof s === "string" || s === null)) {
      return x.map((s) => `\`${s ?? ""}`).join("");
    }
    return x.map(cellText).join(" ");
  }
  if (isRow(x)) {
    return Object.entries(x)
      .map(([k, v]) => `\`${k}!${cellText(v)}`)
      .join(" ");
  }
  return String(x);
}

/// The lines q's console shows for a table of `rows`, `keys` of whose
/// leading columns are its key: names, dashes, then the rows, each column
/// as wide as its widest cell and left-aligned.
function tableLines(rows: Record<string, unknown>[], keys = 0): string[] {
  if (rows.length === 0) {
    return ["+`$()!() / an empty table: the process sends no columns with no rows"];
  }
  const names = Object.keys(rows[0]);
  const cells = names.map((n) => rows.map((r) => cellText(r[n])));
  const widths = names.map((n, i) => Math.max(n.length, ...cells[i].map((c) => c.length)));
  const line = (texts: string[], fill = " "): string => {
    const parts = texts.map((t, i) => t.padEnd(widths[i], fill));
    return keys > 0 ? `${parts.slice(0, keys).join(" ")}| ${parts.slice(keys).join(" ")}` : parts.join(" ");
  };
  const dashes = keys > 0
    ? `${"-".repeat(widths.slice(0, keys).reduce((a, w) => a + w, keys - 1))}| ${"-".repeat(widths.slice(keys).reduce((a, w) => a + w, widths.length - keys - 1))}`
    : "-".repeat(widths.reduce((a, w) => a + w, widths.length - 1));
  return [line(names), dashes, ...rows.map((_, r) => line(cells.map((c) => c[r])))].map((l) => l.trimEnd());
}

/// The lines q's console would show for `value`, as decoded by node-q's
/// codec (tables as lists of rows, temporals not made Dates where it can
/// avoid it, longs as Longs), with `type` the q type of the whole value when
/// it is known.
export function formatValue(value: unknown, type?: number): string[] {
  if (type === NULL_TYPE || (type === undefined && value === null)) {
    return ["::"];
  }
  if (type !== undefined && type >= 100) {
    return ["<a function: the process sends no text for one>"];
  }
  if (type !== undefined && type < 0 && type >= -19) {
    return [atomText(value, type)];
  }
  if (type !== undefined && type >= 1 && type <= 19) {
    return [vectorText(value, type)];
  }
  if ((type === undefined || type === 98) && isTable(value)) {
    return tableLines(value);
  }
  if (type === 98 && Array.isArray(value) && value.length === 0) {
    return tableLines([]);
  }
  if ((type === undefined || type === 99) && isKeyed(value)) {
    const [k, v] = value;
    return tableLines(k.map((row, i) => ({ ...row, ...v[i] })), Object.keys(k[0]).length);
  }
  if (isRow(value)) {
    const entries = Object.entries(value);
    const width = Math.max(0, ...entries.map(([k]) => k.length));
    return entries.map(([k, v]) => `${k.padEnd(width)}| ${cellText(v)}`);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ["()"];
    }
    return value.map((item) => (typeof item === "string" ? quoted(item) : cellText(item)));
  }
  if (typeof value === "string") {
    return [type === undefined && value === "func" ? "<a function: the process sends no text for one>" : quoted(value)];
  }
  return [cellText(value)];
}

/// `lines` cut to a console of `size` (height, width) as `.Q.S` cuts: a
/// line longer than the width ends in `..`, and past the height the rest is
/// one `..` line.
export function cutLines(lines: string[], size: [number, number]): string[] {
  const [height, width] = size;
  const cut = lines.map((l) => (l.length > width ? `${l.slice(0, Math.max(0, width - 2))}..` : l));
  return cut.length > height ? [...cut.slice(0, Math.max(0, height - 1)), ".."] : cut;
}

/// The q type a column holds, guessed from its values: a number column is
/// float (long if a Long is in it), a Date column a date when every Date
/// is at midnight and a datetime otherwise.
function columnType(values: unknown[]): number {
  const present = values.filter((x) => x !== null && x !== undefined);
  if (present.length === 0) {
    return 0;
  }
  if (present.every((x) => typeof x === "boolean")) {
    return 1;
  }
  if (present.every((x) => typeof x === "number" || isLong(x))) {
    return present.some(isLong) ? 7 : 9;
  }
  if (present.every((x) => typeof x === "string")) {
    return 11;
  }
  if (present.every((x) => x instanceof Date)) {
    return present.every((x) => (x as Date).getTime() % DAY_MS === 0) ? 14 : 15;
  }
  return 0;
}

/// A value of a numeric or temporal column as the number the grid sorts
/// and charts: temporals in their own unit since 2000.01.01, as q holds
/// them. Null for a null; an infinity as itself.
function rawNumber(x: unknown, t: number): number | null {
  if (x === null || x === undefined) {
    return null;
  }
  if (infinite(x)) {
    return x === -Infinity ? -Infinity : Infinity;
  }
  if (isLong(x)) {
    return Number(x.toString());
  }
  if (x instanceof Date) {
    const ms = sinceEpoch(x);
    switch (t) {
      case 13:
        return (x.getUTCFullYear() - 2000) * 12 + x.getUTCMonth();
      case 14:
        return Math.round(ms / DAY_MS);
      case 15:
        return ms / DAY_MS;
      case 17:
        return Math.round(ms / 60_000);
      case 18:
        return Math.round(ms / 1000);
      case 19:
        return Math.round(ms);
    }
    return ms;
  }
  if (typeof x === "number") {
    return t === 12 ? x - EPOCH_MS * 1e6 : x;
  }
  return null;
}

const RAW_TYPES = new Set([5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19]);

/// Each row's place when `values` is sorted ascending, nulls first, as
/// `iasc iasc` gives it; empty when the values cannot be compared.
function ranks(values: unknown[], raw: (number | null)[] | undefined): number[] {
  const keys: (number | string)[] = raw
    ? raw.map((x) => (x === null ? -Infinity : x))
    : values.map((x) => (x === null || x === undefined ? "" : typeof x === "boolean" ? Number(x) : cellText(x)));
  const order = keys.map((_, i) => i).sort((a, b) => {
    const x = keys[a];
    const y = keys[b];
    if (typeof x === "number" && typeof y === "number") {
      return x === y ? a - b : x < y ? -1 : 1;
    }
    const sx = String(x);
    const sy = String(y);
    return sx === sy ? a - b : sx < sy ? -1 : 1;
  });
  const rank = new Array<number>(keys.length);
  order.forEach((row, place) => {
    rank[row] = place;
  });
  return rank;
}

/// The rows the result panel shows for `value`, as `GRID` would send them:
/// a table (keyed: its keys marked), a dictionary as `key` and `value`
/// columns, or a list other than a string as one `value` column; at most
/// `limit` rows. Undefined for anything else, which is shown as text.
export function gridOf(value: unknown, type: number | undefined, limit: number): GridPayload | undefined {
  let columns: { name: string; values: unknown[]; type?: number }[];
  let keys = 0;
  if ((type === undefined || type === 98) && isTable(value)) {
    columns = Object.keys(value[0]).map((name) => ({ name, values: value.map((r) => r[name]) }));
  } else if ((type === undefined || type === 99) && isKeyed(value)) {
    const [k, v] = value;
    keys = Object.keys(k[0]).length;
    columns = [
      ...Object.keys(k[0]).map((name) => ({ name, values: k.map((r) => r[name]) })),
      ...Object.keys(v[0]).map((name) => ({ name, values: v.map((r) => r[name]) })),
    ];
  } else if (isRow(value) && (type === undefined || type === 99)) {
    keys = 1;
    columns = [
      { name: "key", values: Object.keys(value), type: 11 },
      { name: "value", values: Object.values(value) },
    ];
  } else if (Array.isArray(value) && (type === undefined || type === 0 || (type >= 1 && type <= 19 && type !== 10))) {
    columns = [{ name: "value", values: value, type: type !== undefined && type > 0 ? type : undefined }];
  } else {
    return undefined;
  }
  const count = columns[0]?.values.length ?? 0;
  const shown = columns.map((c) => ({ ...c, values: c.values.slice(0, limit) }));
  const types = shown.map((c) => c.type ?? columnType(c.values));
  const raw = shown.map((c, i) => (RAW_TYPES.has(types[i]) ? c.values.map((x) => rawNumber(x, types[i])) : []));
  const cells = shown.map((c, i) =>
    c.values.map((x) => {
      if (c.type === undefined || x === null || infinite(x)) {
        return cellText(x);
      }
      return types[i] === 11 ? String(x) : (itemText(x, types[i]) ?? "");
    }),
  );
  return {
    count,
    keys,
    names: shown.map((c) => c.name),
    types,
    cells,
    raw,
    rank: shown.map((c, i) => ranks(c.values, raw[i].length > 0 ? raw[i] : undefined)),
  };
}
