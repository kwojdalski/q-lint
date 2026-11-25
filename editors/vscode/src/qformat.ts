// A q value formatted here, from what node-q's codec decoded, for the two
// cases where the process does not format it: an unwrapped query, whose
// answer is whatever the process returns, and an unlimited one, whose simple
// lists are sent whole because KDB-X's `-3!` cuts them at its `\c` width.
//
// The codec keeps less than q knows, so this is q's console as nearly as is
// practical, not exactly:
// - The q type of the whole value is known when the caller passes it (the
//   type byte of an answer, or `type` sent beside the value),
//   and then an atom or a simple list is written as q writes it, suffix and
//   all. Inside a table, a dictionary or a general list the codec gives
//   plain JavaScript values, and the type is guessed from them: a symbol and
//   a string are both strings, and a date, a month and a datetime all Dates.
// - An unwrapped answer is also decoded with its types (`qdecode.ts`), and
//   an atom or a simple list is written from that: exact, every type.
// - Otherwise a long and a timespan are exact (the codec gives a Long). A
//   timestamp arrives as a float of nanoseconds, exact only to 256 ns, so it
//   is shown to the microsecond, its last three digits 0.
// - The infinity of a date, month, datetime or time arrives as an invalid
//   Date, its sign lost, so a negative one is written as a positive one.
// - A lambda arrives with its text, which an unwrapped query shows. Any
//   other function arrives as the word "func".
// - An empty table arrives with no columns, so they cannot be shown.
import { TREE_NODES, codePointOrder, realValue, type GridPayload, type TreeNode } from "./grid";
import type { Item, QValue } from "./qdecode";

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
/// A year as q writes it, in four digits: `0001.01.01` (#1235).
const pad4 = (n: number): string => String(n).padStart(4, "0");

/// A date as q writes it: `0000.00.00` outside 0001.01.01 to 9999.12.31,
/// which takes in one JavaScript's Date cannot hold (#1498).
function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  if (!(y >= 1 && y <= 9999)) {
    return "0000.00.00";
  }
  return `${pad4(y)}.${pad2(d.getUTCMonth() + 1)}.${pad2(d.getUTCDate())}`;
}

/// A datetime as q writes it: all zeros when its date is out of range.
function ymdhms(d: Date): string {
  const date = ymd(d);
  return date === "0000.00.00" ? "0000.00.00T00:00:00.000" : `${date}T${hms(d)}.${pad3(d.getUTCMilliseconds())}`;
}

function hms(d: Date): string {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/// A float as q writes it at a `\P` of `precision` significant digits (7,
/// q's default, unless given): C's `%.{P}g`, an exponent (of two digits at
/// least) from 10^P up and below 1e-4, trailing zeros dropped. `\P 0` is
/// every digit a float holds, `%.17g`, and a real (`real`) `%.8g`, as
/// KDB-X writes one: 0.3e is 0.30000001e (#1759). A subnormal is written
/// as a zero of its sign, as KDB-X writes one (#1760).
export function floatText(x: number, precision = 7, real = false): string {
  if (x === 0 || !Number.isFinite(x) || Math.abs(x) < (real ? 1.1754943508222875e-38 : 2.2250738585072014e-308)) {
    // String(-0) is "0"; q writes `-0f` (#1236).
    return Number.isFinite(x) ? (x < 0 || Object.is(x, -0) ? "-0" : "0") : String(x);
  }
  const p = precision > 0 ? Math.min(precision, 17) : real ? 8 : 17;
  const [digits, exponent] = significant(Math.abs(x), p);
  const sign = x < 0 ? "-" : "";
  const trim = (text: string): string => text.replace(/\.?0*$/, "");
  if (exponent < -4 || exponent >= p) {
    return `${sign}${trim(`${digits[0]}.${digits.slice(1)}`)}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const text = exponent < 0 ? `0.${"0".repeat(-exponent - 1)}${digits}` : `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
  return sign + trim(text);
}

/// The first `p` significant digits of `x` (positive, finite) and the power
/// of ten of the first, rounded as C's printf rounds: from the exact binary
/// value, a tie to even (#1758). JavaScript's toExponential takes a tie
/// away from zero, and is used only where no tie can be: a tie has at most
/// 18 significant digits, and a value of more than 2^±64 has more.
function significant(x: number, p: number): [string, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let m = (bits & 0xfffffffffffffn) | (biased === 0 ? 0n : 1n << 52n);
  let e = (biased === 0 ? 1 : biased) - 1075;
  while (e < 0 && (m & 1n) === 0n) {
    m >>= 1n;
    e++;
  }
  if (Math.abs(e) > 64) {
    const [mantissa, power] = x.toExponential(p - 1).split("e");
    return [mantissa.replace(".", ""), Number(power)];
  }
  // x is exactly `all` times 10^`shift`.
  const all = (e >= 0 ? m << BigInt(e) : m * 5n ** BigInt(-e)).toString();
  const shift = Math.min(e, 0);
  let exponent = all.length - 1 + shift;
  if (all.length <= p) {
    return [all.padEnd(p, "0"), exponent];
  }
  let head = BigInt(all.slice(0, p));
  const rest = all.slice(p);
  if (rest[0] > "5" || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || (head & 1n) === 1n))) {
    head++;
  }
  let digits = head.toString();
  if (digits.length > p) {
    digits = digits.slice(0, p);
    exponent++;
  }
  return [digits, exponent];
}

