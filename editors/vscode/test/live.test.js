// The live half (#853): how code is cut into statements, how processes are
// read and grouped, how an answer is read and shown, and that package.json
// declares what the extension registers. Run after `tsc`; nothing here needs
// an editor or a q process (qclient.test.js drives a real one).
const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const { statements, blockAt } = require("../out/statements.js");
const {
  consoleSize,
  grouped,
  merge,
  parseProcesses,
  parseTags,
  portProblem,
  processThemeColour,
  readProcessFile,
  tagColour,
} = require("../out/processes.js");
const { NULL_TYPE, RUN, readAnswer, render } = require("../out/query.js");
const {
  COMMANDS,
  CONNECTED,
  DISCOVERY_COMMANDS,
  QUERY_MODES,
  RESULTS,
  RESULT_VIEW,
  RESULTS_LOCATIONS,
  ROW_LIMIT_CHOICES,
  ROW_LIMIT_FROM,
  VIEWS,
  readLive,
  readNotebook,
  readResultView,
  rowLimitLabel,
  rowsArgument,
} = require("../out/liveconfig.js");
const { EXPLORER, readExplorer } = require("../out/explorer.js");
const relations = require("../out/relations.js");
const { NOTEBOOK } = require("../out/qnb.js");
const { needsRestart } = require("../out/settings.js");
const { AGENT } = require("../out/agent.js");
const { SOURCE_COMMANDS } = require("../out/funcsource.js");
const { INFO, readMonitorInterval } = require("../out/monitor.js");
const { readInsight } = require("../out/insightconfig.js");
const { EDITOR_SETTINGS, editorFeatureOn } = require("../out/editorfeatures.js");
const { CHECK_UNDEFINED } = require("../out/undefinednames.js");
const { readAssist, QUERY_FEATURES } = require("../out/assistconfig.js");
const { DRIFT_COMMANDS } = require("../out/definitions.js");
const { QSQL_COMMANDS } = require("../out/assist.js");
const { CONTROL_COMMANDS, readControls } = require("../out/querycontrols.js");
const { readProgress } = require("../out/progress.js");
const { readPlaceholders } = require("../out/placeholders.js");
const { HISTORY_COMMANDS, readHistorySearch } = require("../out/historyfilter.js");
const { CONNECT_SCRIPT_COMMANDS } = require("../out/connectscript.js");
const { TUNNEL_COMMANDS } = require("../out/tunnel.js");
const { GATEWAY_COMMANDS } = require("../out/gateway.js");
const { STREAM_COMMANDS } = require("../out/stream.js");
const { LAUNCH_COMMANDS } = require("../out/launcher.js");
const { NEW_QUERY_COMMAND } = require("../out/newquery.js");
const { RUN_ARGS_COMMAND } = require("../out/runargs.js");
const { SHARED_COMMANDS } = require("../out/shared.js");
const { ONBOARDING } = require("../out/onboarding.js");
const { PARAM_CACHE } = require("../out/paramcache.js");
const { TAG_QUERY, readTagQuery } = require("../out/tagquery.js");
const { COMPARE, readCompare } = require("../out/compare.js");
const { SAVED_QUERIES, readSavedQueries } = require("../out/savedqueries.js");
const { WATCH, readWatch } = require("../out/watch.js");

test("a statement is a line and the indented lines after it", () => {
  assert.deepStrictEqual(statements("a:1\nb:a+1\nb*10"), ["a:1", "b:a+1", "b*10"]);
  assert.deepStrictEqual(statements("f:{[x]\n  y:x+1;\n  y*2}\nf 3"), ["f:{[x]\n  y:x+1;\n  y*2}", "f 3"]);
  // A tab continues as a space does, and blank lines inside are skipped.
  assert.deepStrictEqual(statements("f:{\n\tx+1\n\n  }\n"), ["f:{\n\tx+1\n  }"]);
  // CRLF is read as LF, and trailing spaces are dropped.
  assert.deepStrictEqual(statements("a:1  \r\nb:2\r\n"), ["a:1", "b:2"]);
});

