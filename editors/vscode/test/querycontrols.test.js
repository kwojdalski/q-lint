// Query controls (#887): values formatted client-side for unwrapped and
// unlimited queries, the rows of a grid made from one, what an unwrapped
// query sends and answers, and a file's own connection. Run after `tsc`;
// nothing here needs an editor or a q process (querycontrols_q.test.js
// drives a real one).
const test = require("node:test");
const assert = require("node:assert");
const Long = require("long");
const { atomText, cellText, consoleLines, cutLines, floatText, formatValue, gridOf, vectorText } = require("../out/qformat.js");
const {
  UNLIMITED,
  UNLIMITED_ROWS,
  bindingFor,
  bindingText,
  flagsText,
  limits,
  readUnlimited,
  runUnwrapped,
  timedOutError,
  withBinding,
} = require("../out/querycontrols.js");
const { QError } = require("../out/qclient.js");
const { toGrid } = require("../out/grid.js");
const { deserialize } = require("node-q/lib/c.js");

const day = (y, m, d, ms = 0) => new Date(Date.UTC(y, m - 1, d) + ms);
/// A q time as the codec makes it: 2000.01.01 plus the time.
const time = (ms) => new Date(Date.UTC(2000, 0, 1) + ms);

test("atoms are written as q writes them, suffix and nulls included", () => {
  assert.strictEqual(atomText(Long.fromString("9007199254740993"), -7), "9007199254740993");
  assert.strictEqual(atomText(null, -7), "0N");
  assert.strictEqual(atomText(Infinity, -7), "0W");
  assert.strictEqual(atomText(2, -6), "2i");
  assert.strictEqual(atomText(null, -6), "0Ni");
  assert.strictEqual(atomText(3, -5), "3h");
  assert.strictEqual(atomText(3.14159265358979, -9), "3.141593");
  assert.strictEqual(atomText(2, -9), "2f");
  assert.strictEqual(atomText(null, -9), "0n");
  assert.strictEqual(atomText(-Infinity, -9), "-0w");
  assert.strictEqual(atomText(1.5, -8), "1.5e");
  assert.strictEqual(atomText(true, -1), "1b");
  assert.strictEqual(atomText(255, -4), "0xff");
  assert.strictEqual(atomText("abc", -11), "`abc");
  assert.strictEqual(atomText(null, -11), "`");
  assert.strictEqual(atomText("a", -10), '"a"');
  assert.strictEqual(atomText(day(2026, 11, 20), -14), "2026.11.20");
  assert.strictEqual(atomText(null, -14), "0Nd");
  assert.strictEqual(atomText(day(2026, 11, 1), -13), "2026.11m");
  assert.strictEqual(atomText(day(2026, 11, 20, 36_672_123), -15), "2026.11.20T10:11:12.123");
  assert.strictEqual(atomText(time(36_672_123), -19), "10:11:12.123");
  assert.strictEqual(atomText(time(36_672_000), -18), "10:11:12");
  assert.strictEqual(atomText(time(36_660_000), -17), "10:11");
  assert.strictEqual(atomText(Long.fromString("-3723000000001"), -16), "-0D01:02:03.000000001");
  // A timestamp arrives as a float of nanoseconds since 1970.
  const ns = (Date.UTC(2026, 10, 20, 10, 11, 12) + 123) * 1e6;
  assert.strictEqual(atomText(ns, -12), "2026.11.20D10:11:12.123000000");
  assert.strictEqual(atomText(ns + 456789, -12), "2026.11.20D10:11:12.123457000");
});

test("simple lists are written as q writes them", () => {
  assert.strictEqual(vectorText([Long.fromInt(1), null, Infinity], 7), "1 0N 0W");
  assert.strictEqual(vectorText([1, 2], 6), "1 2i");
  assert.strictEqual(vectorText([1, 2], 9), "1 2f");
  assert.strictEqual(vectorText([1.5, null], 9), "1.5 0n");
  assert.strictEqual(vectorText([true, false, true], 1), "101b");
  assert.strictEqual(vectorText([1, 255], 4), "0x01ff");
  assert.strictEqual(vectorText(["a", "b", null], 11), "`a`b`");
  assert.strictEqual(vectorText("ab\"c", 10), '"ab\\"c"');
  assert.strictEqual(vectorText("a", 10), ',"a"');
  assert.strictEqual(vectorText([Long.fromInt(7)], 7), ",7");
  assert.strictEqual(vectorText([], 7), "`long$()");
  assert.strictEqual(vectorText([day(2026, 11, 20), null], 14), "2026.11.20 0N");
  assert.strictEqual(vectorText([day(2026, 11, 1), day(2026, 12, 1)], 13), "2026.11 2026.12m");
});

/// What the codec makes of a message q serialized (`-8!x`, as hex), and its
/// q type, as an uncompressed answer gives them to `formatValue`.
const decoded = (hex) => {
  const b = Buffer.from(hex, "hex");
  return { value: deserialize(b, false, true, false, false), type: b.readInt8(8) };
};
const shown = (hex) => {
  const { value, type } = decoded(hex);
  return formatValue(value, type);
};

