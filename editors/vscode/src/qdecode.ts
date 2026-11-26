// A q message decoded with its types, for an unwrapped query, whose answer
// q-lint formats itself.
//
// node-q's codec decodes to plain JavaScript, which drops what the text
// needs: a symbol and a string are both strings, a timestamp a float exact
// only to 256 ns, a time a Date at 2000.01.01, a negative temporal infinity
// a positive one, a sorted dictionary "func", an attribute nothing. Here
// every value keeps its q type, and an item is the number q holds it as -
// months, days, minutes, seconds, milliseconds, datetime float days, and
// longs, timestamps and timespans as bigints - with nulls as null and
// infinities as +-Infinity, as the codec gives them.

import { bytesText } from "./grid";

/// One item of an atom or a simple list. A char is its byte, a symbol and a
/// guid their text.
export type Item = null | boolean | number | bigint | string;

export type QValue =
  /// A symbol with a byte past ASCII keeps its bytes: its text reads them
  /// as UTF-8 where they are, and a byte at a time where not (#2578).
  | { kind: "atom"; t: number; v: Item; bytes?: number[] }
  | { kind: "vector"; t: number; attr: number; v: Item[]; bytes?: (number[] | false)[] }
  /// A char vector, as its bytes: q's text escapes what is not printable.
  | { kind: "chars"; attr: number; v: Buffer }
  | { kind: "list"; attr: number; v: QValue[] }
  | { kind: "table"; attr: number; cols: string[]; data: QValue[] }
  /// A dictionary; `sorted` for one with the `s` attribute (type 127).
  | { kind: "dict"; sorted: boolean; k: QValue; v: QValue }
  /// A function: a lambda's or a primitive's text; for a projection (104),
  /// a composition (105) or a derived function (106-111), which q sends as
  /// their parts, `parts`: the function and its arguments, the functions
  /// composed, or the function an iterator derives from (#2477).
  | { kind: "func"; t: number; text?: string; parts?: QValue[] };

/// A value q sends by reference - a mapped table, as its path - so none of
/// it can be shown: said as that, never as the codec's reading of it.
export class ByReference extends Error {}

/// The body of a compressed message, uncompressed, behind an 8-byte header:
/// kdb+'s scheme (code.kx.com/q/basics/ipc), as its own clients undo it.
function decompress(message: Buffer): Buffer {
  if (message.length < 12) {
    throw new Error("a compressed message shorter than its header");
  }
  const size = message.readUInt32LE(8);
  // A copy takes two bytes and a flag bit and gives at most 257: a size
  // past that is not of this message, and is not allocated (#2136).
  if (size < 8 || size > 8 + (message.length - 12) * 257) {
    throw new Error("a compressed message whose size is not its own");
  }
  const out = Buffer.alloc(size);
  const table = new Int32Array(256);
  let s = 8;
  let p = s;
  let d = 12;
  let f = 0;
  let i = 0;
  while (s < out.length) {
    if (d >= message.length) {
      throw new Error("a compressed message shorter than it says");
    }
    if (i === 0) {
      f = message[d++];
      i = 1;
    }
    if ((f & i) !== 0) {
      let r = table[message[d++]];
      out[s++] = out[r++];
      out[s++] = out[r++];
      const n = message[d++];
      for (let m = 0; m < n; m++) {
        out[s + m] = out[r + m];
      }
      while (p < s - 1) {
        table[out[p] ^ out[p + 1]] = p++;
      }
      s += n;
      p = s;
    } else {
      out[s++] = message[d++];
      while (p < s - 1) {
        table[out[p] ^ out[p + 1]] = p++;
      }
    }
    i = i === 128 ? 0 : i * 2;
  }
  return out;
}

const INT_NULL = -2147483648;
const INT_INF = 2147483647;
const LONG_NULL = -9223372036854775808n;
const LONG_INF = 9223372036854775807n;

/// Bytes each item of a simple list of type `t` takes; 0 for a symbol.
const WIDTH = [0, 1, 16, 0, 1, 2, 4, 8, 4, 8, 1, 0, 8, 4, 4, 8, 8, 4, 4, 4];

/// q's primitives by type (101 unary, 102 binary, 103 iterator) and index,
/// as KDB-X prints each: `-9!0x010000000a000000650d` is `#:`.
const PRIMITIVES: readonly (readonly string[])[] = [
  ["::", "+:", "-:", "*:", "%:", "&:", "|:", "^:", "=:", "<:", ">:", "$:", ",:", "#:", "_:", "~:", "!:", "?:", "@:", ".:",
    "0::", "1::", "2::", "avg", "last", "sum", "prd", "min", "max", "exit", "getenv", "abs", "sqrt", "log", "exp", "sin",
    "asin", "cos", "acos", "tan", "atan", "enlist", "var", "dev", "hopen"],
  [":", "+", "-", "*", "%", "&", "|", "^", "=", "<", ">", "$", ",", "#", "_", "~", "!", "?", "@", ".", "0:", "1:", "2:",
    "in", "within", "like", "bin", "ss", "insert", "wsum", "wavg", "div", "xexp", "setenv", "binr", "cov", "cor"],
  ["'", "/", "\\", "':", "/:", "\\:"],
];