/// A time of day, or a span, from milliseconds or nanoseconds: `hh:mm`,
/// `hh:mm:ss` or `hh:mm:ss.mmm`, the hours past 23 when there are more and
/// `**` past 99, as KDB-X writes them (#1762).
function clock(total: number, unit: "minute" | "second" | "milli"): string {
  const sign = total < 0 ? "-" : "";
  let t = Math.abs(Math.round(total));
  const ms = unit === "milli" ? t % 1000 : 0;
  if (unit === "milli") {
    t = Math.floor(t / 1000);
  }
  const hours = (h: number): string => (h > 99 ? "**" : pad2(h));
  if (unit === "minute") {
    return `${sign}${hours(Math.floor(t / 60))}:${pad2(t % 60)}`;
  }
  const text = `${sign}${hours(Math.floor(t / 3600))}:${pad2(Math.floor(t / 60) % 60)}:${pad2(t % 60)}`;
  return unit === "milli" ? `${text}.${pad3(ms)}` : text;
}

/// Whether `x` is an infinity as the codec gives one: a number, or an
/// invalid Date for a date, month, datetime or time, whose sign it loses.
function infinite(x: unknown): boolean {
  return x === Infinity || x === -Infinity || (x instanceof Date && Number.isNaN(x.getTime()));
}

/// The months since 2000.01 of a Date the codec made of a q month. The
/// codec makes a month before 2000 that is not a January a year early
/// (1999.12m, -1, as 1998.12): it takes the year as `2000 + m/12` cut toward
/// zero and the month as `m mod 12`, negative. A month after 2000 is never
/// made a year before it, so a Date before 2000 that is not a January was
/// made that way, and is moved a year on.
function monthsOf(d: Date): number {
  const months = (d.getUTCFullYear() - 2000) * 12 + d.getUTCMonth();
  return months < 0 && d.getUTCMonth() !== 0 ? months + 12 : months;
}

/// A month of `m` months since 2000.01, as KDB-X writes it: the year as two
/// two-digit fields and the month as one, each digit `"0"` plus its value
/// in C's truncating arithmetic, and `**` for a field past two digits. So
/// a year past 9999 is `**66.09`, and before year 1, `0+00.01` (#1736).
function monthText(m: number): string {
  const x = (m + 24_000) | 0;
  const field = (n: number): string =>
    Math.abs(n) > 99 ? "**" : String.fromCharCode(48 + Math.trunc(n / 10), 48 + (n % 10));
  const y = Math.trunc(x / 12);
  return `${field(Math.trunc(y / 100))}${field(y % 100)}.${field((x % 12) + 1)}`;
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

/// A timestamp of `ns` nanoseconds since 2000.01.01, as q holds one.
function exactTimestampText(ns: bigint): string {
  const day = 86_400_000_000_000n;
  const days = ns >= 0n ? ns / day : -((-ns + day - 1n) / day);
  const d = new Date(EPOCH_MS + Number(days) * DAY_MS);
  return `${ymd(d)}D${spanText(ns - days * day).slice(2)}`;
}

/// A temporal item of type `t` (13 to 19) given as the number q holds it
/// as - months, days or float days since 2000, minutes, seconds or
/// milliseconds - which an unlimited query sends; undefined for any other
/// type.
function temporalText(x: number | bigint | LongLike, t: number): string | undefined {
  const n = Number(x.toString());
  switch (t) {
    case 13:
      return monthText(n);
    case 14:
      return ymd(new Date(EPOCH_MS + n * DAY_MS));
    case 15: {
      // KDB-X rounds the float days to the microsecond and cuts that to the
      // millisecond: 0.99999999999 is 23:59:59.999, not the next day (#1757).
      return ymdhms(new Date(EPOCH_MS + Math.floor(Math.round(n * DAY_MS * 1000) / 1000)));
    }
    case 17:
      return clock(n, "minute");
    case 18:
      return clock(n, "second");
    case 19:
      return clock(n, "milli");
  }
  return undefined;
}

/// One item of a simple list, or an atom, of q type `t` (positive), without
/// the suffix a list or an atom ends with. Undefined for a null, which the
/// caller writes.
function itemText(x: unknown, t: number, precision = 7): string | undefined {
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
      return floatText(Number(x), precision, t === 8);
    case 10:
      return String(x);
    case 11:
      return String(x);
    case 12:
      return isLong(x) || typeof x === "bigint" ? exactTimestampText(BigInt(x.toString())) : timestampText(Number(x));
    case 16:
      return spanText(BigInt(String(x)));
  }
  if (typeof x === "number" || typeof x === "bigint" || isLong(x)) {
    const n = temporalText(x, t);
    if (n !== undefined) {
      return n;
    }
  }
  if (!(x instanceof Date)) {
    return String(x);
  }
  switch (t) {
    case 13:
      return monthText(monthsOf(x));
    case 14:
      return ymd(x);
    case 15:
      return ymdhms(x);
    case 17:
      return clock(sinceEpoch(x) / 60_000, "minute");
    case 18:
      return clock(sinceEpoch(x) / 1000, "second");
    case 19:
      return clock(sinceEpoch(x), "milli");
  }
  return String(x);
}