test("a closing brace at column 0 starts a statement, as q reads a script", () => {
  // q refuses this file; a query of it fails the same way.
  assert.deepStrictEqual(statements("g:{[x]\n  x+2\n}"), ["g:{[x]\n  x+2", "}"]);
});

test("comments are not sent", () => {
  assert.deepStrictEqual(statements("/ a comment\na:1\n/ another\nb:2"), ["a:1", "b:2"]);
  // A block comment: `/` alone to `\\` alone.
  assert.deepStrictEqual(statements("a:1\n/\nb:2\nc:3\n\\\nd:4"), ["a:1", "d:4"]);
  // A comment line or a block comment between a statement and an indented
  // line is skipped, and the statement goes on, as q loads a script: a
  // file that loads runs the same as a query (#894).
  assert.deepStrictEqual(statements("a:1\n/ note\n  +2"), ["a:1\n  +2"]);
  assert.deepStrictEqual(statements("f:{\n/ a comment\n  x+1}\nf 1"), ["f:{\n  x+1}", "f 1"]);
  assert.deepStrictEqual(statements("f:{\n/\njunk\n\\\n  x+1}"), ["f:{\n  x+1}"]);
  // A trailing comment stays: q's parser drops it.
  assert.deepStrictEqual(statements("a:1 / one"), ["a:1 / one"]);
});

test("a script's shebang line is skipped, as q skips it", () => {
  assert.deepStrictEqual(statements("#!/usr/bin/env q\na:1\nb:2"), ["a:1", "b:2"]);
  assert.deepStrictEqual(statements("#!/usr/bin/env q\r\na:1"), ["a:1"]);
  // Only the first line: q refuses `#!` anywhere else.
  assert.deepStrictEqual(statements("a:1\n#!x"), ["a:1", "#!x"]);
  const lines = ["#!/usr/bin/env q", "a:1"];
  assert.strictEqual(blockAt(lines, 0), undefined);
  assert.deepStrictEqual(blockAt(lines, 1), { start: 1, end: 1 });
});

test("a lone backslash ends the script", () => {
  assert.deepStrictEqual(statements("a:1\n\\\nb:2"), ["a:1"]);
});

test("system commands are statements", () => {
  assert.deepStrictEqual(statements("\\d .ns\nf:{x}\n\\d ."), ["\\d .ns", "f:{x}", "\\d ."]);
});

test("an indented first line starts a statement", () => {
  assert.deepStrictEqual(statements("  a:1\n  +2"), ["a:1\n  +2"]);
});

test("nothing to run in blank or comment-only code", () => {
  assert.deepStrictEqual(statements(""), []);
  assert.deepStrictEqual(statements("\n  \n/ only a comment\n"), []);
});

test("the block at the cursor is its statement and continuation lines", () => {
  const lines = ["a:1", "f:{[x]", "  y:x+1;", "", "  y*2}", "f 3", "/ note", "/", "b:2", "\\", "c:3"];
  // On the first line, a continuation line, or the blank line between them.
  for (const line of [1, 2, 3, 4]) {
    assert.deepStrictEqual(blockAt(lines, line), { start: 1, end: 4 }, `line ${line}`);
  }
  assert.deepStrictEqual(blockAt(lines, 0), { start: 0, end: 0 });
  assert.deepStrictEqual(blockAt(lines, 5), { start: 5, end: 5 });
  // A comment, a block comment and its markers: nothing.
  for (const line of [6, 7, 8, 9]) {
    assert.strictEqual(blockAt(lines, line), undefined, `line ${line}`);
  }
  assert.deepStrictEqual(blockAt(lines, 10), { start: 10, end: 10 });
});

test("a block runs on past comment lines and block comments inside it (#894)", () => {
  const lines = ["f:{", "/ a comment", "  x+1;", "/", "junk", "\\", "  x}", "g 1"];
  for (const line of [0, 2, 6]) {
    assert.deepStrictEqual(blockAt(lines, line), { start: 0, end: 6 }, `line ${line}`);
  }
  for (const line of [1, 3, 4, 5]) {
    assert.strictEqual(blockAt(lines, line), undefined, `line ${line}`);
  }
  assert.deepStrictEqual(statements(lines.slice(0, 7).join("\n")), ["f:{\n  x+1;\n  x}"]);
});

