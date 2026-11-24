// A result's cells written back as q: each cell as the literal that gives
// its value, and a whole grid as the expression that rebuilds the table.
//
// It works from a `GRID` payload rather than the grid the panel shows, so a
// float keeps every digit (`raw`, not the cell rounded to gridDecimals or
// cut to `\P`), and a null or an infinity keeps its type: `0Nh`, `-0Wd`.
// What `string` writes is a literal already for most types - a date, a
// time, a timestamp - and needs only a suffix for the rest: `1b`, `12h`,
// `2024.01m`. A symbol is `` `a `` or, holding what a bare symbol cannot
// (a space, or a leading `_`), `` `$"a b" ``; a guid `"G"$"..."`. An item
// of a general list is `-3!` of it made readable (`readable`): `-3!` writes
// a one-item list `,x`, which q refuses, and a symbol starting with `_` bare.
// An item cut at 200 characters (`...`), or by `-3!` at the process's `\c`
// width (`..`), is not its value - `cut` says so. An
// enumerated column is written as its symbols, without its domain.
//
// These are the extension's one writer of q strings and symbols: Paste as q
// Table, the JSON conversion, the gateway's statements and the grid's cell
// edits all use `qString` and `symbolLiteral`.
import { realValue, type GridPayload } from "./grid";

const NULL_GUID = "00000000-0000-0000-0000-000000000000";

/// Each type's null and infinity, as q writes them.
const NULLS: Record<number, string> = {
  2: "0Ng", 5: "0Nh", 6: "0Ni", 7: "0Nj", 8: "0Ne", 9: "0n",
  12: "0Np", 13: "0Nm", 14: "0Nd", 15: "0Nz", 16: "0Nn", 17: "0Nu", 18: "0Nv", 19: "0Nt",
};
const INFINITIES: Record<number, string> = {
  5: "0Wh", 6: "0Wi", 7: "0W", 8: "0We", 9: "0w",
  12: "0Wp", 13: "0Wm", 14: "0Wd", 15: "0wz", 16: "0Wn", 17: "0Wu", 18: "0Wv", 19: "0Wt",
};
/// The letter `"x"$()` casts an empty list to, for an empty column.
const LETTERS: Record<number, string> = {
  1: "b", 2: "g", 4: "x", 5: "h", 6: "i", 7: "j", 8: "e", 9: "f", 10: "c", 11: "s",
  12: "p", 13: "m", 14: "d", 15: "z", 16: "n", 17: "u", 18: "v", 19: "t",
};

/// q's reserved words and the names of its builtins: as a column name in
/// `([] ...)` each is an 'assign error, except `by` and `from`.
export const RESERVED = new Set(
  ("abs acos aj aj0 ajf ajf0 all and any asc asin asof atan attr avg avgs bin binr by ceiling cols cor cos count cov cross " +
    "csv cut delete deltas desc dev differ distinct div do dsave each ej ema enlist eval except exec exit exp fby fills first " +
    "fkeys flip floor from get getenv group gtime hclose hcount hdel hopen hsym iasc idesc if ij ijf in insert inter inv key " +
    "keys last like lj ljf load log lower lsq ltime ltrim mavg max maxs mcount md5 mdev med meta min mins mmax mmin mmu mod " +
    "msum neg next not null or over parse peach pj prd prds prev prior rand rank ratios raze read0 read1 reciprocal reval " +
    "reverse rload rotate rsave rtrim save scan scov sdev select set setenv show signum sin sqrt ss ssr string sublist sum " +
    "sums sv svar system tables tan til trim type uj ujf ungroup union update upper upsert use value var view views vs wavg " +
    "where while within wj wj1 wsum ww xasc xbar xcol xcols xdesc xexp xgroup xkey xlog xprev xrank").split(" "),
);