/// How q writes a null of type `t` in a list: a float's is `0n`, a real's
/// `0N` (the list's `e` follows it: `1 0Ne`).
function nullText(t: number): string {
  return t === 9 ? "0n" : t === 2 ? NULL_GUID : t === 11 ? "" : t === 10 ? " " : "0N";
}

const SUFFIX: Record<number, string> = { 5: "h", 6: "i", 8: "e", 13: "m" };
const TEMPORAL_LETTERS: Record<number, string> = { 12: "p", 14: "d", 15: "z", 16: "n", 17: "u", 18: "v", 19: "t" };
const NAMES: Record<number, string> = {
  1: "boolean", 2: "guid", 4: "byte", 5: "short", 6: "int", 7: "long", 8: "real", 9: "float", 10: "char",
  11: "symbol", 12: "timestamp", 13: "month", 14: "date", 15: "datetime", 16: "timespan", 17: "minute",
  18: "second", 19: "time",
};

const ESCAPED: Record<number, string> = { 9: "\\t", 10: "\\n", 13: "\\r", 34: '\\"', 92: "\\\\" };

/// Chars as q writes them, in quotes: a byte that is not printable ASCII as
/// three octal digits (`"caf\303\251"`, `"\001"`), a tab, newline, carriage
/// return, quote or backslash escaped. A string is its UTF-8 bytes; a char
/// vector the codec decoded is written as the bytes q sent when they were
/// UTF-8, which is what it decoded them as.
function quoted(text: string | Uint8Array | number[]): string {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  let out = "";
  for (const c of bytes) {
    out += ESCAPED[c] ?? (c >= 32 && c < 127 ? String.fromCharCode(c) : `\\${c.toString(8).padStart(3, "0")}`);
  }
  return `"${out}"`;
}

/// The attribute a list's header holds (1 to 4) as q writes it before the
/// list: `` `s# ``.
export function attrText(attr: number | string | null | undefined): string {
  const name = typeof attr === "number" ? " supg"[attr]?.trim() : attr;
  return name ? `\`${name}#` : "";
}

/// A simple list of q type `t` (1 to 19) as q's console writes it:
/// `1 2 3i`, `101b`, `` `a`b ``, `"abc"`, `,1` for one item; with its
/// attribute, when it has one, in front: `` `s#1 2 3 ``; a float or a real
/// to `precision` digits, the process's `\P`.
export function vectorText(values: unknown, t: number, attr?: number | string | null, precision = 7): string {
  return attrText(attr) + listText(values, t, precision);
}

function listText(values: unknown, t: number, precision: number): string {
  if (t === 10) {
    // Bytes from a typed decoding or an unlimited query; a string from the
    // codec.
    const s: string | Uint8Array | number[] =
      values instanceof Uint8Array || (Array.isArray(values) && values.every((c) => typeof c === "number"))
        ? (values as Uint8Array | number[])
        : typeof values === "string" ? values : Array.isArray(values) ? values.join("") : String(values);
    const one = typeof s === "string" ? Buffer.byteLength(s, "utf8") === 1 : s.length === 1;
    return one ? `,${quoted(s)}` : quoted(s);
  }
  const items = Array.isArray(values) ? values : [values];
  if (items.length === 0) {
    return `\`${NAMES[t] ?? "list"}$()`;
  }
  const one = items.length === 1 ? "," : "";
  if (t === 11) {
    return one + items.map((s) => `\`${s ?? ""}`).join("");
  }
  const texts = items.map((x) => itemText(x, t, precision) ?? nullText(t));
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
  // A temporal list of only nulls and infinities shows no type of its
  // own, so q writes the letter: `0N 0Nd`, `,0Np` (#1491).
  if (TEMPORAL_LETTERS[t] && texts.every((s) => /^-?0[NWw]$/.test(s))) {
    suffix = TEMPORAL_LETTERS[t];
  }
  return `${one}${texts.join(" ")}${suffix}`;
}

