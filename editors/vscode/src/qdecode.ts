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

/// One item of an atom or a simple list. A char is its byte, a symbol and a
/// guid their text.
export type Item = null | boolean | number | bigint | string;

export type QValue =
  | { kind: "atom"; t: number; v: Item }
  | { kind: "vector"; t: number; attr: number; v: Item[] }
  /// A char vector, as its bytes: q's text escapes what is not printable.
  | { kind: "chars"; attr: number; v: Buffer }
  | { kind: "list"; attr: number; v: QValue[] }
  | { kind: "table"; attr: number; cols: string[]; data: QValue[] }
  /// A dictionary; `sorted` for one with the `s` attribute (type 127).
  | { kind: "dict"; sorted: boolean; k: QValue; v: QValue }
  /// A function: a lambda's text, or none for any other kind.
  | { kind: "func"; t: number; text?: string };

/// The body of a compressed message, uncompressed, behind an 8-byte header:
/// kdb+'s scheme (code.kx.com/q/basics/ipc), as its own clients undo it.
function decompress(message: Buffer): Buffer {
  const out = Buffer.alloc(message.readUInt32LE(8));
  const table = new Int32Array(256);
  let s = 8;
  let p = s;
  let d = 12;
  let f = 0;
  let i = 0;
  while (s < out.length) {
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
  const b = message.readUInt8(2) === 1 ? decompress(message) : message;
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
        const s = b.toString("utf8", pos, end);
        pos = end + 1;
        return s;
      }
    }
    throw new Error(`no q type ${t}`);
  };
  const symbol = (): string => item(11) as string;
  const value = (): QValue => {
    const t = b.readInt8(pos++);
    if (t === -128) {
      throw new Error(symbol());
    }
    if (t < 0 && t >= -19 && t !== -3) {
      return { kind: "atom", t, v: item(-t) };
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
        const text = index === 0 && t === 101 ? undefined : PRIMITIVES[t - 101][index];
        return { kind: "func", t, ...(text !== undefined ? { text } : {}) };
      }
      if (t <= 105) {
        const n = b.readInt32LE(pos);
        pos += 4;
        for (let i = 0; i < n; i++) {
          value();
        }
      } else if (t <= 111) {
        value();
      } else {
        throw new Error(`q-lint cannot read a value of type ${t}`);
      }
      return { kind: "func", t };
    }
    const attr = b.readInt8(pos++);
    if (t === 98) {
      const dict = value();
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
    for (let i = 0; i < n; i++) {
      v[i] = item(t);
    }
    return { kind: "vector", t, attr, v };
  };
  return value();
}
