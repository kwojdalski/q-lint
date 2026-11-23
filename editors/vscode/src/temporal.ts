// q's temporal values read from their literals and converted (#969): a
// timestamp to the long under it, to Unix time and to ISO 8601, a long or a
// Unix epoch number to a timestamp, and so on. Free of any `vscode` import,
// so node tests it; `temporalview.ts` shows the conversions on hover and
// replaces a selection with one.
//
// Every value is held as the integer q holds - nanoseconds since 2000.01.01
// for a timestamp, days for a date, milliseconds for a time - as a BigInt,
// so nothing is rounded through a double: a conversion and its inverse give
// back the value they started from. A null and an infinity are the type's
// own (`0Np`, `-0Wd`) and convert to the other type's as q's casts do. A
// datetime is a float of days in q; only its literal with at most three
// decimals is read, which is milliseconds exactly.

/// Convert Temporal Value (`temporalview.ts`).
export const CONVERT_TEMPORAL = "q-lint.convertTemporal";

export type TemporalType = "timestamp" | "month" | "date" | "datetime" | "timespan" | "minute" | "second" | "time";

/// A value as q holds it: `n` in the type's unit, or a null or infinity.
export interface Temporal {
  type: TemporalType;
  special?: "null" | "inf" | "-inf";
  /// Nanoseconds since 2000.01.01 (timestamp), months since 2000.01, days
  /// since 2000.01.01, milliseconds since 2000.01.01 (datetime), nanoseconds
  /// (timespan), minutes, seconds, milliseconds (time). 0 when special.
  n: bigint;
}

/// One conversion: what it is, and the text it gives.
export interface Conversion {
  label: string;
  text: string;
}

const NS_PER_DAY = 86_400_000_000_000n;
const MS_PER_DAY = 86_400_000n;
/// 2000.01.01 in Unix days, seconds and nanoseconds.
const UNIX_DAYS_2000 = 10_957;
const UNIX_NS_2000 = 946_684_800_000_000_000n;
const LONG_MAX = 9_223_372_036_854_775_807n;
const LONG_NULL = -9_223_372_036_854_775_808n;
const INT_MAX = 2_147_483_647n;

/// The letter of each type in its null and infinity, `0Np`, `0Wd`.
const LETTER: Record<TemporalType, string> = {
  timestamp: "p", month: "m", date: "d", datetime: "z", timespan: "n", minute: "u", second: "v", time: "t",
};
/// The types held in a long; the rest in an int (datetime: a float).
const WIDE: ReadonlySet<TemporalType> = new Set(["timestamp", "timespan"]);

const pad = (n: bigint | number, width = 2): string => String(n).padStart(width, "0");

/// Floor division and its remainder, for a value before 2000.
function floorDiv(a: bigint, b: bigint): [bigint, bigint] {
  let q = a / b;
  let r = a % b;
  if (r < 0n) {
    q -= 1n;
    r += b;
  }
  return [q, r];
}

/// Year, month and day of `days` since 2000.01.01 (proleptic Gregorian).
export function civil(days: number): [number, number, number] {
  // Howard Hinnant's days_from_civil, inverted, counted from 1970.
  const z = days + UNIX_DAYS_2000 + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/// Days since 2000.01.01 of a calendar date, or undefined when there is no
/// such day.
export function daysFrom(y: number, m: number, d: number): number | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return undefined;
  }
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146_097 + doe - 719_468 - UNIX_DAYS_2000;
  const [cy, cm, cd] = civil(days);
  return cy === y && cm === m && cd === d ? days : undefined;
}

/// The date q writes for `days`.
function dateText(days: number): string {
  const [y, m, d] = civil(days);
  return `${pad(y, 4)}.${pad(m)}.${pad(d)}`;
}

/// hh:mm:ss and a fraction of `digits` from a count of `unit` per second.
function clock(total: bigint, perSecond: bigint, digits: number): string {
  const [s, frac] = [total / perSecond, total % perSecond];
  const out = `${pad(s / 3600n)}:${pad((s / 60n) % 60n)}:${pad(s % 60n)}`;
  return digits === 0 ? out : `${out}.${pad(frac, digits)}`;
}