/// A double as q reads it back exactly: JavaScript's shortest round trip,
/// its exponent without the `+` q does not take, and `-0` its sign, which
/// String(-0) drops (#1493).
export function numberText(x: number): string {
  return Object.is(x, -0) ? "-0" : String(x).replace("e+", "e");
}

/// A string as a q char vector's literal, its quote, backslash and
/// control characters escaped as `-3!` escapes them.
export function stringLiteral(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === "\\") {
      out += `\\${ch}`;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (code < 32 || code === 127) {
      out += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      out += ch;
    }
  }
  return `"${out}"`;
}

/// A string's literal as a list: q holds it as UTF-8 bytes, so one byte
/// is a char to `enlist` and `"é"` is two already. Not `,"x"`: q refuses
/// that as a list item, `("ab";,"x")`.
export function qString(text: string): string {
  const s = stringLiteral(text);
  return new TextEncoder().encode(text).length === 1 ? `enlist ${s}` : s;
}

/// A symbol's literal: bare when q reads it back as written, which a name
/// starting with `_` it does not (`` `_y `` is `` ` `` and `_y`).
export function symbolLiteral(name: string): string {
  return /^(?:[A-Za-z0-9.][A-Za-z0-9_.]*)?$/.test(name) ? `\`${name}` : `\`$${stringLiteral(name)}`;
}

/// `::`, or an operator with its iterators, where an item ends. `,:`, `,'`
/// and `,/` are left out: `-3!` writes the monadic `,`, join-each and raze
/// so too.
const VERB = /^(?:::|[-+*%&|^=<>~#_$?@.!][:/\\']*)(?=[;)\]]|$)/;

/// A guid as `-3!` writes it, or a run of them, where it ends.
const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GUIDS = new RegExp(`^${GUID}(?: ${GUID})*(?![A-Za-z0-9_.])`);

/// `enlist x` for a list of the one item `x`, in parentheses when it is no
/// noun: `enlist ::` is `enlist` itself, and `enlist +` a 'rank (#1968).
function lone(item: string): string {
  return /^(?:[A-Za-z0-9"`({]|-\.?\d)/.test(item) ? `enlist ${item}` : `enlist(${item})`;
}

/// `code` with what q writes but will not read back rewritten, outside
/// strings: each monadic `,` - at the start, or after `(`, `;`, `[`, `{`,
/// `!` or another `,` - as `enlist ` (q refuses `,"x"`, and q-sql splits a
/// clause at a `,` after `(`: `where c~\:(,"z")`), each monadic `+`
/// before a `(` or a `` ` `` - a table, as `-3!` writes it - as `flip `
/// (q refuses `+(,`a)!,1`: #1501), and a run of symbols
/// whose first starts with `_` (`` `_y ``, `` `_y`a ``) through `` `$ ``.
/// `-3!` writes both, so a general list's item needs it, and a grid cell
/// edit's value too. A guid, which `-3!` writes bare, and a run of them,
/// are written through `"G"$` (#2081).
export function readable(code: string): string {
  let out = "";
  let inString = false;
  let last = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += code[++i] ?? "";
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "," && (last === "" || "(;[{!,".includes(last))) {
      // No noun - `::`, an operator - is taken in parentheses (#1968).
      const verb = VERB.exec(code.slice(i + 1))?.[0];
      if (verb !== undefined) {
        out += `enlist(${verb})`;
        i += verb.length;
        last = ")";
        continue;
      }
      out += "enlist ";
      last = "";
      continue;
    } else if (ch === "+" && (last === "" || "(;[!,".includes(last)) && "(`".includes(code[i + 1] ?? " ")) {
      out += "flip ";
      last = "";
      continue;
    } else if (/[0-9a-f]/.test(ch) && !/[A-Za-z0-9_.`:]/.test(code[i - 1] ?? "") && GUIDS.test(code.slice(i))) {
      const run = GUIDS.exec(code.slice(i))![0];
      const guids = run.split(" ");
      out += guids.length === 1 ? `("G"$"${run}")` : `("G"$(${guids.map((g) => `"${g}"`).join(";")}))`;
      i += run.length - 1;
      last = ")";
      continue;
    } else if (ch === "`" && code[i + 1] === "_" && !/[A-Za-z0-9_.`]/.test(code[i - 1] ?? "")) {
      const run = /^(?:`[A-Za-z0-9_.]*)+/.exec(code.slice(i))?.[0] ?? "`";
      const names = run.slice(1).split("`");
      out += names.length === 1 ? symbolLiteral(names[0]) : `\`$(${names.map(qString).join(";")})`;
      i += run.length - 1;
      last = ")";
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) {
      last = ch;
    }
  }
  return out;
}

/// `-3!` text with each run of symbols written so q reads it back. `-3!`
/// writes a symbol bare whatever it holds - `` `a b `` for `` `$"a b" ``,
/// which q reads as `` `a `` applied to `b` (#1486) - so outside strings and
/// lambdas a name runs to the next `` ` ``, `;`, `)`, `]`, `}`, `!`, `$`,
/// `#` or the end, which is what follows a symbol in `-3!`'s text, and a run
/// that cannot be bare is written through `` `$ ``. Not for code a person
/// wrote, where `` `a xor `b `` is two symbols.
export function readableSymbols(code: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      const s = /^"(?:[^"\\]|\\.)*"?/s.exec(code.slice(i))?.[0] ?? ch;
      out += s;
      i += s.length - 1;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "`" && depth === 0) {
      const run = /^(?:`[^`;)\]}!$#]*)+/.exec(code.slice(i))?.[0] ?? ch;
      const names = run.slice(1).split("`");
      // After the first, a name may start with `_`: `` `a`_y `` is two.
      const bare = names.every((n, k) => (k === 0 ? symbolLiteral(n) === `\`${n}` : /^[A-Za-z0-9_.]*$/.test(n)));
      const cast = names.length === 1 ? symbolLiteral(names[0]) : `\`$(${names.map(qString).join(";")})`;
      // In parentheses before a `!`, `$` or `#`, which `` `$ `` would take in.
      out += bare ? run : "!$#".includes(code[i + run.length] ?? ";") ? `(${cast})` : cast;
      i += run.length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/// Whether `name` can be a column name in `([] ...)` as written.
export function plainName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name);
}