/// An atom of q type `t` (-1 to -19) as q's console writes it.
export function atomText(x: unknown, t: number, precision = 7): string {
  const p = -t;
  if (p === 10) {
    return quoted(x === null ? " " : typeof x === "number" ? [x] : String(x));
  }
  if (p === 11) {
    return `\`${x ?? ""}`;
  }
  const text = itemText(x, p, precision);
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
    // An int is a number too, and is written whole.
    return Number.isInteger(x) ? String(x) : floatText(x);
  }
  if (typeof x === "string") {
    return x;
  }
  if (isLong(x)) {
    return x.toString();
  }
  if (x instanceof Date) {
    return x.getTime() % DAY_MS === 0 ? ymd(x) : ymdhms(x);
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
  // A loop, not `Math.max(...)`: a large table has more rows than a call
  // takes arguments.
  const widths = names.map((n, i) => cells[i].reduce((w, c) => Math.max(w, c.length), n.length));
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
    const width = entries.reduce((w, [k]) => Math.max(w, k.length), 0);
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

/// A cell's or a tree node's text, cut past 200 characters - by code point,
/// never inside a surrogate pair (#1807), as inlineresult cuts (#1428).
function cutCell(text: string): string {
  const chars = text.length > 200 ? Array.from(text) : [];
  return chars.length > 200 ? `${chars.slice(0, 197).join("")}...` : text;
}

/// A value decoded with its types on one line, as q's `-3!` writes it:
/// `` `a`b!1 2 ``, `(1;`a)`, `,1 2`.
export function oneLine(q: QValue, precision = 7): string {
  switch (q.kind) {
    case "atom":
      return atomText(q.v, q.t, precision);
    case "vector":
      return vectorText(q.v, q.t, q.attr, precision);
    case "chars":
      return vectorText(q.v, 10, q.attr);
    case "list":
      return q.v.length === 1 ? `,${oneLine(q.v[0], precision)}` : `(${q.v.map((x) => oneLine(x, precision)).join(";")})`;
    case "dict": {
      // A key of one item, a table or a dictionary is put in parentheses.
      const k = oneLine(q.k, precision);
      const one = (q.k.kind === "list" || q.k.kind === "vector") && q.k.v.length === 1;
      return `${attrText(q.sorted ? 1 : 0)}${one || q.k.kind === "table" || q.k.kind === "dict" ? `(${k})` : k}!${oneLine(q.v, precision)}`;
    }
    case "table":
      return `+${oneLine({ kind: "dict", sorted: false, k: { kind: "vector", t: 11, attr: 0, v: q.cols }, v: { kind: "list", attr: 0, v: q.data } }, precision)}`;
    case "func":
      return q.text ?? (q.t === 101 ? "::" : "func");
  }
}

/// How many items a decoded list has; 1 for anything else.
function countOf(q: QValue): number {
  return q.kind === "vector" || q.kind === "list" || q.kind === "chars" ? q.v.length : q.kind === "table" ? (q.data[0] ? countOf(q.data[0]) : 0) : 1;
}

/// Rows of cells laid out as q's `.Q.tab` lays them: each cell padded to its
/// place's widest, joined by spaces.
function tabulate(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join(" "));
}

/// `y` with a blank and a dashed line in front when it has fewer lines than
/// `n`, as q's `.Q.t0` lines up a dictionary's keys with a table's values.
function lineUp(n: number, y: string[]): string[] {
  return n > y.length && y.length > 0 ? [" ".repeat(y[0].length), "-".repeat(y[0].length), ...y] : y;
}

