// The benchmark (#1048): runs read, expressions checked, timings summed up,
// the page escaped and scriptless - and, through the stand-in `vscode` and
// a fake q: off, the command refuses and nothing is sent; on, it sends the
// expressions once asked, and on a guarded process an expression that would
// change it is held unless confirmed. The q side is benchmark_q.test.js.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { setUp } = require("./fakeq.js");
const { BENCHMARK, benchmarkHtml, benchmarkLambda, expressionProblem, guardCode, msText, readRuns, readTimings, summarise } = require("../out/benchmark.js");
const { registerBenchmark } = require("../out/benchmarkview.js");
const { PROCESS_TOOL_COMMANDS } = require("../out/processtools.js");
const { guardCheck } = require("../out/guard.js");
const { EVALUATE_READ_ONLY } = require("../out/query.js");
const pkg = require("../package.json");

test("runs and expressions are checked", () => {
  assert.deepStrictEqual(readRuns(" 100  5 "), { n: 100, k: 5 });
  assert.strictEqual(readRuns("100"), undefined);
  assert.strictEqual(readRuns("0 5"), undefined);
  assert.strictEqual(readRuns("10 101"), undefined);
  assert.strictEqual(expressionProblem("sum til 10"), undefined);
  assert.match(expressionProblem(""), /no expression/);
  assert.match(expressionProblem("a:1\nb:2"), /one line/);
  assert.match(expressionProblem("\\l x.q"), /not a system command/);
  assert.strictEqual(guardCode(["sum til 10", " a:1 "], 100), "\\ts:100 sum til 10\n\\ts:100 a:1");
  const prod = { label: "p", tags: ["prod"] };
  const settings = { enabled: true, tags: ["prod"] };
  assert.strictEqual(guardCheck(guardCode(["sum til 10"], 100), [prod], settings), undefined);
  assert.notStrictEqual(guardCheck(guardCode(["t:1"], 100), [prod], settings), undefined);
});

test("timings are read, one repeat as atoms, and summed per run", () => {
  const t = readTimings([[[10, 30, 20], [64, 80, 64]], [5, 128]], ["a", "b"]);
  assert.deepStrictEqual(t[1], { expression: "b", times: [5], spaces: [128] });
  assert.throws(() => readTimings([[1, 2]], ["a", "b"]), /timings/);
  const [a, b] = summarise(t, 10);
  assert.deepStrictEqual(a, { expression: "a", min: 1, median: 2, mean: 2, max: 3, space: 80, ratio: 1 });
  assert.strictEqual(b.mean, 0.5);
  assert.strictEqual(b.ratio, 0.25);
  // A first expression that measures 0 ms gives no ratio, not 1.00x (#1116).
  const zero = summarise(readTimings([[0, 64], [51, 64]], ["a", "b"]), 10);
  assert.deepStrictEqual(zero.map((s) => s.ratio), [1, null]);
  assert.match(benchmarkHtml(zero, "p", 10, 1, "N"), /<td>-<\/td><\/tr>/);
  assert.strictEqual(msText(2), "2.00 ms");
  assert.strictEqual(msText(0.0123), "12 µs");
  // The unit picked as rounded (#1805).
  assert.strictEqual(msText(0.9996), "1.00 ms");
  assert.strictEqual(msText(0.99999), "1.00 ms");
  assert.strictEqual(msText(59999.99), "60.0 s");
});

test("the page escapes every expression, and runs no script", () => {
  const html = benchmarkHtml(summarise(readTimings([[[1], [64]]], ["<b>&</b>"]), 1), "<p>", 1, 1, "NONCE");
  assert.ok(!html.includes("<b>&"));
  assert.ok(html.includes("&lt;b&gt;&amp;&lt;/b&gt;"));
  assert.ok(html.includes("&lt;p&gt;"));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/style="/.test(html), "no inline style the CSP would block");
  assert.match(html, /default-src 'none'; style-src 'nonce-NONCE'/);
  assert.match(html, /<svg role="img"/);
});

test("the switch is declared on, and the command only where it can run", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.query.benchmark.enable"].default, true);
  const entries = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === PROCESS_TOOL_COMMANDS.benchmark);
  assert.ok(entries.length === 2 && entries.every((m) => /config\.q-lint\.query\.benchmark\.enable/.test(m.when)));
});

const READ_ONLY = benchmarkLambda(EVALUATE_READ_ONLY);
const answer = (m) =>
  m === "`reval in key`.q" ? true : Array.isArray(m) && (m[0] === BENCHMARK || m[0] === READ_ONLY) ? m[1].map(() => [[10, 12, 11], [64, 64, 64]]) : null;

function panels() {
  const made = [];
  vscode.window.createWebviewPanel = (id, title) => {
    const panel = { id, title, webview: { html: "" }, onDidDispose: () => {}, reveal() {}, dispose() { this.disposed = true; } };
    made.push(panel);
    return panel;
  };
  return made;
}