test("temporal infinities are written as q writes them, not NaN (#894)", () => {
  // The codec makes a temporal infinity an invalid Date, and keeps a
  // timestamp's and a timespan's as Infinity.
  assert.deepStrictEqual(shown("0100000011000000f4ffffffffffffff7f"), ["0Wp"]);
  assert.deepStrictEqual(shown("0100000011000000f0ffffffffffffff7f"), ["0Wn"]);
  assert.deepStrictEqual(shown("010000000d000000f2ffffff7f"), ["0Wd"]);
  assert.deepStrictEqual(shown("0100000011000000f1000000000000f07f"), ["0wz"]);
  assert.deepStrictEqual(shown("010000000d000000edffffff7f"), ["0Wt"]);
  assert.deepStrictEqual(shown("010000000d000000f3ffffff7f"), ["0Wm"]);
  assert.deepStrictEqual(shown("010000000d000000efffffff7f"), ["0Wu"]);
  assert.deepStrictEqual(shown("010000000d000000eeffffff7f"), ["0Wv"]);
  assert.deepStrictEqual(shown("01000000160000000e0002000000891c0000ffffff7f"), ["2020.01.01 0W"]);
  const table = "010000003f0000006200630b000200000064007a000000020000000e0002000000891c0000ffffff7f0f00020000000000000000000000000000000000f07f";
  // In a table the column's type is guessed: a datetime at midnight is a
  // Date as a date is, and its infinity an invalid Date, so both read as dates.
  assert.deepStrictEqual(shown(table), ["d          z", "---------------------", "2020.01.01 2000.01.01", "0W         0W"]);
  const { value } = decoded(table);
  const grid = gridOf(value, 98, 10);
  assert.deepStrictEqual(grid.cells, [["2020.01.01", "0W"], ["2000.01.01", "0W"]]);
  assert.deepStrictEqual(grid.raw[0], [7305, Infinity]);
});

test("a null in a real list is 0N, as q writes it: 1 0Ne, not 1 0ne (#894)", () => {
  assert.deepStrictEqual(shown("01000000160000000800020000000000803f0000c07f"), ["1 0Ne"]);
  assert.strictEqual(vectorText([null, null], 8), "0N 0Ne");
  // A float list's null stays 0n, and an infinity 0w in both.
  assert.strictEqual(vectorText([2, null, Infinity], 9), "2 0n 0w");
  assert.strictEqual(vectorText([1, Infinity], 8), "1 0we");
});

test("a month before 2000 is its own month, not one a year earlier (#894)", () => {
  // The codec makes 1999.12m (-1 months from 2000) a Date in 1998.12.
  assert.deepStrictEqual(shown("010000000d000000f3ffffffff"), ["1999.12m"]);
  assert.deepStrictEqual(shown("010000001a0000000d0003000000feffffffe8ffffff0e000000"), ["1999.11 1998.01 2001.03m"]);
  const { value } = decoded("010000001a0000000d0003000000feffffffe8ffffff0e000000");
  assert.deepStrictEqual(gridOf(value, 13, 10).raw[0], [-2, -24, 14]);
});

test("floats keep q's seven significant digits", () => {
  assert.strictEqual(floatText(1.5), "1.5");
  assert.strictEqual(floatText(2), "2");
  assert.strictEqual(floatText(1 / 3), "0.3333333");
  // q writes a float as C's %.7g: an exponent from 1e7 up and below 1e-4,
  // of at least two digits (#894). KDB-X's console, for each.
  assert.strictEqual(floatText(123456789), "1.234568e+08");
  assert.strictEqual(floatText(12345678), "1.234568e+07");
  assert.strictEqual(floatText(1234567), "1234567");
  assert.strictEqual(floatText(9999999.6), "1e+07");
  assert.strictEqual(floatText(1e15), "1e+15");
  assert.strictEqual(floatText(1e100), "1e+100");
  assert.strictEqual(floatText(0.0001), "0.0001");
  assert.strictEqual(floatText(0.00001), "1e-05");
  assert.strictEqual(floatText(1.5e-7), "1.5e-07");
  assert.strictEqual(floatText(-0.00012345678), "-0.0001234568");
  assert.strictEqual(floatText(123.456789), "123.4568");
  assert.strictEqual(floatText(0), "0");
  assert.strictEqual(atomText(123456789, -9), "1.234568e+08");
  assert.strictEqual(atomText(1234567, -9), "1234567f");
  assert.strictEqual(vectorText([1e8, 2], 9), "1e+08 2");
  // In a table an int and a float are both numbers: a whole one is written
  // whole, as an int column needs.
  assert.strictEqual(cellText(123456789), "123456789");
  assert.strictEqual(cellText(0.00001), "1e-05");
});

test("a table is laid out as q's console lays it out, a keyed one with its bar", () => {
  const rows = [
    { sym: "a", px: 1.5 },
    { sym: "bb", px: 2.5 },
  ];
  assert.deepStrictEqual(formatValue(rows, 98), ["sym px", "-------", "a   1.5", "bb  2.5"]);
  // Without the type, a list of rows is still a table.
  assert.deepStrictEqual(formatValue(rows), formatValue(rows, 98));
  const keyed = [[{ k: "b" }, { k: "a" }], [{ v: Long.fromInt(2) }, { v: Long.fromInt(1) }]];
  assert.deepStrictEqual(formatValue(keyed, 99), ["k| v", "-| -", "b| 2", "a| 1"]);
  assert.match(formatValue([], 98)[0], /empty table/);
});

test("a dictionary is its keys and values, a general list one item a line", () => {
  assert.deepStrictEqual(formatValue({ a: Long.fromInt(1), bcd: [Long.fromInt(1), Long.fromInt(2)] }, 99), ["a  | 1", "bcd| 1 2"]);
  assert.deepStrictEqual(formatValue([Long.fromInt(1), "abc", ["x", "y"]], 0), ["1", '"abc"', "`x`y"]);
  assert.deepStrictEqual(formatValue(null, 101), ["::"]);
  assert.deepStrictEqual(formatValue("func", 100), ["<a function: the process sends no text for one>"]);
  assert.deepStrictEqual(formatValue([], 0), ["()"]);
});