/// The lines of a value inside the console's text, as q's `.Q.s2` writes
/// them: a simple list's items as `string` writes them (no suffixes, nulls
/// blank); a general list's with `-3!`, or as rows lined up when every item
/// is a list of the same count; a table's names, a rule and its rows; a
/// dictionary's keys and values with `| ` between.
function nested(q: QValue, precision = 7): string[] {
  switch (q.kind) {
    case "atom":
    case "func":
      return [oneLine(q, precision)];
    case "vector":
      return q.v.map((x) => (q.t === 11 ? (x === null ? "" : String(x)) : (itemText(x, q.t, precision) ?? (q.t === 2 ? NULL_GUID : ""))));
    case "chars":
      return [...q.v].map((c) => String.fromCharCode(c));
    case "dict": {
      const d = nested(q.v, precision);
      const k = lineUp(d.length, nested(q.k, precision));
      const v = lineUp(k.length, d);
      const width = k.reduce((w, line) => Math.max(w, line.length), 0);
      return k.map((line, i) => `${line.padEnd(width)}| ${v[i] ?? ""}`);
    }
    case "table": {
      const columns = q.data.map((c) => nested(c, precision));
      const rows = Array.from({ length: columns[0]?.length ?? 0 }, (_, r) => columns.map((c) => c[r] ?? ""));
      // The rule is as wide as the padded names; no line keeps the spaces
      // that pad its last column.
      const [header, ...body] = tabulate([q.cols, ...rows]);
      return [header.trimEnd(), "-".repeat(header.length), ...body.map((line) => line.trimEnd())];
    }
    case "list": {
      const items = q.v;
      if (items.length === 0) {
        return [];
      }
      const types = new Set(items.map((x) => (x.kind === "vector" ? x.t : x.kind === "chars" ? 10 : x.kind === "list" ? 0 : -1)));
      const atomic = items.some((x) => x.kind === "atom" || x.kind === "func" || x.kind === "dict" || x.kind === "table");
      const counts = new Set(items.map(countOf));
      const same = types.size === 1 && [1, 4, 10].includes([...types][0]);
      if (atomic || counts.size > 1 || same) {
        return items.map((x) => oneLine(x, precision));
      }
      return tabulate(items.map((x) => nested(x, precision))).map((line) => line.trimEnd());
    }
  }
}

/// The lines q's console would show for a value decoded with its types
/// (`qdecode.ts`), as `.Q.S` writes them: from the numbers q holds, so a
/// timestamp keeps its nanoseconds and a negative infinity its sign, and
/// with each item's own type, so a symbol is told from a string, and a
/// table keeps its columns when it has no rows. A lambda is its text; any
/// other function is left to `formatValue`, which writes the codec's
/// `value` of it, of q type `type`.
export function formatQ(q: QValue, value: unknown, type?: number, precision = 7): string[] {
  if (q.kind === "atom" || q.kind === "vector" || q.kind === "chars") {
    return [oneLine(q, precision)];
  }
  if (q.kind === "func") {
    // A lambda arrives with its text; any other function as no more than
    // its kind.
    return q.text !== undefined ? q.text.split("\n") : formatValue(value, type);
  }
  return nested(q, precision);
}

/// The lines q's console of `size` (height, width) shows for a value
/// decoded with its types, cut as `.Q.S` cuts them: a table, keyed or not,
/// or a dictionary, or a list, to the rows that fit - so its columns are as
/// wide as the rows shown, not as rows cut off - then `..`, and each line
/// at the width. `value` and `type` are as `formatQ` takes them.
export function consoleLines(q: QValue, size: [number, number], value?: unknown, type?: number, precision = 7): string[] {
  const [height, width] = size;
  let shown = q;
  let more = false;
  if (q.kind === "table" || q.kind === "dict" || q.kind === "list") {
    // A table's two header lines count against the height, and a
    // dictionary's when a table is lined up on either side of it: the
    // console shows 10 lines of `` (`s0`s1..)!([]x:...) `` at `\c 10 80`,
    // though `.Q.S` writes 12 (#1497).
    const tabular = q.kind === "table" || (q.kind === "dict" && (q.k.kind === "table" || q.v.kind === "table"));
    const n = Math.max(0, height - (tabular ? 2 : 0));
    const count = q.kind === "dict" ? countOf(q.k) : countOf(q);
    more = count > n;
    if (more) {
      // At a height of 1 or 2, n - 1 is -1, which slice reads as "all but one" (#1405).
      const m = Math.max(0, n - 1);
      shown = q.kind === "dict" ? { ...q, k: firstOf(q.k, m), v: firstOf(q.v, m) } : firstOf(q, m);
    }
  }
  const lines = formatQ(shown, value, type, precision);
  return cutLines(more ? [...lines, ".."] : lines, [Infinity, width]);
}