test("no block after a lone backslash, or on a blank line between statements", () => {
  assert.strictEqual(blockAt(["a:1", "\\", "b:2"], 2), undefined);
  assert.strictEqual(blockAt(["a:1", "", "b:2"], 1), undefined);
});

test("a block is cut into the statements a script would run", () => {
  const lines = ["f:{[x]", "  x+1}", "f 2"];
  const { start, end } = blockAt(lines, 1);
  assert.deepStrictEqual(statements(lines.slice(start, end + 1).join("\n")), ["f:{[x]\n  x+1}"]);
});

test("a port is a whole number from 1 to 65535", () => {
  assert.strictEqual(portProblem("5010"), undefined);
  assert.strictEqual(portProblem(" 5010 "), undefined);
  assert.match(portProblem("0"), /between/);
  assert.match(portProblem("65536"), /between/);
  assert.match(portProblem("50a"), /whole/);
  assert.match(portProblem(""), /whole/);
  assert.match(portProblem("-1"), /whole/);
});

test("tags are lower case, each once, split on commas or spaces", () => {
  assert.deepStrictEqual(parseTags("Prod, eu  rdb,prod"), ["prod", "eu", "rdb"]);
  assert.deepStrictEqual(parseTags(" , "), []);
});

test("a process list is read, and what is wrong with it is said", () => {
  const { processes, problems } = parseProcesses({
    processes: [
      { label: "rdb", host: "localhost", port: 5011, tags: ["Prod"], user: "me", tls: true },
      { label: "hdb", host: "h", port: "5012", tags: "uat, eu" },
      { label: "rdb", host: "x", port: 1 },
      { host: "x", port: 1 },
      { label: "nohost", port: 1 },
      { label: "badport", host: "x", port: 70000 },
      "rdb",
    ],
  });
  assert.deepStrictEqual(processes, [
    { label: "rdb", host: "localhost", port: 5011, user: "me", tags: ["prod"], tls: true },
    { label: "hdb", host: "h", port: 5012, tags: ["uat", "eu"] },
  ]);
  assert.strictEqual(problems.length, 5);
  assert.match(problems[0], /Entry 3 \(rdb\) repeats a label/);
  assert.match(problems[1], /Entry 4 has no label/);
  assert.match(problems[2], /nohost\) has no host/);
  assert.match(problems[3], /badport\): A port is between/);
  assert.match(problems[4], /Entry 7 is not an object/);
  // A bare list is read too; anything else is not a list.
  assert.strictEqual(parseProcesses([{ label: "a", host: "h", port: 1 }]).processes.length, 1);
  assert.match(parseProcesses({ nope: 1 }).problems[0], /Expected a list/);
  assert.match(parseProcesses(null).problems[0], /Expected a list/);
});

test("a process file is read with a byte order mark and CRLF line ends", () => {
  const text = '\uFEFF{"processes": [\r\n  {"label": "rdb", "host": "h", "port": 5011}\r\n]}\r\n';
  assert.deepStrictEqual(readProcessFile(text), { processes: [{ label: "rdb", host: "h", port: 5011, tags: [] }], problems: [] });
  assert.throws(() => readProcessFile("{nope"), SyntaxError);
});

test("an import replaces processes of the same label and adds the rest", () => {
  const a = { label: "a", host: "h", port: 1, tags: [] };
  const b = { label: "b", host: "h", port: 2, tags: [] };
  const b2 = { label: "b", host: "other", port: 3, tags: ["dev"] };
  const c = { label: "c", host: "h", port: 4, tags: [] };
  assert.deepStrictEqual(merge([a, b], [b2, c]), [a, b2, c]);
});

test("processes are grouped by tag, sorted, untagged last", () => {
  const p = (label, ...tags) => ({ label, host: "h", port: 1, tags });
  const groups = grouped([p("z", "prod"), p("a", "prod", "eu"), p("m"), p("b")]);
  assert.deepStrictEqual(
    groups.map((g) => [g.tag, g.processes.map((x) => x.label)]),
    [
      ["eu", ["a"]],
      ["prod", ["a", "z"]],
      ["", ["b", "m"]],
    ],
  );
  assert.deepStrictEqual(grouped([]), []);
});

