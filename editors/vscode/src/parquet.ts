// A result as an Apache Parquet file, written by hand: one row group, one
// uncompressed PLAIN data page (v1) per column, and the footer's metadata
// in Thrift's compact protocol, as parquet-format's parquet.thrift defines
// it. Small enough to need no library, and read by pyarrow, DuckDB and
// Spark alike.
//
// A column is typed as Parquet types it, so a reader computes with it:
//
//   boolean            BOOLEAN
//   byte, short, int   INT32 (byte unsigned 8-bit, short signed 16-bit)
//   long               INT64
//   real, float        FLOAT, DOUBLE
//   date               INT32 DATE (days since 1970.01.01)
//   timestamp          INT64 TIMESTAMP(NANOS), not adjusted to UTC: q's
//                      timestamps carry no zone
//   datetime           INT64 TIMESTAMP(MILLIS), likewise
//   anything else      BYTE_ARRAY STRING, as q writes it: a symbol, a guid,
//                      a char, a month, a timespan, a minute, a second, a
//                      time, an item of a general list (a string's
//                      characters, any other item as q writes it)
//
// Every column but a boolean, a byte and a char is OPTIONAL, so q's nulls are
// Parquet's. An integer's or a float's infinity is the value q holds for
// it (`0W` is 2^63-1); an infinite date or timestamp, which Parquet's types
// cannot hold, is written as a null, and the notes say how many were.
import type { GridPayload } from "./grid";
import { distinctNames, plainItem, rawColumn, textNull } from "./qliteral";

// --- Thrift's compact protocol, the little of it a footer needs

const T = { TRUE: 1, FALSE: 2, BYTE: 3, I32: 5, I64: 6, BINARY: 8, LIST: 9, STRUCT: 12 } as const;

/// A struct's field: its id, and how its value is written.
type Field = [id: number, value: Value];
type Value =
  | { i32: number }
  | { i64: bigint }
  | { byte: number }
  | { bool: boolean }
  | { str: string }
  | { struct: Field[] }
  | { list: Value[]; of: number };

class Writer {
  private readonly bytes: number[] = [];

