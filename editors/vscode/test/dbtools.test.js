// The database features' pure parts (#1022-#1031): the column manager's
// checks and script, the documenter's reading and rendering, the partition
// check's problems, the sym report, the attribute advice, the schema diff
// and its script, the test data, the tickerplant log's readers, the
// dashboards' store and the charts from files and the command line - and
// that every switch is declared and every command hidden when it is off.
// What runs on q is dbtools_q.test.js; the commands' flows through the
// stand-in `vscode` are dbtools_vscode.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const { DB_SETTINGS, DB_COMMANDS, dbOn, dbOff } = require("../out/dbfeatures.js");
const { opProblem, opText, columnScript, columnScriptOf, readRun, HELPERS } = require("../out/colmanager.js");
const { readDoc, qdocs, docMarkdown, docHtml, typeName, workspaceDocs } = require("../out/dbdoc.js");
const { missingWeekdays, partitionProblems, partitionReport, readPartitions } = require("../out/partcheck.js");
const { readSym, symReport } = require("../out/syminspect.js");
const { advise, filterCounts, adviceReport, readAttributeSample, ATTRIBUTE_SAMPLE } = require("../out/attradvice.js");
const { schemaDiff, migrationScript, nullOf, castOf, castProblem } = require("../out/migrate.js");
const { symbolPool, rangeOf, generator, testDataQ, testDataCsv, loadTypes, random } = require("../out/testdata.js");
const { headNames, timeOfDay, rangeProblem, readTpPage, readTpLog, readReplayed } = require("../out/tplog.js");
const { parseDashboards, changed, tileQueryProblem, dashboardNameProblem, withDashboard, refreshOf } = require("../out/dashboard.js");
const { gridFromCsv, gridFromJson, chartFromGrid } = require("../out/chartfile.js");
const { parseArgs, main, USAGE } = require("../out/chartcli.js");
const { guardCheck } = require("../out/guard.js");

const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));

test("every switch is declared, on by default, and every command hidden by its switch", () => {
  for (const [feature, { key, fallback }] of Object.entries(DB_SETTINGS)) {
    assert.strictEqual(props[`q-lint.${key}`]?.type, "boolean", feature);
    assert.strictEqual(props[`q-lint.${key}`].default, fallback, feature);
    assert.strictEqual(fallback, true, feature);
    assert.match(dbOff(feature), new RegExp(`Set q-lint\\.${key.replace(/\./g, "\\.")} to true`));
  }
  const switchOf = {
    [DB_COMMANDS.manageColumn]: "hdbBrowser.columnManager.enable",
    [DB_COMMANDS.document]: "databaseDocumenter.enable",
    [DB_COMMANDS.checkPartitions]: "hdbBrowser.partitionCheck.enable",
    [DB_COMMANDS.inspectSym]: "hdbBrowser.symInspector.enable",
    [DB_COMMANDS.adviseAttributes]: "processExplorer.attributeAdvisor.enable",
    [DB_COMMANDS.migrateSchema]: "schemaMigration.enable",
    [DB_COMMANDS.testData]: "testDataGenerator.enable",
    [DB_COMMANDS.openTpLog]: "tickerplantLog.enable",
    [DB_COMMANDS.openDashboard]: "dashboards.enable",
    [DB_COMMANDS.addToDashboard]: "dashboards.enable",
    [DB_COMMANDS.renderChart]: "charts.commandLine.enable",
  };
  const menus = Object.values(pkg.contributes.menus).flat();
  for (const [command, key] of Object.entries(switchOf)) {
    if (!Object.values(DB_COMMANDS).includes(command)) continue;
    assert.ok(pkg.contributes.commands.some((c) => c.command === command && c.title && c.category === "q-lint"), command);
    const entries = menus.filter((m) => m.command === command);
    assert.ok(entries.some((m) => m.when !== undefined), `${command} in the palette`);
    for (const m of entries) assert.ok(m.when.includes(`config.q-lint.${key}`), `${command}: ${m.when}`);
  }
  assert.strictEqual(dbOn((k, d) => (k === "charts.commandLine.enable" ? false : d), "chartCli"), false);
  assert.strictEqual(dbOn(() => "yes", "chartCli"), true);
  if (DB_SETTINGS.symInspector) assert.strictEqual(props["q-lint.hdbBrowser.symInspector.warnAbove"].default, 1000000);
});

