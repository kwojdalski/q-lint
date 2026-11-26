// The result panel's wave-two pure parts: export formats (#921), q
// literals, paging's merge (#922), the pivot (#925), the new charts and
// their SVG (#926) and drill-down templates (#927). The xlsx and Parquet
// files are held to their formats' structure here, and read back by
// openpyxl, pyarrow and DuckDB when QLINT_TEST_READBACK names a Python that
// has them, e.g. `uv run --with openpyxl --with pyarrow --with duckdb python`.
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const { atomLiteral, tableLiteral, plainName, plainItem, stringLiteral, symbolLiteral, distinctNames } = require("../out/qliteral.js");
const { liveExpressions } = require("../out/livemarkdown.js");
const { toJson, toMarkdown, markdownCell, exportResult, EXPORT_FORMATS, FORMAT_INFO } = require("../out/resultexport.js");
const { crc32, zip, columnName, xmlText, temporalSerial, xlsxCell } = require("../out/xlsx.js");
const { definitionLevels, planFor, toParquet } = require("../out/parquet.js");
const { gridOfQ } = require("../out/qformat.js");
const { appendPage, readPage, toGrid } = require("../out/grid.js");
const { fillDrilldown, templatesFor } = require("../out/drilldown.js");
const { readDrilldown } = require("../out/liveconfig.js");
const page = require("../media/result.js");
const charts = require("../media/chartspec.js");

/// A payload of typed columns, as GRID sends them.
const typed = () => ({
  count: 3,
  keys: 1,
  names: ["s", "b", "j", "f", "d", "p", "l"],
  types: [11, 1, 7, 9, 14, 12, 0],
  cells: [
    ["a", "b", "c d"],
    ["1", "0", "1"],
    ["9007199254740993", "", "0W"],
    ["3.141593", "", "-0w"],
    ["2024.01.31", "", "1999.12.31"],
    ["2024.01.02D03:04:05.123456789", "", "0W"],
    ['"abc"', "`x`y", "1 2 3"],
  ],
  raw: [[], [], [{ toString: () => "9007199254740993" }, null, Infinity], [3.14159265358979, null, -Infinity], [8796, null, -1], [{ toString: () => "757479845123456789" }, null, Infinity], []],
  rank: [[0, 1, 2], [1, 0, 1], [1, 0, 2], [2, 1, 0], [2, 0, 1], [1, 0, 2], []],
});

test("a cell's q literal keeps its type: suffixes, typed nulls and infinities, symbols and guids", () => {
  const lit = (type, text, raw) => atomLiteral(type, text, raw).literal;
  assert.strictEqual(lit(1, "1"), "1b");
  assert.strictEqual(lit(4, "0a"), "0x0a");
  assert.strictEqual(lit(5, "12", 12), "12h");
  assert.strictEqual(lit(5, "", null), "0Nh");
  assert.strictEqual(lit(6, "2147483647", -Infinity), "-0Wi");
  assert.strictEqual(lit(7, "1", { toString: () => "9223372036854775806" }), "9223372036854775806");
  assert.strictEqual(lit(9, "3.141593", 3.14159265358979), "3.14159265358979f");
  assert.strictEqual(lit(9, "1e+21", 1e21), "1e21f");
  assert.strictEqual(lit(8, "", Infinity), "0We");
  assert.strictEqual(lit(10, '"'), '"\\""');
  assert.strictEqual(lit(11, "AAPL"), "`AAPL");
  assert.strictEqual(lit(11, "a b"), '`$"a b"');
  assert.strictEqual(lit(11, ""), "`");
  assert.strictEqual(lit(2, "8c680a01-5a49-5aab-5a65-d4bfddb6a661"), '"G"$"8c680a01-5a49-5aab-5a65-d4bfddb6a661"');
  assert.strictEqual(lit(2, "00000000-0000-0000-0000-000000000000"), "0Ng");
  assert.strictEqual(lit(13, "2024.01", 288), "2024.01m");
  assert.strictEqual(lit(14, "", null), "0Nd");
  assert.strictEqual(lit(12, "", Infinity), "0Wp");
  assert.strictEqual(lit(15, "", Infinity), "0wz");
  assert.strictEqual(lit(20, "x"), "`x");
  // A general list's item is q already, unless it was cut.
  assert.deepStrictEqual(atomLiteral(0, "`a`b", undefined), { literal: "`a`b", cut: false });
  // A minute, second or time past 99 hours, which -3! writes **, and a
  // timestamp outside 1709-2290, which KDB-X does not read: cast (#2082).
  assert.strictEqual(lit(0, "(**:00;1)", ["l", [["c", [-17, 6000]], "1"]]), '("u"$6000i;1)');
  assert.strictEqual(lit(0, "01:00 **:00", ["c", [17, [60, 6000]]]), '"u"$60 6000i');
  assert.strictEqual(lit(0, ",**:00:00", ["c", [18, [360000]]]), '"v"$enlist 360000i');
  assert.strictEqual(lit(0, "0N **:06:40.000", ["c", [19, [null, 400000000]]]), '"t"$0N 400000000i');
  assert.strictEqual(lit(0, "2000.01.02T02:57:46.666", ["c", [-15, 1.123456789]]), '"z"$1.123456789');
  assert.strictEqual(lit(0, "", ["c", [-12, -9200000000000000000n]]), '"p"$-9200000000000000000');
  assert.strictEqual(lit(12, "1708.06.05D21:51:00.000000000", "-9200000000000000000"), '"p"$-9200000000000000000');
  // But a guid, which -3! writes bare: q refuses it, or reads 0Ng as 0 (#2081).
  const g = "8c680a01-5a49-5aab-5a65-d4bfddb6a661";
  const z = "00000000-0000-0000-0000-000000000000";
  assert.strictEqual(lit(0, `(${g};1)`, false), `(("G"$"${g}");1)`);
  assert.strictEqual(lit(0, `(1 2;${z})`, false), `(1 2;("G"$"${z}"))`);
  assert.strictEqual(lit(0, `,${g} ${z}`, false), `enlist ("G"$("${g}";"${z}"))`);
  assert.strictEqual(lit(0, `("${g}";\`$"${g}")`, false), `("${g}";\`$"${g}")`);
  assert.strictEqual(atomLiteral(0, `"${"x".repeat(196)}...`, undefined).cut, true);
  // Cut by -3! at \c (#1484). KDB-X at \c 25 80: -3!til 40 is "0 1 ... 28 ..".
  const wide = `${Array.from({ length: 29 }, (_, i) => i).join(" ")} ..`;
  assert.strictEqual(atomLiteral(0, wide, undefined).cut, true);
  assert.strictEqual(tableLiteral({ count: 1, keys: 0, names: ["a"], types: [0], cells: [[wide]], raw: [[]], rank: [[]] }).cut, 1);
  assert.strictEqual(stringLiteral("a\nb\t\u0001"), '"a\\nb\\t\\001"');
  assert.strictEqual(symbolLiteral("x.y_1"), "`x.y_1");
  // What `-3!` writes and q will not read back (the 0.29.0 bug; real q in
  // grid_q.test.js): a one-item list's `,`, and a symbol starting with _.
  assert.strictEqual(atomLiteral(0, ',"x"', undefined).literal, 'enlist "x"');
  assert.strictEqual(atomLiteral(0, ',,"x"', undefined).literal, 'enlist enlist "x"');
  assert.strictEqual(atomLiteral(0, '(,`a)!,1', undefined).literal, "(enlist `a)!enlist 1");
  assert.strictEqual(atomLiteral(0, '",x","y"', undefined).literal, '",x","y"');
  assert.strictEqual(atomLiteral(0, "`_z", undefined).literal, '`$"_z"');
  assert.strictEqual(atomLiteral(0, "`_v`u", undefined).literal, '`$("_v";enlist "u")');
  assert.strictEqual(atomLiteral(0, "`a`_y", undefined).literal, "`a`_y");
  assert.strictEqual(symbolLiteral("_y"), '`$"_y"');
  assert.strictEqual(symbolLiteral(""), "`");
  assert.strictEqual(lit(11, "_y"), '`$"_y"');
});