test("cells guess their type from what the codec gave", () => {
  assert.strictEqual(cellText(null), "");
  assert.strictEqual(cellText(true), "1");
  assert.strictEqual(cellText(day(2026, 11, 20)), "2026.11.20");
  assert.strictEqual(cellText(day(2026, 11, 20, 1)), "2026.11.20T00:00:00.001");
  assert.strictEqual(cellText([Long.fromInt(1), Long.fromInt(2)]), "1 2");
});

test("text is cut at the console size as .Q.S cuts it", () => {
  assert.deepStrictEqual(cutLines(["abcdefgh", "ab"], [5, 6]), ["abcd..", "ab"]);
  assert.deepStrictEqual(cutLines(["1", "2", "3", "4"], [3, 80]), ["1", "2", ".."]);
  assert.deepStrictEqual(cutLines(["1", "2", "3"], [3, 80]), ["1", "2", "3"]);
  // An unwrapped table at a height of 1 or 2 shows no rows, not all but one (#1405).
  const t = { kind: "table", attr: 0, cols: ["a"], data: [{ kind: "vector", t: 7, attr: 0, v: [1n, 2n, 3n, 4n, 5n] }] };
  for (const h of [1, 2]) {
    assert.deepStrictEqual(consoleLines(t, [h, 80]), ["a", "-", ".."]);
  }
});

test("a decoded table, dictionary or list becomes grid rows the panel can sort and chart", () => {
  const rows = [
    { sym: "b", px: 2.5, n: Long.fromInt(3), d: day(2026, 11, 21) },
    { sym: "a", px: null, n: Long.fromInt(1), d: day(2026, 11, 20) },
    { sym: "c", px: 1.5, n: null, d: null },
  ];
  const payload = gridOf(rows, 98, 2);
  assert.strictEqual(payload.count, 3);
  assert.deepStrictEqual(payload.names, ["sym", "px", "n", "d"]);
  assert.deepStrictEqual(payload.types, [11, 9, 7, 14]);
  assert.deepStrictEqual(payload.cells[0], ["b", "a"]);
  assert.deepStrictEqual(payload.raw[1], [2.5, null]);
  assert.deepStrictEqual(payload.raw[3], [9821, 9820]);
  // Nulls sort first, as q's iasc puts them.
  assert.deepStrictEqual(payload.rank[1], [1, 0]);
  assert.deepStrictEqual(payload.rank[0], [1, 0]);
  const grid = toGrid(payload, -1);
  assert.deepStrictEqual(grid.cells[1], ["2.5", ""]);
  assert.strictEqual(grid.columns[1].numeric, true);
  assert.strictEqual(grid.columns[3].temporal, true);

  const keyed = gridOf([[{ k: "b" }], [{ v: Long.fromInt(2) }]], 99, 10);
  assert.strictEqual(keyed.keys, 1);
  assert.deepStrictEqual(keyed.names, ["k", "v"]);
  const dict = gridOf({ a: 1, b: 2 }, 99, 10);
  assert.deepStrictEqual(dict.names, ["key", "value"]);
  assert.deepStrictEqual(dict.cells, [["a", "b"], ["1", "2"]]);
  const list = gridOf([1, 2, 3], 6, 10);
  assert.deepStrictEqual(list.types, [6]);
  assert.deepStrictEqual(list.cells, [["1", "2", "3"]]);
  // Equal values share a place, as GRID ranks them (#1406).
  assert.deepStrictEqual(gridOf([1, 1, 2], 0, 10).rank, [[0, 0, 1]]);
  assert.deepStrictEqual(gridOf(["b", "a", "b"], 0, 10).rank, [[1, 0, 1]]);
  assert.strictEqual(gridOf("abc", 10, 10), undefined);
  assert.strictEqual(gridOf(Long.fromInt(1), -7, 10), undefined);
});