/// Whether `t` is a value q can write as a literal of its type.
function representable(t: Temporal): boolean {
  if (t.special !== undefined) {
    return true;
  }
  const max = WIDE.has(t.type) ? LONG_MAX : INT_MAX;
  if (t.type !== "datetime" && (t.n > max || t.n < -max)) {
    return false;
  }
  switch (t.type) {
    case "date":
      return civil(Number(t.n))[0] >= 1 && civil(Number(t.n))[0] <= 9999;
    case "month":
      return 2000n + floorDiv(t.n, 12n)[0] >= 1n && 2000n + floorDiv(t.n, 12n)[0] <= 9999n;
    // A float of days holds a millisecond exactly only so far from 2000:
    // q writes 4348.01.05T07:37:35.275 as .274.
    case "datetime": {
      const days = Number(floorDiv(t.n, MS_PER_DAY)[0]);
      return days >= LITERAL_DAYS[0] && days < LITERAL_DAYS[1];
    }
    // q writes ** past 99 hours.
    case "time":
      return t.n > -360_000_000n && t.n < 360_000_000n;
    case "second":
      return t.n > -360_000n && t.n < 360_000n;
    case "minute":
      return t.n > -6000n && t.n < 6000n;
    default:
      return true;
  }
}

/// `t` as q writes it, `-3!`: a literal that reads back as `t`. Undefined
/// when q cannot write it (a date past 9999, a time past 99 hours).
export function format(t: Temporal): string | undefined {
  if (!representable(t)) {
    return undefined;
  }
  if (t.special !== undefined) {
    const w = t.type === "datetime" ? "w" : "W";
    return t.special === "null" ? `0N${LETTER[t.type]}` : `${t.special === "-inf" ? "-" : ""}0${w}${LETTER[t.type]}`;
  }
  const sign = t.n < 0n ? "-" : "";
  const abs = t.n < 0n ? -t.n : t.n;
  switch (t.type) {
    case "timestamp": {
      const [days, rem] = floorDiv(t.n, NS_PER_DAY);
      return `${dateText(Number(days))}D${clock(rem, 1_000_000_000n, 9)}`;
    }
    case "date":
      return dateText(Number(t.n));
    case "month": {
      const [y, m] = floorDiv(t.n, 12n);
      return `${pad(2000n + y, 4)}.${pad(m + 1n)}m`;
    }
    case "datetime": {
      const [days, rem] = floorDiv(t.n, MS_PER_DAY);
      return `${dateText(Number(days))}T${clock(rem, 1000n, 3)}`;
    }
    case "timespan":
      return `${sign}${abs / NS_PER_DAY}D${clock(abs % NS_PER_DAY, 1_000_000_000n, 9)}`;
    case "time":
      return `${sign}${clock(abs, 1000n, 3)}`;
    case "second":
      return `${sign}${clock(abs, 1n, 0)}`;
    case "minute":
      return `${sign}${pad(abs / 60n)}:${pad(abs % 60n)}`;
  }
}

/// The days of 1709.01.01 and 2291.01.01: KDB-X reads a timestamp literal
/// only between them, though it writes ones outside.
const LITERAL_DAYS = [daysFrom(1709, 1, 1) as number, daysFrom(2291, 1, 1) as number];

/// A timestamp as text q reads back: its literal, or `"p"$` of its long
/// where KDB-X would not read the literal.
export function timestampText(t: Temporal): string | undefined {
  if (t.special === undefined && t.type === "timestamp") {
    const days = Number(floorDiv(t.n, NS_PER_DAY)[0]);
    if (days < LITERAL_DAYS[0] || days >= LITERAL_DAYS[1]) {
      return `"p"$${t.n}`;
    }
  }
  return format(t);
}

/// A fraction's digits as a count of `digits` places: "5" of 9 is 500000000.
const fraction = (f: string | undefined, digits: number): bigint => BigInt((f ?? "").padEnd(digits, "0") || "0");

