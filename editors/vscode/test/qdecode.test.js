// The decoder of q's IPC bytes (src/qdecode.ts) and what the console
// formatter (src/qformat.ts) makes of what it decodes, on messages built
// here byte by byte, each as KDB-X sends it. Run after `tsc`.
const test = require("node:test");
const assert = require("node:assert");
const { decode } = require("../out/qdecode.js");
const { formatQ } = require("../out/qformat.js");

/// A whole message: the 8-byte header, then `body`.
function message(...body) {
  const b = Buffer.concat(body.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))));
  const head = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
  head.writeInt32LE(8 + b.length, 4);
  return Buffer.concat([head, b]);
}

function long(n) {
  const b = Buffer.alloc(9);
  b.writeInt8(-7, 0);
  b.writeBigInt64LE(BigInt(n), 1);
  return b;
}

/// What the console shows for the value `body` encodes.
function shown(...body) {
  return formatQ(decode(message(...body)), undefined).join("\n");
}

test("a primitive shows as q prints it, not as (::) (#1232)", () => {
  // KDB-X: count is unary 13, `#:`; neg unary 2, `-:`; + binary 1; / iterator 1.
  assert.strictEqual(shown([0x65, 13]), "#:");
  assert.strictEqual(shown([0x65, 2]), "-:");
  assert.strictEqual(shown([0x65, 41]), "enlist");
  assert.strictEqual(shown([0x66, 1]), "+");
  assert.strictEqual(shown([0x66, 23]), "in");
  assert.strictEqual(shown([0x67, 1]), "/");
  // (neg;1), as .Q.s1 shows it: (-:;1).
  const list = formatQ(decode(message([0, 0, 2, 0, 0, 0], [0x65, 2], long(1))), undefined);
  assert.ok(list.some((l) => l.includes("-:")), list.join("\n"));
  assert.ok(!list.some((l) => l.includes("::")), list.join("\n"));
  // The generic null is unary 0, and still (::).
  assert.strictEqual(formatQ(decode(message([0x65, 0])), undefined, 101).join(""), "::");
});

/// A simple vector of q type `t`, each item written by `put`.
function vector(t, size, put, items) {
  const b = Buffer.alloc(6 + size * items.length);
  b.writeInt8(t, 0);
  b.writeInt32LE(items.length, 2);
  items.forEach((x, i) => put(b, x, 6 + size * i));
  return b;
}
const longs = (t, items) => vector(t, 8, (b, x, at) => b.writeBigInt64LE(x, at), items);
const floats = (items) => vector(9, 8, (b, x, at) => b.writeDoubleLE(x, at), items);

test("the unwrapped grid ranks longs and timestamps exactly, and a null below -0W and -0w (#1233)", () => {
  const { gridOfQ } = require("../out/qformat.js");
  const NULL = -(2n ** 63n);
  // Two timestamps 1ns apart, which Number() made one; the null, then -0W.
  const ts = gridOfQ(decode(message(longs(12, [1700000000000000001n, 1700000000000000000n, NULL, NULL + 1n]))), 100);
  assert.deepStrictEqual(ts.rank[0], [3, 2, 0, 1]);
  const js = gridOfQ(decode(message(longs(7, [2n ** 62n + 1n, 2n ** 62n]))), 100);
  assert.deepStrictEqual(js.rank[0], [1, 0]);
  // 0n is below -0w, as q's iasc puts it.
  const fs = gridOfQ(decode(message(floats([1, -Infinity, NaN]))), 100);
  assert.deepStrictEqual(fs.rank[0], [2, 1, 0]);
});

function atom(t, size, put, x) {
  const b = Buffer.alloc(1 + size);
  b.writeInt8(t, 0);
  put(b, x, 1);
  return b;
}
const int = (t, x) => atom(t, 4, (b, v, at) => b.writeInt32LE(v, at), x);
const float = (x) => atom(-9, 8, (b, v, at) => b.writeDoubleLE(v, at), x);

test("a year before 1000 is written in four digits, as q writes it (#1235)", () => {
  const { atomText } = require("../out/qformat.js");
  // KDB-X: 0001.01.01 is day -730119, 0001.01m month -23988.
  assert.strictEqual(shown(int(-14, -730119)), "0001.01.01");
  assert.strictEqual(shown(int(-13, -23988)), "0001.01m");
  assert.strictEqual(shown(vector(14, 4, (b, x, at) => b.writeInt32LE(x, at), [-693961, -365607])), "0099.12.31 0999.01.01");
  assert.strictEqual(atomText(-730119, -14), "0001.01.01");
  // A Date, as node-q decodes one: Date.UTC reads year 1 as 1901, so it is set.
  const d = new Date(0);
  d.setUTCFullYear(1, 0, 1);
  assert.strictEqual(atomText(d, -14), "0001.01.01");
  assert.strictEqual(atomText(d, -13), "0001.01m");
});

test("a date or datetime outside years 1 to 9999 is 0000.00.00, as KDB-X writes it (#1498)", () => {
  const { atomText } = require("../out/qformat.js");
  // KDB-X: "d"$1700000000i and "d"$2921940i are 0000.00.00; 2921939 is 9999.12.31.
  assert.strictEqual(shown(int(-14, 1700000000)), "0000.00.00");
  assert.strictEqual(shown(int(-14, -348563124)), "0000.00.00");
  assert.strictEqual(shown(int(-14, 2921940)), "0000.00.00");
  assert.strictEqual(shown(int(-14, 2921939)), "9999.12.31");
  assert.strictEqual(shown(int(-14, -730120)), "0000.00.00");
  assert.strictEqual(atomText(1700000000, -14), "0000.00.00");
  // KDB-X: "z"$1e8 is 0000.00.00T00:00:00.000.
  const datetime = (x) => atom(-15, 8, (b, v, at) => b.writeDoubleLE(v, at), x);
  assert.strictEqual(shown(datetime(1e8)), "0000.00.00T00:00:00.000");
  assert.strictEqual(shown(datetime(3000000.25)), "0000.00.00T00:00:00.000");
  assert.strictEqual(shown(datetime(2921939.5)), "9999.12.31T12:00:00.000");
});

test("negative zero keeps its sign: KDB-X shows -0f (#1236)", () => {
  const { atomText } = require("../out/qformat.js");
  assert.strictEqual(shown(float(-0)), "-0f");
  assert.strictEqual(shown(floats([1, -0])), "1 -0f");
  assert.strictEqual(atomText(-0, -9), "-0f");
  assert.strictEqual(shown(float(0)), "0f");
});

test("a decoded result ranks text in code point order, as q sorts it: an emoji after U+FF21 (#1747)", () => {
  const { gridOf, gridOfQ } = require("../out/qformat.js");
  const syms = ["\u{1F600}", "Ａ", "b"];
  // q: iasc of them is 2 1 0.
  assert.deepStrictEqual(gridOfQ({ kind: "table", attr: 0, cols: ["s"], data: [{ kind: "vector", t: 11, attr: 0, v: syms }] }, 100).rank, [[2, 1, 0]]);
  assert.deepStrictEqual(gridOf(syms, 11, 100).rank, [[2, 1, 0]]);
});