test("a table's q literal: ([k:...] v:...) for plain names, n!flip for a reserved or odd one, enlist for one row", () => {
  const t = tableLiteral(typed());
  assert.strictEqual(
    t.code,
    '([s:(`a;`b;`$"c d")] b:(1b;0b;1b);j:(9007199254740993;0Nj;0W);f:(3.14159265358979f;0n;-0w);d:(2024.01.31;0Nd;1999.12.31);p:(2024.01.02D03:04:05.123456789;0Np;0Wp);l:("abc";`x`y;1 2 3))',
  );
  assert.deepStrictEqual([t.rows, t.total, t.cut], [3, 3, 0]);
  // Only the rows shown, in their order.
  assert.strictEqual(tableLiteral(typed(), [2]).code.slice(0, 22), '([s:enlist `$"c d"] b:');
  // A dictionary's grid: `key` and `value` are q's own words.
  const dict = { count: 2, keys: 1, names: ["key", "value"], types: [11, 7], cells: [["a", "b"], ["1", "2"]], raw: [[], [1, 2]], rank: [[], []] };
  assert.strictEqual(tableLiteral(dict).code, "1!flip `key`value!(`a`b;(1;2))");
  assert.strictEqual(tableLiteral({ ...dict, keys: 0, names: ["a b"], types: [7], cells: [["1"]], raw: [[1]] }).code, 'flip (enlist `$"a b")!enlist enlist 1');
  assert.strictEqual(tableLiteral({ ...dict, keys: 0, names: ["x"], types: [9], cells: [[]], raw: [[]] }).code, '([] x:"f"$())');
  assert.ok(plainName("price") && !plainName("count") && !plainName("1a") && !plainName("a b"));
});

test("a general list's string item is its characters where a format has strings of its own", () => {
  assert.strictEqual(plainItem('"say \\"hi\\"\\n\\001"'), 'say "hi"\n\u0001');
  assert.strictEqual(plainItem("`x`y"), "`x`y");
  // A run of escapes is UTF-8, not one character per byte (#1397).
  assert.strictEqual(plainItem('"caf\\303\\251 \\344\\275\\240"'), "café 你");
  assert.strictEqual(plainItem('"\\\\101 \\377"'), "\\101 \u00ff");
  // A byte that is not UTF-8 spoils none of the run's characters (#1737).
  assert.strictEqual(plainItem('"caf\\303\\251\\377"'), "café\u00ff");
  assert.strictEqual(plainItem('"\\377\\344\\275\\240\\303"'), "\u00ff你\u00c3");
  assert.strictEqual(plainItem('"\\303\\303\\251"'), "\u00c3é");
  // A string of one character, which q writes with a comma (#1961); a
  // list of one string is no string.
  assert.deepStrictEqual([',"x"', ',"\\n"', ',"\\""', ',"\\351"', ',"ab"', ',""', ',,"x"'].map(plainItem), ["x", "\n", '"', "\u00e9", ',"ab"', ',""', ',,"x"']);
  const flags = { count: 3, keys: 0, names: ["a"], types: [0], cells: [['"ab"', '""', ',"x"']], raw: [[false, false, false]], rank: [[]] };
  assert.deepStrictEqual(JSON.parse(toJson(flags)), [{ a: "ab" }, { a: "" }, { a: "x" }]);
  assert.deepStrictEqual(distinctNames(["a", "a", "", "a_1"]), ["a", "a_1", "column3", "a_1_1"]);
});

test("JSON writes numbers as numbers, every digit of a long, nulls as null, the rest as q's text", () => {
  const rows = JSON.parse(toJson(typed()));
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[1], { s: "b", b: false, j: null, f: null, d: null, p: null, l: "`x`y" });
  assert.strictEqual(rows[0].l, "abc");
  assert.strictEqual(rows[2].j, "0W");
  assert.strictEqual(rows[2].f, "-0w");
  // The long's digits are in the text, past what a double holds.
  assert.match(toJson(typed()), /"j": 9007199254740993,/);
  assert.strictEqual(toJson({ ...typed(), cells: typed().cells.map(() => []), raw: typed().raw.map(() => []) }), "[]\n");
});

test("Markdown shows the cells as the grid does, escapes pipes, and aligns numbers right", () => {
  const md = toMarkdown({ count: 2, keys: 0, names: ["a|b", "x"], types: [11, 9], cells: [["p|q", "r"], ["1.23456", "2"]], raw: [[], [1.23456, 2]], rank: [[], []] }, 2);
  assert.strictEqual(md, "| a\\|b | x |\n| --- | ---: |\n| p\\|q | 1.23 |\n| r | 2.00 |\n");
  // A cell is its text: `a`b keeps its backticks, *x* is no emphasis (#1263).
  assert.strictEqual(markdownCell("`a`b *x* _y_ [l](u) <b> a&amp; ~s~ $m$ \\"), "\\`a\\`b \\*x\\* \\_y\\_ \\[l\\](u) \\<b\\> a\\&amp; \\~s\\~ \\$m\\$ \\\\");
  // Data never becomes a live value the notebook runs (#1543).
  const md2 = toMarkdown({ count: 1, keys: 0, names: ["{{q: n}}"], types: [0], cells: [['{{q: system "touch /tmp/x"}}']], raw: [[]], rank: [[]] }, 2);
  assert.deepStrictEqual(liveExpressions(md2), []);
  assert.strictEqual(markdownCell("{{q: x}}"), "\\{\\{q: x\\}\\}");
});

test("every format is offered with its extension, and says how many rows the grid held of a cut result", () => {
  assert.deepStrictEqual(EXPORT_FORMATS.map((f) => FORMAT_INFO[f].extension), ["xlsx", "parquet", "json", "md", "q", "html"]);
  const cut = { ...typed(), count: 10 };
  for (const f of EXPORT_FORMATS) {
    const out = exportResult(f, cut, -1, [0, 2]);
    assert.strictEqual(out.rows, 2, f);
    assert.match(out.notes.join(), /held 3 of the result's 10 rows/, f);
  }
});

/// The files of a zip, read back by its central directory, each checked
/// against its CRC-32.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buffer.readUInt32LE(at), 0x02014b50);
    const size = buffer.readUInt32LE(at + 20);
    const crc = buffer.readUInt32LE(at + 16);
    const nameLength = buffer.readUInt16LE(at + 28);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    const local = buffer.readUInt32LE(at + 42);
    assert.strictEqual(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26);
    const data = zlib.inflateRawSync(buffer.subarray(start, start + size));
    assert.strictEqual(crc32(data), crc, name);
    files[name] = data.toString("utf8");
    at += 46 + nameLength;
  }
  return files;
}