test("production is red, uat blue, development green; the most cautious wins", () => {
  assert.strictEqual(tagColour("PRD"), "red");
  assert.strictEqual(tagColour("uat"), "blue");
  assert.strictEqual(tagColour("development"), "green");
  assert.strictEqual(tagColour("eu"), undefined);
  assert.strictEqual(processThemeColour({ label: "x", host: "h", port: 1, tags: ["dev", "prod"] }, {}), "charts.red");
  assert.strictEqual(processThemeColour({ label: "x", host: "h", port: 1, tags: ["eu"] }, {}), undefined);
});

test("a console size is two positive whole numbers", () => {
  assert.deepStrictEqual(consoleSize("50 160"), [50, 160]);
  assert.deepStrictEqual(consoleSize("  25   80 "), [25, 80]);
  assert.strictEqual(consoleSize("50"), undefined);
  assert.strictEqual(consoleSize("0 80"), undefined);
  assert.strictEqual(consoleSize("50x160"), undefined);
});

test("the query lambda keeps nothing on the process", () => {
  // No assignment to a global: `::` would define one, and `set` would too.
  assert.ok(!RUN.includes("::"), RUN);
  assert.ok(!/\bset\b/.test(RUN), RUN);
  assert.ok(RUN.startsWith("{[s;size]") && RUN.endsWith("}"));
});

test("an answer is read, and anything else is refused", () => {
  assert.deepStrictEqual(readAnswer({ ok: true, type: -7, text: ["2"] }), { ok: true, type: -7, text: ["2"] });
  // .Q.S of an atom can come back as one string.
  assert.deepStrictEqual(readAnswer({ ok: true, type: 10, text: "abc" }), { ok: true, type: 10, text: ["abc"] });
  assert.deepStrictEqual(readAnswer({ ok: false, error: "type", trace: "  [1] 1+`a" }), {
    ok: false,
    error: "type",
    trace: "  [1] 1+`a",
  });
  assert.throws(() => readAnswer(42), /something other than a query result/);
  assert.throws(() => readAnswer(null), /something other than a query result/);
});

test("a result is shown with its process and time, and an error with its trace", () => {
  const ok = { process: "rdb", code: "a:1\n1+1", answer: { ok: true, type: -7, text: ["2"] }, millis: 3 };
  const off = { includeQuery: false, ignoreNullReturn: false };
  assert.deepStrictEqual(render(ok, off), ["# rdb (3 ms)", "2"]);
  assert.deepStrictEqual(render(ok, { ...off, includeQuery: true }), ["# rdb (3 ms)", "q) a:1", "q) 1+1", "2"]);
  const bad = { ...ok, answer: { ok: false, error: "type", trace: "  [1]  1+`a\n        ^\n" } };
  assert.deepStrictEqual(render(bad, off), ["# rdb (3 ms) - 'type", "'type", "  [1]  1+`a", "        ^"]);
  const none = { ...ok, answer: { ok: true, type: NULL_TYPE, text: ["::"] } };
  assert.deepStrictEqual(render(none, { ...off, ignoreNullReturn: true }), []);
  assert.deepStrictEqual(render(none, off), ["# rdb (3 ms)", "::"]);
});

