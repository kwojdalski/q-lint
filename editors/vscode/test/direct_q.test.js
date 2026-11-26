// Direct evaluation per process (#2470) against a real q process that
// plays TorQ with permissions on: its `.z.pg` evaluates a plain string, and
// refuses anything else - q-lint's lambdas - and any string naming `.Q.` or
// the permissioned `.priv`, as `.pm` refuses them. A second, ordinary q is
// the wrapped process beside it. Needs a q binary, so it runs only when
// QLINT_TEST_Q names one (a command line, run by the shell, as for
// qclient.test.js) and is skipped otherwise - CI has no q. Each q listens on
// a port from 54200 to 54219 (or QLINT_TEST_PORTS) and is killed when the
// test ends.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Live } = require("../out/live.js");
const { ProcessExplorer } = require("../out/explorerview.js");
const { registerBenchmark } = require("../out/benchmarkview.js");
const { AsyncQueries } = require("../out/asyncqueryview.js");
const { runText } = require("../out/consolerun.js");
const { runAgentQuery } = require("../out/agent.js");
const { runNotebook } = require("../out/qnbrun.js");
const { LIVE_KEY } = require("../out/livemarkdown.js");
const { QConnection } = require("../out/qclient.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";

const TABLES = "t:([] sym:`a`b`c; px:1.5 2.5 3.5)\n.foo.f:{x};.foo.v:3;.foo.q:([] a:1 2)\n.priv.x:1\n";

/// TorQ's permissions, as far as q-lint meets them: a lambda is refused
/// and counted, and so is a string naming `.Q.` or `.priv`.
const PM = `${TABLES}
lambdas:0
refused:{lambdas+:1;'"pm: no read permission on [",$[10h=type first x;first x;-3!x],"]"}
.z.pg:{$[not 10h=type x;refused x;any x like/:("*.Q.*";"*.priv*");'"pm: no read permission on [",x,"]";value x]}
.z.ps:{$[10h=type x;value x;[lambdas+:1;'"pm: no async lambdas"]]}
`;

/// The ports the q processes may take: 54200 to 54219, or the range
/// QLINT_TEST_PORTS names ("54320-54339"), for a machine shared by runs.
const [LOW, HIGH] = (process.env.QLINT_TEST_PORTS ?? "54200-54219").split("-").map(Number);

/// A free port from LOW to HIGH.
async function freePort(taken) {
  for (let port = LOW; port <= HIGH; port++) {
    if (taken.has(port)) continue;
    const free = await new Promise((resolve) => {
      const s = net.createServer().once("error", () => resolve(false)).listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (free) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`no free port from ${LOW} to ${HIGH}`);
}

async function startQ(t, source, taken) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-direct-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, source);
  const port = await freePort(taken);
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  t.after(stop);
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (up) return port;
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  throw new Error("q did not start listening");
}

/// What the q process says `expr` is, asked apart as a plain string.
async function ask(port, expr) {
  const c = await QConnection.open({ host: "127.0.0.1", port });
  try {
    return (await c.evaluate(expr)).value;
  } finally {
    c.abort();
  }
}

async function setUp(t, processes) {
  stub.reset();
  const vscode = require("vscode");
  const lines = [];
  const make = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = () => ({ appendLine: (l) => lines.push(...l.split("\n")), append() {}, clear: () => (lines.length = 0), show() {}, dispose() {} });
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  vscode.window.createOutputChannel = make;
  const explorer = new ProcessExplorer(context, live);
  const benchmark = registerBenchmark(context, live);
  const queries = new AsyncQueries(context, live);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  /// Run Query: the console's lines, past the header.
  const run = async (code) => {
    lines.length = 0;
    await live.run(code);
    return { outcome: live.history()[0].outcome, error: live.history()[0].error, text: lines.slice(1).join("\n").trim() };
  };
  const view = stub.trees.find((v) => v.id === "q-lint.processExplorer");
  return { live, explorer, benchmark, queries, run, view };
}

const SETTINGS = { consoleSize: [25, 80], rows: 1000, rowLimitFrom: "first" };
/// The Executor Run Notebook with Parameters gives `runNotebook`.
const executor = (live) => ({
  on: async (_label, code, use) => {
    const ran = await live.runOnActive(code, use);
    if (ran === undefined) throw new Error("not run");
    return ran.value;
  },
});
const outputText = (cell) => JSON.stringify(cell.outputs ?? []);

test("a direct process that refuses lambdas is queried with plain strings, and a wrapped one as before", { skip }, async (t) => {
  const taken = new Set();
  const pm = await startQ(t, PM, taken);
  const rdb = await startQ(t, TABLES, taken);
  const { live, explorer, benchmark, queries, run, view } = await setUp(t, [
    { label: "pm", host: "127.0.0.1", port: pm, tags: ["perm"], evaluation: "direct" },
    { label: "rdb", host: "127.0.0.1", port: rdb, tags: [] },
  ]);

  await t.test("connected, the explorer reads nothing until Refresh", async () => {
    assert.strictEqual(await live.connectTo("pm"), true);
    assert.deepStrictEqual(live.activeDirect(), { label: "pm", from: "process" });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(explorer.rows(), []);
    assert.match(view.message, /pm is evaluated directly: Refresh reads its tables/);
  });

  await t.test("Run Query: a select, and several statements, answer", async () => {
    let r = await run("select from t where px>2");
    assert.deepStrictEqual([r.outcome, r.text.split("\n").map((l) => l.trim())], ["ok", ["sym px", "-------", "b   2.5", "c   3.5"]]);
    r = await run("a:10;b:20;a+b");
    assert.deepStrictEqual([r.outcome, r.text], ["ok", "30"]);
    // q's error as q sent it.
    r = await run(".Q.w[]");
    assert.deepStrictEqual([r.outcome, r.error], ["error", "pm: no read permission on [.Q.w[]]"]);
  });

  await t.test("the REPL, Interactive Window and Smart Send answer", async () => {
    const ran = await runText(live, "select from t where px>2");
    assert.strictEqual(ran.answer.ok, true, JSON.stringify(ran.answer));
    assert.match(ran.answer.text.join("\n"), /c\s+3\.5/);
    const sum = await runText(live, "a:10;b:20;a+b");
    assert.deepStrictEqual(sum.answer.text, ["30"]);
  });

  await t.test("notebook cells, a grid cell and live values answer, as the kernel and Run with Parameters run them", async () => {
    const qnb = {
      cells: [
        { kind: "code", source: "select from t where px>2" },
        { kind: "markdown", source: "There are {{q: count t}} rows of {{q: `t}}; {{q: .Q.w[]}}." },
        { kind: "code", source: "/ @grid\nselect from t" },
        { kind: "code", source: "a:10;b:20;a+b" },
      ],
    };
    const result = await runNotebook(qnb, executor(live), SETTINGS, {}, { liveValues: true });
    assert.strictEqual(result.failed, undefined, JSON.stringify(result.failed));
    const [select, markdown, grid, sum] = result.qnb.cells;
    assert.match(outputText(select), /c   3\.5/);
    assert.deepStrictEqual(markdown.metadata[LIVE_KEY], {
      "count t": { text: "3" },
      "`t": { text: "t" },
      ".Q.w[]": { error: "pm: no read permission on [.Q.w[]]" },
    });
    assert.match(outputText(grid), /<table/);
    assert.match(outputText(grid), /3\.5/);
    assert.match(outputText(sum), /"30"/);
    // A refused cell shows q's error, and the run stops there.
    const failed = await runNotebook({ cells: [{ kind: "code", source: ".Q.w[]" }] }, executor(live), SETTINGS);
    assert.match(failed.failed.message, /pm: no read permission on \[\.Q\.w\[\]\]/);
  });

  await t.test("the agent tool answers with rows", async () => {
    const ran = await live.runOnActive("select from t", (connection) => runAgentQuery(connection, "select from t", [25, 80]), "refuse");
    assert.deepStrictEqual([ran.value.columns, ran.value.rowCount], [["sym", "px"], 3]);
  });

  await t.test("Refresh lists the tables, and a refused namespace is unavailable, not the process", async () => {
    await stub.commands.get("q-lint.refreshProcessExplorer")();
    assert.strictEqual(view.message, undefined);
    const rows = explorer.rows();
    const root = rows.find((n) => n.label === ".");
    const tables = root.children.find((c) => c.label === "Tables");
    assert.deepStrictEqual(tables.children.map((c) => c.label), ["t"]);
    const foo = rows.find((n) => n.label === ".foo");
    assert.deepStrictEqual(foo.children.map((c) => [c.label, c.children?.map((k) => k.label)]), [
      ["Tables", ["q"]],
      ["Functions", ["f"]],
      ["Variables", ["v"]],
    ]);
    const priv = rows.find((n) => n.label === ".priv");
    assert.deepStrictEqual(priv.children.map((c) => c.description), [
      "pm: no read permission on [\\a .priv]",
      "pm: no read permission on [\\f .priv]",
      "pm: no read permission on [\\v .priv]",
    ]);
    // A hover on an unread table states no rows or columns it never read (#2490).
    const vscode = require("vscode");
    const Hover = vscode.Hover;
    vscode.Hover = class {
      constructor(contents) {
        this.contents = contents;
      }
    };
    stub.config.user["processExplorer.editorTableHover.enable"] = true;
    const hover = await explorer.hover({ lineAt: () => ({ text: "t" }) }, { line: 0, character: 0 });
    delete stub.config.user["processExplorer.editorTableHover.enable"];
    vscode.Hover = Hover;
    assert.match(hover.contents.value, /^\*\*t\*\* on pm: table, not read/);
    assert.doesNotMatch(hover.contents.value, /0 columns/);
    // Preview of a table answers too.
    const r = await run("5 sublist t");
    assert.strictEqual(r.outcome, "ok");
  });

  await t.test("a feature that needs q-lint's lambda refuses, naming the mode, and sends nothing", async () => {
    const said = await benchmark.benchmark("til 10", "", "10 2");
    assert.match(said, /^q-lint: the benchmark failed: this needs q-lint's own evaluator lambda, and pm uses direct evaluation.*nothing was sent\. Set Process Evaluation on pm/);
    stub.messages.length = 0;
    assert.strictEqual(await queries.run("1+1"), undefined);
    assert.match(stub.messages.at(-1)[1], /Run Query Asynchronously: this needs q-lint's own evaluator lambda, and pm uses direct evaluation/);
    assert.deepStrictEqual(queries.state().pending, []);
    // Not one lambda reached the process in all of the above.
    assert.strictEqual(await ask(pm, "0=lambdas"), true);
  });

  await t.test("on a guarded process, the guard still asks, and q-lint says once that reval is not applied", async () => {
    stub.config.user["processes.readOnlyGuard.tags"] = ["perm"];
    stub.messages.length = 0;
    assert.strictEqual((await run("count t")).outcome, "ok");
    assert.strictEqual((await run("count t")).outcome, "ok");
    const said = stub.messages.filter(([, m]) => /reval is not applied/.test(m));
    assert.strictEqual(said.length, 1);
    assert.match(said[0][1], /pm does not enforce read-only/);
    // A write is asked about first; declined, nothing is sent.
    stub.messages.length = 0;
    const before = live.history().length;
    await live.run("zz:1");
    assert.ok(stub.messages.some(([kind]) => kind === "warning"));
    assert.strictEqual(live.history().length, before);
    assert.strictEqual(await ask(pm, "`zz in key `."), false);
    delete stub.config.user["processes.readOnlyGuard.tags"];
  });

  await t.test("a wrapped process is as before: its lambdas, its backtrace, its explorer", async () => {
    assert.strictEqual(await live.connectTo("rdb"), true);
    assert.strictEqual(live.activeDirect(), undefined);
    // Read on connect, as ever: GATHER.
    for (let i = 0; i < 50 && explorer.rows().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    const root = explorer.rows().find((n) => n.label === ".");
    // GATHER counts the rows, which direct evaluation does not read.
    assert.match(root.children.find((c) => c.label === "Tables").children[0].description, /^3 rows · 2 columns$/);
    let r = await run("select from t where px>2");
    assert.deepStrictEqual([r.outcome, r.text.split("\n").map((l) => l.trim())], ["ok", ["sym px", "-------", "b   2.5", "c   3.5"]]);
    r = await run("{x+`a}1");
    assert.strictEqual(r.outcome, "error");
    assert.ok(live.lastFailure !== undefined && live.lastFailure.trace !== "", "a wrapped error keeps its backtrace");
    const bench = await benchmark.benchmark("til 10", "", "10 2");
    assert.strictEqual(typeof bench, "object", String(bench));
    assert.strictEqual(bench.process, "rdb");
  });

  await t.test("q-lint.query.unwrapped is every unset process's mode; a process's own evaluation wins", async () => {
    stub.config.user["query.unwrapped"] = true;
    assert.deepStrictEqual(live.activeDirect(), { label: "rdb", from: "setting" });
    // The connection's tooltip says so at once, as the flags item does (#2489).
    stub.changeConfig("q-lint.query.unwrapped");
    assert.match(live.status.tooltip, /Evaluation on rdb: direct \(q-lint\.query\.unwrapped\)/);
    assert.strictEqual((await run("a:10;b:20;a+b")).text, "30");
    await stub.commands.get("q-lint.setProcessEvaluation")("rdb", "wrapped");
    assert.strictEqual(live.processes().find((p) => p.label === "rdb").evaluation, "wrapped");
    assert.strictEqual(live.activeDirect(), undefined);
    const bench = await benchmark.benchmark("til 10", "", "10 2");
    assert.strictEqual(typeof bench, "object", String(bench));
    await stub.commands.get("q-lint.setProcessEvaluation")("rdb", null);
    assert.strictEqual("evaluation" in live.processes().find((p) => p.label === "rdb"), false);
    assert.deepStrictEqual(live.activeDirect(), { label: "rdb", from: "setting" });
    delete stub.config.user["query.unwrapped"];
    assert.strictEqual(live.activeDirect(), undefined);
  });
});

test("a feature that sends only a plain string answers on a direct process: Copy Value as JSON, Run SQL (#2482, #2483)", { skip }, async (t) => {
  const taken = new Set();
  const pm = await startQ(t, PM, taken);
  const { live } = await setUp(t, [{ label: "pm", host: "127.0.0.1", port: pm, tags: ["perm"], evaluation: "direct" }]);
  const { registerPaste } = require("../out/pasteview.js");
  const { registerSql } = require("../out/sqlview.js");
  const { PASTE } = require("../out/pastetable.js");
  const { LANGUAGE_COMMANDS } = require("../out/languagefeatures.js");
  const vscode = require("vscode");
  const context = stub.newContext();
  registerPaste(context, live);
  vscode.languages.registerCompletionItemProvider = () => ({ dispose() {} });
  registerSql(context, live);
  assert.strictEqual(await live.connectTo("pm"), true);
  stub.messages.length = 0;
  const json = await stub.commands.get(PASTE.copyJson)("t");
  assert.deepStrictEqual(JSON.parse(json), [{ sym: "a", px: 1.5 }, { sym: "b", px: 2.5 }, { sym: "c", px: 3.5 }], JSON.stringify(stub.messages));
  // Run SQL: the probe for the engine and the query go as plain strings,
  // and the command never throws.
  t.after(() => (vscode.window.activeTextEditor = undefined));
  vscode.window.activeTextEditor = { document: { languageId: "sql", uri: { toString: () => "untitled:2483" }, getText: () => "select * from t" }, selection: { isEmpty: true } };
  const code = await stub.commands.get(LANGUAGE_COMMANDS.runSql)();
  assert.match(code, /^\.s\.e "select \* from t"/);
  assert.strictEqual(live.history()[0].code, code);
  assert.strictEqual(await ask(pm, "0=lambdas"), true);
});

test("on a guarded direct process, a feature that needs q-lint's lambda is refused before the guard asks (#2485)", { skip }, async (t) => {
  const taken = new Set();
  const pm = await startQ(t, PM, taken);
  const { live, benchmark } = await setUp(t, [{ label: "pm", host: "127.0.0.1", port: pm, tags: ["perm"], evaluation: "direct" }]);
  stub.config.user["processes.readOnlyGuard.tags"] = ["perm"];
  t.after(() => delete stub.config.user["processes.readOnlyGuard.tags"]);
  assert.strictEqual(await live.connectTo("pm"), true);
  stub.messages.length = 0;
  const said = await benchmark.benchmark("zz:1", "", "10 2");
  assert.match(said, /this needs q-lint's own evaluator lambda, and pm uses direct evaluation.*nothing was sent/);
  // Not asked "Run it anyway?" about a change that could not be sent.
  assert.deepStrictEqual(stub.messages.filter(([kind]) => kind === "warning"), []);
  assert.strictEqual(await ask(pm, "0=lambdas"), true);
});

test("the Process Explorer reads a process again once its evaluation changes, and says the new mode's (#2495)", { skip }, async (t) => {
  const taken = new Set();
  const rdb = await startQ(t, TABLES, taken);
  const { live, explorer, view } = await setUp(t, [{ label: "rdb", host: "127.0.0.1", port: rdb, tags: [], evaluation: "direct" }]);
  const until = async (f) => {
    for (let i = 0; i < 60 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  assert.strictEqual(await live.connectTo("rdb"), true);
  await until(() => view.message !== undefined);
  assert.match(view.message, /rdb is evaluated directly/);
  await stub.commands.get("q-lint.setProcessEvaluation")("rdb", "wrapped");
  await until(() => explorer.rows().length > 0);
  assert.strictEqual(view.message, undefined);
  assert.ok(explorer.rows().some((n) => n.label === "."));
});

test("the command-line chart queries a process that refuses lambdas with --direct (#2494)", { skip }, async (t) => {
  const { main } = require("../out/chartcli.js");
  const taken = new Set();
  const pm = await startQ(t, PM, taken);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-chart-"));
  const out = path.join(dir, "x.svg");
  const said = [];
  const io = { out: (s) => said.push(s), err: (s) => said.push(s), stdin: () => "" };
  const args = ["--host", "127.0.0.1", "--port", String(pm), "--query", "select from t", "-o", out];
  // Wrapped, the process refuses the grid lambda.
  assert.strictEqual(await main(args, io), 1);
  assert.match(said.join(""), /pm: no read permission/);
  assert.strictEqual(await main([...args, "--direct"], io), 0, said.join(""));
  assert.match(fs.readFileSync(out, "utf8"), /^<svg/);
  assert.strictEqual(await ask(pm, "1=lambdas"), true);
});

test("a notebook @grid cell on a direct process shows what the same cell wrapped does: strings unquoted, a mixed column cut to numbers aligned (#2478)", { skip }, async (t) => {
  const { cellAnswer } = require("../out/qnbrun.js");
  const { cellDirective } = require("../out/celldirectives.js");
  const taken = new Set();
  const port = await startQ(t, "c2:([] a:2026.01.01+til 5; s:(\"ab\";\"c\";\"d\";\"e\";\"f\"); b:(1 2;3;4 5 6;7;8))\nk:([k:`x`y`z] s:(\"ab\";\"cd\";\"e\"))\n", taken);
  const outputs = async (direct, code, rows) => {
    const c = await QConnection.open({ host: "127.0.0.1", port });
    if (direct) c.direct = () => ({ label: "q", from: "process" });
    try {
      const [ok, parts] = await cellAnswer(c, cellDirective(`/ @grid\n${code}`), [code], { ...SETTINGS, rows });
      assert.strictEqual(ok, true, JSON.stringify(parts));
      return JSON.stringify(parts);
    } finally {
      c.abort();
    }
  };
  for (const [code, rows] of [["c2", -2], ["c2", 1000], ["c2", 2], ["k", 1000]]) {
    const wrapped = await outputs(false, code, rows);
    assert.strictEqual(await outputs(true, code, rows), wrapped, `${code} ${rows}`);
  }
  const last = await outputs(true, "c2", -2);
  assert.match(last, /<td>e<\/td>/);
  assert.match(last, /<td class=\\"n\\">7<\/td>/);
});
