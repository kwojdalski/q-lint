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

test("a month outside years 1 to 9999 is written as KDB-X writes it (#1736)", () => {
  const { atomText, vectorText } = require("../out/qformat.js");
  // KDB-X: .Q.s1 "m"$200000 -30000 is "**66.09 0+00.01m".
  assert.strictEqual(vectorText([200000, -30000], 13), "**66.09 0+00.01m");
  const kdbx = {
    95988: "9999.01m", 96000: "**00.01m", 100000: "**33.05m", 2147483646: "**)0.0'm",
    "-23988": "0001.01m", "-23989": "0000.12m", "-24001": "0000.00m", "-24011": "0000./0m",
    "-24012": "000/.01m", "-25000": "00(-.0-m", "-100000": "*---.0-m", 0: "2000.01m", "-1": "1999.12m",
  };
  for (const [m, text] of Object.entries(kdbx)) {
    assert.strictEqual(atomText(Number(m), -13), text, m);
    assert.strictEqual(shown(int(-13, Number(m))), text, m);
  }
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

test("a decoded general column is ranked as q's iasc sorts it and differ splits it (#1756)", () => {
  const { gridOfQ } = require("../out/qformat.js");
  const chars = (s) => ({ kind: "chars", attr: 0, v: Buffer.from(s, "latin1") });
  const atom = (t, v) => ({ kind: "atom", t, v });
  const rank = (...items) => gridOfQ({ kind: "list", attr: 0, v: items }, 100).rank[0];
  // KDB-X: iasc ("bb";enlist "a";"ab") is 1 2 0, so the ranks are 2 0 1.
  assert.deepStrictEqual(rank(chars("bb"), chars("a"), chars("ab")), [2, 0, 1]);
  // Atoms before lists, atoms by type before value: iasc (10;2;3.5) is 1 0 2.
  assert.deepStrictEqual(rank(atom(-7, 10n), atom(-7, 2n), atom(-9, 3.5)), [1, 0, 2]);
  // (3;2.5;1i;7h;0x01;1b;2e): 1b 0x01 7h 1i 3 2e 2.5.
  assert.deepStrictEqual(rank(atom(-7, 3n), atom(-9, 2.5), atom(-6, 1), atom(-5, 7), atom(-4, 1), atom(-1, true), atom(-8, 2)), [4, 6, 3, 2, 1, 0, 5]);
  // A shorter list that starts the other first; a char atom before any list.
  assert.deepStrictEqual(rank(chars("abc"), chars("ab"), atom(-10, 98), chars("")), [3, 2, 0, 1]);
  // differ holds the first to its type's null: (0N;0Nd) ranks -1 0, and
  // enlist "" -1; equal items share a place.
  assert.deepStrictEqual(rank(atom(-7, null), atom(-14, null)), [-1, 0]);
  assert.deepStrictEqual(rank(chars("")), [-1]);
  assert.deepStrictEqual(rank(chars("a"), atom(-11, "x"), chars("a")), [1, 0, 1]);
  // iasc (`x;1) is a type error, so GRID sends no ranks.
  assert.deepStrictEqual(rank(atom(-11, "x"), atom(-7, 1n)), []);
});

test("a decoded table column of a dictionary is ranked by its rows, as GRID ranks it (#2073)", () => {
  const { gridOfQ } = require("../out/qformat.js");
  const syms = (v) => ({ kind: "vector", t: 11, attr: 0, v });
  const longs = (v) => ({ kind: "vector", t: 7, attr: 0, v });
  const table = (cols, data) => ({ kind: "table", attr: 0, cols, data });
  // KDB-X: GRID's ranks of `a`b`c!([]x:10 9 100) are 1 0 2, of
  // ([]x:1 1 0 1;y:`b`a`c`b) 2 1 0 2, of ([]x:0N 1 2) 0 1 2.
  const rank = (v) => gridOfQ({ kind: "dict", sorted: false, k: syms(v.data[0].v.map((_, i) => `k${i}`)), v }, 100).rank[1];
  assert.deepStrictEqual(rank(table(["x"], [longs([10n, 9n, 100n])])), [1, 0, 2]);
  assert.deepStrictEqual(rank(table(["x", "y"], [longs([1n, 1n, 0n, 1n]), syms(["b", "a", "c", "b"])])), [2, 1, 0, 2]);
  assert.deepStrictEqual(rank(table(["x"], [longs([null, 1n, 2n])])), [0, 1, 2]);
});

test("a long symbol in a general list is cut by code point in the grid and the tree (#1807)", () => {
  const { gridOfQ, treeOfQ } = require("../out/qformat.js");
  const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  const texts = (n) => [n.text, ...(n.children ?? []).flatMap(texts)];
  for (const k of [193, 194, 195, 196]) {
    const sym = { kind: "atom", t: -11, v: "a".repeat(k) + "😀😀😀😀" };
    const list = { kind: "list", attr: 0, v: [sym, { kind: "list", attr: 0, v: [sym] }] };
    const cells = gridOfQ(list, 10).cells[0];
    assert.ok(cells.every((c) => !lone(c)), String(k));
    assert.ok(texts(treeOfQ(list)).every((t) => !lone(t)), String(k));
  }
  // Counted by code point: 200 characters of which some are emoji are not cut.
  const short = { kind: "atom", t: -11, v: "😀".repeat(150) };
  assert.ok(!treeOfQ({ kind: "list", attr: 0, v: [short] }).children[0].text.endsWith("..."));
});

// A symbol list holding fewer symbols than its count never threw: each
// symbol past the last NUL read the message again from byte 0, until the
// extension host ran out of heap - in this decoder and in node-q's (#2136).
// Run in a child with a small heap, so a hang or an OOM fails the test
// rather than the test run.
test("no decoder reads past a message cut short or corrupted: it throws, at once (#2136)", { timeout: 60_000 }, () => {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const out = path.join(__dirname, "..", "out");
  const body = `
const { serialize, deserialize } = require(${JSON.stringify(require.resolve("node-q/lib/c.js"))});
const { decode, checkedBody } = require(${JSON.stringify(path.join(out, "qdecode.js"))});
const readers = [(m) => decode(m), (m) => deserialize(checkedBody(m), false, true, false, false)];
const tried = (m) => { for (const read of readers) { try { read(m); } catch {} } };
// The issue's message: a symbol list of 5e7 with no symbols in it, and the
// same for a general list and a char vector.
for (const t of [0, 10, 11]) {
  const m = Buffer.alloc(14); m[0] = 1; m[1] = 2; m.writeUInt32LE(14, 4); m[8] = t; m.writeUInt32LE(50_000_000, 10);
  for (const read of readers) { let threw = false; try { read(m); } catch { threw = true; } if (!threw) throw new Error("read type " + t); }
}
// A compressed message claiming 4 GB.
{ const m = Buffer.alloc(16); m[0] = 1; m[1] = 2; m[2] = 1; m.writeUInt32LE(16, 4); m.writeUInt32LE(0xffffffff, 8); tried(m); }
const values = [
  { s: ["abc", "de", "", "f"] }, [1, "two", [3, ["four"]], { k: "v" }], "a char vector", 42, [1.5, 2.5], { a: [1, 2], b: ["x", "y"] },
  Array.from({ length: 300 }, (_, i) => "sym" + i), new Date(0), true,
];
let seed = 2136;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (const v of values) {
  const whole = serialize(v);
  whole.writeUInt8(2, 1);
  for (const read of readers) read(whole);
  // Cut at every length, the header saying the length it has.
  for (let n = 9; n < whole.length; n++) {
    const m = Buffer.from(whole.subarray(0, n)); m.writeUInt32LE(n, 4); tried(m);
  }
  // Bytes changed at random: a count, a type, a NUL.
  for (let k = 0; k < 400; k++) {
    const m = Buffer.from(whole);
    for (let j = 0; j < 1 + Math.floor(random() * 3); j++) m[8 + Math.floor(random() * (m.length - 8))] = Math.floor(random() * 256);
    tried(m);
  }
}
`;
  const run = spawnSync(process.execPath, ["--max-old-space-size=128", "-e", body], { encoding: "utf8", timeout: 45_000 });
  assert.strictEqual(run.status, 0, `${run.signal ?? ""} ${run.stderr.slice(-800)}`);
});

test("a whole message is checked and given back uncompressed (#2136)", () => {
  const { checkedBody } = require("../out/qdecode.js");
  const m = message([0x0b, 0x00, 0x02, 0, 0, 0], "ab\0c\0");
  assert.strictEqual(checkedBody(m), m);
  assert.throws(() => checkedBody(message([0x0b, 0x00, 0x03, 0, 0, 0], "ab\0c\0")), /a message shorter than its list/);
  assert.throws(() => decode(message([0x0b, 0x00, 0x03, 0, 0, 0], "ab\0c\0")), /a message shorter than its list/);
  assert.throws(() => checkedBody(message([0x07, 0x00, 0x02, 0, 0, 0], Buffer.alloc(15))), /a message shorter than its list/);
});

test("a splayed or partitioned table, sent by reference, is refused as that, not shown as one row of its path (#2569)", async () => {
  const { ByReference } = require("../out/qdecode.js");
  const { runUnwrapped } = require("../out/querycontrols.js");
  // KDB-X: -8!pt of a partitioned pt, and -8!sp of a splayed sp mapped
  // from :db/sp/ - a table whose dictionary's value is a symbol.
  const pt = Buffer.from("010000001c0000006200630b000200000073796d00707800f5707400", "hex");
  const sp = Buffer.from("01000000200000006200630b000300000073006e006300f53a64622f73702f00", "hex");
  assert.throws(() => decode(pt), (e) => e instanceof ByReference && /by reference \(its name `pt\)/.test(e.message));
  assert.throws(() => decode(sp), (e) => e instanceof ByReference && /by reference \(its path `:db\/sp\/\)/.test(e.message));
  // The codec makes the path characters: never shown.
  const fake = { evaluate: async () => ({ value: { s: [":"], n: ["."], c: ["/"] }, type: 98, message: sp }) };
  const answer = await runUnwrapped(fake, ["sp"], { size: [25, 80], limit: 10, unlimited: false, grid: true });
  assert.strictEqual(answer.ok, false);
  assert.match(answer.error, /select from it/);
});

test("a projection, composition or derived function is written as -3! writes it, from the parts q sends (#2477)", () => {
  // KDB-X: each -8! of the value, and its -3!.
  const cases = [
    ["0100000023000000680200000064000a00050000007b782b797df90100000000000000", "{x+y}[1]"],
    ["0100000030000000680400000064000a00070000007b782b792b7a7df9010000000000000065fff90300000000000000", "{x+y+z}[1;;3]"],
    ["010000001800000068020000006601f90100000000000000", "+[1]"],
    ["010000000b0000006b6601", "+/"],
    ["0100000011000000690200000065026519", "-sum"],
    ["0100000023000000690200000064000a00030000007b787d64000a00030000007b797d", "{x}{y}"],
    ["01000000140000006a64000a00030000007b787d", "{x}'"],
    ["010000001f00000068020000006471000a00070000006b297b7827797d6601", "k){x'y}[+]"],
    ["010000000b0000006e660c", ",/:"],
    ["010000000b0000006c6601", "+\\"],
    ["010000000b0000006d6601", "+':"],
    ["010000000b0000006f660c", ",\\:"],
    ["010000001a0000006803000000651965fff90100000000000000", "sum[;1]"],
    ["0100000021000000690200000065026902000000651964000a00030000007b787d", "-sum{x}"],
    ["010000001d000000680200000064000a00050000007b782b797df56100", "{x+y}[`a]"],
    ["0100000022000000680200000064000a00050000007b782b797d0a00020000006162", '{x+y}["ab"]'],
    ["0100000030000000680200000064000a00050000007b782b797d07000200000001000000000000000200000000000000", "{x+y}[1 2]"],
    ["01000000190000006b68020000006601f90100000000000000", "+[1]/"],
    ["0100000011000000690200000066016602", "+-"],
    ["010000002c000000680200000064000a00050000007b782a797d000002000000f90100000000000000f56100", "{x*y}[(1;`a)]"],
    ["010000001a00000068030000006529f9010000000000000065ff", "enlist[1;]"],
    ["0100000025000000680300000064000a00050000007b782b797d65fff90200000000000000", "{x+y}[;2]"],
    ["010000000b0000006a6502", "-:'"],
    ["010000001f00000069020000006802000000660df902000000000000006502", "#[2]-:"],
    ["0100000023000000680200000064000a00050000007b782b797df7000000000000f83f", "{x+y}[1.5]"],
  ];
  for (const [hex, text] of cases) {
    assert.strictEqual(formatQ(decode(Buffer.from(hex, "hex")), undefined).join("\n"), text, hex);
  }
  // In a list, and a live value's one line, the same.
  const { oneLine } = require("../out/qformat.js");
  assert.strictEqual(oneLine(decode(message("\x00\x00", Buffer.from([2, 0, 0, 0]), Buffer.from("6b6601", "hex"), Buffer.from("6a6502", "hex")))), "(+/;-:')");
});

/// What Copy as q writes of the direct grid of the value `-8!` gave as `hex`.
function copied(hex) {
  const { gridOfQ } = require("../out/qformat.js");
  const { tableLiteral } = require("../out/qliteral.js");
  const grid = gridOfQ(decode(Buffer.from(hex, "hex")), 100);
  return { cells: grid.cells, literal: tableLiteral(grid).code };
}

test("a symbol past UTF-8 shows its bytes' characters and copies as them, as the wrapped grid does (#2578)", () => {
  // KDB-X: -8!([] a:`$("caf\351";"b")), -8!([] a:(`$"caf\351";1)), -8!([] a:(`$("caf\351";"x");1))
  assert.deepStrictEqual(copied("01000000260000006200630b000100000061000000010000000b0002000000636166e9006200"), {
    cells: [["café", "b"]],
    literal: '([] a:(`$"caf\\351";`b))',
  });
  assert.deepStrictEqual(copied("010000002e0000006200630b00010000006100000001000000000002000000f5636166e900f90100000000000000"), {
    cells: [["`café", "1"]],
    literal: '([] a:(`$"caf\\351";1))',
  });
  assert.strictEqual(copied("01000000350000006200630b000100000061000000010000000000020000000b0002000000636166e9007800f90100000000000000").literal, '([] a:((`$"caf\\351";`x);1))');
  // A UTF-8 symbol is its characters still.
  assert.strictEqual(shown(Buffer.from("f563c3a900", "hex")), "`cé");
});

test("a general column's time q cannot read back as -3! writes it copies as a cast from its count, as the wrapped grid does (#2579)", () => {
  // KDB-X: -8! of each table, and the literal q reads back as it (~).
  const cases = [
    ["010000002a0000006200630b000100000061000000010000000000020000000a0000000000efe02e0000", '([] a:("";"u"$12000i))'],
    ["010000002d0000006200630b00010000006100000001000000000002000000ed002a7515f90100000000000000", '([] a:("t"$360000000i;1))'],
    ["01000000310000006200630b00010000006100000001000000000002000000f90100000000000000f12ab3f798be11f440", '([] a:(1;"z"$82203.9123456))'],
    ["01000000310000006200630b00010000006100000001000000000002000000f90100000000000000f400006862be085380", '([] a:(1;"p"$-9200000000000000000))'],
    // One q reads back is written as -3! writes it.
    ["01000000310000006200630b00010000006100000001000000000002000000f90100000000000000f40000000000000000", "([] a:(1;2000.01.01D00:00:00.000000000))"],
  ];
  for (const [hex, literal] of cases) {
    assert.strictEqual(copied(hex).literal, literal, hex);
  }
});

test("a dictionary of a table's rows shows each row's values as q makes them, a simple list of one type (#2582)", () => {
  const { gridOfQ } = require("../out/qformat.js");
  const syms = (...v) => ({ kind: "vector", t: 11, attr: 0, v });
  const table = (cols, ...data) => ({ kind: "table", attr: 0, cols, data });
  const longs = (...v) => ({ kind: "vector", t: 7, attr: 0, v: v.map(BigInt) });
  // `a`b!([] x:1 2; y:3 4), `a`b!([] s:`x`y; t:`p`q), `a`b!([] c:"ab"; n:1 2)
  const cells = (v) => gridOfQ({ kind: "dict", sorted: false, k: syms("a", "b"), v }, 10).cells[1];
  assert.deepStrictEqual(cells(table(["x", "y"], longs(1, 2), longs(3, 4))), ["`x`y!1 3", "`x`y!2 4"]);
  assert.deepStrictEqual(cells(table(["s", "t"], syms("x", "y"), syms("p", "q"))), ["`s`t!`x`p", "`s`t!`y`q"]);
  assert.deepStrictEqual(cells(table(["c", "n"], { kind: "chars", attr: 0, v: Buffer.from("ab") }, longs(1, 2))), ['`c`n!("a";1)', '`c`n!("b";2)']);
});

test("a direct grid ranks dictionaries item by item, and equal (::) cells as one null, as q ranks them (#2575, #2576)", () => {
  const { gridOfQ } = require("../out/qformat.js");
  const syms = (...v) => ({ kind: "vector", t: 11, attr: 0, v });
  const dict = (v) => ({ kind: "dict", sorted: false, k: syms("a", "b"), v });
  const rank = (q) => gridOfQ(q, 100).rank;
  // ([] a:((`a`b!1 2);`a`b!(1;`x))): q's iasc is 0 1.
  const simple = dict({ kind: "vector", t: 7, attr: 0, v: [1n, 2n] });
  const general = dict({ kind: "list", attr: 0, v: [{ kind: "atom", t: -7, v: 1n }, { kind: "atom", t: -11, v: "x" }] });
  assert.deepStrictEqual(rank({ kind: "table", attr: 0, cols: ["a"], data: [{ kind: "list", attr: 0, v: [simple, general] }] }), [[0, 1]]);
  // (::;::): both one null, as GRID ranks them.
  const nil = { kind: "func", t: 101 };
  assert.deepStrictEqual(rank({ kind: "list", attr: 0, v: [nil, nil] }), [[-1, -1]]);
  // A projection the same as another is one value.
  const p = (n) => ({ kind: "func", t: 104, parts: [{ kind: "func", t: 100, text: "{x+y}" }, { kind: "atom", t: -7, v: BigInt(n) }] });
  assert.deepStrictEqual(rank({ kind: "list", attr: 0, v: [p(1), p(1), p(2)] }), [[0, 0, 1]]);
});