test("an xlsx is a zip of the parts Excel needs, numbers, booleans and temporals typed, nulls empty", () => {
  assert.strictEqual(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.deepStrictEqual([0, 25, 26, 701, 16383].map(columnName), ["A", "Z", "AA", "ZZ", "XFD"]);
  assert.strictEqual(xmlText('<a & "b">\u0001'), "&lt;a &amp; &quot;b&quot;&gt;");
  const out = exportResult("xlsx", typed(), -1);
  const files = unzip(out.data);
  assert.deepStrictEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
  const sheet = files["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<c s="1" r="A1" t="inlineStr"><is><t xml:space="preserve">s<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="B2" t="b"><v>1<\/v><\/c>/);
  // A long past 2^53 keeps its digits as text; a float is a number.
  assert.match(sheet, /<c r="C2" t="inlineStr"><is><t xml:space="preserve">9007199254740993<\/t>/);
  assert.match(sheet, /<c r="D2"><v>3.14159265358979<\/v><\/c>/);
  // 2024.01.31 is serial 45322, a date; the null row has no D3 at all.
  assert.match(sheet, /<c r="E2" s="2"><v>45322<\/v><\/c>/);
  assert.doesNotMatch(sheet, /r="E3"/);
  assert.match(sheet, /<c r="G2" t="inlineStr"><is><t xml:space="preserve">abc<\/t>/);
  assert.match(sheet, /<pane ySplit="1"/);
  // Each part is XML whose tags close.
  for (const [name, xml] of Object.entries(files)) {
    assert.ok(xml.startsWith("<?xml"), name);
  }
});

test("a temporal is an Excel serial with a format, unless Excel cannot show it", () => {
  assert.deepStrictEqual(temporalSerial(14, 0), { n: 36526, s: 2 });
  assert.deepStrictEqual(temporalSerial(13, 1), { n: 36557, s: 3 });
  assert.deepStrictEqual(temporalSerial(19, 43200000), { n: 0.5, s: 5 });
  assert.strictEqual(temporalSerial(14, -36500), undefined);
  assert.strictEqual(temporalSerial(16, -1), undefined);
  assert.deepStrictEqual(xlsxCell(16, "-0D00:00:01", -1e9), { t: "-0D00:00:01" });
  assert.deepStrictEqual(xlsxCell(7, "0W", Infinity), { t: "0W" });
  assert.deepStrictEqual(xlsxCell(4, "ff"), { n: 255 });
  assert.strictEqual(xlsxCell(11, ""), undefined);
});

test("a zip of no file is an empty archive", () => {
  const empty = zip([]);
  assert.strictEqual(empty.length, 22);
  assert.strictEqual(empty.readUInt32LE(0), 0x06054b50);
});

test("a Parquet file starts and ends with PAR1, its footer's length before the last, and types columns as Parquet does", () => {
  const out = exportResult("parquet", typed(), -1);
  const data = out.data;
  assert.strictEqual(data.toString("latin1", 0, 4), "PAR1");
  assert.strictEqual(data.toString("latin1", data.length - 4), "PAR1");
  const footer = data.readUInt32LE(data.length - 8);
  assert.ok(footer > 0 && footer < data.length - 12);
  const meta = data.subarray(data.length - 8 - footer, data.length - 8).toString("latin1");
  for (const name of ["schema", "s", "b", "j", "f", "d", "p", "l", "q-lint"]) {
    assert.ok(meta.includes(name), name);
  }
  assert.match(out.notes.join(), /1 infinite or out-of-range date\(s\) or timestamp\(s\) were written as null/);
  assert.deepStrictEqual([1, 5, 7, 9, 12, 14, 11].map((t) => planFor(t).type), [0, 1, 2, 5, 2, 1, 6]);
  assert.deepStrictEqual([1, 4, 10, 7].map((t) => planFor(t).optional), [false, false, false, true]);
  // Runs of definition levels after their length: three present, one null.
  assert.deepStrictEqual([...definitionLevels([true, true, true, false])], [4, 0, 0, 0, 6, 1, 2, 0]);
});

test("a Parquet timestamp or date past what its type holds is a null, counted in the notes, not a RangeError (#1483)", () => {
  // KDB-X: 2263.01.06D19:33:20 is 8300000000000000000 nanoseconds since 2000.
  const ts = { count: 2, keys: 0, names: ["t"], types: [12], cells: [["2263.01.06D19:33:20.000000000", "2000.01.01D00:00:00.000000000"]], raw: [[8300000000000000000n, 0n]], rank: [[1, 0]] };
  assert.match(toParquet(ts, [0, 1]).notes.join(), /^1 infinite or out-of-range/);
  const d = { count: 1, keys: 0, names: ["d"], types: [14], cells: [["0000.00.00"]], raw: [[2147483000]], rank: [[0]] };
  assert.match(toParquet(d, [0]).notes.join(), /^1 infinite or out-of-range/);
  const z = { count: 1, keys: 0, names: ["z"], types: [15], cells: [["0000.00.00T00:00:00.000"]], raw: [[1e300]], rank: [[0]] };
  assert.match(toParquet(z, [0]).notes.join(), /^1 infinite or out-of-range/);
});

test("a datetime finer than its millisecond text is written as its float of days (#1494)", () => {
  // KDB-X: string "z"$1.123456789 is 2000.01.02T02:57:46.666, 6.6e-9 days short.
  assert.strictEqual(atomLiteral(15, "2000.01.02T02:57:46.666", 1.123456789).literal, '"z"$1.123456789');
  // KDB-X: "z"$9497.425 is 2026.01.01T10:12:00.000, which reads back exactly.
  assert.strictEqual(atomLiteral(15, "2026.01.01T10:12:00.000", 9497.425).literal, "2026.01.01T10:12:00.000");
  assert.strictEqual(atomLiteral(15, "", null).literal, "0Nz");
});

test("a minute, second or time of 100 hours or more is cast from its count: q cannot read the ** it writes (#1967)", () => {
  // KDB-X: "u"$6000 is **:00, "v"$-360000 is -**:00:00, "t"$360000001 is **:00:00.001.
  assert.strictEqual(atomLiteral(17, "**:00", 6000).literal, '"u"$6000');
  assert.strictEqual(atomLiteral(18, "-**:00:00", -360000).literal, '"v"$-360000');
  assert.strictEqual(atomLiteral(19, "**:00:00.001", 360000001).literal, '"t"$360000001');
  // Up to 99 hours the text is the literal, as it was.
  assert.deepStrictEqual([atomLiteral(17, "99:59", 5999).literal, atomLiteral(18, "-99:59:59", -359999).literal, atomLiteral(19, "00:00:00.059", 59).literal], ["99:59", "-99:59:59", "00:00:00.059"]);
  assert.deepStrictEqual([atomLiteral(17, "", null).literal, atomLiteral(17, "0W", Infinity).literal], ["0Nu", "0Wu"]);
  const minutes = { count: 2, keys: 0, names: ["c0"], types: [17], cells: [["", "**:00"]], raw: [[null, 6000]], rank: [[0, 1]] };
  assert.strictEqual(tableLiteral(minutes).code, '([] c0:(0Nu;"u"$6000))');
});

test("a date, month or datetime outside years 1 to 9999 is cast from its count: q cannot read what it writes (#3073)", () => {
  // KDB-X: "d"$-800000 is 0000.00.00, "m"$-30000 100000 are 0+00.01m and **33.05m, "z"$-1000000f is 0000.00.00T00:00:00.000.
  assert.strictEqual(atomLiteral(14, "0000.00.00", -800000).literal, '"d"$-800000');
  assert.strictEqual(atomLiteral(14, "0000.00.00", 2921940).literal, '"d"$2921940');
  assert.strictEqual(atomLiteral(13, "0+00.01", -30000).literal, '"m"$-30000');
  assert.strictEqual(atomLiteral(13, "0000.12", -23989).literal, '"m"$-23989');
  assert.strictEqual(atomLiteral(13, "**33.05", 100000).literal, '"m"$100000');
  assert.strictEqual(atomLiteral(15, "0000.00.00T00:00:00.000", -1000000).literal, '"z"$-1000000f');
  assert.strictEqual(atomLiteral(15, "0000.00.00T00:00:00.000", 2921940.5).literal, '"z"$2921940.5');
  // Inside them the text is the literal, as it was.
  assert.deepStrictEqual(
    [atomLiteral(14, "0001.01.01", -730119).literal, atomLiteral(14, "9999.12.31", 2921939).literal, atomLiteral(13, "0001.01", -23988).literal, atomLiteral(13, "9999.12", 95999).literal],
    ["0001.01.01", "9999.12.31", "0001.01m", "9999.12m"],
  );
  assert.deepStrictEqual([atomLiteral(15, "0001.01.01T00:00:00.000", -730119).literal, atomLiteral(15, "9999.12.31T12:00:00.000", 2921939.5).literal], ["0001.01.01T00:00:00.000", "9999.12.31T12:00:00.000"]);
  assert.deepStrictEqual([atomLiteral(14, "", null).literal, atomLiteral(14, "0W", Infinity).literal, atomLiteral(13, "", null).literal], ["0Nd", "0Wd", "0Nm"]);
  const dates = { count: 2, keys: 0, names: ["a"], types: [14], cells: [["0000.00.00", "2024.01.02"]], raw: [[-800000, 8767]], rank: [[0, 1]] };
  assert.strictEqual(tableLiteral(dates).code, '([] a:("d"$-800000;2024.01.02))');
});

test("a lone item that is no noun, the generic null or an operator, is enlisted in parentheses (#1968)", () => {
  // KDB-X: enlist :: is enlist itself, and enlist + a 'rank.
  const one = (type, cell, raw) => tableLiteral({ count: 1, keys: 0, names: ["c"], types: [type], cells: [[cell]], raw: [[raw]], rank: [[0]] }).code;
  assert.strictEqual(one(0, "::", false), "([] c:enlist(::))");
  assert.deepStrictEqual(["+", "+/", "-:", "#:", "'", ":"].map((v) => one(0, v, false)), ["+", "+/", "-:", "#:", "'", ":"].map((v) => `([] c:enlist(${v}))`));
  // A noun is written as it was.
  assert.deepStrictEqual([one(0, '"ab"', false), one(0, "1 2", false), one(0, "{x+1}", false), one(6, "0N", null), one(7, "-1", -1), one(9, "-0w", -Infinity), one(11, "a", undefined)], [
    '([] c:enlist "ab")',
    "([] c:enlist 1 2)",
    "([] c:enlist {x+1})",
    "([] c:enlist 0Ni)",
    "([] c:enlist -1)",
    "([] c:enlist -0w)",
    "([] c:enlist `a)",
  ]);
  // One enlisted inside an item, as -3! writes it with a comma.
  assert.deepStrictEqual([",::", ",,::", "(,::;1)", ",+", ",-:", "(,`a)!,::", ",-1", ",:"].map((v) => atomLiteral(0, v, false).literal), [
    "enlist(::)",
    "enlist enlist(::)",
    "(enlist(::);1)",
    "enlist(+)",
    "enlist(-:)",
    "(enlist `a)!enlist(::)",
    "enlist -1",
    "enlist :",
  ]);
  assert.strictEqual(atomLiteral(0, "(1.5;,::)", ["l", [["f", 1.5], ",::"]]).literal, "(1.5f;enlist(::))");
  assert.strictEqual(atomLiteral(0, ",::", ["l", ["::"]]).literal, "enlist(::)");
});

test("a char cell's literal is written from its byte: one past ASCII as its octal escape (#1489)", () => {
  // GRID's cells of "\303\251" decode as U+FFFD; its raw is the bytes.
  assert.strictEqual(atomLiteral(10, "\ufffd", 0xc3).literal, '"\\303"');
  assert.strictEqual(atomLiteral(10, "a", 97).literal, '"a"');
  assert.strictEqual(atomLiteral(10, " ", 32).literal, '" "');
  assert.strictEqual(atomLiteral(10, '"', 34).literal, '"\\""');
  assert.strictEqual(atomLiteral(10, "\n", 10).literal, '"\\n"');
  // Unwrapped, the decoded bytes are sent the same way.
  const g = gridOfQ({ kind: "table", attr: 0, cols: ["c"], data: [{ kind: "chars", attr: 0, v: Buffer.from([0xc3, 0xa9]) }] }, 100);
  assert.deepStrictEqual(g.raw[0], [0xc3, 0xa9]);
  assert.strictEqual(tableLiteral(g).code, '([] c:("\\303";"\\251"))');
});

test("a char cell past ASCII is exported, and shown, as the character its byte is, not as U+FFFD (#1962)", () => {
  // GRID's cells of "a\351\303" decode as U+FFFD twice; its raw is the bytes.
  const chars = { count: 3, keys: 0, names: ["c"], types: [10], cells: [["a", "\ufffd", "\ufffd"]], raw: [[97, 0xe9, 0xc3]], rank: [[]] };
  assert.deepStrictEqual(JSON.parse(toJson(chars)), [{ c: "a" }, { c: "\u00e9" }, { c: "\u00c3" }]);
  assert.strictEqual(toMarkdown(chars, 2), "| c |\n| --- |\n| a |\n| \u00e9 |\n| \u00c3 |\n");
  assert.match(exportResult("html", chars, 2).data.toString("utf8"), /<td>a<\/td><\/tr>\n<tr><td>\u00e9<\/td><\/tr>\n<tr><td>\u00c3<\/td>/);
  assert.deepStrictEqual(toGrid(chars, 2).cells, [["a", "\u00e9", "\u00c3"]]);
  const parquet = toParquet(chars, [0, 1, 2]).data;
  assert.ok(parquet.includes(Buffer.from("\u00e9")) && parquet.includes(Buffer.from("\u00c3")) && !parquet.includes(Buffer.from("\ufffd")));
  assert.deepStrictEqual([xlsxCell(10, "\ufffd", 0xe9), xlsxCell(10, "a", 97)], [{ t: "\u00e9" }, { t: "a" }]);
  // The same from an unwrapped result, and the q literal is still the byte.
  const g = gridOfQ({ kind: "table", attr: 0, cols: ["c"], data: [{ kind: "chars", attr: 0, v: Buffer.from([97, 0xe9, 0xc3]) }] }, 100);
  assert.deepStrictEqual(JSON.parse(toJson(g)), JSON.parse(toJson(chars)));
  assert.strictEqual(tableLiteral(chars).code, '([] c:("a";"\\351";"\\303"))');
});

test("a general-list item's symbol holding a space, / or - is written through `$ (#1486)", () => {
  // Each read back by KDB-X to what -3! wrote.
  const lit = (t) => atomLiteral(0, t, undefined).literal;
  assert.strictEqual(lit("(`a b;1)"), '(`$"a b";1)');
  assert.strictEqual(lit("`a b`c"), '`$("a b";enlist "c")');
  assert.strictEqual(lit(",`a b"), 'enlist `$"a b"');
  assert.strictEqual(lit("`a/b"), '`$"a/b"');
  assert.strictEqual(lit("`x y!,1"), '(`$"x y")!enlist 1');
  assert.strictEqual(lit("`s#`a b`c"), '`s#`$("a b";enlist "c")');
  // What can be bare stays bare, a string's or a lambda's text untouched.
  assert.strictEqual(lit("`a``b"), "`a``b");
  assert.strictEqual(lit("`a`b!(1;\"x\")"), '`a`b!(1;"x")');
  assert.strictEqual(lit('("`x y";`p)'), '("`x y";`p)');
  assert.strictEqual(lit("{`a b}"), "{`a b}");
  // The table literal does the same.
  const t = { count: 1, keys: 0, names: ["a"], types: [0], cells: [["`x y"]], raw: [[]], rank: [[]] };
  assert.strictEqual(tableLiteral(t).code, '([] a:enlist `$"x y")');
});

test("floats nested in a general-list item are written with every digit too (#1502)", () => {
  // GRID's raw for such an item: ("F";floats), ("E";reals as floats), ("f";x), ("e";x) and
  // ("l";each item's own, or its -3! text), as the codec decodes it.
  const lit = (text, raw) => atomLiteral(0, text, raw);
  assert.deepStrictEqual(lit("1.234568 2.5", ["F", [1.23456789012, 2.5]]), { literal: "1.23456789012 2.5", cut: false });
  assert.strictEqual(lit("1 2f", ["F", [1, 2]]).literal, "1 2f");
  assert.strictEqual(lit("1 0n 0w -0w", ["F", [1, null, Infinity, -Infinity]]).literal, "1 0n 0w -0w");
  assert.strictEqual(lit(",1.234568", ["F", [1.23456789]]).literal, "enlist 1.23456789f");
  assert.strictEqual(lit("`float$()", ["F", []]).literal, '"f"$()');
  assert.strictEqual(lit("0.1 0N 0we", ["E", [Math.fround(0.1), null, Infinity]]).literal, "0.1 0N 0we");
  assert.strictEqual(lit("(1;2.123457;`a b;1 2.5e)", ["l", ["1", ["f", 2.1234567891234], "`a b", ["E", [1, 2.5]]]]).literal, '(1;2.1234567891234f;`$"a b";1 2.5e)');
  assert.strictEqual(lit(",(1.234568;0n)", ["l", [["l", [["f", 1.23456789], ["f", null]]]]]).literal, "enlist (1.23456789f;0n)");
  assert.strictEqual(lit("(0Ne;-0w)", ["l", [["e", null], ["f", -Infinity]]]).literal, "(0Ne;-0w)");
  // An item's text cut by -3! is still cut.
  assert.strictEqual(lit("(1.5;`aaaa..)", ["l", [["f", 1.5], "`aaaa.."]]).cut, true);
  // Unwrapped, from the decoded items.
  const f = (v) => ({ kind: "vector", t: 9, attr: 0, v });
  const list = { kind: "list", attr: 0, v: [f([1.23456789012, 2.5]), { kind: "list", attr: 0, v: [{ kind: "atom", t: -7, v: 1n }, { kind: "atom", t: -9, v: 2.1234567891234 }] }, { kind: "atom", t: -11, v: "x" }] };
  const g = gridOfQ({ kind: "table", attr: 0, cols: ["a"], data: [list] }, 100);
  assert.strictEqual(tableLiteral(g).code, "([] a:(1.23456789012 2.5;(1;2.1234567891234f);`x))");
});

test("floats in a dictionary or a table nested in a general-list item keep every digit (#1746)", () => {
  const lit = (text, raw) => atomLiteral(0, text, raw).literal;
  assert.strictEqual(lit("`a`b!1.123457 2", ["d", ["`a`b", ["F", [1.123456789, 2]]]]), "(`a`b)!1.123456789 2");
  assert.strictEqual(lit("+(,`a)!,1.123457 2", ["t", ["d", [",`a", ["l", [["F", [1.123456789, 2]]]]]]]), "flip (enlist `a)!enlist 1.123456789 2");
  // Unwrapped, from the decoded items.
  const f = (v) => ({ kind: "vector", t: 9, attr: 0, v });
  const syms = (v) => ({ kind: "vector", t: 11, attr: 0, v });
  const dict = { kind: "dict", sorted: false, k: syms(["a", "b"]), v: f([1.123456789, 2]) };
  const table = { kind: "table", attr: 0, cols: ["a"], data: [f([1.123456789, 2])] };
  const g = gridOfQ({ kind: "table", attr: 0, cols: ["x"], data: [{ kind: "list", attr: 0, v: [dict, table] }] }, 100);
  assert.strictEqual(tableLiteral(g).code, "([] x:((`a`b)!1.123456789 2;flip (enlist `a)!enlist 1.123456789 2))");
});

test("a table in a general-list item is written through flip, as q reads it (#1501)", () => {
  // -3! writes a table with k's monadic +, which q refuses: '+ on KDB-X.
  const lit = (t) => atomLiteral(0, t, undefined).literal;
  assert.strictEqual(lit("+(,`a)!,`p`r"), "flip (enlist `a)!enlist `p`r");
  assert.strictEqual(lit("(+(,`k)!,,1)!+(,`v)!,,2"), "(flip (enlist `k)!enlist enlist 1)!flip (enlist `v)!enlist enlist 2");
  assert.strictEqual(lit(",+(,`a)!,1 2"), "enlist flip (enlist `a)!enlist 1 2");
  assert.strictEqual(lit("+`a b`c!(1 2;3 4)"), 'flip (`$("a b";enlist "c"))!(1 2;3 4)');
  // + the function, and + between two values, stay.
  assert.strictEqual(lit("(+;1)"), "(+;1)");
  assert.strictEqual(lit("{x+(y;1)}"), "{x+(y;1)}");
  assert.strictEqual(lit('("+(";1)'), '("+(";1)');
});

test("a float or real item of a general list is written with every digit, not -3!'s \\P 7 text (#1485)", () => {
  // GRID's raw for a general column: each float or real item as a float, 0b for the rest.
  const p = { count: 3, keys: 0, names: ["a"], types: [0], cells: [["1.234568", "`x", "0.1e"]], raw: [[1.23456789, false, Math.fround(0.1)]], rank: [[]] };
  assert.strictEqual(tableLiteral(p).code, "([] a:(1.23456789f;`x;0.1e))");
  assert.match(toJson(p), /"a": 1\.23456789\}.*"a": "`x"\}.*"a": 0\.1\}/s);
  assert.strictEqual(atomLiteral(0, "0w", Infinity).literal, "0w");
  assert.strictEqual(atomLiteral(0, "2f", 2).literal, "2f");
  // Unwrapped, from the decoded items.
  const list = { kind: "list", attr: 0, v: [{ kind: "atom", t: -9, v: 1.23456789 }, { kind: "atom", t: -11, v: "x" }, { kind: "atom", t: -9, v: null }] };
  const g = gridOfQ({ kind: "table", attr: 0, cols: ["a"], data: [list] }, 100);
  assert.deepStrictEqual(g.raw[0], [1.23456789, false, false]);
  assert.strictEqual(tableLiteral(g).code, "([] a:(1.23456789f;`x;0n))");
});