/// One cell's literal. `text` is q's text of it, as `GRID` sent it;
/// `raw` its number, when `GRID` sent one (undefined when it did not).
/// `cut`: the text was cut at 200 characters or at `\c`, so the literal is
/// not the value.
export function atomLiteral(type: number, text: string, raw: unknown): { literal: string; cut: boolean } {
  const ok = (literal: string) => ({ literal, cut: false });
  if (raw === null && NULLS[type] !== undefined) {
    return ok(NULLS[type]);
  }
  if ((raw === Infinity || raw === -Infinity) && INFINITIES[type] !== undefined) {
    return ok(`${raw < 0 ? "-" : ""}${INFINITIES[type]}`);
  }
  switch (type) {
    case 1:
      return ok(`${text === "1" ? "1" : "0"}b`);
    case 2:
      return ok(text === "" || text === NULL_GUID ? "0Ng" : `"G"$"${text}"`);
    case 4:
      return ok(`0x${text}`);
    case 5:
      return ok(`${text}h`);
    case 6:
      return ok(`${text}i`);
    case 7:
      // A long past 2^53 is a rounded number in `raw`; its text is exact (#1276).
      return ok(raw === undefined || raw === null || (typeof raw === "number" && !Number.isSafeInteger(raw)) ? text : String(raw));
    case 8:
    case 9: {
      const n = typeof raw === "number" ? numberText(raw) : text;
      return ok(`${n}${type === 8 ? "e" : "f"}`);
    }
    case 10:
      // From its byte when sent: one past ASCII is no character alone, and
      // its text is U+FFFD or a Latin-1 character (#1489).
      if (typeof raw === "number") {
        return ok(raw >= 128 ? `"\\${raw.toString(8).padStart(3, "0")}"` : stringLiteral(String.fromCharCode(raw)));
      }
      return ok(stringLiteral(text === "" ? " " : text));
    case 11:
      return ok(symbolLiteral(text));
    case 13:
      return ok(`${text}m`);
    case 15:
      // A datetime is a float of days, which `string` writes to the
      // millisecond: one with a finer fraction is written as its float
      // (#1494).
      if (typeof raw === "number") {
        const ms = raw * 864e5;
        if (Math.abs(ms - Math.round(ms)) > 1e-3) {
          return ok(`"z"$${numberText(raw)}`);
        }
      }
      return ok(text);
    case 17:
    case 18:
    case 19:
      // Past 99 hours KDB-X writes the hours `**`, which it cannot read
      // back: cast from the count of minutes, seconds or milliseconds
      // (#1967).
      if (text.includes("**") && typeof raw === "number" && Number.isInteger(raw)) {
        return ok(`"${LETTERS[type]}"$${raw}`);
      }
      return ok(text);
    case 12:
    case 14:
    case 16:
      return ok(text);
    default:
      if (type >= 20 && type <= 76) {
        return ok(symbolLiteral(text));
      }
      // A float or real item, sent as its float: every digit, not the
      // `\P` that `-3!` writes (#1485).
      if (type === 0 && typeof raw === "number" && Number.isFinite(raw)) {
        const real = text.endsWith("e");
        return ok(`${numberText(real ? Number(realValue(raw)) : raw)}${real ? "e" : "f"}`);
      }
      // An item with floats or reals inside, sent as they are (#1502).
      if (type === 0 && Array.isArray(raw)) {
        const exact = exactLiteral(raw);
        if (exact !== undefined) {
          return exact;
        }
      }
      // A general list's item: `-3!` of it, or a string written as one,
      // made readable.
      // Cut, it ends `...` or `..`, as no whole item does but a symbol
      // ending in dots, which is taken as cut too (#1484).
      return { literal: text === "" ? "()" : readable(readableSymbols(text)), cut: text.endsWith("..") };
  }
}