/// hh, mm, ss as one count, or undefined when a minute or second is 60 or more.
function hms(h: string | undefined, m: string | undefined, s: string | undefined): bigint | undefined {
  if (Number(m ?? 0) > 59 || Number(s ?? 0) > 59) {
    return undefined;
  }
  return BigInt(h ?? 0) * 3600n + BigInt(m ?? 0) * 60n + BigInt(s ?? 0);
}

/// A q temporal literal read, or undefined when `text` is not one: a
/// timestamp, month, date, datetime, timespan, minute, second or time, or
/// one of their nulls and infinities.
export function parse(text: string): Temporal | undefined {
  const special = /^(-?)0([NWw])([pmdznuvt])$/.exec(text);
  if (special !== null) {
    const type = (Object.keys(LETTER) as TemporalType[]).find((k) => LETTER[k] === special[3]) as TemporalType;
    // q writes a datetime's infinity 0wz, every other 0W; a null has no sign.
    const w = type === "datetime" ? "w" : "W";
    if (special[2] === "N") {
      return special[1] === "" ? { type, special: "null", n: 0n } : undefined;
    }
    return special[2] === w ? { type, special: special[1] === "-" ? "-inf" : "inf", n: 0n } : undefined;
  }
  const day = (y: string, m: string, d: string) => daysFrom(Number(y), Number(m), Number(d));
  let m = /^(\d{4})\.(\d{2})\.(\d{2})D(?:(\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?)?$/.exec(text);
  if (m !== null) {
    const days = day(m[1], m[2], m[3]);
    const secs = hms(m[4], m[5], m[6]);
    if (days === undefined || secs === undefined || Number(m[4] ?? 0) > 23) {
      return undefined;
    }
    const n = BigInt(days) * NS_PER_DAY + secs * 1_000_000_000n + fraction(m[7], 9);
    // Written out in full, 0Wp and -0Wp are still the infinities (#1069).
    return n >= -LONG_MAX && n <= LONG_MAX ? timestampOfLong(n) : undefined;
  }
  m = /^(\d{4})\.(\d{2})\.(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
  if (m !== null) {
    const days = day(m[1], m[2], m[3]);
    const secs = hms(m[4], m[5], m[6]);
    if (days === undefined || secs === undefined || Number(m[4]) > 23) {
      return undefined;
    }
    return { type: "datetime", n: BigInt(days) * MS_PER_DAY + secs * 1000n + fraction(m[7], 3) };
  }
  m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(text);
  if (m !== null) {
    const days = day(m[1], m[2], m[3]);
    return days === undefined ? undefined : { type: "date", n: BigInt(days) };
  }
  m = /^(\d{4})\.(\d{2})m$/.exec(text);
  if (m !== null) {
    const month = Number(m[2]);
    return month < 1 || month > 12 ? undefined : { type: "month", n: (BigInt(m[1]) - 2000n) * 12n + BigInt(month - 1) };
  }
  m = /^(-?)(\d+)D(?:(\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?)?$/.exec(text);
  if (m !== null) {
    const secs = hms(m[3], m[4], m[5]);
    if (secs === undefined || Number(m[3] ?? 0) > 23) {
      return undefined;
    }
    const abs = BigInt(m[2]) * NS_PER_DAY + secs * 1_000_000_000n + fraction(m[6], 9);
    return abs < LONG_MAX ? { type: "timespan", n: m[1] === "-" ? -abs : abs } : undefined;
  }
  m = /^(-?)(\d{2}):(\d{2})(?::(\d{2})(\.(\d{1,3}))?)?$/.exec(text);
  if (m !== null) {
    const secs = hms(m[2], m[3], m[4]);
    if (secs === undefined) {
      return undefined;
    }
    const neg = m[1] === "-";
    if (m[5] !== undefined) {
      const ms = secs * 1000n + fraction(m[6], 3);
      return { type: "time", n: neg ? -ms : ms };
    }
    if (m[4] !== undefined) {
      return { type: "second", n: neg ? -secs : secs };
    }
    const mins = secs / 60n;
    return { type: "minute", n: neg ? -mins : mins };
  }
  return undefined;
}

/// `n` over 10^`places`, written exactly: 1704164645123 over 3 is
/// "1704164645.123", and trailing zeros are dropped.
export function decimal(n: bigint, places: number): string {
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const unit = 10n ** BigInt(places);
  const frac = places === 0 ? "" : pad(abs % unit, places).replace(/0+$/, "");
  return `${sign}${abs / unit}${frac === "" ? "" : `.${frac}`}`;
}

/// A decimal's value times 10^`places`, or undefined when it has more
/// decimals than that: nothing is rounded.
export function scaled(text: string, places: number): bigint | undefined {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null || (m[3]?.length ?? 0) > places) {
    return undefined;
  }
  const abs = BigInt(m[2]) * 10n ** BigInt(places) + fraction(m[3], places);
  return m[1] === "-" ? -abs : abs;
}

/// A timestamp of `ns` since 2000, or the special value a long is.
export function timestampOfLong(n: bigint): Temporal {
  if (n === LONG_NULL) {
    return { type: "timestamp", special: "null", n: 0n };
  }
  if (n === LONG_MAX || n === -LONG_MAX) {
    return { type: "timestamp", special: n > 0n ? "inf" : "-inf", n: 0n };
  }
  return { type: "timestamp", n };
}

/// The units a Unix epoch number may be in, with nanoseconds in one.
export const UNIX_UNITS = [
  { name: "seconds", places: 9 },
  { name: "milliseconds", places: 6 },
  { name: "microseconds", places: 3 },
  { name: "nanoseconds", places: 0 },
] as const;
export type UnixUnit = (typeof UNIX_UNITS)[number]["name"];

/// The Unix unit a number of this many integer digits most likely counts:
/// 10 for seconds this century, 13 for milliseconds, and so on.
export function likelyUnit(digits: number): UnixUnit | undefined {
  return digits >= 9 && digits <= 10 ? "seconds" : digits >= 12 && digits <= 13 ? "milliseconds" : digits >= 15 && digits <= 16 ? "microseconds" : digits >= 18 && digits <= 19 ? "nanoseconds" : undefined;
}

/// A Unix epoch number in `unit` as a timestamp, or undefined when it has
/// finer digits than a nanosecond or falls outside a timestamp's range.
export function fromUnix(text: string, unit: UnixUnit): Temporal | undefined {
  const places = UNIX_UNITS.find((u) => u.name === unit)?.places ?? 0;
  // `places` decimals of the unit are a nanosecond: scaled by them, the
  // number is in nanoseconds.
  const unixNs = scaled(text, places);
  if (unixNs === undefined) {
    return undefined;
  }
  const ns = unixNs - UNIX_NS_2000;
  return ns > -LONG_MAX && ns < LONG_MAX ? { type: "timestamp", n: ns } : undefined;
}

/// Nanoseconds since 2000 of a timestamp, date or datetime, at its start.
function nanos(t: Temporal): bigint | undefined {
  if (t.special !== undefined) {
    return undefined;
  }
  switch (t.type) {
    case "timestamp":
      return t.n;
    case "date":
      return t.n * NS_PER_DAY;
    case "datetime":
      return t.n * 1_000_000n;
    case "month": {
      const [y, m] = floorDiv(t.n, 12n);
      const days = daysFrom(2000 + Number(y), Number(m) + 1, 1);
      return days === undefined ? undefined : BigInt(days) * NS_PER_DAY;
    }
    default:
      return undefined;
  }
}

/// ISO 8601 in UTC of nanoseconds since 2000, its fraction to the last digit
/// that is not zero.
function iso(ns: bigint): string {
  const [days, rem] = floorDiv(ns, NS_PER_DAY);
  const [y, m, d] = civil(Number(days));
  const frac = pad(rem % 1_000_000_000n, 9).replace(/0+$/, "");
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}T${clock(rem / 1_000_000_000n, 1n, 0)}${frac === "" ? "" : `.${frac}`}Z`;
}

/// The same special value in another type, as q's casts carry it.
const specialAs = (t: Temporal, type: TemporalType): Temporal => ({ type, special: t.special, n: 0n });

/// The integer under a special value, as `"j"$` (a long type) or `"i"$`
/// (an int type) gives it.
function specialInteger(t: Temporal): string {
  const suffix = WIDE.has(t.type) ? "" : "i";
  return t.special === "null" ? `0N${suffix}` : `${t.special === "-inf" ? "-" : ""}0W${suffix}`;
}

/// Every conversion of `t` this offers: each one's text reads back as the
/// same instant or length.
export function conversions(t: Temporal): Conversion[] {
  const out: Conversion[] = [];
  const add = (label: string, text: string | undefined) => text !== undefined && out.push({ label, text });
  const unit: Record<TemporalType, string> = {
    timestamp: "nanoseconds since 2000.01.01",
    month: "months since 2000.01",
    date: "days since 2000.01.01",
    datetime: "days since 2000.01.01, a float",
    timespan: "nanoseconds",
    minute: "minutes",
    second: "seconds",
    time: "milliseconds",
  };
  if (t.special !== undefined) {
    if (t.type !== "datetime") {
      add(`${WIDE.has(t.type) ? "long" : "int"}, ${unit[t.type]} (\`"${WIDE.has(t.type) ? "j" : "i"}"$\`)`, specialInteger(t));
    }
    if (t.type === "date" || t.type === "datetime" || t.type === "month") {
      add('timestamp (`"p"$`)', format(specialAs(t, "timestamp")));
    }
    if (t.type === "timestamp" || t.type === "datetime") {
      add('date (`"d"$`)', format(specialAs(t, "date")));
    }
    return out;
  }
  if (t.type !== "datetime") {
    add(`${WIDE.has(t.type) ? "long" : "int"}, ${unit[t.type]} (\`"${WIDE.has(t.type) ? "j" : "i"}"$\`)`, String(t.n));
  }
  const ns = nanos(t);
  if (ns !== undefined) {
    // A date past 2292 has no timestamp: q's cast overflows.
    if (t.type !== "timestamp" && ns > -LONG_MAX && ns < LONG_MAX) {
      // A datetime is a float: KDB-X's `"p"$` of one can be microseconds off
      // its milliseconds, so this names the millisecond, not the cast.
      add(t.type === "datetime" ? "timestamp of the same millisecond" : 'timestamp (`"p"$`)', timestampText({ type: "timestamp", n: ns }));
    }
    if (t.type === "timestamp" || t.type === "datetime") {
      add('date (`"d"$`)', format({ type: "date", n: floorDiv(ns, NS_PER_DAY)[0] }));
    }
    if (t.type === "date") {
      add('month (`"m"$`)', format({ type: "month", n: (BigInt(civil(Number(t.n))[0]) - 2000n) * 12n + BigInt(civil(Number(t.n))[1] - 1) }));
    }
    const unix = ns + UNIX_NS_2000;
    for (const u of UNIX_UNITS) {
      add(`Unix ${u.name}`, decimal(unix, u.places));
    }
    add("ISO 8601, UTC", iso(ns));
  } else {
    // A length: the same in nanoseconds and seconds, and as a timespan.
    const per: Partial<Record<TemporalType, bigint>> = { timespan: 1n, time: 1_000_000n, second: 1_000_000_000n, minute: 60_000_000_000n };
    const span = t.n * (per[t.type] ?? 1n);
    if (t.type !== "timespan") {
      add('timespan (`"n"$`)', format({ type: "timespan", n: span }));
    } else {
      add("milliseconds", decimal(span, 6));
    }
    add("seconds", decimal(span, 9));
  }
  return out;
}