test("a string cut at 200 characters is written as its characters up to the cut, and every format says so (#2087)", () => {
  // KDB-X: GRID's cells of ([] s:(300#"a";"b";"caf\303\251",300#"\303\251")).
  const long = `"${"a".repeat(196)}...`;
  const utf = `"caf\\303\\251${"\\303\\251".repeat(23)}\\...`;
  assert.strictEqual(utf.length, 200);
  const p = { count: 3, keys: 0, names: ["s"], types: [0], cells: [[long, '"b"', utf]], raw: [[false, false, false]], rank: [[]] };
  assert.deepStrictEqual(JSON.parse(toJson(p)).map((r) => r.s), [`${"a".repeat(196)}...`, "b", `café${"é".repeat(23)}...`]);
  for (const format of EXPORT_FORMATS) {
    assert.ok(exportResult(format, p, -1).notes.includes("2 cell(s) were cut at 200 characters or at the process's \\c width and are not their whole value"), format);
  }
  assert.deepStrictEqual(exportResult("json", p, -1, [1]).notes, []);
  // Cut inside an escape, or inside a character's bytes: neither is kept.
  assert.deepStrictEqual(['"caf\\303\\251 \\303...', '"\\346\\227\\245\\346\\227...', '"ab\\30...', '"x\\"...', '"ab\\\\...'].map(plainItem), ["café ...", "日...", "ab...", 'x"...', "ab\\..."]);
});