/// A float's or a real's literal, without a suffix: its null and
/// infinities as q writes them in a list of their type.
function floatText(x: unknown, real: boolean): string {
  if (typeof x !== "number" || Number.isNaN(x)) {
    return real ? "0N" : "0n";
  }
  if (!Number.isFinite(x)) {
    return x < 0 ? "-0w" : "0w";
  }
  return numberText(real ? Number(realValue(x)) : x);
}

/// The literal of a general list's item that `GRID` sent with its floats
/// and reals: `("f";x)` or `("e";x)` for one, `("F";v)` or `("E";v)` for a
/// list of them (a real as its float), `("l";v)` for a general list,
/// each item its own such pair or, holding none, its `-3!` text,
/// `("d";(k;v))` for a dictionary and `("t";d)` for a table. Undefined
/// for anything else.
export function exactLiteral(raw: unknown[]): { literal: string; cut: boolean } | undefined {
  const [tag, v] = raw;
  if (raw.length !== 2) {
    return undefined;
  }
  if (tag === "f" || tag === "e") {
    const n = floatText(v, tag === "e");
    return { literal: tag === "e" || (typeof v === "number" && Number.isFinite(v)) ? `${n}${tag}` : n, cut: false };
  }
  if ((tag === "F" || tag === "E") && Array.isArray(v)) {
    const real = tag === "E";
    if (v.length < 2) {
      return { literal: v.length === 0 ? `"${real ? "e" : "f"}"$()` : `enlist ${exactLiteral([real ? "e" : "f", v[0]])!.literal}`, cut: false };
    }
    const items = v.map((x) => floatText(x, real));
    // A suffix where the items alone would not say the type.
    const suffix = real ? "e" : items.every((n) => /^[-0-9]+$/.test(n)) ? "f" : "";
    return { literal: `${items.join(" ")}${suffix}`, cut: false };
  }
  if (tag === "l" && Array.isArray(v) && v.length > 0) {
    let cut = false;
    const items: string[] = [];
    for (const x of v) {
      const item = Array.isArray(x) ? exactLiteral(x) : typeof x === "string" ? atomLiteral(0, x, false) : undefined;
      if (item === undefined) {
        return undefined;
      }
      cut ||= item.cut;
      items.push(item.literal);
    }
    return { literal: items.length === 1 ? lone(items[0]) : `(${items.join(";")})`, cut };
  }
  // A dictionary, its keys in parentheses unless they are one already, and
  // a table as its dictionary flipped (#1746).
  if (tag === "d" && Array.isArray(v) && v.length === 2) {
    const [k, w] = v.map((x) => (Array.isArray(x) ? exactLiteral(x) : typeof x === "string" ? atomLiteral(0, x, false) : undefined));
    if (k === undefined || w === undefined) {
      return undefined;
    }
    return { literal: `${/^\(.*\)$/.test(k.literal) ? k.literal : `(${k.literal})`}!${w.literal}`, cut: k.cut || w.cut };
  }
  if (tag === "t" && Array.isArray(v)) {
    const d = exactLiteral(v);
    return d === undefined ? undefined : { literal: `flip ${d.literal}`, cut: d.cut };
  }
  return undefined;
}