test("package.json declares exactly the commands the extension registers", () => {
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  const registered = [
    ...Object.values(COMMANDS),
    ...Object.values(CONTROL_COMMANDS),
    ...Object.values(HISTORY_COMMANDS),
    ...Object.values(CONNECT_SCRIPT_COMMANDS),
    ...Object.values(TUNNEL_COMMANDS),
    ...Object.values(GATEWAY_COMMANDS),
    ...Object.values(STREAM_COMMANDS),
    ...Object.values(LAUNCH_COMMANDS),
    ...Object.values(SHARED_COMMANDS),
    ...Object.values(PARAM_CACHE),
    ...Object.values(DISCOVERY_COMMANDS),
    ...Object.values(EXPLORER).filter((id) => id !== EXPLORER.view),
    ...Object.values(relations.COMMANDS),
    NOTEBOOK.exportCommand,
    ...[NOTEBOOK.exportHtmlCommand, NOTEBOOK.exportIpynbCommand, NOTEBOOK.importIpynbCommand, NOTEBOOK.runWithParameters, NOTEBOOK.refreshVariables],
    RESULTS.exportCsv,
    RESULTS.exportViewCsv,
    RESULTS.setRowLimit,
    ...Object.values(RESULT_VIEW),
    AGENT.copyLabel,
    ...[ONBOARDING.getStarted, ONBOARDING.openHelpLink, ONBOARDING.editTagColor, ONBOARDING.newNotebook],
    "q-lint.restartServer",
    "q-lint.runDefinition",
    ...Object.values(SOURCE_COMMANDS),
    INFO.refreshMonitor,
    INFO.refreshHdb,
    ...Object.values(TAG_QUERY),
    ...Object.values(COMPARE),
    ...Object.values(SAVED_QUERIES).filter((id) => id !== SAVED_QUERIES.view),
    ...Object.values(WATCH),
    CHECK_UNDEFINED,
    ...Object.values(DRIFT_COMMANDS),
    ...Object.values(QSQL_COMMANDS),
    NEW_QUERY_COMMAND,
    RUN_ARGS_COMMAND,
  ].sort();
  assert.deepStrictEqual(declared, registered);
});

test("the views live in their own container, and every menu names a declared command", () => {
  const [container] = pkg.contributes.viewsContainers.activitybar;
  assert.strictEqual(container.id, VIEWS.container);
  assert.deepStrictEqual(
    pkg.contributes.views[VIEWS.container].map((v) => v.id),
    [VIEWS.processes, EXPLORER.view, VIEWS.history, ONBOARDING.helpView, INFO.monitor, INFO.hdb, NOTEBOOK.variablesView, SAVED_QUERIES.view],
  );
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const [where, items] of Object.entries(pkg.contributes.menus)) {
    for (const item of items) {
      assert.ok(declared.has(item.command), `${where}: ${item.command}`);
    }
  }
  for (const binding of pkg.contributes.keybindings) {
    assert.ok(declared.has(binding.command), binding.command);
  }
  const abort = pkg.contributes.commands.find((c) => c.command === COMMANDS.abort);
  assert.strictEqual(abort.enablement, CONNECTED);
});

test("every view has an icon that ships, and every welcome names a view and commands that exist", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const shipped = (file) => assert.ok(fs.existsSync(path.join(root, file)), file);
  shipped(pkg.icon);
  for (const container of Object.values(pkg.contributes.viewsContainers).flat()) {
    shipped(container.icon);
  }
  for (const view of Object.values(pkg.contributes.views).flat()) {
    assert.ok(view.icon, `${view.id} has no icon`);
    shipped(view.icon);
  }
  // Every view in the q-lint container can be empty, and says what to do then.
  assert.deepStrictEqual(
    [...new Set(pkg.contributes.viewsWelcome.map((w) => w.view))].sort(),
    pkg.contributes.views[VIEWS.container].map((v) => v.id).sort(),
  );
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const welcome of pkg.contributes.viewsWelcome) {
    for (const [, command] of welcome.contents.matchAll(/\(command:([^)?]+)/g)) {
      assert.ok(declared.has(command), `${welcome.view}: ${command}`);
    }
  }
  // The explorer's welcome is for when nothing is connected: connected, it
  // says what it is reading in its message instead.
  const explorer = pkg.contributes.viewsWelcome.find((w) => w.view === EXPLORER.view);
  assert.strictEqual(explorer.when, `!${CONNECTED}`);
  // The query keys the history's welcome names are the ones bound.
  const history = pkg.contributes.viewsWelcome.find((w) => w.view === VIEWS.history);
  const keys = Object.fromEntries(pkg.contributes.keybindings.map((k) => [k.command, k.key]));
  for (const command of [COMMANDS.queryLine, COMMANDS.querySelection, COMMANDS.queryBlock]) {
    const key = keys[command].replace(/(^|\+)(\w)/g, (_, plus, c) => plus + c.toUpperCase());
    assert.ok(history.contents.includes(key), `${command}: ${key}`);
  }
});