test("-0 keeps its sign in every export, a real's too (#2089)", () => {
  const { realValue } = require("../out/grid.js");
  assert.ok(Object.is(realValue(-0), -0));
  const p = { count: 2, keys: 0, names: ["e", "f"], types: [8, 9], cells: [["-0", "1"], ["-0", "1"]], raw: [[-0, 1], [-0, 1]], rank: [[0, 1], [0, 1]] };
  assert.match(toJson(p), /"e": -0, "f": -0\}/);
  assert.strictEqual(tableLiteral(p).code, "([] e:(-0e;1e);f:(-0f;1f))");
  assert.match(unzip(exportResult("xlsx", p, -1).data)["xl/worksheets/sheet1.xml"], /<c r="A2"><v>-0<\/v><\/c><c r="B2"><v>-0<\/v><\/c>/);
  const file = toParquet(p, [0, 1]).data;
  assert.ok(file.includes(Buffer.from([0, 0, 0, 0x80, 0, 0, 0x80, 0x3f])), "the real -0's float bytes");
  assert.ok(file.includes(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0x80])), "the float -0's");
});

test("Excel and Parquet write a general list's float with every digit, as JSON does (#2088)", () => {
  // GRID's payload of ([] l:(acos -1;0n;"x";1b;7;9007199254740993)).
  assert.deepStrictEqual(xlsxCell(0, "3.141593", Math.PI), { n: Math.PI });
  assert.deepStrictEqual(xlsxCell(0, "0.1e", Math.fround(0.1)), { n: 0.1 });
  assert.deepStrictEqual(xlsxCell(0, "0n", false), undefined);
  assert.deepStrictEqual(xlsxCell(0, '"x"', false), { t: "x" });
  assert.deepStrictEqual(xlsxCell(0, "1b", false), { b: true });
  assert.deepStrictEqual(xlsxCell(0, "7", false), { n: 7 });
  assert.deepStrictEqual(xlsxCell(0, "9007199254740993", false), { t: "9007199254740993" });
  const p = { count: 3, keys: 0, names: ["l"], types: [0], cells: [["3.141593", "0n", '"x"']], raw: [[Math.PI, false, false]], rank: [[]] };
  const file = toParquet(p, [0, 1, 2]).data;
  assert.ok(file.includes(Buffer.from("3.141592653589793")), "every digit");
  assert.ok(!file.includes(Buffer.from("3.141593")) && !file.includes(Buffer.from("0n")), "no \\P text, no q null");
  const sheet = unzip(exportResult("xlsx", p, -1).data)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<c r="A2"><v>3\.141592653589793<\/v><\/c>/);
});

test("JSON writes a general list's integers, booleans and nulls as JSON's own, as it does a float's (#2086)", () => {
  // KDB-X -3! of each item of ([] a:(1;0n;2.5;0Nj;1b;0x01;`a;"x";enlist "y";1 2;0Wh;-0we;0Ni;`;-7i;9007199254740993)).
  const cells = ["1", "0n", "2.5", "0N", "1b", "0x01", "`a", '"x"', ',"y"', "1 2", "0Wh", "-0we", "0Ni", "`", "-7i", "9007199254740993"];
  const raw = cells.map(() => false);
  raw[2] = 2.5;
  raw[11] = -Infinity;
  const p = { count: cells.length, keys: 0, names: ["a"], types: [0], cells: [cells], raw: [raw], rank: [[]] };
  const json = toJson(p);
  assert.deepStrictEqual(JSON.parse(json).map((r) => r.a), [1, null, 2.5, null, true, 1, "`a", "x", "y", "1 2", "0Wh", "-0we", null, null, -7, 9007199254740992]);
  assert.match(json, /"a": 9007199254740993\}/);
});