/// What a number means when read as a time: a timestamp of that many
/// nanoseconds since 2000 (a whole number, `"p"$`), and a Unix epoch in the
/// unit its size suggests.
export function numberConversions(text: string): Conversion[] {
  const m = /^(-?)(\d+)(\.\d+)?(j?)$/.exec(text);
  if (m === null || (m[3] !== undefined && m[4] !== "")) {
    return [];
  }
  const out: Conversion[] = [];
  const digits = m[2].replace(/^0+/, "").length;
  if (m[3] === undefined && digits <= 19) {
    const n = BigInt(`${m[1]}${m[2]}`);
    if (n >= LONG_NULL && n <= LONG_MAX) {
      const lit = timestampText(timestampOfLong(n));
      if (lit !== undefined) {
        out.push({ label: 'q timestamp, nanoseconds since 2000.01.01 (`"p"$`)', text: lit });
      }
    }
  }
  const unit = likelyUnit(digits);
  if (unit !== undefined) {
    const t = fromUnix(`${m[1]}${m[2]}${m[3] ?? ""}`, unit);
    const lit = t === undefined ? undefined : timestampText(t);
    if (lit !== undefined && t !== undefined) {
      out.push({ label: `from Unix ${unit}`, text: lit }, { label: `from Unix ${unit}, ISO 8601`, text: iso(t.n) });
    }
  }
  return out;
}