test("the query modes are the ones package.json offers", () => {
  const mode = pkg.contributes.configuration[1].properties["q-lint.query.mode"];
  assert.deepStrictEqual(mode.enum, [...QUERY_MODES]);
  assert.strictEqual(mode.enumDescriptions.length, QUERY_MODES.length);
});

test("the query keys are ctrl+q, ctrl+r and ctrl+e in a q editor", () => {
  const keys = Object.fromEntries(pkg.contributes.keybindings.map((k) => [k.command, k]));
  assert.strictEqual(keys[COMMANDS.queryLine].key, "ctrl+q");
  assert.strictEqual(keys[COMMANDS.querySelection].key, "ctrl+r");
  assert.strictEqual(keys[COMMANDS.queryBlock].key, "ctrl+e");
  for (const k of pkg.contributes.keybindings) {
    assert.match(k.when, /editorLangId == q/);
  }
});

test("every query setting is read, with the default package.json declares, and none restarts the server", () => {
  const declared = pkg.contributes.configuration[1].properties;
  const read = new Map();
  const get = (key, fallback) => {
    read.set(key, fallback);
    return fallback;
  };
  const live = readLive(get);
  const explorer = readExplorer(get);
  const controls = readControls(get);
  const resultView = readResultView(get);
  const progress = readProgress(get);
  const placeholders = readPlaceholders(get);
  const historySearch = readHistorySearch(get);
  assert.deepStrictEqual(readTagQuery(get), { enabled: true });
  assert.deepStrictEqual(readCompare(get), { enabled: true });
  assert.deepStrictEqual(readSavedQueries(get), { enabled: true });
  assert.deepStrictEqual(readWatch(get), { enabled: false, interval: 5 });
  readMonitorInterval(get);
  readInsight(get);
  // Each editor feature's switch that is declared here (#939, #940, #944, #945).
  for (const [feature, { key }] of Object.entries(EDITOR_SETTINGS)) {
    if (`q-lint.${key}` in declared) editorFeatureOn(get, feature);
  }
  readAssist(get, QUERY_FEATURES);
  for (const [key, spec] of Object.entries(declared)) {
    const short = key.replace(/^q-lint\./, "");
    assert.ok(read.has(short), `${key} is declared but never read`);
    assert.deepStrictEqual(read.get(short), spec.default, key);
    const affects = (section) => key === section || key.startsWith(`${section}.`);
    assert.strictEqual(needsRestart(affects), false, key);
  }
  assert.strictEqual(read.size, Object.keys(declared).length);
  assert.deepStrictEqual(live, {
    consoleSize: [50, 160],
    autoClear: false,
    includeQuery: false,
    ignoreNullReturn: false,
    mode: "console",
    gridLimit: 10000,
    gridDecimals: -1,
    resultsLocation: "editor",
  });
  assert.deepStrictEqual(controls, { unwrapped: false, timeout: 0 });
  assert.deepStrictEqual(resultView, {
    history: 10,
    heatmap: false,
    enable: { history: true, diff: true, statistics: true, heatmap: true, tree: true, export: true, paging: false, pivot: true, charts: true, drilldown: true },
    drilldown: [],
  });
  const view = (values) => readResultView((key, fallback) => (key in values ? values[key] : fallback));
  assert.strictEqual(view({ "query.resultHistory": 0 }).history, 1);
  assert.strictEqual(view({ "query.resultHistory": 99 }).history, 50);
  assert.strictEqual(view({ "query.resultHistory": 2.5 }).history, 10);
  assert.strictEqual(view({ "query.gridHeatmap": "true" }).heatmap, false);
  // A feature turned off: the history keeps one result, the heatmap colours nothing.
  assert.strictEqual(view({ "results.history.enable": false, "query.resultHistory": 20 }).history, 1);
  assert.strictEqual(view({ "results.heatmap.enable": false, "query.gridHeatmap": true }).heatmap, false);
  assert.strictEqual(view({ "results.tree.enable": false }).enable.tree, false);
  assert.deepStrictEqual(progress, { enabled: true, notifyAfter: 10 });
  assert.deepStrictEqual(historySearch, { enabled: true });
  assert.deepStrictEqual(placeholders, { enabled: true });
  assert.deepStrictEqual(explorer, { excludedNamespaces: ["q", "Q", "h", "j", "o", "s"], previewLimit: 5, autoRefresh: false });
  // A size that is not one falls back to the default.
  assert.deepStrictEqual(readLive((key, fallback) => (key === "output.consoleSize" ? "big" : fallback)).consoleSize, [50, 160]);
  // So do a mode, a limit and decimals that are not ones.
  const set = (values) => readLive((key, fallback) => (key in values ? values[key] : fallback));
  assert.strictEqual(set({ "query.mode": "chart" }).mode, "chart");
  assert.strictEqual(set({ "query.mode": "table" }).mode, "console");
  assert.strictEqual(set({ "query.gridLimit": 50 }).gridLimit, 50);
  assert.strictEqual(set({ "query.gridLimit": 0 }).gridLimit, 10000);
  assert.strictEqual(set({ "query.gridLimit": 2.5 }).gridLimit, 10000);
  assert.strictEqual(set({ "query.gridDecimals": 3 }).gridDecimals, 3);
  assert.strictEqual(set({ "query.gridDecimals": -7 }).gridDecimals, -1);
  assert.strictEqual(set({ "query.gridDecimals": 99 }).gridDecimals, 20);
  assert.strictEqual(set({ "query.resultsLocation": "panel" }).resultsLocation, "panel");
  assert.strictEqual(set({ "query.resultsLocation": "sidebar" }).resultsLocation, "editor");
  assert.deepStrictEqual(declared["q-lint.query.resultsLocation"].enum, [...RESULTS_LOCATIONS]);
});