test("unlimited asks for every row and a size nothing reaches, and keeps nothing on the process", () => {
  const settings = { consoleSize: [50, 160], gridLimit: 100 };
  assert.deepStrictEqual(limits(settings, false), settings);
  const off = limits(settings, true);
  assert.strictEqual(off.gridLimit, UNLIMITED_ROWS);
  assert.ok(off.consoleSize[0] >= 1e9 && off.consoleSize[1] >= 1e9);
  // No global is assigned: the one `::` is the null LAID_OUT compares with (#1995).
  assert.ok(!UNLIMITED.replace('(::)~x', "").includes("::") && !/\bset\b/.test(UNLIMITED), UNLIMITED);
  // And the process's console size is read, never set.
  assert.ok(!/system\s*"c\s|\\c\s/.test(UNLIMITED), UNLIMITED);
  assert.ok(UNLIMITED.startsWith("{[s;size]") && UNLIMITED.endsWith("}"));
  // A simple list comes as its value and is written here, whole.
  const many = Array.from({ length: 1000 }, (_, i) => Long.fromInt(i));
  const answer = readUnlimited({ ok: true, type: 7, text: [], value: many });
  assert.strictEqual(answer.text.length, 1);
  assert.ok(answer.text[0].endsWith("998 999"));
  assert.deepStrictEqual(readUnlimited({ ok: true, type: 98, text: ["a", "-", "1"] }).text, ["a", "-", "1"]);
  assert.deepStrictEqual(readUnlimited({ ok: false, error: "type", trace: "" }), { ok: false, error: "type", trace: "" });
});

test("an unwrapped query sends each statement as a string and shows the last value", async () => {
  const sent = [];
  const answers = { "a:1": { value: null, type: 101 }, "til 3": { value: [Long.fromInt(0), Long.fromInt(1), Long.fromInt(2)], type: 7 } };
  const fake = {
    evaluate: async (text) => {
      sent.push(text);
      if (text === "1+`a") {
        throw new QError("type");
      }
      if (text === "boom") {
        throw new Error("the connection closed before the process answered");
      }
      return answers[text];
    },
  };
  const options = { size: [25, 80], limit: 10, unlimited: false, grid: false };
  assert.deepStrictEqual(await runUnwrapped(fake, ["a:1", "til 3"], options), { ok: true, type: 7, text: ["0 1 2"] });
  assert.deepStrictEqual(sent, ["a:1", "til 3"]);
  // A q error stops the rest, and is the answer.
  sent.length = 0;
  assert.deepStrictEqual(await runUnwrapped(fake, ["1+`a", "til 3"], options), { ok: false, error: "type", trace: "" });
  assert.deepStrictEqual(sent, ["1+`a"]);
  // Anything else throws, as an abort must.
  await assert.rejects(runUnwrapped(fake, ["boom"], options), /closed/);
  // Grid mode adds the rows of a tabular value.
  const grid = await runUnwrapped(fake, ["til 3"], { ...options, grid: true });
  assert.deepStrictEqual(grid.grid.cells, [["0", "1", "2"]]);
});

test("an unwrapped statement after a \\d is sent with the \\d in front, since q reads each message in the root (#2476)", async () => {
  const sent = [];
  const fake = { evaluate: async (text) => (sent.push(text), { value: null, type: 101 }) };
  const options = { size: [25, 80], limit: 10, unlimited: false, grid: false };
  await runUnwrapped(fake, ["\\d .lib", 'h1:{x+"a"}', "x", 'system "d .b"', "y", "\\d .", "z"], options);
  assert.deepStrictEqual(sent, [
    "\\d .lib",
    'system"d .lib";value "h1:{x+\\"a\\"}"',
    'system"d .lib";value enlist "x"',
    'system"d .lib";value "system \\"d .b\\""',
    'system"d .b";value enlist "y"',
    'system"d .b";value "\\\\d ."',
    "z",
  ]);
});

test("a file's connection is kept by URI, and shown only when it is not the active one", () => {
  const stored = withBinding(undefined, "file:///a.q", "rdb");
  assert.deepStrictEqual(stored, { "file:///a.q": "rdb" });
  assert.strictEqual(bindingFor(stored, "file:///a.q"), "rdb");
  assert.strictEqual(bindingFor(stored, "file:///b.q"), undefined);
  assert.strictEqual(bindingFor("junk", "file:///a.q"), undefined);
  const two = withBinding({ ...stored, bad: 3 }, "file:///b.q", "hdb");
  assert.deepStrictEqual(two, { "file:///a.q": "rdb", "file:///b.q": "hdb" });
  assert.deepStrictEqual(withBinding(two, "file:///a.q", undefined), { "file:///b.q": "hdb" });
  assert.strictEqual(bindingText("rdb", "rdb"), undefined);
  assert.strictEqual(bindingText(undefined, "rdb"), undefined);
  // A label's $(name) is text, not an icon (#1313).
  assert.strictEqual(bindingText("a$(zap)", "rdb"), "$(file-symlink-file) file: a\\$(zap)");
  assert.match(bindingText("hdb", "rdb"), /file: hdb/);
  assert.match(bindingText("hdb", undefined), /file: hdb/);
});

test("the status bar names the flags that are on", () => {
  assert.strictEqual(flagsText(false, false), "");
  assert.match(flagsText(true, false), /unlimited/);
  assert.match(flagsText(true, true), /unlimited.*unwrapped/);
  assert.strictEqual(timedOutError(2), "timed out after 2 s");
});

/// An unwrapped answer as the connection gives it, from what q's `-8!` of
/// the value is: the codec's value, the q type and the message.
function fromQ(hex) {
  const message = Buffer.from(hex.replace(/^0x/, ""), "hex");
  message.writeUInt8(2, 1);
  return { value: deserialize(message, false, true, false, false), type: message.readInt8(8), message };
}

/// What an unwrapped query shows for each `-8!` hex, as one text.
async function unwrapped(hex, options = {}) {
  const fake = { evaluate: async () => fromQ(hex) };
  const answer = await runUnwrapped(fake, ["x"], { size: [1e9, 1e9], limit: 100, unlimited: true, grid: false, ...options });
  return answer;
}

test("an unwrapped atom or simple list keeps nanoseconds, a negative infinity's sign and a negative time", async () => {
  // -8!2026.11.20D10:11:12.123456789
  assert.deepStrictEqual((await unwrapped("0x0100000011000000f4154d4857506cc60b")).text, ["2026.11.20D10:11:12.123456789"]);
  // -8!1999.12.31D23:59:59.999999999 0Np
  assert.deepStrictEqual(
    (await unwrapped("0x010000001e0000000c0002000000ffffffffffffffff0000000000000080")).text,
    ["1999.12.31D23:59:59.999999999 0N"],
  );
  // -8!-0Wd
  assert.deepStrictEqual((await unwrapped("0x010000000d000000f201000080")).text, ["-0Wd"]);
  // -8!-00:00:01.000
  assert.deepStrictEqual((await unwrapped("0x010000000d000000ed18fcffff")).text, ["-00:00:01.000"]);
});

test("a string is written with q's escapes, unwrapped and unlimited", async () => {
  // -8!"caf\303\251\001\377"
  assert.deepStrictEqual((await unwrapped("0x01000000150000000a0007000000636166c3a901ff")).text, ['"caf\\303\\251\\001\\377"']);
  // -8!"\t"
  assert.deepStrictEqual((await unwrapped("0x010000000f0000000a000100000009")).text, [',"\\t"']);
  // -8!"\001"
  assert.deepStrictEqual((await unwrapped("0x010000000a000000f601")).text, ['"\\001"']);
  // An unlimited string comes as its bytes.
  const bytes = [...Buffer.from("café", "utf8"), 255];
  assert.deepStrictEqual(readUnlimited({ ok: true, type: 10, text: [], value: bytes }).text, ['"caf\\303\\251\\377"']);
  assert.ok(UNLIMITED.includes('t=10h;"x"$r 1'));
  assert.deepStrictEqual(readUnlimited({ ok: true, type: 10, text: [], value: "é\u0001" }).text, ['"\\303\\251\\001"']);
});

test("a list's attribute is written before it, unwrapped and unlimited", async () => {
  // -8!`s#1 2
  assert.deepStrictEqual((await unwrapped("0x010000001e00000007010200000001000000000000000200000000000000")).text, ["`s#1 2"]);
  // -8!`u#"ab"
  assert.deepStrictEqual((await unwrapped("0x01000000100000000a02020000006162")).text, ['`u#"ab"']);
  assert.ok(UNLIMITED.includes("attr r 1"));
  assert.deepStrictEqual(readUnlimited({ ok: true, type: 11, text: [], value: ["a"], attr: "g" }).text, ["`g#,`a"]);
  assert.deepStrictEqual(readUnlimited({ ok: true, type: 7, text: [], value: [], attr: "p" }).text, ["`p#`long$()"]);
  assert.deepStrictEqual(readUnlimited({ ok: true, type: 7, text: [], value: [Long.fromInt(1)], attr: null }).text, [",1"]);
});

test("an unwrapped general list or dictionary tells a symbol from a string, and nests as q's console does", async () => {
  // -8!(1;`a;"b")
  assert.deepStrictEqual((await unwrapped("0x010000001c000000000003000000f90100000000000000f56100f662")).text, ["1", "`a", '"b"']);
  // -8!`a`b!(`c`d!1 2;`e`f!3 4)
  assert.deepStrictEqual(
    (await unwrapped("0x010000005b000000630b000200000061006200000002000000630b00020000006300640007000200000001000000000000000200000000000000630b00020000006500660007000200000003000000000000000400000000000000")).text,
    ["a| `c`d!1 2", "b| `e`f!3 4"],
  );
  // -8!1#.q: the null symbol key and the generic null.
  assert.deepStrictEqual((await unwrapped("0x0100000018000000630b0001000000000000010000006500")).text, ["| ::"]);
  // -8!(1 2;30 4): rows lined up.
  assert.deepStrictEqual(
    (await unwrapped("0x010000003a000000000002000000070002000000010000000000000002000000000000000700020000001e000000000000000400000000000000")).text,
    ["1  2", "30 4"],
  );
  // -8!(`a;1)!(2;`b)
  assert.deepStrictEqual(
    (await unwrapped("0x010000002d00000063000002000000f56100f90100000000000000000002000000f90200000000000000f56200")).text,
    ["`a| 2", "1 | `b"],
  );
});

test("an unwrapped table shows each column as its own type, and its columns when it has no rows", async () => {
  // -8!([]p:2026.11.20D10:11:12.123456789 0Np;t:10:11:12.123 0Nt;g:2#0Ng;s:("ab";"c"))
  const table = await unwrapped(
    "0x01000000790000006200630b000400000070007400670073000000040000000c0002000000154d4857506cc60b00000000000000801300020000007b922f020000008002000200000000000000000000000000000000000000000000000000000000000000000000000000020000000a00020000006162f663",
  );
  assert.deepStrictEqual(table.text.map((l) => l.trimEnd()), [
    "p                             t            g                                    s",
    "-".repeat(84),
    '2026.11.20D10:11:12.123456789 10:11:12.123 00000000-0000-0000-0000-000000000000 "ab"',
    '                                           00000000-0000-0000-0000-000000000000 "c"',
  ]);
  // -8!0#([]a:1 2)
  assert.deepStrictEqual((await unwrapped("0x010000001f0000006200630b00010000006100000001000000070000000000")).text, ["a", "-"]);
  // -8!([k:`a`b]v:1 2)
  assert.deepStrictEqual(
    (await unwrapped("0x010000004b000000636200630b00010000006b000000010000000b0002000000610062006200630b0001000000760000000100000007000200000001000000000000000200000000000000")).text,
    ["k| v", "-| -", "a| 1", "b| 2"],
  );
});

test("an unwrapped lambda is shown as its text, which the process sends", async () => {
  // -8!{[x;y]\n  x+y}
  assert.deepStrictEqual((await unwrapped("0x010000001d00000064000a000d0000007b5b783b795d0a2020782b797d")).text, ["{[x;y]", "  x+y}"]);
  // -8!(+): a primitive is shown as q prints it (#1232).
  assert.deepStrictEqual((await unwrapped("0x010000000a0000006601")).text, ["+"]);
});

test("an unwrapped grid has each column's own type, its rows' ranks shared by equal values, and a sorted dictionary", async () => {
  const grid = async (hex) => (await unwrapped(hex, { unlimited: false, limit: 100, size: [25, 80], grid: true })).grid;
  // -8!([]p:2026.11.20D10:11:12.123456789 0Np;u:10:11 10:11;m:2026.11 -0Wm;g:2#0Ng)
  const g = toGrid(
    await grid(
      "0x01000000770000006200630b0004000000700075006d0067000000040000000c0002000000154d4857506cc60b000000000000008011000200000063020000630200000d000200000042010000010000800200020000000000000000000000000000000000000000000000000000000000000000000000",
    ),
    -1,
  );
  assert.deepStrictEqual(g.columns.map((c) => c.type), [12, 17, 13, 2]);
  assert.deepStrictEqual(g.cells, [
    ["2026.11.20D10:11:12.123456789", ""],
    ["10:11", "10:11"],
    ["2026.11", "-0W"],
    ["00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000"],
  ]);
  assert.deepStrictEqual(g.values.slice(1, 3), [[611, 611], [322, null]]);
  // Equal values share a place, so a descending sort keeps their order.
  assert.deepStrictEqual(g.rank[1], [0, 0]);
  // -8!0#([]a:1 2): the columns of a table with no rows.
  const empty = await grid("0x010000001f0000006200630b00010000006100000001000000070000000000");
  assert.deepStrictEqual([empty.names, empty.types, empty.count], [["a"], [7], 0]);
  // -8!`s#`a`b!1 2: a sorted dictionary, not a function.
  const sorted = await unwrapped("0x01000000290000007f0b01020000006100620007000200000001000000000000000200000000000000", { grid: true });
  assert.deepStrictEqual(sorted.text, ["a| 1", "b| 2"]);
  assert.deepStrictEqual(sorted.grid.cells, [["a", "b"], ["1", "2"]]);
});

/// The message of a q table of one long column `a` of `n` rows, 0 to n-1.
function longTable(n) {
  const head = Buffer.from("0100000000000000" + "6200" + "630b0001000000" + "6100" + "000001000000" + "0700", "hex");
  const count = Buffer.alloc(4);
  count.writeUInt32LE(n);
  const items = Buffer.alloc(8 * n);
  for (let i = 0; i < n; i++) {
    items.writeBigInt64LE(BigInt(i), 8 * i);
  }
  const message = Buffer.concat([head, count, items]);
  message.writeUInt32LE(message.length, 4);
  return message;
}

test("an unwrapped table or dictionary of more rows than a call takes arguments is written", async () => {
  const message = longTable(300_000);
  message.writeUInt8(2, 1);
  const answer = { value: deserialize(message, false, true, false, false), type: 98, message };
  const run = (m) => runUnwrapped({ evaluate: async () => m }, ["t"], { size: [25, 80], limit: 10, unlimited: true, grid: false });
  const table = await run(answer);
  assert.strictEqual(table.text.length, 300_002);
  assert.strictEqual(table.text[300_001].trimEnd(), "299999");
  // A dictionary keyed by that table, and one of as many keys.
  const keyed = Buffer.concat([Buffer.from("0100000000000000" + "63", "hex"), message.subarray(8), message.subarray(8)]);
  keyed.writeUInt8(2, 1);
  keyed.writeUInt32LE(keyed.length, 4);
  assert.strictEqual((await run({ value: null, type: 99, message: keyed })).text.length, 300_002);
});

test("an unwrapped table is cut to the console's rows before it is laid out, as .Q.S cuts it", async () => {
  const message = longTable(20);
  message.writeUInt8(2, 1);
  const answer = { value: deserialize(message, false, true, false, false), type: 98, message };
  const run = (size) => runUnwrapped({ evaluate: async () => answer }, ["t"], { size, limit: 10, unlimited: false, grid: false });
  // As wide as the rows shown: "-", not "--" for a 19 cut off.
  assert.deepStrictEqual((await run([5, 80])).text.map((l) => l.trimEnd()), ["a", "-", "0", "1", ".."]);
  assert.deepStrictEqual((await run([25, 80])).text.length, 22);
});

test("an unwrapped float is written to the process's \\P, asked as a plain string, as its console writes it (#2570)", async () => {
  // -8!0.1+0.2, and -8!([] a:1%3 7)
  const table = fromQ("0x010000002f0000006200630b00010000006100000001000000090002000000555555555555d53f922449922449c23f");
  const run = async (answer, precision) => {
    const sent = [];
    const fake = { evaluate: async (text) => (sent.push(text), text === "\\P" ? { value: precision, type: -6 } : answer) };
    const ran = await runUnwrapped(fake, ["x"], { size: [25, 80], limit: 10, unlimited: false, grid: true });
    return { ran, sent };
  };
  const atom = fromQ("0x0100000011000000f7343333333333d33f");
  assert.deepStrictEqual((await run(atom, 0)).ran.text, ["0.30000000000000004"]);
  assert.deepStrictEqual((await run(atom, 7)).ran.text, ["0.3"]);
  const at0 = (await run(table, 0)).ran;
  assert.deepStrictEqual(at0.text, ["a", "-------------------", "0.33333333333333331", "0.14285714285714285"]);
  assert.deepStrictEqual(at0.grid.cells, [["0.33333333333333331", "0.14285714285714285"]]);
  assert.deepStrictEqual((await run(table, 3)).ran.text, ["a", "-----", "0.333", "0.143"]);
  // A value with no float in it asks nothing more.
  assert.deepStrictEqual((await run(fromQ("0x010000000d000000fa01000000"), 0)).sent, ["x"]);
});

test("an unlimited float list is written to the process's \\P, as its console writes it", () => {
  const floats = (value, precision, type = 9) => readUnlimited({ ok: true, type, text: [], value, attr: null, precision }).text[0];
  assert.ok(UNLIMITED.includes('system"P"'));
  // \P 0: every digit a float holds.
  assert.strictEqual(floats([1 / 3, 2 / 3], 0), "0.33333333333333331 0.66666666666666663");
  assert.strictEqual(floats([1 / 3, 2], 10), "0.3333333333 2");
  assert.strictEqual(floats([1234.5, 0.000123], 3), "1.23e+03 0.000123");
  assert.strictEqual(floats([123456789012.5], 10), ",1.23456789e+11");
  // A real at \P 0 is %.8g, as KDB-X writes it (#1759); at \P 10, ten.
  assert.strictEqual(floats([Math.fround(1.1), Math.fround(2.2)], 0, 8), "1.1 2.2e");
  assert.strictEqual(floats([Math.fround(0.3), Math.fround(0.052670188)], 0, 8), "0.30000001 0.052670188e");
  assert.strictEqual(floats([Math.fround(1.1)], 10, 8), ",1.100000024e");
  // q's default, and an answer with no precision.
  assert.strictEqual(floats([1 / 3], 7), ",0.3333333");
  assert.strictEqual(readUnlimited({ ok: true, type: 9, text: [], value: [1 / 3] }).text[0], ",0.3333333");
});

test("a temporal list of only nulls and infinities ends with its type's letter, as q writes it (#1491)", () => {
  assert.strictEqual(vectorText([null, null], 14), "0N 0Nd");
  assert.strictEqual(vectorText([null], 12), ",0Np");
  assert.strictEqual(vectorText([Infinity, null], 19), "0W 0Nt");
  assert.strictEqual(vectorText([-Infinity, null], 12), "-0W 0Np");
  assert.strictEqual(vectorText([Infinity], 15), ",0wz");
  assert.strictEqual(vectorText([null, null], 17), "0N 0Nu");
  assert.strictEqual(vectorText([null, null], 13), "0N 0Nm");
  assert.strictEqual(vectorText([day(2026, 11, 20), null], 14), "2026.11.20 0N");
});

test("an unwrapped dictionary with a table on either side counts its header lines, as the console does (#1497)", () => {
  // KDB-X console at \c 10 80: (`$"s",/:string til 30)!([]x:til 30) and
  // ([]k:til 30)!til 30 each show 10 lines, the 8th row then "..".
  const longs = (n) => ({ kind: "vector", t: 7, attr: 0, v: Array.from({ length: n }, (_, i) => i) });
  const table = (name, n) => ({ kind: "table", attr: 0, cols: [name], data: [longs(n)] });
  const syms = { kind: "vector", t: 11, attr: 0, v: Array.from({ length: 30 }, (_, i) => `s${i}`) };
  const bySym = consoleLines({ kind: "dict", sorted: false, k: syms, v: table("x", 30) }, [10, 80]);
  assert.strictEqual(bySym.length, 10);
  assert.deepStrictEqual([bySym[0], bySym[2], bySym[8], bySym[9]], ["  | x", "s0| 0", "s6| 6", ".."]);
  const byTable = consoleLines({ kind: "dict", sorted: false, k: table("k", 30), v: longs(30) }, [10, 80]);
  assert.strictEqual(byTable.length, 10);
  assert.strictEqual(byTable[8].trimEnd(), "6| 6");
});

// The untitled editor a saved file came from, by its text (#1529).
test("a file saved from a bound untitled editor is matched by its text, recently, and only one way", () => {
  const { savedFrom } = require("../out/querycontrols.js");
  const now = 100000;
  assert.strictEqual(savedFrom("a:1", [{ label: "prod", text: "a:1", at: now - 10 }], now), "prod");
  assert.strictEqual(savedFrom("a:1", [{ label: "prod", text: "a:1", at: now - 60000 }], now), undefined);
  assert.strictEqual(savedFrom("a:2", [{ label: "prod", text: "a:1", at: now }], now), undefined);
  assert.strictEqual(savedFrom("  ", [{ label: "prod", text: "  ", at: now }], now), undefined);
  assert.strictEqual(savedFrom("a:1", [{ label: "prod", text: "a:1", at: now }, { label: "dev", text: "a:1", at: now }], now), undefined);
  assert.strictEqual(savedFrom("a:1", [{ label: "prod", text: "a:1", at: now }, { label: "prod", text: "a:1", at: now }], now), "prod");
  // A file this window opened long ago is not one just saved as (#1723).
  assert.strictEqual(savedFrom("a:1", [{ label: "prod", text: "a:1", at: now }], now, 5000, now - 60000), undefined);
  assert.strictEqual(savedFrom("a:1", [{ label: "prod", text: "a:1", at: now }], now, 5000, now - 10), "prod");
});

test("an unwrapped datetime is cut to the millisecond as KDB-X cuts it, not rounded (#1757)", () => {
  // KDB-X: "z"$0.99999999999 -1e-9, 0.5 and 1.5 ms, and 1561.428 (stored as
  // 1561.4279999999999), which a plain floor writes as .199.
  assert.strictEqual(atomText(0.99999999999, -15), "2000.01.01T23:59:59.999");
  assert.strictEqual(atomText(-1e-9, -15), "1999.12.31T23:59:59.999");
  assert.strictEqual(vectorText([0.5 / 86400000, 1.5 / 86400000], 15), "2000.01.01T00:00:00.000 2000.01.01T00:00:00.001");
  assert.strictEqual(atomText(1561.4279999999999, -15), "2004.04.10T10:16:19.200");
});

test("a float at an exact decimal tie rounds to even, as C's %g in KDB-X does (#1758)", () => {
  // KDB-X: 100.03125 -> 100.0312, 2345678.5 -> 2345678f, 0.125 at \P 2 -> 0.12,
  // and at \P 17 182394159939530.125 -> 182394159939530.12.
  assert.strictEqual(floatText(100.03125), "100.0312");
  assert.strictEqual(floatText(100.03135), "100.0314");
  assert.strictEqual(floatText(2345678.5), "2345678");
  assert.strictEqual(floatText(2345679.5), "2345680");
  assert.strictEqual(floatText(0.125, 2), "0.12");
  assert.strictEqual(floatText(182394159939530.125, 17), "182394159939530.12");
  assert.strictEqual(floatText(-979628008118440.5, 15), "-979628008118440");
  assert.strictEqual(vectorText([1, 2, 100.03125], 9), "1 2 100.0312");
  // Not a tie: the nearest decimal, as before.
  assert.strictEqual(floatText(0.1 + 0.2, 17), "0.30000000000000004");
  assert.strictEqual(floatText(9999999.6), "1e+07");
});

test("a subnormal float or real is written as a zero of its sign, as KDB-X writes it (#1760)", () => {
  // KDB-X: 1e-310 -1e-310 1e-308 5e-324 -> 0 -0 0 0f; -3.08e-39e -> -0e.
  assert.strictEqual(vectorText([1e-310, -1e-310, 1e-308, 5e-324], 9), "0 -0 0 0f");
  assert.strictEqual(floatText(1e-310, 0), "0");
  assert.strictEqual(atomText(Math.fround(-3.08e-39), -8), "-0e");
  // The smallest normal ones are still written: 2.225074e-308, 1.175494e-38e.
  assert.strictEqual(floatText(2.2250738585072014e-308), "2.225074e-308");
  assert.strictEqual(atomText(Math.fround(1.1754944e-38), -8), "1.175494e-38e");
});

test("an unwrapped minute, second or time of 100 hours or more writes its hours as **, as KDB-X does (#1762)", () => {
  // KDB-X: "u"$-5940 -6000 5999 6000 -> -99:00 -**:00 99:59 **:00.
  assert.strictEqual(vectorText([-5940, -6000, 5999, 6000], 17), "-99:00 -**:00 99:59 **:00");
  // "v"$359999 360000 -360000 -> 99:59:59 **:00:00 -**:00:00.
  assert.strictEqual(vectorText([359999, 360000, -360000], 18), "99:59:59 **:00:00 -**:00:00");
  // "t"$359999999 -2147483646 -> 99:59:59.999 -**:31:23.646.
  assert.strictEqual(vectorText([359999999, -2147483646], 19), "99:59:59.999 -**:31:23.646");
  assert.strictEqual(atomText(2147483646, -18), "**:14:06");
});

test("an unwrapped line cut at the width never ends in half an astral character (#1761)", () => {
  const smile = "\u{1F600}";
  // 77 a's and two emoji at 80: the cut at 78 would end inside the first.
  assert.deepStrictEqual(cutLines(["a".repeat(77) + smile + smile], [25, 80]), ["a".repeat(77) + ".."]);
  assert.deepStrictEqual(cutLines(["a".repeat(76) + smile + smile + "b"], [25, 80]), ["a".repeat(76) + smile + ".."]);
  assert.deepStrictEqual(cutLines(["a".repeat(78) + smile], [25, 80]), ["a".repeat(78) + smile]);
});

test("a datetime far from 2000 is cut to the millisecond as KDB-X cuts it, not a millisecond out (#2577)", () => {
  // KDB-X: "z"$82203.9 -43797.3 -101962.1 73121.93
  assert.deepStrictEqual(
    [82203.9, -43797.3, -101962.1, 73121.93].map((n) => atomText(n, -15)),
    ["2225.01.24T21:36:00.000", "1880.02.01T16:47:59.999", "1720.11.01T21:35:59.999", "2200.03.14T22:19:12.000"],
  );
});

test("a line -3! writes is cut a character short of the width, as q cuts it; a table's or dictionary's at it (#2571)", () => {
  const til = (n) => ({ kind: "vector", t: 7, attr: 0, v: Array.from({ length: n }, (_, i) => BigInt(i)) });
  const width = (q) => consoleLines(q, [25, 80]).map((l) => l.length);
  // KDB-X: count each .Q.S[25 80;0j] of each.
  assert.deepStrictEqual(width(til(100)), [79]);
  assert.ok(consoleLines(til(100), [25, 80])[0].endsWith("28 .."));
  assert.deepStrictEqual(width({ kind: "chars", attr: 0, v: Buffer.alloc(200, "x") }), [79]);
  assert.deepStrictEqual(width({ kind: "list", attr: 0, v: [til(100), { kind: "atom", t: -11, v: "a" }] }), [79, 2]);
  assert.deepStrictEqual(width({ kind: "list", attr: 0, v: [til(50), til(50)] }), [80, 80]);
  assert.deepStrictEqual(width({ kind: "dict", sorted: false, k: { kind: "vector", t: 11, attr: 0, v: ["a", "b"] }, v: { kind: "list", attr: 0, v: [til(100), til(100)] } }), [80, 80]);
});

test("the process's \\P is asked once a connection, again after a statement that sets it, and never of a gateway call (#2570)", async () => {
  const atom = { value: 0.1 + 0.2, type: -9, message: Buffer.from("0100000011000000f7343333333333d33f", "hex") };
  const sent = [];
  let p = 0;
  const fake = { evaluate: async (text) => (sent.push(text), text === "\\P" ? { value: p, type: -6 } : text.startsWith("\\P ") ? ((p = Number(text.slice(3))), { value: null, type: 101 }) : atom) };
  const options = { size: [25, 80], limit: 10, unlimited: false, grid: false };
  assert.deepStrictEqual((await runUnwrapped(fake, ["x"], options)).text, ["0.30000000000000004"]);
  assert.deepStrictEqual((await runUnwrapped(fake, ["x"], options)).text, ["0.30000000000000004"]);
  assert.deepStrictEqual(sent, ["x", "\\P", "x"]);
  assert.deepStrictEqual((await runUnwrapped(fake, ["\\P 3", "x"], options)).text, ["0.3"]);
  assert.deepStrictEqual(sent.slice(3), ["\\P 3", "x", "\\P"]);
  sent.length = 0;
  await runUnwrapped({ evaluate: async (text) => (sent.push(text), atom) }, ['.gw.syncexec["x";`rdb]'], options);
  assert.deepStrictEqual(sent, ['.gw.syncexec["x";`rdb]']);
});