test("a float infinity in a general list is shown, sent to an agent and exported as q writes it, not as a long's 0W (#1733)", () => {
  const { toGrid } = require("../out/grid.js");
  const { jsonCell } = require("../out/agent.js");
  const p = { count: 3, keys: 0, names: ["a"], types: [0], cells: [["0w", "`a", "-0we"]], raw: [[Infinity, false, -Infinity]], rank: [[]] };
  assert.deepStrictEqual(toGrid(p, -1).cells[0], ["0w", "`a", "-0we"]);
  assert.strictEqual(jsonCell(0, "0w", Infinity), "0w");
  assert.strictEqual(jsonCell(0, "-0we", -Infinity), "-0we");
  assert.deepStrictEqual(xlsxCell(0, "-0we", -Infinity), { t: "-0we" });
  // A float, a real and a long column still write their own infinities.
  assert.strictEqual(jsonCell(9, "0w", Infinity), "0w");
  assert.strictEqual(jsonCell(7, "0W", Infinity), "0W");
  assert.deepStrictEqual(xlsxCell(8, "-0we", -Infinity), { t: "-0w" });
  assert.deepStrictEqual(xlsxCell(7, "0W", Infinity), { t: "0W" });
});

test("a page of rows is added after the grid's, ranked again over both, and a page of another result is refused", () => {
  const first = { count: 4, keys: 0, names: ["v", "s"], types: [9, 11], cells: [["3", "1"], ["b", "a"]], raw: [[3, 1], []], rank: [[1, 0], [1, 0]] };
  const next = readPage({ count: 4, names: ["v", "s"], types: [9, 11], cells: [["", "2"], ["a", "c"]], raw: [[null, 2], []], rank: [[0, 1], [0, 1]] });
  const merged = appendPage(first, next);
  assert.deepStrictEqual(merged.cells, [["3", "1", "", "2"], ["b", "a", "a", "c"]]);
  // As q's iasc would rank them over all four: the null first.
  assert.deepStrictEqual(merged.rank, [[3, 1, 0, 2], [1, 0, 0, 2]]);
  assert.strictEqual(merged.count, 4);
  assert.throws(() => appendPage(first, { ...next, names: ["w", "s"] }), /not this result's/);
  assert.strictEqual(readPage("held"), "held");
  // A column q could not sort stays unranked.
  assert.deepStrictEqual(appendPage({ ...first, rank: [[], [1, 0]] }, next).rank[0], []);
});

test("a page of strings ranks a one-character one by its text, not its leading comma (#1126)", () => {
  const first = { count: 4, keys: 0, names: ["s"], types: [0], cells: [['"ab"', '"zz"']], raw: [[]], rank: [[0, 1]] };
  const next = readPage({ count: 4, names: ["s"], types: [0], cells: [[',"b"', '"a\\"q"']], raw: [[]], rank: [[1, 0]] });
  // As iasc: "a\"q", "ab", "b", "zz".
  assert.deepStrictEqual(appendPage(first, next).rank, [[1, 3, 2, 0]]);
});

test("a drill-down template has the cell's value, its column and its row's other cells put in as q", () => {
  const p = typed();
  assert.deepStrictEqual(fillDrilldown("select from t where sym={{value}}, d={{row.d}}, c={{column}}", p, 0, 2), {
    code: 'select from t where sym=(`$"c d"), d=1999.12.31, c=`s',
  });
  // A name a bare symbol cannot write is one operand on the left too (#1570).
  assert.deepStrictEqual(fillDrilldown("{{column}} xasc t", { ...p, names: ["a b", ...p.names.slice(1)] }, 0, 0), { code: '(`$"a b") xasc t' });
  assert.deepStrictEqual(fillDrilldown("{{ value }}", p, 2, 1), { code: "0Nj" });
  assert.match(fillDrilldown("{{row.nope}}", p, 0, 0).error, /no column nope/);
  assert.match(fillDrilldown("{{value}}", p, 9, 0).error, /not in the result/);
  const templates = readDrilldown([{ label: "T", query: "x {{value}}", columns: ["s"] }, { query: "y" }, { label: "bad" }, 3]);
  assert.deepStrictEqual(templates, [{ label: "T", query: "x {{value}}", columns: ["s"] }, { label: "y", query: "y", columns: [] }]);
  assert.deepStrictEqual(templatesFor(templates, "j").map((t) => t.label), ["y"]);
  assert.deepStrictEqual(templatesFor(templates, "s").map((t) => t.label), ["T", "y"]);
  assert.deepStrictEqual(readDrilldown("no"), []);
});

/// A grid as grid.ts's toGrid makes it.
const grid = (columns, cells, values, rank) => ({
  columns: columns.map(([name, type]) => ({ name, type, typeName: "", key: false, numeric: [5, 6, 7, 8, 9].includes(type), temporal: false })),
  cells,
  values,
  rank: rank ?? cells.map(() => null),
  total: cells[0].length,
});

test("a pivot groups by two columns in q's order and aggregates a third", () => {
  const g = grid(
    [["sym", 11], ["side", 11], ["qty", 7]],
    [["b", "a", "b", "a", "c"], ["buy", "sell", "sell", "buy", "buy"], ["10", "20", "30", "", "5"]],
    [null, null, [10, 20, 30, null, 5]],
    [[1, 0, 1, 0, 2], [0, 1, 1, 0, 0], [1, 2, 3, 0, 0]],
  );
  const rows = [0, 1, 2, 3, 4];
  const sum = page.pivot(g, rows, { row: 0, column: 1, value: 2, agg: "sum" });
  assert.deepStrictEqual(sum, { rows: ["a", "b", "c"], columns: ["buy", "sell"], cells: [["", "20"], ["10", "30"], ["5", ""]] });
  assert.deepStrictEqual(page.pivot(g, rows, { row: 0, column: -1, value: 2, agg: "count" }).cells, [["1"], ["2"], ["1"]]);
  assert.deepStrictEqual(page.pivot(g, rows, { row: 0, column: -1, value: -1, agg: "count" }).cells, [["2"], ["2"], ["1"]]);
  assert.deepStrictEqual(page.pivot(g, rows, { row: 1, column: -1, value: 2, agg: "avg" }).cells, [["7.5"], ["25"]]);
  assert.match(page.pivot(g, rows, { row: 0, column: -1, value: 1, agg: "max" }).note, /numeric column/);
  assert.match(page.pivot(g, rows, { row: 1, column: 0, value: 2, agg: "min" }, 2).note, /first 2 of 3 values of sym/);
  assert.deepStrictEqual(page.defaultPivot(g), { row: 0, column: -1, value: 2, agg: "sum" });
});

test("a pivot's min, max and sum of longs past 2^53 are q's, digit for digit (#2451)", () => {
  const cells = ["1700000000000000123", "1700000000000000999", "9007199254740993"];
  const g = grid([["s", 11], ["id", 7]], [["a", "a", "b"], cells], [null, cells.map(Number)], [[0, 0, 1], [1, 2, 0]]);
  const at = (agg) => page.pivot(g, [0, 1, 2], { row: 0, column: -1, value: 1, agg }).cells;
  assert.deepStrictEqual(at("min"), [["1700000000000000123"], ["9007199254740993"]]);
  assert.deepStrictEqual(at("max"), [["1700000000000000999"], ["9007199254740993"]]);
  assert.deepStrictEqual(at("sum"), [["3400000000000001122"], ["9007199254740993"]]);
});

test("a pivot keeps apart floats the grid rounds alike, as q's by does (#2078)", () => {
  const g = grid([["px", 9], ["qty", 7]], [["1.00", "1.00", "1.00", "1.00"], ["10", "20", "30", "40"]], [[1.001, 1.002, 1.003, 1.002], [10, 20, 30, 40]], [[0, 1, 2, 1], [0, 1, 2, 3]]);
  const p = page.pivot(g, [0, 1, 2, 3], { row: 0, column: -1, value: 1, agg: "sum" });
  assert.deepStrictEqual(p, { rows: ["1.00", "1.00", "1.00"], columns: ["sum"], cells: [["10"], ["60"], ["30"]] });
  // As columns too, in q's order.
  const across = page.pivot(g, [3, 2, 0], { row: -1, column: 0, value: 1, agg: "sum" });
  assert.deepStrictEqual([across.columns, across.cells], [["1.00", "1.00", "1.00"], [["10", "40", "30"]]]);
});

test("a pivot's aggregates keep every digit of a long: 123456789012345 is not 123456789012000 (#1487)", () => {
  const g = grid([["s", 11], ["q", 7]], [["a", "a"], ["123456789012345", "1"]], [null, [123456789012345, 1]]);
  const cells = (agg) => page.pivot(g, [0, 1], { row: 0, column: -1, value: 1, agg }).cells;
  assert.deepStrictEqual(cells("max"), [["123456789012345"]]);
  assert.deepStrictEqual(cells("min"), [["1"]]);
  assert.deepStrictEqual(cells("sum"), [["123456789012346"]]);
  assert.deepStrictEqual(cells("avg"), [["61728394506173"]]);
  assert.strictEqual(page.columnStats(g, [0, 1])[1].mean, "61728394506173");
});

test("a mean of finite values that overflow their sum is finite, and a sum past the largest float is 0w (#1492)", () => {
  const g = grid([["s", 11], ["f", 9]], [["a", "a"], ["1e+308", "1e+308"]], [null, [1e308, 1e308]]);
  assert.strictEqual(page.columnStats(g, [0, 1])[1].mean, "1e+308");
  const cells = (agg) => page.pivot(g, [0, 1], { row: 0, column: -1, value: 1, agg }).cells;
  assert.deepStrictEqual(cells("avg"), [["1e+308"]]);
  // KDB-X: sum 1e308 1e308 is 0w.
  assert.deepStrictEqual(cells("sum"), [["0w"]]);
  const h = grid([["s", 11], ["f", 9]], [["a", "a"], ["1e+308", "-1e+308"]], [null, [1e308, -1e308]]);
  assert.strictEqual(page.columnStats(h, [0, 1])[1].mean, "0");
});

test("a mean of large values is the sum over the count, as q's avg, not a running mean an ulp off (#1735)", () => {
  const xs = [9846345813163, 9846345813140, 9846345813100, 9846345813120, 9846345813090, 9846345813091, 9846345813113];
  const g = grid([["s", 11], ["f", 9]], [xs.map(() => "a"), xs.map(String)], [null, xs]);
  const rows = xs.map((_, i) => i);
  // KDB-X: avg gives 9846345813116.7148 (\P 0), the double 9846345813116.715.
  assert.strictEqual(page.columnStats(g, rows)[1].mean, "9846345813116.715");
  assert.deepStrictEqual(page.pivot(g, rows, { row: 0, column: -1, value: 1, agg: "avg" }).cells, [["9846345813116.715"]]);
  // Small values as before.
  const small = grid([["s", 11], ["f", 9]], [["a", "a"], ["1", "2"]], [null, [1, 2]]);
  assert.strictEqual(page.columnStats(small, [0, 1])[1].mean, "1.5");
});

const look = { colours: ["#111111", "#222222"], foreground: "#000", border: "#ccc", font: "sans-serif", up: "#0f0", down: "#f00" };

test("candles find open, high, low and close by name, and are drawn as floating bars coloured by direction", () => {
  const g = grid(
    [["date", 14], ["close", 9], ["high", 9], ["low", 9], ["open", 9]],
    [["d1", "d2"], ["11", "9"], ["12", "10"], ["8", "7"], ["10", "10"]],
    [[0, 1], [11, 9], [12, 10], [8, 7], [10, 10]],
  );
  assert.deepStrictEqual(charts.ohlcColumns(g), [4, 2, 3, 1]);
  const data = charts.chartData(g, [0, 1], "candlestick", [], 20);
  assert.deepStrictEqual(data.datasets.map((d) => d.data), [[[8, 12], [7, 10]], [[10, 11], [10, 9]]]);
  const config = charts.chartConfig(g, [0, 1], "candlestick", data, look);
  assert.deepStrictEqual(config.data.datasets[1].backgroundColor, ["#0f0", "#f00"]);
  assert.strictEqual(config.data.datasets[0].grouped, false);
  const few = grid([["x", 7], ["a", 9]], [["1"], ["2"]], [[1], [2]]);
  assert.match(charts.chartData(few, [0], "candlestick", [], 20).note, /needs open, high, low and close/);
});

test("an area fills, a step steps, and a series on the second axis gets its own scale on the right", () => {
  const g = grid([["t", 7], ["a", 9], ["b", 9]], [["1", "2"], ["1", "2"], ["100", "200"]], [[1, 2], [1, 2], [100, 200]]);
  const area = charts.chartConfig(g, [0, 1], "area", charts.chartData(g, [0, 1], "area", [1, 2], 20), look, undefined, { y2: 2 });
  assert.strictEqual(area.type, "line");
  assert.strictEqual(area.data.datasets[0].fill, "origin");
  assert.strictEqual(area.data.datasets[1].yAxisID, "y2");
  assert.strictEqual(area.options.scales.y2.position, "right");
  assert.strictEqual(area.options.scales.y2.title.text, "b");
  const step = charts.chartConfig(g, [0, 1], "step", charts.chartData(g, [0, 1], "step", [1], 20), look);
  assert.strictEqual(step.data.datasets[0].stepped, true);
  assert.deepStrictEqual(step.options.scales.y2, { display: false });
});

test("chartSvg draws a chart as an SVG document whose elements close, with gaps at nulls and the right axis labelled", () => {
  const g = grid([["t", 7], ["a", 9], ["b", 9]], [["1", "2", "3"], ["1", "", "3"], ["10", "20", "30"]], [[1, 2, 3], [1, null, 3], [10, 20, 30]]);
  for (const kind of ["line", "area", "step", "bar", "scatter", "histogram"]) {
    const data = charts.chartData(g, [0, 1, 2], kind, kind === "histogram" ? [1] : [1, 2], 5);
    const svg = charts.chartSvg(g, [0, 1, 2], kind, data, look, { y2: 2, title: "a <title>", background: "#fff" });
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), kind);
    assert.ok(svg.endsWith("</svg>"), kind);
    assert.ok(svg.includes("a &lt;title&gt;"), kind);
    const opened = (svg.match(/<(text|svg)\b/g) || []).length;
    const closed = (svg.match(/<\/(text|svg)>/g) || []).length;
    assert.strictEqual(opened, closed, kind);
  }
  const line = charts.chartSvg(g, [0, 1, 2], "line", charts.chartData(g, [0, 1, 2], "line", [1, 2], 5), look, { y2: 2 });
  // The null splits series a into two runs: two paths and two single points.
  assert.strictEqual((line.match(/stroke="#111111" stroke-width="1.5"/g) || []).length, 2);
  assert.ok(line.includes("b (right)"));
  const none = charts.chartSvg(g, [], "line", { type: "bar", datasets: [], note: "No numeric column" }, look, {});
  assert.ok(none.includes("No numeric column"));
  assert.deepStrictEqual(charts.ticks(0, 10).values, [0, 2, 4, 6, 8, 10]);
});

