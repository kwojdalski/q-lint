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
  processColour,
  tagColour,
} = require("../out/processes.js");
const { NULL_TYPE, RUN, readAnswer, render } = require("../out/query.js");
const { COMMANDS, CONNECTED, QUERY_MODES, VIEWS, readLive } = require("../out/liveconfig.js");
const { EXPLORER, readExplorer } = require("../out/explorer.js");
const relations = require("../out/relations.js");
const { NOTEBOOK } = require("../out/qnb.js");
const { needsRestart } = require("../out/settings.js");

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
  // A comment line between a statement and an indented line ends the statement.
  assert.deepStrictEqual(statements("a:1\n/ note\n  +2"), ["a:1", "+2"]);
  // A trailing comment stays: q's parser drops it.
  assert.deepStrictEqual(statements("a:1 / one"), ["a:1 / one"]);
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
  assert.strictEqual(processColour({ label: "x", host: "h", port: 1, tags: ["dev", "prod"] }), "red");
  assert.strictEqual(processColour({ label: "x", host: "h", port: 1, tags: ["eu"] }), undefined);
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
    ...Object.values(EXPLORER).filter((id) => id !== EXPLORER.view),
    ...Object.values(relations.COMMANDS),
    NOTEBOOK.exportCommand,
    "q-lint.restartServer",
  ].sort();
  assert.deepStrictEqual(declared, registered);
});

test("the views live in their own container, and every menu names a declared command", () => {
  const [container] = pkg.contributes.viewsContainers.activitybar;
  assert.strictEqual(container.id, VIEWS.container);
  assert.deepStrictEqual(
    pkg.contributes.views[VIEWS.container].map((v) => v.id),
    [VIEWS.processes, EXPLORER.view, VIEWS.history],
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
  });
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
});