/// A column's literal over `rows`: `enlist x` for one item, `(x;y;...)`
/// for more, and a typed empty list for none.
export function columnLiteral(type: number, items: string[]): string {
  if (items.length === 0) {
    if (type === 0) {
      return "()";
    }
    if (type === 10) {
      return '""';
    }
    if (type === 11 || (type >= 20 && type <= 76)) {
      return "`$()";
    }
    return `"${LETTERS[type] ?? ""}"$()`;
  }
  if (items.length === 1) {
    return lone(items[0]);
  }
  // Symbols side by side when each is bare: `a`b`c.
  if ((type === 11 || (type >= 20 && type <= 76)) && items.every((s) => /^`[A-Za-z0-9_.]*$/.test(s))) {
    return items.join("");
  }
  return `(${items.join(";")})`;
}

export interface QTable {
  /// The expression.
  code: string;
  /// Rows written, and rows the result had.
  rows: number;
  total: number;
  /// Cells cut at 200 characters or at `\c`, whose literal is not their value.
  cut: number;
}

/// The expression that rebuilds the grid's `rows` (indices, in the order
/// shown; all of them when undefined) as a table, keyed by its key columns.
/// `([k:...] v:...)` when every name can be written plainly, and
/// `` n!flip `a`b!(...) `` when one cannot.
export function tableLiteral(payload: GridPayload, rows?: number[]): QTable {
  const { parts, ...rest } = tableParts(payload, rows);
  return { code: parts.join(""), ...rest };
}

/// `tableLiteral`'s expression in parts, a column's literal one of them:
/// all of a big result's columns together are past the longest string V8
/// makes, which an export writes with `textBuffer` instead (#1855).
export function tableParts(payload: GridPayload, rows?: number[]): Omit<QTable, "code"> & { parts: string[] } {
  const held = payload.cells[0]?.length ?? 0;
  const order = rows ?? [...Array(held).keys()];
  let cut = 0;
  const columns = payload.names.map((_, i) => {
    const type = payload.types[i];
    const cells = payload.cells[i];
    const raw = payload.raw[i]?.length === cells.length ? payload.raw[i] : undefined;
    const items = order.map((r) => {
      const atom = atomLiteral(type, cells[r] ?? "", raw === undefined ? undefined : raw[r]);
      cut += atom.cut ? 1 : 0;
      return atom.literal;
    });
    return columnLiteral(type, items);
  });
  const names = payload.names;
  const keys = Math.min(payload.keys, names.length);
  const parts: string[] = [];
  if (names.length > 0 && names.every(plainName) && new Set(names).size === names.length) {
    const part = (from: number, to: number) => {
      for (let k = from; k < to; k++) {
        parts.push(`${k > from ? ";" : ""}${names[k]}:`, columns[k]);
      }
    };
    parts.push("([");
    part(0, keys);
    parts.push("] ");
    part(keys, names.length);
    parts.push(")");
  } else {
    const symbols = names.map(symbolLiteral);
    // Parenthesised: `enlist `a!x` would be `enlist (`a!x)`.
    const nameList = symbols.length === 1 ? `(enlist ${symbols[0]})` : symbols.every((s) => /^`[A-Za-z0-9_.]*$/.test(s)) ? symbols.join("") : `(${symbols.join(";")})`;
    parts.push(`${keys > 0 ? `${keys}!` : ""}flip ${nameList}!`);
    if (columns.length === 1) {
      parts.push("enlist ", columns[0]);
    } else {
      parts.push("(");
      columns.forEach((c, k) => parts.push(k > 0 ? ";" : "", c));
      parts.push(")");
    }
  }
  return { parts, rows: order.length, total: payload.count, cut };
}