test("the column manager checks an op against the table and writes a script the guard reads as a write", () => {
  const cols = ["date", "sym", "px"];
  assert.strictEqual(opProblem({ op: "add", column: "ex", value: "`" }, cols, "date"), undefined);
  assert.match(opProblem({ op: "add", column: "px", value: "0n" }, cols, "date"), /already has a column px/);
  assert.match(opProblem({ op: "add", column: "1x", value: "0n" }, cols, "date"), /not a column name/);
  assert.match(opProblem({ op: "add", column: "x", value: "" }, cols, "date"), /one q value/);
  // A keyword, a builtin or `i` as a new name is refused with why (#1960).
  for (const name of ["type", "select", "count", "by", "xasc"]) {
    assert.strictEqual(opProblem({ op: "add", column: name, value: "0n" }, cols, "date"), `${name} is a q keyword or builtin, which a query cannot name as a column`);
    assert.strictEqual(opProblem({ op: "rename", column: "px", to: name }, cols, "date"), `${name} is a q keyword or builtin, which a query cannot name as a column`);
  }
  assert.match(opProblem({ op: "add", column: "i", value: "0n" }, cols, "date"), /^i is the row index in a query/);
  assert.match(opProblem({ op: "rename", column: "px", to: "i" }, cols, ""), /^i is the row index in a query/);
  assert.match(opProblem({ op: "rename", column: "px", to: "a b" }, cols, "date"), /not a column name/);
  // Names that only start like one, and a column that has such a name already, are not.
  assert.strictEqual(opProblem({ op: "add", column: "types", value: "0n" }, cols, "date"), undefined);
  assert.strictEqual(opProblem({ op: "rename", column: "px", to: "ii" }, cols, "date"), undefined);
  assert.strictEqual(opProblem({ op: "rename", column: "type", to: "kind" }, [...cols, "type"], "date"), undefined);
  assert.strictEqual(opProblem({ op: "delete", column: "i" }, [...cols, "i"], "date"), undefined);
  assert.match(opProblem({ op: "delete", column: "date" }, cols, "date"), /partition field/);
  assert.match(opProblem({ op: "delete", column: "nope" }, cols, "date"), /no column nope/);
  assert.match(opProblem({ op: "rename", column: "px", to: "sym" }, cols, "date"), /already has a column sym/);
  assert.match(opProblem({ op: "cast", column: "px", type: "q" }, cols, "date"), /type characters/);
  assert.strictEqual(opProblem({ op: "attr", column: "sym", attr: "p" }, cols, "date"), undefined);
  assert.strictEqual(opProblem({ op: "reorder", order: ["px", "sym"] }, cols, "date"), undefined);
  assert.match(opProblem({ op: "reorder", order: ["px"] }, cols, "date"), /every column once/);
  const script = columnScript("trade", { op: "rename", column: "px", to: "price" }, "hdb");
  assert.match(script, /^\/ q-lint: HDB column manager - rename column px to price in trade on hdb\./);
  for (const h of HELPERS) assert.ok(script.includes(h));
  assert.match(script, /\.qlint\.cm\.run\[`trade;\.qlint\.cm\.ren\[`px;`price\]\]/);
  assert.match(script, /system"l \."/);
  // A rename quotes both paths for the shell (#1083): run on a real q in dbtools_q.test.js.
  assert.ok(HELPERS.some((h) => h.startsWith(".qlint.cm.mvcmd:") && h.includes(`{"'",ssr[x;"'";"'\\\\''"],"'"}`) && h.includes('{"\\"",ssr[x;"/";"\\\\"],"\\""}')));
  assert.match(opText({ op: "attr", column: "sym", attr: "" }), /remove the attribute/);
  assert.match(columnScriptOf("t", [{ op: "delete", column: "a" }, { op: "reorder", order: ["b"] }], "p"), /step:2 from .*order\[enlist`b\]/);
  const settings = { enabled: true, tags: ["prod"] };
  assert.notStrictEqual(guardCheck(script, [{ label: "hdb", tags: ["prod"] }], settings), undefined);
  assert.deepStrictEqual(readRun([true, "changed 3 of 3 directories"]), { ok: true, text: "changed 3 of 3 directories" });
  assert.deepStrictEqual(readRun([false, "type"]), { ok: false, error: "type" });
  assert.throws(() => readRun("x"), /outcome/);
});

