// A result's cells written back as q: each cell as the literal that gives
// its value, and a whole grid as the expression that rebuilds the table.
//
// It works from a `GRID` payload rather than the grid the panel shows, so a
// float keeps every digit (`raw`, not the cell rounded to gridDecimals or
// cut to `\P`), and a null or an infinity keeps its type: `0Nh`, `-0Wd`.
// What `string` writes is a literal already for most types - a date, a
// time, a timestamp - and needs only a suffix for the rest: `1b`, `12h`,
// `2024.01m`. A symbol is `` `a `` or, holding what a bare symbol cannot,
// `` `$"a b" ``; a guid `"G"$"..."`. An item of a general list is `-3!` of
// it, which is q already, unless it was cut at 200 characters - `cut` says
// so. An enumerated column is written as its symbols, without its domain.
import type { GridPayload } from "./grid";

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
const RESERVED = new Set(
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
/// its exponent without the `+` q does not take.
export function numberText(x: number): string {
  return String(x).replace("e+", "e");
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

/// A symbol's literal: bare when q reads it back as written.
export function symbolLiteral(name: string): string {
  return /^[A-Za-z0-9_.]*$/.test(name) ? `\`${name}` : `\`$${stringLiteral(name)}`;
}

/// Whether `name` can be a column name in `([] ...)` as written.
export function plainName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name);
}

/// One cell's literal. `text` is q's text of it, as `GRID` sent it;
/// `raw` its number, when `GRID` sent one (undefined when it did not).
/// `cut`: the text was cut at 200 characters, so the literal is not the value.
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
      return ok(raw !== undefined && raw !== null ? String(raw) : text);
    case 8:
    case 9: {
      const n = typeof raw === "number" ? numberText(raw) : text;
      return ok(`${n}${type === 8 ? "e" : "f"}`);
    }
    case 10:
      return ok(stringLiteral(text === "" ? " " : text));
    case 11:
      return ok(symbolLiteral(text));
    case 13:
      return ok(`${text}m`);
    case 12:
    case 14:
    case 15:
    case 16:
    case 17:
    case 18:
    case 19:
      return ok(text);
    default:
      if (type >= 20 && type <= 76) {
        return ok(symbolLiteral(text));
      }
      // A general list's item: `-3!` of it, or a string written as one.
      return { literal: text === "" ? "()" : text, cut: text.length >= 200 && text.endsWith("...") };
  }
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
    return `enlist ${items[0]}`;
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
  /// Cells cut at 200 characters, whose literal is not their value.
  cut: number;
}

/// The expression that rebuilds the grid's `rows` (indices, in the order
/// shown; all of them when undefined) as a table, keyed by its key columns.
/// `([k:...] v:...)` when every name can be written plainly, and
/// `` n!flip `a`b!(...) `` when one cannot.
export function tableLiteral(payload: GridPayload, rows?: number[]): QTable {
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
  let code: string;
  if (names.length > 0 && names.every(plainName) && new Set(names).size === names.length) {
    const part = (from: number, to: number) => names.slice(from, to).map((n, j) => `${n}:${columns[from + j]}`).join(";");
    code = `([${part(0, keys)}] ${part(keys, names.length)})`;
  } else {
    const symbols = names.map(symbolLiteral);
    // Parenthesised: `enlist `a!x` would be `enlist (`a!x)`.
    const nameList = symbols.length === 1 ? `(enlist ${symbols[0]})` : symbols.every((s) => /^`[A-Za-z0-9_.]*$/.test(s)) ? symbols.join("") : `(${symbols.join(";")})`;
    const columnList = columns.length === 1 ? `enlist ${columns[0]}` : `(${columns.join(";")})`;
    code = `${keys > 0 ? `${keys}!` : ""}flip ${nameList}!${columnList}`;
  }
  return { code, rows: order.length, total: payload.count, cut };
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
/// (and a string cut at 200 characters) as q wrote it.
export function plainItem(text: string): string {
  const m = /^"((?:[^"\\]|\\.)*)"$/s.exec(text);
  if (m === null) {
    return text;
  }
  return m[1].replace(/\\([0-7]{3}|.)/gs, (_, e: string) =>
    e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e,
  );
}