/// What a selection converts to: a temporal's conversions, or a number's.
export function convertText(text: string): { what: string; conversions: Conversion[] } | undefined {
  const trimmed = text.trim();
  const t = parse(trimmed);
  if (t !== undefined) {
    const kind = t.special === "null" ? `null ${t.type}` : t.special !== undefined ? `infinite ${t.type}` : t.type;
    return { what: kind, conversions: conversions(t) };
  }
  const n = numberConversions(trimmed);
  return n.length > 0 ? { what: "number", conversions: n } : undefined;
}

/// The literals a hover looks for, longest forms first.
const TOKEN =
  /-?0[NWw][pmdznuvt]|-?\d{4}\.\d{2}\.\d{2}(?:[DT][0-9:.]*)?|-?\d{4}\.\d{2}m|-?\d+D[0-9:.]*|-?\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?|-?\d+(?:\.\d+)?j?/g;

/// Whether `index` of `line` is inside a string or after a comment's `/`.
export function inStringOrComment(line: string, index: number): boolean {
  let quoted = false;
  for (let i = 0; i < index && i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === "\\") {
        i++;
      } else if (c === '"') {
        quoted = false;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === "/" && (i === 0 || /\s/.test(line[i - 1]))) {
      return true;
    }
  }
  return quoted;
}