test("the documenter reads one table's answer, takes the qDoc above a definition, and escapes what it renders", () => {
  const raw = {
    pf: "",
    parts: 0,
    tables: { name: "t<1>", kind: "keyed", rows: 2, keys: ["k"], cols: ["k", "v"], types: ["j", "C"], fkeys: ["", ""], attrs: ["u", ""] },
    fnames: ".lib.f",
    fparams: ["a", "b"],
  };
  const doc = readDoc(raw);
  assert.strictEqual(doc.tables.length, 1);
  assert.deepStrictEqual(doc.functions, [{ name: ".lib.f", params: ["a", "b"] }]);
  assert.strictEqual(typeName("C"), "list of char");
  const source = ["/// Adds two numbers.", "/// @param a", "f:{[a;b] a+b}", "", "/", "Block doc.", "\\", ".lib.g:{x}", "h:{x}"].join("\n");
  const docs = qdocs(source);
  assert.strictEqual(docs.get("f"), "Adds two numbers.\n@param a");
  assert.strictEqual(docs.get(".lib.g"), "Block doc.");
  assert.strictEqual(docs.has("h"), false);
  // A block nested in the doc's block is part of it: the doc is the outer one's (#1817).
  const nested = qdocs(["/", "Adds one to x.", "/", "old note", "\\", "Returns a long.", "\\", "f:{x+1}"].join("\n"));
  assert.strictEqual(nested.get("f"), "Adds one to x.\n/\nold note\n\\\nReturns a long.");
  const md = docMarkdown(doc, "rdb", "now", new Map([[".lib.f", "x <b>"]]));
  assert.match(md, /### t\\<1\\>/);
  assert.match(md, /\| k \(key\) \| long \| unique \|/);
  assert.match(md, /x \\<b\\>/);
  const html = docHtml(doc, "rdb<script>", "now");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /rdb&lt;script&gt;/);
  assert.throws(() => readDoc(1), /tables/);
  // A table the process could not describe is named with q's error (#1868).
  const bad = { name: "e<m>", kind: "", rows: null, keys: [], cols: [], types: [], fkeys: [], attrs: [], error: "..sym" };
  const mixed = readDoc({ ...raw, tables: [{ ...raw.tables, error: "" }, bad] });
  assert.deepStrictEqual(mixed.tables.map((x) => x.error), [undefined, "..sym"]);
  assert.match(docMarkdown(mixed, "rdb", "now"), /### e\\<m\\>\n\nNot read: \.\.sym\.\n\n## Functions/);
  assert.match(docHtml(mixed, "rdb", "now"), /<h3 id="t-e&lt;m&gt;">e&lt;m&gt;<\/h3>\n<p>Not read: \.\.sym\.<\/p>\n<h2>Functions/);
});

test("the partition check finds weekday gaps, and each kind of problem in an answer", () => {
  assert.deepStrictEqual(missingWeekdays(["2026.01.02", "2026.01.06"]), ["2026.01.05"]);
  assert.deepStrictEqual(missingWeekdays(["2026.01.02"]), []);
  const row = (partition, extra = {}) => ({ table: "t", partition, dir: true, dotd: true, columns: ["sym", "px"], missing: [], types: [20, 9], enums: ["sym", ""], maxIndexes: [], rows: 100, ...extra });
  const answer = {
    hdb: true,
    field: "date",
    root: "/db",
    all: ["2026.01.05", "2026.01.06", "2026.01.07", "2026.01.08", "2026.01.12"],
    checked: 5,
    tables: ["t"],
    domains: new Map([["sym", 10]]),
    rows: [
      row("2026.01.05"),
      row("2026.01.06", { types: [20, 7] }),
      row("2026.01.07", { dir: false, dotd: false }),
      row("2026.01.08", { columns: ["sym", "px", "x"], types: [20, 9, 7], enums: ["sym", "", ""], rows: 0 }),
      row("2026.01.12", { missing: ["px"], types: [20], enums: ["other"], maxIndexes: [12], rows: 5000 }),
    ],
  };
  const kinds = Object.groupBy(partitionProblems(answer), (p) => p.kind);
  assert.deepStrictEqual(kinds["missing dates"][0].partitions, ["2026.01.09"]);
  assert.deepStrictEqual(kinds["missing table"][0].partitions, ["2026.01.07"]);
  assert.deepStrictEqual(kinds["missing column file"][0].partitions, ["2026.01.12"]);
  assert.match(kinds["different columns"][0].what, /has x/);
  assert.deepStrictEqual(kinds["different types"][0].partitions, ["2026.01.06"]);
  assert.ok(kinds.enumeration.some((p) => /against other/.test(p.what)));
  assert.ok(kinds["row count"].some((p) => p.partitions.includes("2026.01.08")));
  assert.ok(kinds["row count"].some((p) => p.partitions[0].startsWith("2026.01.12")));
  // Each enumerated column's largest index is held to its own domain (#1103).
  const two = (maxIndexes) => partitionProblems({ ...answer, all: ["2026.01.05"], domains: new Map([["sym", 1000], ["src", 3]]), rows: [row("2026.01.05", { columns: ["sym", "src"], types: [20, 21], enums: ["sym", "src"], maxIndexes })] }).filter((p) => p.kind === "enumeration");
  assert.deepStrictEqual(two([500, 2]), []);
  assert.deepStrictEqual(two([500, 3]).map((p) => p.what), ["t.src has a symbol index past the end of src"]);
  assert.deepStrictEqual(two([1000, 2]).map((p) => p.what), ["t.sym has a symbol index past the end of sym"]);
  const report = partitionReport(answer, "hdb", false);
  assert.match(report, /A quick check/);
  assert.match(report, /\*\*missing dates\*\*/);
  assert.match(partitionReport({ hdb: false, root: "/x" }, "rdb", false), /no partitioned database/);
  assert.deepStrictEqual(readPartitions({ hdb: false, root: "/x" }), { hdb: false, root: "/x" });
  // One table in one partition: each column of the answer is a one-item list (#1102).
  const single = readPartitions({ hdb: true, pf: "date", root: "/db", all: ["2026.01.05"], checked: 1, tables: ["trade"], domains: ["sym"], domainsizes: [2], rows: { tbl: ["trade"], part: ["2026.01.05"], dir: [true], dotd: [true], cols: [["sym", "px"]], missing: [[]], types: [[20, 9]], enums: [["sym", ""]], maxidx: [[1, null]], rows: [2] } });
  assert.deepStrictEqual(single.rows, [{ table: "trade", partition: "2026.01.05", dir: true, dotd: true, columns: ["sym", "px"], missing: [], types: [20, 9], enums: ["sym", ""], maxIndexes: [1, null], rows: 2 }]);
  assert.deepStrictEqual(partitionProblems(single), []);
});

// #2007: q writes a string or nested column with no rows as a general list
// (type 0), and maps one with rows as 77h on.
test("an empty partition's string or nested column is not a different type (#2007)", () => {
  const row = (partition, types, rows) => ({ table: "ev", partition, dir: true, dotd: true, columns: ["sym", "note", "sz"], missing: [], types, enums: ["sym", "", ""], maxIndexes: [], rows });
  const typed = (...rows) =>
    partitionProblems({ hdb: true, field: "date", root: "/db", all: rows.map((r) => r.partition), checked: rows.length, tables: ["ev"], domains: new Map([["sym", 10]]), rows })
      .filter((p) => p.kind === "different types")
      .map((p) => [p.what, p.partitions]);
  const full = (partition) => row(partition, [20, 77, 7], 3);
  const empty = (partition) => row(partition, [20, 0, 7], 0);
  assert.deepStrictEqual(typed(full("2026.01.05"), empty("2026.01.06"), full("2026.01.07")), []);
  // Most partitions empty: the one with rows is not the odd one either.
  assert.deepStrictEqual(typed(empty("2026.01.05"), empty("2026.01.06"), full("2026.01.07")), []);
  assert.deepStrictEqual(typed(empty("2026.01.05"), empty("2026.01.06")), []);
  // A general list with rows is another type, and so is an empty one where
  // the column is a simple vector: q keeps that one's type with no rows.
  assert.deepStrictEqual(typed(full("2026.01.05"), row("2026.01.06", [20, 0, 7], 3), full("2026.01.07")), [["ev.note is type 0 here, 77 in most partitions", ["2026.01.06"]]]);
  assert.deepStrictEqual(typed(full("2026.01.05"), row("2026.01.06", [20, 77, 0], 0), full("2026.01.07")), [["ev.sz is type 0 here, 7 in most partitions", ["2026.01.06"]]]);
  assert.deepStrictEqual(typed(full("2026.01.05"), row("2026.01.06", [20, 0, 6], 0), full("2026.01.07")), [["ev.sz is type 6 here, 7 in most partitions", ["2026.01.06"]]]);
});

test("the sym report warns above the threshold and lists columns and growth", () => {
  const a = readSym({ sym: true, root: "/db", count: 2000, bytes: 4096, partitions: 10, sampled: 2, ctable: ["t", "o"], ccol: ["sym", "id"], cdistinct: [5, 1900], gpart: ["2026.01.06", "2026.01.05"], gsize: [2000, 100] });
  assert.deepStrictEqual(a.columns.map((c) => c.column), ["id", "sym"]);
  assert.deepStrictEqual(a.growth.map((g) => g.partition), ["2026.01.05", "2026.01.06"]);
  const text = symReport(a, "hdb", 1000);
  assert.match(text, /\*\*Warning:\*\* more than 1,000 symbols/);
  assert.match(text, /\| o \| id \| 1,900 \| 95\.0% \|/);
  assert.match(text, /\| 2026\.01\.06 \| 2,000 \| 1,900 \|/);
  assert.doesNotMatch(symReport(a, "hdb", 5000), /Warning/);
  assert.match(symReport({ sym: false, root: "/x" }, "p", 1), /no sym file/);
  // Int partitions grow in number order, not text order (#1128).
  const ints = readSym({ sym: true, root: "/db", count: 300, bytes: 1, partitions: 3, sampled: 3, ctable: [], ccol: [], cdistinct: [], gpart: ["10", "8", "9"], gsize: [300, 100, 200] });
  assert.deepStrictEqual(ints.growth.map((g) => g.partition), ["8", "9", "10"]);
});

test("the attribute advisor counts filters and suggests by shape, never for an unfiltered column", () => {
  // Order is asked of a copy: `asc` would mark the table's own column s# (#1863).
  assert.deepStrictEqual(ATTRIBUTE_SAMPLE.match(/[^;\[]*\basc [^\])]*/g), ["{x~asc x}x til count x"]);
  const queries = ["select from trade where sym=`a", "select from trade where sym in `a`b, px>1", "?[trade;enlist(=;`id;1);0b;()]", "select from quote where sym=`a"];
  assert.deepStrictEqual(Object.fromEntries(filterCounts(queries, "trade", ["sym", "px", "id", "sz"])), { sym: 2, px: 1, id: 1, sz: 0 });
  // A namespaced table is matched by its whole name, and not by its last part (#1113).
  assert.deepStrictEqual(Object.fromEntries(filterCounts(["select from .ns.t where sym=`a", "select from t where px>1"], ".ns.t", ["sym", "px"])), { sym: 1, px: 0 });
  assert.deepStrictEqual(Object.fromEntries(filterCounts(["select from .ns.t where sym=`a"], "t", ["sym"])), { sym: 0 });
  // A symbol value is not a column, nor is a column a prefix of one (#1373).
  assert.deepStrictEqual(Object.fromEntries(filterCounts(["select from trade where x=`sym"], "trade", ["s", "x", "sym"])), { s: 0, x: 1, sym: 0 });
  assert.deepStrictEqual(Object.fromEntries(filterCounts(["?[trade;enlist(=;`sym;enlist`a);0b;()]"], "trade", ["s", "sym"])), { s: 0, sym: 1 });
  // A functional select may name its table by symbol (#1374).
  assert.deepStrictEqual(Object.fromEntries(filterCounts(["?[`trade;enlist(=;`sym;enlist`a);0b;()]"], "trade", ["sym"])), { sym: 1 });
  assert.deepStrictEqual(Object.fromEntries(filterCounts(["?[`.ns.t;enlist(=;`sym;enlist`a);0b;()]"], ".ns.t", ["sym"])), { sym: 1 });
  assert.deepStrictEqual(Object.fromEntries(filterCounts(["?[`tradex;enlist(=;`sym;enlist`a);0b;()]"], "trade", ["sym"])), { sym: 0 });
  const s = readAttributeSample({
    kind: "table",
    rows: 1000,
    sampled: 1000,
    partitions: 1,
    cols: ["time", "sym", "id", "px", "grp", "note"],
    types: ["p", "s", "j", "f", "s", "C"],
    attrs: ["", "", "", "", "", ""],
    distinct: [1000, 3, 1000, 990, 4, 50],
    runs: [1000, 700, 1000, 990, 4, 0],
    sorted: [true, false, false, false, false, false],
  });
  const filters = new Map([["sym", 2], ["id", 1], ["grp", 1], ["px", 0]]);
  const by = Object.fromEntries(advise(s, filters).map((a) => [a.column, a]));
  assert.strictEqual(by.time.suggest, "s");
  assert.strictEqual(by.time.cost, 0);
  assert.strictEqual(by.sym.suggest, "g");
  assert.strictEqual(by.sym.cost, 8 * 1000 + 16 * 3);
  assert.strictEqual(by.id.suggest, "u");
  assert.strictEqual(by.grp.suggest, "p");
  assert.strictEqual(by.px.suggest, "");
  assert.strictEqual(by.note.suggest, "");
  assert.strictEqual(advise(s, new Map()).find((a) => a.column === "sym").suggest, "");
  const report = adviceReport("trade", "rdb", s, advise(s, filters), 4);
  assert.match(report, /Nothing was applied/);
  assert.match(report, /\| sym \|  \| g# \|/);
});

test("a schema diff names adds, drops, casts and order, and the script turns one into the other", () => {
  const t = (kind, cols, keys = []) => ({ kind, rows: 0, bytes: null, partitions: null, keys, ncols: cols.length, columns: cols.map(([name, type, attr = ""]) => ({ name, type, fkey: "", attr })) });
  const from = t("keyed", [["k", "j"], ["x", "j"], ["y", "s"]], ["k"]);
  const to = t("keyed", [["k", "j"], ["z", "f"], ["x", "f", "s"]], ["k"]);
  const d = schemaDiff(from, to);
  assert.deepStrictEqual(d.add, [{ name: "z", type: "f" }]);
  assert.deepStrictEqual(d.drop, ["y"]);
  assert.deepStrictEqual(d.cast, [{ name: "x", from: "j", to: "f" }]);
  assert.deepStrictEqual(d.order, ["k", "z", "x"]);
  const script = migrationScript("a", from, "a", to, "b", "p");
  assert.match(script, /a:0!a\na:delete y from a\na:update z:0n from a\na:update x:"f"\$x from a\na:update x:`s#x from a\na:`k`z`x xcols a\na:`k xkey a/);
  assert.strictEqual(nullOf("C"), '""');
  assert.strictEqual(nullOf("J"), "`long$()");
  assert.strictEqual(castOf("c", "C", "s"), "`$c");
  // Text to a number is parsed, not cast to its character codes (#1096).
  assert.strictEqual(castOf("c", "C", "j"), '"J"$c');
  assert.strictEqual(castOf("c", "s", "j"), '"J"$string c');
  assert.strictEqual(castOf("c", "s", "d"), '"D"$string c');
  // A cast q does not make is left out by its name (#2012); between two list
  // columns it is the atoms' cast, made in each item (#2013).
  assert.strictEqual(castProblem("j", "g", false), "q has no cast from long to guid");
  assert.strictEqual(castProblem("d", "t", true), "q has no cast from date to time");
  assert.deepStrictEqual([castProblem("g", "s", false), castProblem("s", "g", true), castProblem("d", "p", false), castProblem("", "j", false)], [undefined, undefined, undefined, undefined]);
  assert.strictEqual(castProblem("j", "", false), "no cast makes a mixed column");
  assert.deepStrictEqual([castProblem("J", "F", false), castOf("b", "J", "F")], [undefined, '"f"$b']);
  assert.deepStrictEqual([castOf("b", "S", "J"), castOf("b", "J", "S"), castOf("b", "S", "C"), castOf("b", "C", "J")], ['{"J"$string x} each b', "{`$string x} each b", '{"c"$first each string x} each b', '"j"$b']);
  assert.strictEqual(castProblem("M", "T", false), "q has no cast from month to time");
  assert.strictEqual(castProblem("J", "j", false), "a list column's items are lists, an atom column's are not");
  const cast = migrationScript("a", t("table", [["k", "j"], ["g", "j"], ["l", "J"], ["m", "j"]]), "a", t("table", [["k", "j"], ["g", "g"], ["l", "F"], ["m", ""]]), "b", "p");
  assert.match(cast, /\n\/ not written: a cast of g from j to g: q has no cast from long to guid\na:update l:"f"\$l from a\n\/ not written: a cast of m from j to mixed: no cast makes a mixed column\n$/);
  // A mixed column is added as an empty list a row (#1097).
  assert.match(migrationScript("a", t("table", [["k", "j"]]), "a", t("table", [["k", "j"], ["m", ""]]), "b", "p"), /\na:update m:count\[i\]#enlist \(\) from a\n/);
  assert.match(migrationScript("a", from, "a", from, "a", "p"), /the same: there is nothing to change/);
  // A column q-sql cannot name is added, so the order and keys after find it (#1719).
  const odd = migrationScript("my t", t("keyed", [["sym", "s"], ["px bid", "f"]], ["sym"]), "a", t("keyed", [["new c", "j"], ["sym", "s"], ["px bid", "f"]], ["new c"]), "b", "p");
  assert.match(odd, /\n\(`\$"my t"\) set \{@\[x;y;:;count\[x\]#enlist z\]\}\[get`\$"my t";`\$"new c";0N\]\n/);
  assert.doesNotMatch(odd, /not written/);
  // Only the keys differ: keyed, or unkeyed (#1579).
  const ua = t("table", [["s", "s"], ["p", "f"]]);
  const ka = t("keyed", [["s", "s"], ["p", "f"]], ["s"]);
  assert.match(migrationScript("ua", ua, "ua", ka, "ka", "p"), /\/ keys {3}s\nua:`s xkey ua\n$/);
  assert.match(migrationScript("ka", ka, "ka", ua, "ua", "p"), /\/ keys {3}none\nka:0!ka\n/);
  const disk = migrationScript("trade", t("partitioned", [["date", "d"], ["sym", "s"], ["px", "f"]]), "trade", t("table", [["sym", "s"], ["px", "j"], ["ex", "s"]]), "t2", "hdb");
  assert.match(disk, /HDB column manager/);
  assert.match(disk, /\.qlint\.cm\.add\[`ex;`\]/);
  assert.match(disk, /\.qlint\.cm\.cast\[`px;"j"\]/);
  assert.doesNotMatch(disk, /del\[`date\]/);
});

test("test data: pools, ranges, a q generator per type, and CSV that sorts and repeats by seed", () => {
  assert.deepStrictEqual(symbolPool("3"), ["sym1", "sym2", "sym3"]);
  assert.deepStrictEqual(symbolPool("AAPL, `MSFT IBM"), ["AAPL", "MSFT", "IBM"]);
  assert.strictEqual(symbolPool("a-b"), undefined);
  assert.deepStrictEqual(rangeOf("0 100"), [0, 100]);
  assert.deepStrictEqual(rangeOf("-1.5..2"), [-1.5, 2]);
  assert.strictEqual(rangeOf("5 1"), undefined);
  const o = { rows: 20, symbols: ["A"], low: 10, high: 20, sorted: "px", seed: 3 };
  assert.strictEqual(generator("s", o), "n?enlist`A");
  assert.strictEqual(generator("f", o), "10+n?10f");
  const info = { kind: "keyed", rows: 0, bytes: null, partitions: null, keys: ["k"], ncols: 3, columns: [{ name: "k", type: "s", fkey: "", attr: "" }, { name: "px", type: "f", fkey: "", attr: "" }, { name: "t", type: "p", fkey: "", attr: "" }] };
  const q = testDataQ(info, "gen", o);
  assert.match(q, /\\S 3\nn:20\ngen:`k xkey \{x where\(til count x\)=k\?k:\(\(\),y\)#x\}\[\(\[\] k:n\?enlist`A; px:asc 10\+n\?10f; t:2026\.01\.02D\+n\?1D\);`k\]/);
  assert.match(q, /\ndelete n from `\.\n/);
  // A table named n is not deleted by the script's own clean-up (#1084).
  assert.doesNotMatch(testDataQ(info, "n", o), /delete n from/);
  const csv = testDataCsv(info, o);
  assert.strictEqual(csv, testDataCsv(info, o));
  const lines = csv.trim().split("\n");
  assert.strictEqual(lines[0], "k,px,t");
  assert.strictEqual(lines.length, 21);
  const px = lines.slice(1).map((l) => Number(l.split(",")[1]));
  assert.deepStrictEqual(px, [...px].sort((a, b) => a - b));
  assert.ok(px.every((x) => x >= 10 && x < 20));
  assert.match(lines[1].split(",")[2], /^2026\.01\.0[23]D\d\d:\d\d:\d\d\.\d{9}$/);
  assert.strictEqual(loadTypes(info), "SFP");
  assert.notStrictEqual(random(1)(), random(2)());
});

test("test data: a short's or an int's range is cut to the finite values it holds, in the q and the CSV (#1499)", () => {
  const o = { rows: 200, symbols: ["A"], low: 0, high: 5e9, seed: 7 };
  assert.strictEqual(generator("h", o), '"h"$0+n?32767');
  assert.strictEqual(generator("i", o), '"i"$0+n?2147483647');
  assert.strictEqual(generator("j", o), "0+n?5000000000");
  assert.strictEqual(generator("h", { ...o, low: -40000, high: -39000 }), '"h"$-32766+n?1');
  assert.strictEqual(generator("h", { ...o, low: 10, high: 20 }), '"h"$10+n?10');
  const info = { kind: "table", rows: 0, bytes: null, partitions: null, keys: [], ncols: 2, columns: [{ name: "h", type: "h", fkey: "", attr: "" }, { name: "i", type: "i", fkey: "", attr: "" }] };
  const rows = testDataCsv(info, o).trim().split("\n").slice(1).map((l) => l.split(",").map(Number));
  assert.ok(rows.every(([h, i]) => h >= 0 && h <= 32766 && i >= 0 && i <= 2147483646), JSON.stringify(rows.slice(0, 3)));
});

test("test data: a long's range is cut to the whole numbers a JavaScript number holds, in the q and the CSV (#1904)", () => {
  const o = { rows: 200, symbols: ["A"], low: 0, high: 1e19, seed: 7 };
  // 2^52 either way: past 2^63 q cannot read the count, and 1e21 prints as a float.
  assert.strictEqual(generator("j", o), "0+n?4503599627370497");
  assert.strictEqual(generator("j", { ...o, high: 1e21 }), "0+n?4503599627370497");
  assert.strictEqual(generator("j", { ...o, low: -1e21, high: 1e21 }), "-4503599627370496+n?9007199254740992");
  assert.strictEqual(generator("j", { ...o, low: 1e25, high: 1e26 }), "4503599627370496+n?1");
  assert.strictEqual(generator("j", { ...o, high: 5e9 }), "0+n?5000000000");
  const info = { kind: "table", rows: 0, bytes: null, partitions: null, keys: [], ncols: 1, columns: [{ name: "j", type: "j", fkey: "", attr: "" }] };
  for (const [low, high] of [[0, 1e19], [0, 1e21], [-1e21, 1e21]]) {
    const cells = testDataCsv(info, { ...o, low, high }).trim().split("\n").slice(1);
    assert.ok(cells.every((c) => /^-?\d+$/.test(c) && Math.abs(Number(c)) <= 2 ** 52), JSON.stringify(cells.slice(0, 3)));
  }
});

test("the tickerplant log's readers, times of day and ranges", () => {
  assert.strictEqual(timeOfDay(""), null);
  assert.strictEqual(timeOfDay("09:30"), 34_200_000);
  assert.strictEqual(timeOfDay("09:30:01.5"), 34_201_500);
  assert.strictEqual(timeOfDay("25:00"), undefined);
  assert.strictEqual(timeOfDay("9.30"), undefined);
  assert.strictEqual(rangeProblem(0, 2, 3), undefined);
  assert.match(rangeProblem(2, 1, 3), /comes before/);
  assert.match(rangeProblem(0, 3, 3), /0 to 2/);
  assert.deepStrictEqual(readTpPage({ total: 1, i: 4, fn: "upd", tb: "trade", rows: 2, tx: "09:00" }).rows, [{ index: 4, fn: "upd", table: "trade", rows: 2, time: "09:00" }]);
  assert.strictEqual(readTpLog({ count: 3, bytes: 10, size: 12, complete: false, tables: "trade" }).tables[0], "trade");
  assert.deepStrictEqual(readReplayed({ replayed: 2, failed: 0, errors: [], tables: ["t"], rows: [2] }).tables, [{ name: "t", rows: 2 }]);
  assert.deepStrictEqual(readReplayed({ replayed: 1, failed: 0, errors: [], skipped: 2, heads: ["system", ""], tables: [], rows: [] }).heads, ["system", ""]);
  assert.strictEqual(headNames(["system", ""]), "system, no name");
  assert.throws(() => readTpPage(1), /page of messages/);
});

test("dashboards are parsed, changed, and take read-only queries without placeholders only", () => {
  const list = parseDashboards([
    { name: "a", columns: 9, tiles: [{ id: "1", query: "q1", process: "p", view: "pie", refresh: 2 }, { bad: 1 }] },
    { name: "a", tiles: [] },
    "junk",
  ]);
  assert.deepStrictEqual(list, [{ name: "a", columns: 4, tiles: [{ id: "1", query: "q1", process: "p", view: "table", refresh: 5 }] }]);
  assert.strictEqual(refreshOf(0), 0);
  assert.strictEqual(refreshOf(-3), 0);
  let d = { name: "d", columns: 2, tiles: [{ id: "1", query: "a", process: "p", view: "table", refresh: 0 }, { id: "2", query: "b", process: "p", view: "table", refresh: 0 }] };
  d = changed(d, { type: "move", id: "2", by: -1 });
  assert.deepStrictEqual(d.tiles.map((t) => t.id), ["2", "1"]);
  assert.strictEqual(changed(d, { type: "move", id: "2", by: -1 }), d);
  d = changed(d, { type: "refresh-interval", id: "1", seconds: 30 });
  assert.strictEqual(d.tiles[1].refresh, 30);
  d = changed(d, { type: "view", id: "1", view: "line" });
  assert.strictEqual(d.tiles[1].view, "line");
  assert.strictEqual(changed(d, { type: "view", id: "1", view: "nope" }).tiles[1].view, "line");
  assert.strictEqual(changed(d, { type: "remove", id: "2" }).tiles.length, 1);
  assert.strictEqual(changed(d, { type: "columns", columns: 0 }).columns, 1);
  assert.strictEqual(tileQueryProblem("select from trade"), undefined);
  assert.match(tileQueryProblem("t:select from trade"), /read-only queries only/);
  assert.match(tileQueryProblem("select from trade where sym={{s}}"), /placeholder/);
  // A dotted name was let through and sent unfilled, read by q as a lambda (#1129).
  assert.match(tileQueryProblem("select from trade where date={{.cfg.day}}"), /placeholder/);
  assert.match(tileQueryProblem("select from trade where date={{cfg.day}}"), /placeholder/);
  assert.match(dashboardNameProblem(" a ", ["a"]), /already/);
  assert.deepStrictEqual(withDashboard([{ name: "x", columns: 1, tiles: [] }], { name: "x", columns: 3, tiles: [] }), [{ name: "x", columns: 3, tiles: [] }]);
});

test("a chart is drawn from CSV and JSON tables, and the command line writes it", async () => {
  const g = gridFromCsv('day,a,"b, c"\nmon,1,10\ntue,,5\n');
  assert.deepStrictEqual(g.columns.map((c) => [c.name, c.numeric]), [["day", false], ["a", true], ["b, c", true]]);
  assert.deepStrictEqual(g.values[1], [1, null]);
  // A quoted newline is inside one field of one record (#1115).
  const quoted = gridFromCsv('label,v\n"two\nlines",1\nb,2');
  assert.deepStrictEqual(quoted.cells, [["two\nlines", "b"], ["1", "2"]]);
  assert.deepStrictEqual(quoted.values[1], [1, 2]);
  assert.throws(() => gridFromCsv("\n  \n"), /no header row/);
  assert.deepStrictEqual(gridFromJson('[{"x":1,"y":2},{"x":2,"y":3}]').values[1], [2, 3]);
  assert.deepStrictEqual(gridFromJson('{"x":[1,2],"y":["a","b"]}').columns.map((c) => c.numeric), [true, false]);
  const proto = gridFromJson('[{"t":1,"valueOf":5,"constructor":"a"},{"t":2,"valueOf":6},{"t":3}]');
  assert.deepStrictEqual(proto.cells.slice(1), [["5", "6", ""], ["a", "", ""]]);
  assert.strictEqual(proto.columns[1].numeric, true);
  assert.throws(() => gridFromJson("3"), /not a table/);
  const svg = chartFromGrid(g, { kind: "bar", title: "T <1>", y: ["a"] });
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  assert.match(svg, /T &lt;1&gt;/);
  assert.throws(() => chartFromGrid(g, { kind: "pie" }), /one of/);
  assert.throws(() => chartFromGrid(g, { kind: "line", y: ["day"] }), /not numeric/);
  assert.throws(() => chartFromGrid(g, { kind: "line", x: "zz" }), /no column zz/);
  assert.strictEqual(parseArgs(["--help"]), USAGE);
  assert.match(parseArgs(["a.csv"]), /-o names/);
  assert.match(parseArgs(["--query", "1", "-o", "x.svg"]), /needs --host/);
  assert.match(parseArgs(["--host", "h", "--port", "1", "--query", "`:f set 1", "-o", "x.svg"]), /a chart only reads/);
  assert.match(parseArgs(["a.csv", "-o", "x", "--kind", "pie"]), /--kind is one of/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-chart-"));
  const csv = path.join(dir, "in.csv");
  fs.writeFileSync(csv, "t,v\n1,2\n2,4\n");
  const out = path.join(dir, "out.svg");
  const said = [];
  const io = { out: (s) => said.push(s), err: (s) => said.push(s), stdin: () => "" };
  assert.strictEqual(await main([csv, "-o", out, "--kind", "line", "--title", "x"], io), 0);
  assert.ok(fs.readFileSync(out, "utf8").startsWith("<svg"));
  assert.strictEqual(await main([path.join(dir, "missing.csv"), "-o", out], io), 1);
  assert.strictEqual(await main(["-", "--json", "-o", out], { ...io, stdin: () => '[{"a":1,"b":2}]' }), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the tickerplant log page forgets the last log's messages, pick and range when another log comes (#1258)", () => {
  const vm = require("node:vm");
  const fsm = require("node:fs");
  const pathm = require("node:path");
  const { Element } = require("./pagedom.js");
  // The page builds with appendChild, and empties an element by its text.
  class PageElement extends Element {
    appendChild(n) {
      this.append(n);
      return n;
    }
    get textContent() {
      return this.text ?? "";
    }
    set textContent(t) {
      this.text = t;
      this.children = [];
    }
  }
  const body = new PageElement("body");
  const listeners = [];
  const sandbox = {
    document: { body, createElement: (t) => new PageElement(t) },
    window: { addEventListener: (type, f) => type === "message" && listeners.push(f) },
    acquireVsCodeApi: () => ({ postMessage: () => {} }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fsm.readFileSync(pathm.join(__dirname, "..", "media", "tplog.js"), "utf8"), sandbox);
  const send = (data) => listeners.forEach((f) => f({ data }));
  const cells = () => body.all((e) => e.tagName === "TD").map((e) => e.textContent);
  const inputs = () => body.all((e) => e.tagName === "INPUT").map((e) => e.value ?? "");
  send({ type: "log", log: { file: "a.log", count: 3, complete: true, tables: ["t"] }, port: 1 });
  send({ type: "page", offset: 0, size: 200, total: 3, rows: [0, 1, 2].map((i) => ({ index: i, fn: "upd", table: "t", rows: 1, time: "" })) });
  body.all((e) => e.tagName === "TR")[2].fire("click");
  body.all((e) => e.tagName === "INPUT")[0].value = "09:00";
  send({ type: "message", index: 1, text: "old" });
  assert.ok(cells().includes("2"));
  send({ type: "log", log: { file: "b.log", count: 1, complete: true, tables: ["u"] }, port: 2 });
  assert.deepStrictEqual(cells(), []);
  assert.deepStrictEqual(inputs(), ["", "", "", ""]);
  assert.strictEqual(body.all((e) => e.tagName === "PRE")[0].textContent, "");
});

test("a menu that matches a file's extension matches it in any case (#1382)", () => {
  const whens = Object.values(pkg.contributes.menus).flat().map((m) => m.when ?? "");
  const clauses = whens.flatMap((w) => [...w.matchAll(/resourceExtname =~ (\/\S*)/g)].map((m) => m[1]));
  assert.ok(clauses.length > 0);
  for (const c of clauses) assert.match(c, /\/i$/, c);
});

// One file that cannot be read - permission denied, a dangling symlink -
// ended the reading, and the files after it went undocumented (#1542).
test("a workspace file that cannot be read is skipped, and the files after it still documented", async () => {
  const files = { "a.q": "/ adds one\nf:{x+1}\n", "b.q": null, "c.q": "/ doubles\ng:{2*x}\n/ not this one\nf:{x}\n" };
  const read = async (f) => {
    if (files[f] === null) throw new Error("EACCES");
    return files[f];
  };
  const docs = await workspaceDocs(Object.keys(files), read);
  assert.deepStrictEqual([...docs], [["f", "adds one"], ["g", "doubles"]]);
});
