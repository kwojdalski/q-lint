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
const { readDoc, qdocs, docMarkdown, docHtml, typeName } = require("../out/dbdoc.js");
const { gridFromCsv, gridFromJson, chartFromGrid } = require("../out/chartfile.js");
const { parseArgs, main, USAGE } = require("../out/chartcli.js");

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
