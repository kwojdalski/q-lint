// Query controls (#887): values formatted client-side for unwrapped and
// unlimited queries, the rows of a grid made from one, what an unwrapped
// query sends and answers, and a file's own connection. Run after `tsc`;
// nothing here needs an editor or a q process (querycontrols_q.test.js
// drives a real one).
const test = require("node:test");
const assert = require("node:assert");
const Long = require("long");
const { atomText, cellText, cutLines, floatText, formatValue, gridOf, vectorText } = require("../out/qformat.js");
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

test("floats keep q's seven significant digits", () => {
  assert.strictEqual(floatText(1.5), "1.5");
  assert.strictEqual(floatText(2), "2");
  assert.strictEqual(floatText(1 / 3), "0.3333333");
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
  assert.strictEqual(gridOf("abc", 10, 10), undefined);
  assert.strictEqual(gridOf(Long.fromInt(1), -7, 10), undefined);
});

test("unlimited asks for every row and a size nothing reaches, and keeps nothing on the process", () => {
  const settings = { consoleSize: [50, 160], gridLimit: 100 };
  assert.deepStrictEqual(limits(settings, false), settings);
  const off = limits(settings, true);
  assert.strictEqual(off.gridLimit, UNLIMITED_ROWS);
  assert.ok(off.consoleSize[0] >= 1e9 && off.consoleSize[1] >= 1e9);
  assert.ok(!UNLIMITED.includes("::") && !/\bset\b/.test(UNLIMITED), UNLIMITED);
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
  assert.match(bindingText("hdb", "rdb"), /file: hdb/);
  assert.match(bindingText("hdb", undefined), /file: hdb/);
});

test("the status bar names the flags that are on", () => {
  assert.strictEqual(flagsText(false, false), "");
  assert.match(flagsText(true, false), /unlimited/);
  assert.match(flagsText(true, true), /unlimited.*unwrapped/);
  assert.strictEqual(timedOutError(2), "timed out after 2 s");
});