  varint(n: bigint): void {
    let v = n;
    while (v >= 0x80n) {
      this.bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.bytes.push(Number(v));
  }

  zigzag(n: bigint): void {
    this.varint(n >= 0n ? n << 1n : (-n << 1n) - 1n);
  }

  byte(b: number): void {
    this.bytes.push(b & 0xff);
  }

  struct(fields: Field[]): void {
    let last = 0;
    for (const [id, value] of fields) {
      const type = typeOf(value);
      const delta = id - last;
      if (delta > 0 && delta <= 15) {
        this.byte((delta << 4) | type);
      } else {
        this.byte(type);
        this.zigzag(BigInt(id));
      }
      // A field's boolean is its header's type, with no byte after it.
      if (!("bool" in value)) {
        this.value(value);
      }
      last = id;
    }
    this.byte(0);
  }

  value(value: Value): void {
    if ("i32" in value) {
      this.zigzag(BigInt(value.i32));
    } else if ("i64" in value) {
      this.zigzag(value.i64);
    } else if ("byte" in value) {
      this.byte(value.byte);
    } else if ("bool" in value) {
      // Only a list's boolean comes here, as a byte.
      this.byte(value.bool ? T.TRUE : T.FALSE);
    } else if ("str" in value) {
      const b = Buffer.from(value.str, "utf8");
      this.varint(BigInt(b.length));
      b.forEach((x) => this.byte(x));
    } else if ("struct" in value) {
      this.struct(value.struct);
    } else {
      const n = value.list.length;
      this.byte(n < 15 ? (n << 4) | value.of : 0xf0 | value.of);
      if (n >= 15) {
        this.varint(BigInt(n));
      }
      value.list.forEach((v) => this.value(v));
    }
  }

  buffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

function typeOf(value: Value): number {
  if ("i32" in value) return T.I32;
  if ("i64" in value) return T.I64;
  if ("byte" in value) return T.BYTE;
  if ("bool" in value) return value.bool ? T.TRUE : T.FALSE;
  if ("str" in value) return T.BINARY;
  if ("struct" in value) return T.STRUCT;
  return T.LIST;
}

/// A struct as Thrift's compact protocol writes it.
function thrift(fields: Field[]): Buffer {
  const w = new Writer();
  w.struct(fields);
  return w.buffer();
}

// --- Parquet

const TYPE = { BOOLEAN: 0, INT32: 1, INT64: 2, FLOAT: 4, DOUBLE: 5, BYTE_ARRAY: 6 } as const;
const CONVERTED = { UTF8: 0, DATE: 6, UINT_8: 11, INT_16: 16 } as const;
const PLAIN = 0;
const RLE = 3;

/// How one q column is written: its Parquet type, its schema element's
/// converted and logical types, and each value's bytes.
interface Plan {
  type: number;
  converted?: number;
  logical?: Field[];
  optional: boolean;
}

/// A LogicalType union: STRING (1), DATE (6), TIMESTAMP (8), INTEGER (10).
const LOGICAL = {
  string: [[1, { struct: [] }]] as Field[],
  date: [[6, { struct: [] }]] as Field[],
  timestamp: (unit: 1 | 3): Field[] => [[8, { struct: [[1, { bool: false }], [2, { struct: [[unit, { struct: [] }]] }]] }]],
  integer: (bits: number, signed: boolean): Field[] => [[10, { struct: [[1, { byte: bits }], [2, { bool: signed }]] }]],
};

export function planFor(type: number): Plan {
  switch (type) {
    case 1:
      return { type: TYPE.BOOLEAN, optional: false };
    case 4:
      return { type: TYPE.INT32, converted: CONVERTED.UINT_8, logical: LOGICAL.integer(8, false), optional: false };
    case 5:
      return { type: TYPE.INT32, converted: CONVERTED.INT_16, logical: LOGICAL.integer(16, true), optional: true };
    case 6:
      return { type: TYPE.INT32, optional: true };
    case 7:
      return { type: TYPE.INT64, optional: true };
    case 8:
      return { type: TYPE.FLOAT, optional: true };
    case 9:
      return { type: TYPE.DOUBLE, optional: true };
    case 14:
      return { type: TYPE.INT32, converted: CONVERTED.DATE, logical: LOGICAL.date, optional: true };
    case 12:
      return { type: TYPE.INT64, logical: LOGICAL.timestamp(3), optional: true };
    case 15:
      return { type: TYPE.INT64, logical: LOGICAL.timestamp(1), optional: true };
    case 10:
      return { type: TYPE.BYTE_ARRAY, converted: CONVERTED.UTF8, logical: LOGICAL.string, optional: false };
    default:
      return { type: TYPE.BYTE_ARRAY, converted: CONVERTED.UTF8, logical: LOGICAL.string, optional: true };
  }
}

const INT32_MAX = 2147483647;
const INT64_MAX = 9223372036854775807n;
/// 2000.01.01 in Unix days and nanoseconds.
const EPOCH_DAYS = 10957;
const EPOCH_NANOS = 946684800000000000n;
const EPOCH_MILLIS = 946684800000n;

/// A value as the column's plan writes it, or null for a null. `lost`
/// counts infinities written as null.
function valueOf(type: number, text: string, raw: unknown, lost: { n: number }): number | bigint | boolean | string | null {
  if (raw === null || textNull(type, text)) {
    return null;
  }
  const infinite = raw === Infinity || raw === -Infinity;
  const sign = raw === -Infinity ? -1 : 1;
  switch (type) {
    case 1:
      return text === "1";
    case 4:
      return parseInt(text, 16);
    case 5:
      return infinite ? sign * 32767 : Number(raw ?? text);
    case 6:
      return infinite ? sign * INT32_MAX : Number(raw ?? text);
    case 7:
      return infinite ? BigInt(sign) * INT64_MAX : BigInt(String(raw ?? text));
    case 8:
    case 9:
      return Number(raw);
    case 14:
    case 12:
    case 15:
      if (infinite || raw === undefined) {
        lost.n += infinite ? 1 : 0;
        return infinite ? null : text;
      }
      if (type === 14) {
        return Number(raw) + EPOCH_DAYS;
      }
      if (type === 12) {
        return BigInt(String(raw)) + EPOCH_NANOS;
      }
      return BigInt(Math.round(Number(raw) * 864e5)) + EPOCH_MILLIS;
    case 0:
      return plainItem(text);
    default:
      return text;
  }
}

/// The non-null values in PLAIN encoding.
function plain(type: number, values: (number | bigint | boolean | string)[]): Buffer {
  switch (type) {
    case TYPE.BOOLEAN: {
      const b = Buffer.alloc(Math.ceil(values.length / 8));
      values.forEach((v, i) => {
        if (v) {
          b[i >> 3] |= 1 << (i & 7);
        }
      });
      return b;
    }
    case TYPE.INT32: {
      const b = Buffer.alloc(4 * values.length);
      values.forEach((v, i) => b.writeInt32LE(Number(v), 4 * i));
      return b;
    }
    case TYPE.INT64: {
      const b = Buffer.alloc(8 * values.length);
      values.forEach((v, i) => b.writeBigInt64LE(BigInt(v as bigint | number), 8 * i));
      return b;
    }
    case TYPE.FLOAT: {
      const b = Buffer.alloc(4 * values.length);
      values.forEach((v, i) => b.writeFloatLE(Number(v), 4 * i));
      return b;
    }
    case TYPE.DOUBLE: {
      const b = Buffer.alloc(8 * values.length);
      values.forEach((v, i) => b.writeDoubleLE(Number(v), 8 * i));
      return b;
    }
    default: {
      const parts: Buffer[] = [];
      values.forEach((v) => {
        const s = Buffer.from(String(v), "utf8");
        const n = Buffer.alloc(4);
        n.writeUInt32LE(s.length, 0);
        parts.push(n, s);
      });
      return Buffer.concat(parts);
    }
  }
}

/// Definition levels (0 null, 1 present) in the RLE/bit-packing hybrid,
/// as runs, after the 4-byte length a data page v1 puts first.
export function definitionLevels(present: boolean[]): Buffer {
  const w = new Writer();
  for (let i = 0; i < present.length; ) {
    let j = i;
    while (j < present.length && present[j] === present[i]) {
      j++;
    }
    w.varint(BigInt(j - i) << 1n);
    w.byte(present[i] ? 1 : 0);
    i = j;
  }
  const runs = w.buffer();
  const n = Buffer.alloc(4);
  n.writeUInt32LE(runs.length, 0);
  return Buffer.concat([n, runs]);
}

/// The rows `order` of the payload as a Parquet file.
export function toParquet(payload: GridPayload, order: number[]): { data: Buffer; notes: string[] } {
  const names = distinctNames(payload.names);
  const parts: Buffer[] = [Buffer.from("PAR1")];
  let offset = 4;
  const lost = { n: 0 };
  const chunks: Value[] = [];
  const schema: Value[] = [{ struct: [[4, { str: "schema" }], [5, { i32: names.length }]] }];
  let total = 0;
  payload.names.forEach((_, i) => {
    const type = payload.types[i];
    const plan = planFor(type);
    const raw = rawColumn(payload, i);
    const cells = payload.cells[i];
    const values = order.map((r) => valueOf(type, cells[r] ?? "", raw === undefined ? undefined : raw[r], lost));
    // A temporal sent without its number (it never is) falls back to text.
    const text = values.some((v) => typeof v === "string") && plan.type !== TYPE.BYTE_ARRAY;
    const used = text ? planFor(-1) : plan;
    const kept = (text ? order.map((r, k) => (values[k] === null ? null : cells[r])) : values) as (number | bigint | boolean | string | null)[];
    // A required column cannot hold a null; a char's blank is a space.
    const filled = used.optional ? kept : kept.map((v) => (v === null ? (used.type === TYPE.BOOLEAN ? false : used.type === TYPE.INT32 ? 0 : " ") : v));
    const present = filled.map((v) => v !== null);
    const body = Buffer.concat([
      ...(used.optional ? [definitionLevels(present)] : []),
      plain(used.type, filled.filter((v): v is number | bigint | boolean | string => v !== null)),
    ]);
    const header = thrift([
      [1, { i32: 0 }], // DATA_PAGE
      [2, { i32: body.length }],
      [3, { i32: body.length }],
      [5, { struct: [[1, { i32: order.length }], [2, { i32: PLAIN }], [3, { i32: RLE }], [4, { i32: RLE }]] }],
    ]);
    const start = offset;
    parts.push(header, body);
    const size = header.length + body.length;
    offset += size;
    total += size;
    chunks.push({
      struct: [
        [2, { i64: BigInt(start) }],
        [
          3,
          {
            struct: [
              [1, { i32: used.type }],
              [2, { list: [{ i32: PLAIN }, { i32: RLE }], of: T.I32 }],
              [3, { list: [{ str: names[i] }], of: T.BINARY }],
              [4, { i32: 0 }], // UNCOMPRESSED
              [5, { i64: BigInt(order.length) }],
              [6, { i64: BigInt(size) }],
              [7, { i64: BigInt(size) }],
              [9, { i64: BigInt(start) }],
            ],
          },
        ],
      ],
    });
    schema.push({
      struct: [
        [1, { i32: used.type }],
        [3, { i32: used.optional ? 1 : 0 }],
        [4, { str: names[i] }],
        ...(used.converted !== undefined ? ([[6, { i32: used.converted }]] as Field[]) : []),
        ...(used.logical !== undefined ? ([[10, { struct: used.logical }]] as Field[]) : []),
      ],
    });
  });
  const footer = thrift([
    [1, { i32: 1 }],
    [2, { list: schema, of: T.STRUCT }],
    [3, { i64: BigInt(order.length) }],
    [
      4,
      {
        list: [{ struct: [[1, { list: chunks, of: T.STRUCT }], [2, { i64: BigInt(total) }], [3, { i64: BigInt(order.length) }]] }],
        of: T.STRUCT,
      },
    ],
    [6, { str: "q-lint" }],
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(footer.length, 0);
  parts.push(footer, length, Buffer.from("PAR1"));
  const notes = lost.n > 0 ? [`${lost.n} infinite date(s) or timestamp(s) were written as null: Parquet's types cannot hold them`] : [];
  return { data: Buffer.concat(parts), notes };
}