test("off, nothing is sent; on, the expressions are timed and shown", async (t) => {
  const made = panels();
  const { q, live, feature } = await setUp(t, { config: { "query.benchmark.enable": false }, answer, register: registerBenchmark });
  await live.connectTo("rdb");
  const before = q.sent.length;
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.benchmark)("sum til 10", "", "100 3"), /The benchmark is turned off\. Set q-lint\.query\.benchmark\.enable to true/);
  assert.strictEqual(q.sent.length, before);
  assert.strictEqual(made.length, 0);

  stub.config.user["query.benchmark.enable"] = true;
  stub.changeConfig("q-lint.query.benchmark.enable");
  const result = await stub.commands.get(PROCESS_TOOL_COMMANDS.benchmark)("sum til 10", "sum `long$til 10", "100 3");
  assert.deepStrictEqual(q.sent.slice(before), [[BENCHMARK, [" sum til 10", " sum `long$til 10"], 100, 3]]);
  assert.strictEqual(result.summary.length, 2);
  assert.strictEqual(made.length, 1);
  assert.match(made[0].webview.html, /sum `long\$til 10/);
  assert.strictEqual(feature.panelOpen(), true);
  stub.config.user["query.benchmark.enable"] = false;
  stub.changeConfig("q-lint.query.benchmark.enable");
  assert.strictEqual(feature.panelOpen(), false);
});

test("on a guarded process an expression that writes is held unless confirmed", async (t) => {
  panels();
  const { q, live } = await setUp(t, { tags: ["prod"], answer, register: registerBenchmark });
  await live.connectTo("rdb");
  const before = q.sent.length;
  // A read is sent unasked, timed under reval (#2423).
  await stub.commands.get(PROCESS_TOOL_COMMANDS.benchmark)("sum til 10", "", "10 1");
  assert.deepStrictEqual(q.sent.slice(before), ["`reval in key`.q", [READ_ONLY, [" sum til 10"], 10, 1]]);
  stub.picks.push(undefined);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.benchmark)("t:til 10", "", "10 1"), /not confirmed/);
  assert.strictEqual(q.sent.length, before + 2);
});

test("turned off while it asks for the runs, nothing is timed (#1453)", async (t) => {
  const made = panels();
  const { q, live } = await setUp(t, { config: { "query.benchmark.enable": true }, answer, register: registerBenchmark });
  await live.connectTo("rdb");
  const before = q.sent.length;
  stub.inputs.push(() => {
    stub.config.user["query.benchmark.enable"] = false;
    stub.changeConfig("q-lint.query.benchmark.enable");
    return "10 2";
  });
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.benchmark)("sum til 10", ""), /The benchmark is turned off/);
  assert.deepStrictEqual(q.sent.slice(before), []);
  assert.strictEqual(made.length, 0);
});

test("each process tool sends the editor's code to the process its file is bound to (#2365, #2438-#2444)", async (t) => {
  panels();
  vscode.window.showTextDocument = async () => {};
  vscode.env = { clipboard: { readText: async () => "", writeText: async () => {} } };
  vscode.window.createTextEditorDecorationType = () => ({ dispose() {} });
  vscode.Range = class {
    constructor(a, b, c, d) {
      Object.assign(this, { start: { line: a, character: b }, end: { line: c, character: d } });
    }
  };
  const tools = {};
  const { live } = await setUp(t, {
    answer,
    more: [{ label: "dev" }],
    register: (context, live) => {
      tools.benchmark = registerBenchmark(context, live);
      tools.profile = require("../out/profileview.js").registerFunctionProfile(context, live);
      tools.timings = require("../out/linetimingsview.js").registerLineTimings(context, live);
      tools.aj = require("../out/ajexplainview.js").registerAjExplainer(context, live);
      require("../out/pasteview.js").registerPaste(context, live);
      require("../out/snapshotview.js").registerSnapshots(context, live, () => {});
      tools.async = new (require("../out/asyncqueryview.js").AsyncQueries)(context, live);
    },
  });
  stub.config.user["query.lineTimings.enable"] = true;
  stub.config.user["query.functionProfile.enable"] = true;
  stub.config.user["query.watch.enable"] = true;
  stub.changeConfig("q-lint.query.lineTimings.enable");
  const uri = Object.assign(vscode.Uri.file("/w/a.q"), { scheme: "file" });
  // Choose Connection for File's binding (the stub keeps no workspaceState).
  live.fileBinding = (u) => (u.toString() === uri.toString() ? "dev" : undefined);
  const text = "aj[`sym`time;t;q]";
  const editor = {
    document: { uri, version: 1, lineCount: 1, getText: () => text, lineAt: () => ({ text, range: { end: { line: 0, character: text.length } } }) },
    selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    setDecorations() {},
  };
  vscode.window.activeTextEditor = editor;
  live.codeFromEditor = async () => text;
  const sentTo = [];
  const runOnActive = live.runOnActive.bind(live);
  live.runOnActive = (...a) => (sentTo.push(live.activeLabel()), runOnActive(...a));
  const { PASTE } = require("../out/pastetable.js");
  const { SNAPSHOT_COMMANDS } = require("../out/snapshot.js");
  const runs = {
    benchmark: () => tools.benchmark.benchmark(undefined, "", "1 1"),
    profile: () => tools.profile.profile(".x"),
    timings: () => tools.timings.time(editor),
    json: () => stub.commands.get(PASTE.copyJson)(),
    aj: () => tools.aj.explainRow(undefined, "0"),
    snapshot: () => (stub.inputs.push("s"), stub.commands.get(SNAPSHOT_COMMANDS.record)()),
    async: () => tools.async.run(),
  };
  for (const [name, run] of Object.entries(runs)) {
    assert.strictEqual(await live.connectTo("rdb"), true);
    sentTo.length = 0;
    await run().catch(() => undefined);
    assert.deepStrictEqual(sentTo, ["dev"], name);
  }
  // Watch Query too, which asks for no guard but connects itself.
  assert.strictEqual(await live.connectTo("rdb"), true);
  await live.watch(undefined, 60);
  assert.strictEqual(live.activeLabel(), "dev");
  await stub.commands.get("q-lint.stopWatchingQuery")?.();
});