test("the q Results view is a webview in its own container in the bottom panel (#889)", () => {
  const [container] = pkg.contributes.viewsContainers.panel;
  assert.strictEqual(container.id, RESULTS.container);
  assert.strictEqual(container.title, "q Results");
  const [view] = pkg.contributes.views[RESULTS.container];
  assert.strictEqual(view.id, RESULTS.view);
  assert.strictEqual(view.type, "webview");
  // Export Results to CSV is on the view's title bar; the row limit on a
  // notebook's toolbar.
  assert.ok(pkg.contributes.menus["view/title"].some((m) => m.command === RESULTS.exportViewCsv && m.when === `view == ${RESULTS.view}`));
  assert.ok(pkg.contributes.menus["notebook/toolbar"].some((m) => m.command === RESULTS.setRowLimit));
});

test("every notebook setting is read, with the default package.json declares, and none restarts the server (#889)", () => {
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: notebooks");
  const declared = section.properties;
  const read = new Map();
  const settings = readNotebook((key, fallback) => {
    read.set(key, fallback);
    return fallback;
  });
  for (const [key, spec] of Object.entries(declared)) {
    const short = key.replace(/^q-lint\./, "");
    assert.ok(read.has(short), `${key} is declared but never read`);
    assert.deepStrictEqual(read.get(short), spec.default, key);
    const affects = (s) => key === s || key.startsWith(`${s}.`);
    assert.strictEqual(needsRestart(affects), false, key);
  }
  assert.strictEqual(read.size, Object.keys(declared).length);
  assert.deepStrictEqual(settings, { rowLimit: 1000, rowLimitFrom: "first" });
  assert.deepStrictEqual(declared["q-lint.notebook.rowLimitFrom"].enum, [...ROW_LIMIT_FROM]);
  const set = (values) => readNotebook((key, fallback) => (key in values ? values[key] : fallback));
  assert.deepStrictEqual(set({ "notebook.rowLimit": 0, "notebook.rowLimitFrom": "last" }), { rowLimit: 0, rowLimitFrom: "last" });
  assert.strictEqual(set({ "notebook.rowLimit": -5 }).rowLimit, 1000);
  assert.strictEqual(set({ "notebook.rowLimit": 2.5 }).rowLimit, 1000);
  assert.strictEqual(set({ "notebook.rowLimitFrom": "middle" }).rowLimitFrom, "first");
});