/// `lines` cut to a console of `size` (height, width) as `.Q.S` cuts: a
/// line longer than the width ends in `..`, and past the height the rest is
/// one `..` line.
export function cutLines(lines: string[], size: [number, number]): string[] {
  const [height, width] = size;
  // A cut inside an astral character drops its first half too (#1761).
  const head = (l: string, n: number): string => (/[\ud800-\udbff]/.test(l[n - 1] ?? "") ? l.slice(0, n - 1) : l.slice(0, n));
  const cut = lines.map((l) => (l.length > width ? `${head(l, Math.max(0, width - 2))}..` : l));
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
        return monthsOf(x);
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

/// Each row's place when `values` is sorted ascending, nulls first, equal
/// values sharing one place as `denseRanks` gives them (#1406); empty when
/// the values cannot be compared.
function ranks(values: unknown[], raw: (number | null)[] | undefined): number[] {
  const keys: (number | string)[] = raw
    ? raw.map((x) => (x === null ? -Infinity : x))
    : values.map((x) => (x === null || x === undefined ? "" : typeof x === "boolean" ? Number(x) : cellText(x)));
  const compare = (a: number, b: number): number => {
    const x = keys[a];
    const y = keys[b];
    if (typeof x === "number" && typeof y === "number") {
      return x === y ? 0 : x < y ? -1 : 1;
    }
    // In code point order, as q sorts text (#1747).
    return codePointOrder(String(x), String(y));
  };
  const order = keys.map((_, i) => i).sort((a, b) => compare(a, b) || a - b);
  const rank = new Array<number>(keys.length);
  let place = -1;
  order.forEach((row, i) => {
    if (i === 0 || compare(order[i - 1], row) !== 0) {
      place++;
    }
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

/// A column of a value decoded with its types, as a grid holds it.
interface TypedColumn {
  name: string;
  q: QValue;
}

/// The q type a decoded column has: a simple list's, 0 for any other.
function columnTypeOf(q: QValue): number {
  return q.kind === "vector" ? q.t : q.kind === "chars" ? 10 : q.kind === "table" ? 98 : q.kind === "dict" ? 99 : 0;
}

/// The first `n` items of a decoded list.
function firstOf(q: QValue, n: number): QValue {
  if (q.kind === "vector" || q.kind === "list") {
    return { ...q, v: q.v.slice(0, n) } as QValue;
  }
  if (q.kind === "chars") {
    return { ...q, v: q.v.subarray(0, n) };
  }
  if (q.kind === "table") {
    return { ...q, data: q.data.map((c) => firstOf(c, n)) };
  }
  return q;
}

/// The items of a decoded list as values: a table's rows, a list's items.
function itemsOf(q: QValue): QValue[] {
  if (q.kind === "vector") {
    return q.v.map((v) => ({ kind: "atom", t: -q.t, v }));
  }
  if (q.kind === "chars") {
    return [...q.v].map((v) => ({ kind: "atom", t: -10, v }));
  }
  if (q.kind === "list") {
    return q.v;
  }
  if (q.kind === "table") {
    return Array.from({ length: countOf(q) }, (_, r) => ({
      kind: "dict",
      sorted: false,
      k: { kind: "vector", t: 11, attr: 0, v: q.cols },
      v: { kind: "list", attr: 0, v: q.data.map((c) => itemsOf(c)[r]) },
    }));
  }
  return [q];
}

/// Each row's place among the distinct values of a simple column sorted
/// ascending, nulls first, as `GRID` ranks one: equal values share a place,
/// so a sort either way keeps them in their order.
function denseRanks(keys: (number | bigint | string | null)[]): number[] {
  const order = keys.map((_, i) => i).sort((a, b) => {
    const x = keys[a];
    const y = keys[b];
    // A null is below every value, -0w and -0W among them; text in code
    // point order, as q sorts it (#1747).
    return x === y ? a - b : x === null ? -1 : y === null ? 1 : typeof x === "string" && typeof y === "string" ? codePointOrder(x, y) : x < y ? -1 : 1;
  });
  const rank = new Array<number>(keys.length);
  let place = -1;
  order.forEach((row, i) => {
    if (i === 0 || keys[row] !== keys[order[i - 1]]) {
      place++;
    }
    rank[row] = place;
  });
  return rank;
}

/// Two items of one simple type in q's order: a null first, text in code
/// point order.
function itemOrder(x: Item, y: Item): number {
  if (x === y) {
    return 0;
  }
  if (x === null || y === null) {
    return x === null ? -1 : 1;
  }
  if (typeof x === "string" && typeof y === "string") {
    return codePointOrder(x, y);
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

/// Two values in the order q's `iasc` sorts a general list (#1756): every
/// atom before every list, atoms by type (`1b` before `0x01` before `2`
/// before `2.5`) and then value, lists by type and then item by item, a
/// shorter one first when it is the other's start; a dictionary and a table
/// by their values alone. A function is equal to any other.
function qOrder(a: QValue, b: QValue): number {
  const typeOf = (q: QValue): number => (q.kind === "atom" ? q.t - 1000 : q.kind === "func" ? q.t : columnTypeOf(q));
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) {
    return a.kind === "atom" && b.kind === "atom" ? tb - ta : ta - tb;
  }
  if (a.kind === "atom" && b.kind === "atom") {
    return itemOrder(a.v, b.v);
  }
  if (a.kind === "dict" && b.kind === "dict") {
    return qOrder(a.v, b.v);
  }
  if (a.kind === "func" || b.kind === "func" || a.kind === "dict" || b.kind === "dict") {
    return 0;
  }
  const xs = a.kind === "table" ? a.data : itemsOf(a);
  const ys = b.kind === "table" ? b.data : itemsOf(b);
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const order = qOrder(xs[i], ys[i]);
    if (order !== 0) {
      return order;
    }
  }
  return xs.length - ys.length;
}

/// Whether two values are the same to q's `~`, given they are equal in
/// `qOrder`: a dictionary's keys, a table's names and a lambda's text too.
function same(a: QValue, b: QValue): boolean {
  if (a.kind === "dict" && b.kind === "dict") {
    return same(a.k, b.k) && same(a.v, b.v);
  }
  if (a.kind === "table" && b.kind === "table") {
    return a.cols.join("\u0000") === b.cols.join("\u0000") && a.data.every((c, i) => same(c, b.data[i]));
  }
  if (a.kind === "func" && b.kind === "func") {
    return a.text !== undefined && a.text === b.text;
  }
  if (a.kind === "list" && b.kind === "list") {
    return a.v.every((x, i) => same(x, b.v[i]));
  }
  return qOrder(a, b) === 0;
}

/// The ranks `GRID` gives a general column: its items sorted as `iasc`
/// sorts them, a new place wherever one `differ`s from the one before. The
/// first is held to its type's null, as `differ` holds it, so a first null
/// or empty item, or a general list of them, ranks -1. None for a symbol and a long, which `iasc`
/// refuses with `type`, as an enumeration's parts.
function listRanks(items: QValue[]): number[] {
  const [x, y] = items;
  if (items.length === 2 && x.kind === "atom" && x.t === -11 && y.kind === "atom" && y.t === -7) {
    return [];
  }
  const order = items.map((_, i) => i).sort((a, b) => qOrder(items[a], items[b]) || a - b);
  const rank = new Array<number>(items.length);
  const empty = (q: QValue): boolean =>
    q.kind === "atom"
      ? q.v === null || q.v === false || q.v === "" || (q.v === 0 && q.t === -4) || (q.v === 32 && q.t === -10)
      : q.kind === "list"
        ? q.v.every(empty)
        : countOf(q) === 0;
  let place = -1;
  order.forEach((row, i) => {
    if (i === 0 ? !empty(items[row]) : qOrder(items[order[i - 1]], items[row]) !== 0 || !same(items[order[i - 1]], items[row])) {
      place++;
    }
    rank[row] = place;
  });
  return rank;
}

/// The rows the result panel shows for a value decoded with its types, as
/// `GRID` would send them for the same value: a table (keyed: its keys
/// marked), a dictionary as `key` and `value` columns (keyed by a table, its
/// key columns and `value`), or a list other than a string as one `value`
/// column; at most `limit` rows. Undefined for anything else.
export function gridOfQ(q: QValue, limit: number, precision = 7): GridPayload | undefined {
  let columns: TypedColumn[];
  let keys = 0;
  const tableColumns = (t: QValue & { kind: "table" }): TypedColumn[] => t.cols.map((name, i) => ({ name, q: t.data[i] }));
  if (q.kind === "table") {
    columns = tableColumns(q);
  } else if (q.kind === "dict" && q.k.kind === "table") {
    keys = q.k.cols.length;
    columns = [...tableColumns(q.k), ...(q.v.kind === "table" ? tableColumns(q.v) : [{ name: "value", q: q.v }])];
  } else if (q.kind === "dict") {
    keys = 1;
    columns = [
      { name: "key", q: q.k },
      { name: "value", q: q.v },
    ];
  } else if (q.kind === "vector" || q.kind === "list") {
    columns = [{ name: "value", q }];
  } else {
    return undefined;
  }
  const count = columns.length > 0 ? countOf(columns[0].q) : 0;
  const shown = columns.map((c) => ({ ...c, q: firstOf(c.q, limit) }));
  const types = shown.map((c) => columnTypeOf(c.q));
  const cells = shown.map((c) =>
    c.q.kind === "vector" || c.q.kind === "chars"
      ? nested(c.q, precision)
      : itemsOf(c.q).map((x) => {
          return cutCell(oneLine(x, precision));
        }),
  );
  // The numbers of a numeric, temporal or guid column, as `GRID` sends them.
  // A long, timestamp or timespan past 2^53 keeps its digits as a string,
  // as `GRID`'s Long does: Number() would round it (#1398).
  // A char column's bytes, and a general column's float and real items
  // (`false` for any other), as `GRID` sends them (#1489, #1485), and an
  // item with floats or reals inside as `exactOf` (#1502).
  const raw = shown.map((c, i): unknown[] =>
    c.q.kind === "chars"
      ? [...c.q.v]
      : c.q.kind === "list"
        ? c.q.v.map((x) => (x.kind === "atom" && (x.t === -9 || x.t === -8) ? (typeof x.v === "number" && !Number.isNaN(x.v) ? x.v : false) : exactOf(x)))
        : c.q.kind === "vector" && [2, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19].includes(types[i])
      ? c.q.v.map((x) => (typeof x === "bigint" ? (Number.isSafeInteger(Number(x)) ? Number(x) : x.toString()) : types[i] === 8 ? realValue(x) : x))
      : [],
  );
  const rank = shown.map((c) => {
    if (c.q.kind === "chars") {
      return denseRanks([...c.q.v]);
    }
    if (c.q.kind === "list") {
      return listRanks(c.q.v);
    }
    // A table column, a dictionary's value, by its rows as `iasc` sorts them (#2073).
    if (c.q.kind === "table") {
      return listRanks(itemsOf(c.q));
    }
    if (c.q.kind !== "vector") {
      return [];
    }
    return denseRanks(
      // A long or a timestamp is ranked as the bigint it is: Number() would
      // make neighbouring ones equal.
      c.q.v.map((x) => (x === null ? (c.q.kind === "vector" && [2, 11].includes(c.q.t) ? "" : null) : typeof x === "boolean" ? Number(x) : x)),
    );
  });
  const tree = q.kind === "list" || (q.kind === "dict" && q.k.kind !== "table") ? treeOfQ(q, TREE_NODES, "", precision) : undefined;
  return { count, keys, names: shown.map((c) => c.name), types, cells, raw, rank, ...(tree !== undefined ? { tree } : {}) };
}

/// A general list's item with floats or reals inside as `GRID` sends it,
/// for `exactLiteral`: `("f";x)`, `("e";x)`, `("F";v)` or `("E";v)` for a
/// float, a real or a list of them, `("l";v)` for a general list, each
/// item its own or, holding none, its text, `("d";(k;v))` for a dictionary
/// and `("t";d)` for a table. At most 200 items a list, as
/// a cell is cut at 200 characters; `false` for anything else.
function exactOf(q: QValue): unknown[] | false {
  if (q.kind === "atom" && (q.t === -9 || q.t === -8)) {
    return [q.t === -9 ? "f" : "e", q.v];
  }
  if (q.kind === "vector" && (q.t === 9 || q.t === 8) && q.v.length <= 200) {
    return [q.t === 9 ? "F" : "E", q.v];
  }
  if (q.kind === "list" && q.v.length <= 200) {
    const items = q.v.map(exactOf);
    return items.every((x) => x === false) ? false : ["l", items.map((x, i) => (x === false ? oneLine(q.v[i]) : x))];
  }
  // A dictionary as ("d";(keys;values)), a table as ("t";its dictionary):
  // -3! would write their floats to \P (#1746).
  if (q.kind === "dict") {
    const pair = exactOf({ kind: "list", attr: 0, v: [q.k, q.v] });
    return pair === false ? false : ["d", pair[1]];
  }
  if (q.kind === "table") {
    const dict = exactOf({ kind: "dict", sorted: false, k: { kind: "vector", t: 11, attr: 0, v: q.cols }, v: { kind: "list", attr: 0, v: q.data } });
    return dict === false ? false : ["t", dict];
  }
  return false;
}

/// A value decoded with its types as the tree `GRID` sends for it: a
/// dictionary's entries and a list's items as children, at most `budget`
/// nodes, each node's share divided among its children as `GRID` divides it.
export function treeOfQ(q: QValue, budget = TREE_NODES, key = "", precision = 7): TreeNode {
  const dict = q.kind === "dict" && q.k.kind !== "table";
  const open = dict || q.kind === "list" || q.kind === "vector";
  const count = q.kind === "dict" ? countOf(q.k) : countOf(q);
  const shown = open ? Math.min(count, Math.max(0, budget - 1)) : 0;
  const share = shown > 0 ? Math.floor((budget - 1) / shown) : 0;
  const type = q.kind === "list" ? 0 : q.kind === "chars" ? 10 : q.kind === "table" ? 98 : q.kind === "dict" ? 99 : q.t;
  const text = open || q.kind === "table" || q.kind === "dict" ? "" : cutCell(oneLine(q, precision));
  let children: TreeNode[] = [];
  if (shown > 0) {
    const items = itemsOf(firstOf(q.kind === "dict" ? q.v : q, shown));
    const keys =
      q.kind === "dict"
        ? itemsOf(firstOf(q.k, shown)).map((k) => (k.kind === "atom" && k.t === -11 ? String(k.v ?? "") : cutCell(oneLine(k, precision))))
        : items.map((_, i) => String(i));
    children = items.slice(0, shown).map((item, i) => treeOfQ(item, share, keys[i], precision));
  }
  return { key, text, type, count, children };
}