test("the xlsx opens in openpyxl and the Parquet file in pyarrow and DuckDB, with the values and types written", { skip: process.env.QLINT_TEST_READBACK ? false : "QLINT_TEST_READBACK names no Python" }, () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-export-"));
  fs.writeFileSync(path.join(dir, "r.xlsx"), exportResult("xlsx", typed(), -1).data);
  fs.writeFileSync(path.join(dir, "r.parquet"), exportResult("parquet", typed(), -1).data);
  const script = path.join(dir, "read.py");
  fs.writeFileSync(
    script,
    [
      "import json, sys, openpyxl, pyarrow.parquet as pq, duckdb",
      "d = sys.argv[1]",
      "ws = openpyxl.load_workbook(d + '/r.xlsx').active",
      "rows = [[str(v) if v is not None else None for v in r] for r in ws.iter_rows(values_only=True)]",
      "t = pq.read_table(d + '/r.parquet')",
      "types = [str(f.type) for f in t.schema]",
      "j = t.column('j').to_pylist()",
      "duck = duckdb.sql(\"select s, d::varchar, epoch_ns(p) from '\" + d + \"/r.parquet'\").fetchall()",
      "print(json.dumps({'xlsx': rows, 'types': types, 'j': [str(x) for x in j], 'duck': [[str(x) for x in r] for r in duck]}))",
    ].join("\n"),
  );
  const out = JSON.parse(execSync(`${process.env.QLINT_TEST_READBACK} -I ${script} ${dir}`, { encoding: "utf8" }));
  assert.deepStrictEqual(out.xlsx[0], ["s", "b", "j", "f", "d", "p", "l"]);
  assert.deepStrictEqual(out.xlsx[1].slice(0, 5), ["a", "True", "9007199254740993", "3.14159265358979", "2024-01-31 00:00:00"]);
  assert.deepStrictEqual(out.xlsx[2], ["b", "False", null, null, null, null, "`x`y"]);
  assert.deepStrictEqual(out.types, ["string", "bool", "int64", "double", "date32[day]", "timestamp[ns]", "string"]);
  assert.deepStrictEqual(out.j, ["9007199254740993", "None", "9223372036854775807"]);
  assert.deepStrictEqual(out.duck[0], ["a", "2024-01-31", "1704164645123456789"]);
  assert.deepStrictEqual(out.duck[1], ["b", "None", "None"]);
});