test("a row limit is one signed count for sublist: last negative, all infinite (#889)", () => {
  assert.strictEqual(rowsArgument({ rowLimit: 1000, rowLimitFrom: "first" }), 1000);
  assert.strictEqual(rowsArgument({ rowLimit: 10, rowLimitFrom: "last" }), -10);
  assert.strictEqual(rowsArgument({ rowLimit: 0, rowLimitFrom: "first" }), Infinity);
  assert.strictEqual(rowsArgument({ rowLimit: 0, rowLimitFrom: "last" }), -Infinity);
  assert.deepStrictEqual([...ROW_LIMIT_CHOICES], [10, 100, 1000, 10000, 100000, 0]);
  assert.deepStrictEqual(ROW_LIMIT_CHOICES.map(rowLimitLabel), ["10 rows", "100 rows", "1,000 rows", "10,000 rows", "100,000 rows", "All rows"]);
  // The default is one of the choices.
  assert.ok(ROW_LIMIT_CHOICES.includes(readNotebook((_, fallback) => fallback).rowLimit));
});

test("query controls: a timeout is a positive number of seconds, at most a day; unwrapped only when true", () => {
  const set = (values) => readControls((key, fallback) => (key in values ? values[key] : fallback));
  assert.strictEqual(set({ "query.timeout": 2.5 }).timeout, 2.5);
  assert.strictEqual(set({ "query.timeout": -1 }).timeout, 0);
  assert.strictEqual(set({ "query.timeout": "5" }).timeout, 0);
  assert.strictEqual(set({ "query.timeout": 1e9 }).timeout, 86400);
  assert.strictEqual(set({ "query.unwrapped": true }).unwrapped, true);
  assert.strictEqual(set({ "query.unwrapped": "yes" }).unwrapped, false);
});

test("Execute Entire File is bound to a key no VS Code default takes, and is in the run menu", () => {
  const binding = pkg.contributes.keybindings.find((k) => k.command === CONTROL_COMMANDS.queryFile);
  // ctrl+f10 is in none of VS Code 1.147's default keybindings on macOS,
  // Windows or Linux; ctrl+shift+d (Run and Debug) and ctrl+d (add next
  // occurrence) are what KX's extension uses, and both clash.
  assert.strictEqual(binding.key, "ctrl+f10");
  assert.ok(!binding.mac && !binding.win && !binding.linux);
  const keys = pkg.contributes.keybindings.map((k) => k.key);
  assert.strictEqual(new Set(keys).size, keys.length, "two commands share a key");
  assert.ok(pkg.contributes.menus["editor/title/run"].some((m) => m.command === CONTROL_COMMANDS.queryFile));
  // Copy Query is on a history row, inline and in its menu.
  const rows = pkg.contributes.menus["view/item/context"].filter((m) => m.command === CONTROL_COMMANDS.copyQuery);
  assert.deepStrictEqual(rows.map((m) => m.group).sort(), ["1_history@2", "inline"]);
});

test("Toggle Parameter Cache is bound to a key no VS Code default takes (#892)", () => {
  const binding = pkg.contributes.keybindings.find((k) => k.command === PARAM_CACHE.toggle);
  // ctrl+shift+' is in none of VS Code 1.147's default keybindings on macOS,
  // Windows or Linux, alone or as the first key of a chord. KX's extension
  // uses ctrl+shift+y, the Debug Console on Windows and Linux, and a
  // ctrl+alt key is AltGr on Windows.
  assert.strictEqual(binding.key, "ctrl+shift+'");
  assert.ok(!binding.mac && !binding.win && !binding.linux);
  assert.match(binding.when, /editorLangId == q/);
  const keys = pkg.contributes.keybindings.map((k) => k.key);
  assert.strictEqual(new Set(keys).size, keys.length, "two commands share a key");
  assert.ok(pkg.contributes.menus["editor/context"].some((m) => m.command === PARAM_CACHE.toggle));
});
