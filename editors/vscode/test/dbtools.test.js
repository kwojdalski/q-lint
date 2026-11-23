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
const { readDoc, qdocs, docMarkdown, docHtml, typeName } = require("../out/dbdoc.js");
const { missingWeekdays, partitionProblems, partitionReport, readPartitions } = require("../out/partcheck.js");
const { readSym, symReport } = require("../out/syminspect.js");
const { advise, filterCounts, adviceReport, readAttributeSample } = require("../out/attradvice.js");
const { schemaDiff, migrationScript, nullOf, castOf } = require("../out/migrate.js");
const { symbolPool, rangeOf, generator, testDataQ, testDataCsv, loadTypes, random } = require("../out/testdata.js");
const { timeOfDay, rangeProblem, readTpPage, readTpLog, readReplayed } = require("../out/tplog.js");
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
  const md = docMarkdown(doc, "rdb", "now", new Map([[".lib.f", "x <b>"]]));
  assert.match(md, /### t\\<1\\>/);
  assert.match(md, /\| k \(key\) \| long \| unique \|/);
  assert.match(md, /x \\<b\\>/);
  const html = docHtml(doc, "rdb<script>", "now");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /rdb&lt;script&gt;/);
  assert.throws(() => readDoc(1), /tables/);
});

test("the partition check finds weekday gaps, and each kind of problem in an answer", () => {
  assert.deepStrictEqual(missingWeekdays(["2026.01.02", "2026.01.06"]), ["2026.01.05"]);
  assert.deepStrictEqual(missingWeekdays(["2026.01.02"]), []);
  const row = (partition, extra = {}) => ({ table: "t", partition, dir: true, dotd: true, columns: ["sym", "px"], missing: [], types: [20, 9], enums: ["sym", ""], maxIndex: null, rows: 100, ...extra });
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
      row("2026.01.12", { missing: ["px"], types: [20], enums: ["other"], maxIndex: 12, rows: 5000 }),
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
  const report = partitionReport(answer, "hdb", false);
  assert.match(report, /A quick check/);
  assert.match(report, /\*\*missing dates\*\*/);
  assert.match(partitionReport({ hdb: false, root: "/x" }, "rdb", false), /no partitioned database/);
  assert.deepStrictEqual(readPartitions({ hdb: false, root: "/x" }), { hdb: false, root: "/x" });
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
});

test("the attribute advisor counts filters and suggests by shape, never for an unfiltered column", () => {
  const queries = ["select from trade where sym=`a", "select from trade where sym in `a`b, px>1", "?[trade;enlist(=;`id;1);0b;()]", "select from quote where sym=`a"];
  assert.deepStrictEqual(Object.fromEntries(filterCounts(queries, "trade", ["sym", "px", "id", "sz"])), { sym: 2, px: 1, id: 1, sz: 0 });
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
  assert.match(migrationScript("a", from, "a", from, "a", "p"), /the same: there is nothing to change/);
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
  assert.match(q, /\\S 3\nn:20\ngen:`k xkey \(\[\] k:n\?enlist`A; px:asc 10\+n\?10f; t:2026\.01\.02D\+n\?1D\)/);
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
  assert.deepStrictEqual(gridFromJson('[{"x":1,"y":2},{"x":2,"y":3}]').values[1], [2, 3]);
  assert.deepStrictEqual(gridFromJson('{"x":[1,2],"y":["a","b"]}').columns.map((c) => c.numeric), [true, false]);
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