/// The value a whole q message holds (its header included), with its types.
/// Throws on what it cannot read, an error message included.
export function decode(message: Buffer): QValue {
  const b = checkedBody(message);
  let pos = 8;
  const int = (n: number): number => (n === INT_NULL ? NaN : n === INT_INF ? Infinity : n === -INT_INF ? -Infinity : n);
  const item = (t: number): Item => {
    switch (t) {
      case 1:
        return b.readUInt8(pos++) !== 0;
      case 2: {
        const hex = b.toString("hex", pos, (pos += 16));
        return /^0+$/.test(hex) ? null : `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
      case 4:
      case 10:
        return b.readUInt8(pos++);
      case 5: {
        const h = b.readInt16LE(pos);
        pos += 2;
        return h === -32768 ? null : h === 32767 ? Infinity : h === -32767 ? -Infinity : h;
      }
      case 6:
      case 13:
      case 14:
      case 17:
      case 18:
      case 19: {
        const n = int(b.readInt32LE(pos));
        pos += 4;
        return Number.isNaN(n) ? null : n;
      }
      case 7:
      case 12:
      case 16: {
        const j = b.readBigInt64LE(pos);
        pos += 8;
        return j === LONG_NULL ? null : j === LONG_INF ? Infinity : j === -LONG_INF ? -Infinity : j;
      }
      case 8: {
        const e = b.readFloatLE(pos);
        pos += 4;
        return Number.isNaN(e) ? null : e;
      }
      case 9:
      case 15: {
        const f = b.readDoubleLE(pos);
        pos += 8;
        return Number.isNaN(f) ? null : f;
      }
      case 11: {
        const end = b.indexOf(0, pos);
        // No NUL left: indexOf's -1 put pos back at 0, and each symbol
        // after read the message again, until the heap ran out (#2136).
        if (end < 0) {
          throw new Error("a message shorter than its list");
        }
        const raw = b.subarray(pos, end);
        pos = end + 1;
        symbolBytes = raw.some((x) => x > 127) ? [...raw] : undefined;
        return symbolBytes === undefined ? raw.toString("utf8") : (bytesText(symbolBytes) ?? raw.toString("utf8"));
      }
    }
    throw new Error(`no q type ${t}`);
  };
  /// The bytes of the symbol `item` read last, when one is past ASCII.
  let symbolBytes: number[] | undefined;
  const symbol = (): string => item(11) as string;
  const value = (): QValue => {
    const t = b.readInt8(pos++);
    if (t === -128) {
      throw new Error(symbol());
    }
    if (t < 0 && t >= -19 && t !== -3) {
      const v = item(-t);
      return t === -11 && symbolBytes !== undefined ? { kind: "atom", t, v, bytes: symbolBytes } : { kind: "atom", t, v };
    }
    if (t === 99 || t === 127) {
      const k = value();
      return { kind: "dict", sorted: t === 127, k, v: value() };
    }
    if (t >= 100) {
      if (t === 100) {
        symbol();
        const text = value();
        return { kind: "func", t, ...(text.kind === "chars" ? { text: text.v.toString("utf8") } : {}) };
      }
      if (t <= 103) {
        const index = b.readUInt8(pos++);
        // A primitive is sent as its index in q's table: (::), the generic
        // null, is unary 0 and keeps no text; `count` is unary 13, `#:`.
        // Unary 255 is an argument a projection leaves out, written as none.
        const text = t === 101 && index === 255 ? "" : index === 0 && t === 101 ? undefined : PRIMITIVES[t - 101][index];
        return { kind: "func", t, ...(text !== undefined ? { text } : {}) };
      }
      const parts: QValue[] = [];
      if (t <= 105) {
        const n = b.readInt32LE(pos);
        pos += 4;
        for (let i = 0; i < n; i++) {
          parts.push(value());
        }
      } else if (t <= 111) {
        parts.push(value());
      } else {
        throw new Error(`q-lint cannot read a value of type ${t}`);
      }
      return { kind: "func", t, parts };
    }
    const attr = b.readInt8(pos++);
    if (t === 98) {
      const dict = value();
      // A mapped splayed or partitioned table is sent as its columns and
      // its path, or its name: none of its rows (#2569).
      if (dict.kind === "dict" && dict.v.kind === "atom" && dict.v.t === -11) {
        const ref = dict.v.v === null ? "" : ` \`${dict.v.v}`;
        const as = String(dict.v.v).startsWith(":") ? "its path" : "its name";
        throw new ByReference(`a splayed or partitioned table is sent by reference (${as}${ref}), with none of its rows: select from it to see them, as select from t does.`);
      }
      if (dict.kind !== "dict" || dict.k.kind !== "vector" || dict.v.kind !== "list") {
        throw new Error("a table that is not a dictionary of columns");
      }
      return { kind: "table", attr, cols: dict.k.v.map(String), data: dict.v.v };
    }
    if (t < 0 || t > 19 || t === 3) {
      throw new Error(`q-lint cannot read a value of type ${t}`);
    }
    const n = b.readUInt32LE(pos);
    pos += 4;
    if (t === 10) {
      return { kind: "chars", attr, v: Buffer.from(b.subarray(pos, (pos += n))) };
    }
    if (t === 0) {
      const v: QValue[] = [];
      for (let i = 0; i < n; i++) {
        v.push(value());
      }
      return { kind: "list", attr, v };
    }
    if (WIDTH[t] > 0 && pos + n * WIDTH[t] > b.length) {
      throw new Error("a message shorter than its list");
    }
    const v: Item[] = new Array(n);
    let bytes: (number[] | false)[] | undefined;
    for (let i = 0; i < n; i++) {
      v[i] = item(t);
      if (t === 11 && symbolBytes !== undefined) {
        bytes ??= new Array(n).fill(false);
        bytes[i] = symbolBytes;
      }
    }
    return bytes === undefined ? { kind: "vector", t, attr, v } : { kind: "vector", t, attr, v, bytes };
  };
  return value();
}