test("an unwrapped result's longs and timestamps reach Parquet exactly (#1398)", () => {
  const longs = gridOfQ({ kind: "vector", t: 7, attr: 0, v: [9007199254740993n, 9223372036854775806n, 5n] }, 10);
  assert.deepStrictEqual(longs.raw[0], ["9007199254740993", "9223372036854775806", 5]);
  const has = (data, n) => {
    for (let k = 0; k + 8 <= data.length; k++) {
      if (data.readBigInt64LE(k) === n) {
        return true;
      }
    }
    return false;
  };
  const data = toParquet(longs, [0, 1, 2]).data;
  assert.ok(has(data, 9007199254740993n));
  assert.ok(has(data, 9223372036854775806n));
  // A timestamp is always past 2^53 ns: 2024.12.31D22:40:00.123456789.
  const ts = gridOfQ({ kind: "vector", t: 12, attr: 0, v: [789000000123456789n] }, 10);
  assert.ok(has(toParquet(ts, [0]).data, 789000000123456789n + 946684800000000000n));
});

test("an xlsx cell past Excel's 32767 is cut before an emoji, not through it (#1811)", () => {
  assert.strictEqual(xlsxCell(10, `${"a".repeat(32766)}😀`).t, "a".repeat(32766));
  assert.strictEqual(xlsxCell(10, `${"a".repeat(32765)}😀b`).t, `${"a".repeat(32765)}😀`);
  assert.strictEqual(xlsxCell(10, "a".repeat(40000)).t.length, 32767);
});

test("an export is written in parts: past V8's longest string it is still the whole text (#1855)", () => {
  const { textBuffer, csvLines, toCsv, toGrid, tooBigToCopy, CLIPBOARD_LIMIT } = require("../out/grid.js");
  const { constants } = require("node:buffer");
  // One string shared by every part, so only the Buffer costs memory.
  const part = "x".repeat(1 << 20);
  const count = Math.ceil(constants.MAX_STRING_LENGTH / part.length) + 1;
  assert.throws(() => Array(count).fill(part).join(""), /Invalid string length/);
  const big = textBuffer(Array(count).fill(part));
  assert.strictEqual(big.length, count * part.length);
  assert.strictEqual(big[big.length - 1], 0x78);
  // Too big to copy says so, and points at a file.
  assert.match(tooBigToCopy(big, 1_000_000), /more than the 64 MB a copy puts on the clipboard\. Export them to a file instead\./);
  assert.strictEqual(tooBigToCopy(Buffer.alloc(CLIPBOARD_LIMIT), 1), undefined);
  // Each format's parts make the same text as its string.
  const payload = { count: 3, keys: 1, names: ["k", "v", "s"], types: [7, 9, 11], cells: [["1", "2", "3"], ["1.5", "0n", "-0w"], ["a", "", "c d"]], raw: [[1, 2, 3], [1.5, null, -Infinity], []], rank: [[], [], []] };
  const grid = toGrid(payload, 2);
  assert.strictEqual(textBuffer(csvLines(grid, [2, 0])).toString(), toCsv(grid, [2, 0]));
  assert.strictEqual(exportResult("json", payload, 2).data.toString(), toJson(payload));
  assert.strictEqual(exportResult("markdown", payload, 2).data.toString(), toMarkdown(payload, 2));
  assert.strictEqual(exportResult("q", payload, 2).data.toString(), `${tableLiteral(payload).code}\n`);
  assert.strictEqual(exportResult("q", { ...payload, names: ["k", "v w", "s"] }, 2).data.toString(), `${tableLiteral({ ...payload, names: ["k", "v w", "s"] }).code}\n`);
  const { toHtml } = require("../out/resultexport.js");
  assert.strictEqual(exportResult("html", payload, 2).data.toString(), toHtml(payload, 2));
  assert.match(toHtml({ ...payload, cells: [[], [], []], raw: [[], [], []] }, 2), /<tbody>\n\n<\/tbody>\n<\/table><\/body><\/html>\n$/);
  assert.strictEqual(toJson({ ...payload, cells: [[], [], []], raw: [[], [], []] }), "[]\n");
});

test("a cell of a function q writes as it does not read back is counted, and Copy as q says so (#3084)", () => {
  // As GRID sends one: ("u";its text), in a list too.
  const k = "k){$[0>@x;!x;'`type]}";
  const p = { count: 3, keys: 0, names: ["a"], types: [0], cells: [[k, `(${k};1)`, "{x}"]], raw: [[["u", k], ["l", [["u", k], "1"]], false]], rank: [[]] };
  assert.strictEqual(atomLiteral(0, k, ["u", k]).unread, true);
  assert.strictEqual(atomLiteral(0, "{x}", false).unread, undefined);
  assert.strictEqual(tableLiteral(p).unread, 2);
  assert.strictEqual(tableLiteral(p, [2]).unread, 0);
  const note = "2 cell(s) hold a function q writes as it does not read back (one defined in q, or a composition)";
  assert.ok(exportResult("q", p, -1).notes.includes(note));
  assert.deepStrictEqual(exportResult("q", p, -1, [2]).notes, []);
  // The other formats write the cell's text, which is all they say it is.
  assert.deepStrictEqual(exportResult("json", p, -1).notes, []);
});

test("a drill-down literal that is no single token is one operand, in parentheses (#3072)", () => {
  const g = "409031f3-b19c-6770-ee84-6e9369c98697";
  const p = {
    count: 1,
    keys: 0,
    names: ["g", "u", "x", "d", "s", "n", "l", "v", "w"],
    types: [2, 17, 0, 0, 11, 7, 0, 0, 0],
    cells: [[g], ["**:00"], [',"x"'], ["`a`b!1 2"], ["a"], ["-1"], ["(1;`a)"], ["1 2 3"], ["(1;2)!(3;4)"]],
    raw: [[], [6000], [false], [false], [], [-1], [false], [false], [false]],
    rank: [[]],
  };
  const left = (column) => fillDrilldown("{{value}}~/:c", p, column, 0).code;
  // q reads `"G"$"..."~/:c` as `"G"$("..."~/:c)`.
  assert.strictEqual(left(0), `("G"$"${g}")~/:c`);
  assert.strictEqual(left(1), '("u"$6000)~/:c');
  assert.strictEqual(left(2), '(enlist "x")~/:c');
  assert.strictEqual(left(3), "(`a`b!1 2)~/:c");
  assert.strictEqual(left(7), "(1 2 3)~/:c");
  assert.strictEqual(left(8), "((1;2)!(3;4))~/:c");
  // One token, or one in parentheses already, is as it was.
  assert.strictEqual(left(4), "`a~/:c");
  assert.strictEqual(left(5), "-1~/:c");
  assert.strictEqual(left(6), "(1;`a)~/:c");
  const t = typed();
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4, 5].map((c) => fillDrilldown("{{value}}", t, c, 0).code),
    ["`a", "1b", "9007199254740993", fillDrilldown("{{value}}", t, 3, 0).code, "2024.01.31", "2024.01.02D03:04:05.123456789"],
  );
  assert.strictEqual(fillDrilldown("{{value}}", t, 6, 0).code, '"abc"');
  assert.strictEqual(fillDrilldown("{{value}}", t, 6, 1).code, "`x`y");
});