/// Whether a cell holds q's null of a type sent without raw numbers.
export function textNull(type: number, text: string): boolean {
  return (type === 11 && text === "") || (type === 2 && (text === "" || text === NULL_GUID)) || (type >= 20 && type <= 76 && text === "");
}

/// The payload's raw numbers for column `i`, or undefined when it has none.
export function rawColumn(payload: GridPayload, i: number): unknown[] | undefined {
  const raw = payload.raw[i];
  return raw !== undefined && raw.length > 0 && raw.length === payload.cells[i].length ? raw : undefined;
}

/// Names made distinct, for a format whose columns are looked up by name:
/// a second `a` becomes `a_1`.
export function distinctNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((name, i) => {
    let n = name === "" ? `column${i + 1}` : name;
    for (let k = 1; seen.has(n); k++) {
      n = `${name || `column${i + 1}`}_${k}`;
    }
    seen.add(n);
    return n;
  });
}

/// An item of a general list as plain text: a string's characters, its
/// escapes undone, for a format with strings of its own; any other item
/// (and a string cut at 200 characters) as q wrote it. A run of octal
/// escapes is the string's UTF-8 bytes, decoded as such; a byte that is
/// not part of a UTF-8 character keeps one character, and spoils none of
/// the run's others (#1737). A string of one character is one too, which
/// q writes with a comma before it (#1961); `,"ab"` is a list of a string.
export function plainItem(text: string): string {
  const m = /^(?:"((?:[^"\\]|\\.)*)"|,"([^"\\]|\\[0-7]{3}|\\.)")$/s.exec(text);
  if (m === null) {
    return text;
  }
  return (m[1] ?? m[2]).replace(/((?:\\[0-7]{3})+)|\\(.)/gs, (_, run: string | undefined, e: string) => {
    if (run === undefined) {
      return e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e;
    }
    const bytes = Buffer.from(run.match(/[0-7]{3}/g)!.map((o) => parseInt(o, 8)));
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    let out = "";
    for (let i = 0; i < bytes.length; ) {
      // The character the byte at `i` leads, by its length; latin1 if it is none.
      const b = bytes[i];
      const length = b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
      let char: string | undefined;
      try {
        char = length > 0 && i + length <= bytes.length ? utf8.decode(bytes.subarray(i, i + length)) : undefined;
      } catch {
        char = undefined;
      }
      out += char ?? bytes.toString("latin1", i, i + 1);
      i += char === undefined ? 1 : length;
    }
    return out;
  });
}