const SHORT = "a message shorter than its list";

/// `message` uncompressed (or itself, when it is not compressed), once it
/// is checked to hold one whole value: every item of every list, every
/// symbol's NUL, inside its bytes. A message cut short or corrupted, from a
/// server or the network, throws here instead of sending a decoder - this
/// one or node-q's, whose symbol reader starts the message again when it
/// finds no NUL - reading past its end, for ever (#2136). Linear in the
/// message: a simple list is stepped over whole.
export function checkedBody(message: Buffer): Buffer {
  if (message.length < 9) {
    throw new Error("a message shorter than its header");
  }
  const b = message.readUInt8(2) === 1 ? decompress(message) : message;
  let pos = 8;
  const need = (n: number): void => {
    if (!(n >= 0) || pos + n > b.length) {
      throw new Error(SHORT);
    }
  };
  const symbol = (): void => {
    const end = b.indexOf(0, pos);
    if (end < 0) {
      throw new Error(SHORT);
    }
    pos = end + 1;
  };
  // A width for each simple type; enumerations (20-76) are ints.
  const width = (t: number): number | undefined => (t >= 20 && t <= 76 ? 4 : t >= 1 && t <= 19 && t !== 3 && t !== 11 ? WIDTH[t] : undefined);
  const value = (): void => {
    need(1);
    const t = b.readInt8(pos++);
    if (t === -128 || t === -11) {
      symbol();
      return;
    }
    if (t < 0) {
      const w = width(-t);
      if (w === undefined) {
        throw new Error(`a value of no q type (${t})`);
      }
      need(w);
      pos += w;
      return;
    }
    if (t === 99 || t === 127) {
      value();
      value();
      return;
    }
    if (t >= 100) {
      if (t === 100) {
        symbol();
        value();
      } else if (t <= 103) {
        need(1);
        pos++;
      } else if (t <= 105) {
        need(4);
        const n = b.readInt32LE(pos);
        pos += 4;
        need(n);
        for (let i = 0; i < n; i++) {
          value();
        }
      } else if (t <= 112) {
        value();
      } else {
        throw new Error(`a value of no q type (${t})`);
      }
      return;
    }
    need(1);
    pos++;
    if (t === 98) {
      value();
      return;
    }
    need(4);
    const n = b.readInt32LE(pos);
    pos += 4;
    // Each item takes a byte at least.
    need(n);
    if (t === 0) {
      for (let i = 0; i < n; i++) {
        value();
      }
    } else if (t === 11) {
      for (let i = 0; i < n; i++) {
        symbol();
      }
    } else if (t === 10) {
      pos += n;
    } else {
      const w = width(t);
      if (w === undefined) {
        throw new Error(`a value of no q type (${t})`);
      }
      need(n * w);
      pos += n * w;
    }
  };
  value();
  return b;
}