/// The temporal literal or epoch-sized number under `character` of `line`,
/// with where it starts and ends, and what it converts to. Undefined for
/// anything else, a number too small to be a time among them.
export function temporalAt(
  line: string,
  character: number,
): { start: number; end: number; text: string; what: string; conversions: Conversion[] } | undefined {
  for (const m of line.matchAll(TOKEN)) {
    let start = m.index ?? 0;
    let text = m[0];
    const end = start + text.length;
    if (character < start || character > end) {
      continue;
    }
    // `x-1` is a subtraction, the minus not the literal's; `x -1` is not,
    // as q reads a minus after a space before a digit as a sign.
    if (text.startsWith("-") && /[A-Za-z0-9_.)\]}"`]/.test(line[start - 1] ?? "")) {
      start += 1;
      text = text.slice(1);
      if (character < start) {
        return undefined;
      }
    }
    // Part of a longer word (`a2024`, `x10`) is no literal.
    const before = text === m[0] ? (line[start - 1] ?? "") : "";
    if (/[A-Za-z0-9_.]/.test(before) || /[A-Za-z0-9_]/.test(line[end] ?? "")) {
      return undefined;
    }
    if (inStringOrComment(line, start)) {
      return undefined;
    }
    // A bare number counts once it is as long as an epoch: 9 digits.
    if (/^-?\d+(\.\d+)?j?$/.test(text) && text.replace(/^-/, "").split(".")[0].replace(/j$/, "").replace(/^0+/, "").length < 9) {
      return undefined;
    }
    const found = convertText(text);
    return found === undefined ? undefined : { start, end, text, ...found };
  }
  return undefined;
}

/// A hover's Markdown: the value's type and a table of its conversions.
export function hoverMarkdown(found: { text: string; what: string; conversions: Conversion[] }): string {
  const code = (s: string) => `\`${s.replace(/`/g, "")}\``;
  const rows = found.conversions.map((c) => `| ${c.label.replace(/\|/g, "\\|")} | ${code(c.text)} |`);
  return [`**${found.what}** ${code(found.text)}`, "", "| as | value |", "| --- | --- |", ...rows].join("\n");
}
