// Searching the query history (#913): what a filter keeps, how the view says
// so, the history written as JSON and as a q script, and the commands
// through the stand-in `vscode` module.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const {
  HISTORY_COMMANDS,
  HISTORY_FILTERED,
  OUTCOME_CHOICES,
  exportFormat,
  filterDescription,
  filtered,
  historyJson,
  historyProcesses,
  historyScript,
  isFiltering,
  matches,
  normalised,
} = require("../out/historyfilter.js");
const { Live } = require("../out/live.js");

const at = "2026-11-21T10:00:00.000Z";
const ENTRIES = [
  { process: "rdb", code: "select from trade", at, millis: 5, outcome: "ok" },
  { process: "hdb", code: "1+`a", at, millis: 1, outcome: "error", error: "type" },
  { process: "rdb", code: "slow 10", at, millis: 5000, outcome: "timeout", error: "timed out after 5 s" },
  { process: "hdb", code: "Select From Quote", at, millis: 2, outcome: "aborted", error: "aborted", agent: true },
];

test("a filter keeps entries by process, outcome and text, ignoring case in the text", () => {
  const codes = (f) => filtered(ENTRIES, f).map((e) => e.code);
  assert.deepStrictEqual(codes({}), ENTRIES.map((e) => e.code));
  assert.deepStrictEqual(codes({ process: "rdb" }), ["select from trade", "slow 10"]);
  assert.deepStrictEqual(codes({ outcome: "ok" }), ["select from trade"]);
  assert.deepStrictEqual(codes({ outcome: "failed" }), ["1+`a", "slow 10", "Select From Quote"]);
  assert.deepStrictEqual(codes({ outcome: "error" }), ["1+`a"]);
  assert.deepStrictEqual(codes({ text: "SELECT" }), ["select from trade", "Select From Quote"]);
  // q's error is searched too.
  assert.deepStrictEqual(codes({ text: "type" }), ["1+`a"]);
  assert.deepStrictEqual(codes({ process: "hdb", outcome: "failed", text: "quote" }), ["Select From Quote"]);
  assert.deepStrictEqual(codes({ process: "nowhere" }), []);
  assert.strictEqual(matches(ENTRIES[0], { text: "   " }), true);
});

test("an empty part is no filter, and the description names the parts set", () => {
  assert.deepStrictEqual(normalised({ process: undefined, outcome: undefined, text: "  " }), {});
  assert.strictEqual(isFiltering({ text: " " }), false);
  assert.strictEqual(isFiltering({ outcome: "ok" }), true);
  assert.strictEqual(filterDescription({}), "");
  assert.strictEqual(filterDescription({ process: "rdb", outcome: "failed", text: " sel " }), 'rdb · failed · "sel"');
  assert.strictEqual(filterDescription({ outcome: "timeout" }), "timed out");
  assert.deepStrictEqual(historyProcesses(ENTRIES), ["hdb", "rdb"]);
  assert.strictEqual(OUTCOME_CHOICES[0].outcome, undefined);
});

test("the history is exported as JSON, newest first, or as a q script, oldest first", () => {
  const json = JSON.parse(historyJson(ENTRIES.slice(0, 2)));
  assert.deepStrictEqual(json, {
    queries: [
      { process: "rdb", at, millis: 5, outcome: "ok", code: "select from trade" },
      { process: "hdb", at, millis: 1, outcome: "error", error: "type", code: "1+`a" },
    ],
  });
  assert.strictEqual(
    historyScript([{ ...ENTRIES[3], code: "a:1\nb:2\n" }, ENTRIES[1]]),
    [`/ hdb, ${at}, 1 ms, error`, "/ 'type", "1+`a", "", `/ hdb, ${at}, 2 ms, aborted, run by an agent`, "/ 'aborted", "a:1\nb:2", ""].join("\n"),
  );
  // An error over two lines stays in its comment.
  assert.match(historyScript([{ ...ENTRIES[1], error: "a\nb" }]), /^\/ 'a b$/m);
  assert.strictEqual(exportFormat("/x/h.q"), "q");
  assert.strictEqual(exportFormat("/x/h.Q"), "q");
  assert.strictEqual(exportFormat("/x/h.json"), "json");
  assert.strictEqual(exportFormat("/x/h"), "json");
});

test("each entry of the exported script loads as it ran on its own (#1098)", () => {
  const { statements } = require("../out/statements.js");
  const entry = (code) => ({ process: "p", code, at, millis: 1, outcome: "ok" });
  // Newest first, as kept: the script runs them oldest first.
  const script = (...codes) => statements(historyScript(codes.reverse().map(entry)));
  assert.deepStrictEqual(script("a:1", "  b:2"), ["a:1", "b:2"]);
  assert.deepStrictEqual(script("a:1", "  f:{\n    x}"), ["a:1", "f:{\n    x}"]);
  assert.deepStrictEqual(script("a:1", "/ note\n  b:2\n  c"), ["a:1", "b:2\n  c"]);
  assert.deepStrictEqual(script("a:1", "b:2\n/\nhidden", "c:3"), ["a:1", "b:2", "c:3"]);
  assert.deepStrictEqual(script("/\nx\n\\\ny:1", "z:2"), ["y:1", "z:2"]);
  // An end of script ended only its own entry (#1136): the rest of it is
  // commented out, and the entries after it still load.
  assert.deepStrictEqual(script("a:1", "b:2\n\\\nnever:1\n\n\\", "c:3"), ["a:1", "b:2", "c:3"]);
  assert.match(historyScript([entry("b:2\n\\\nnever:1")]), /^b:2\n\/ \\\n\/ never:1$/m);
  // A closed block comment, kept as written.
  assert.match(historyScript([entry("/\nx\n\\\ny:1")]), /^\/\nx\n\\\ny:1\n$/m);
});

test("the filter is on the view's title bar, and Clear Filter only while filtered", () => {
  const title = pkg.contributes.menus["view/title"];
  const on = (command) => title.filter((m) => m.command === command).map((m) => m.when);
  const search = "config.q-lint.queryHistory.search.enable";
  assert.deepStrictEqual(on(HISTORY_COMMANDS.clearFilter), [`view == q-lint.queryHistory && ${HISTORY_FILTERED} && ${search}`]);
  assert.ok(on(HISTORY_COMMANDS.filter).includes(`view == q-lint.queryHistory && !${HISTORY_FILTERED} && ${search}`));
  assert.deepStrictEqual(on(HISTORY_COMMANDS.export), [`view == q-lint.queryHistory && ${search}`]);
  // Hidden from the palette too while the setting is off.
  for (const command of Object.values(HISTORY_COMMANDS)) {
    const palette = pkg.contributes.menus.commandPalette.find((m) => m.command === command);
    assert.ok(palette && palette.when.includes(search), command);
  }
  for (const command of Object.values(HISTORY_COMMANDS)) {
    const declared = pkg.contributes.commands.find((c) => c.command === command);
    assert.strictEqual(declared.category, "q-lint", command);
  }
});

async function setUp(t) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.queryHistory", ENTRIES);
  const live = new Live(context);
  const contexts = [];
  const vscode = require("vscode");
  const execute = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (name, ...args) => (name === "setContext" ? void contexts.push(args) : execute(name, ...args));
  t.after(() => {
    vscode.commands.executeCommand = execute;
    for (const d of context.subscriptions) d.dispose?.();
  });
  const view = stub.trees.find((v) => v.id === "q-lint.queryHistory");
  return { live, view, contexts, run: (name, ...args) => stub.commands.get(name)(...args) };
}

test("Filter Query History asks for a process, an outcome and text, and the view shows only what matches", async (t) => {
  const { live, view, contexts, run } = await setUp(t);
  let offered;
  stub.picks.push(({ items }) => ((offered = items.map((i) => i.label)), items.find((i) => i.label === "hdb")), "Failed (error, timeout or aborted)");
  stub.inputs.push("QUOTE");
  await run(HISTORY_COMMANDS.filter);
  assert.deepStrictEqual(offered, ["Any process", "hdb", "rdb"]);
  assert.deepStrictEqual(live.shownHistory().map((e) => e.code), ["Select From Quote"]);
  assert.strictEqual(view.options.treeDataProvider.getChildren().length, 1);
  assert.strictEqual(view.description, 'filtered: hdb · failed · "QUOTE"');
  assert.deepStrictEqual(contexts.at(-1), [HISTORY_FILTERED, true]);
  // The next filter starts from this one, and Escape keeps it.
  let current;
  stub.picks.push(({ items }) => ((current = items.filter((i) => i.description === "current").map((i) => i.label)), undefined));
  await run(HISTORY_COMMANDS.filter);
  assert.deepStrictEqual(current, ["hdb"]);
  assert.strictEqual(live.shownHistory().length, 1);
  // A filter nothing matches says so.
  await run(HISTORY_COMMANDS.filter, { text: "nothing like it" });
  assert.strictEqual(view.message, "No query in the history matches the filter.");
  // A new query that matches shows at once.
  await live.record({ process: "rdb", code: "nothing like it", at, millis: 1, outcome: "ok" });
  assert.deepStrictEqual([live.shownHistory().length, view.message], [1, undefined]);
  await run(HISTORY_COMMANDS.clearFilter);
  assert.deepStrictEqual([live.shownHistory().length, view.description, contexts.at(-1)], [5, undefined, [HISTORY_FILTERED, false]]);
  // A bad outcome from a keybinding's args is no filter.
  await run(HISTORY_COMMANDS.filter, { outcome: "weird" });
  assert.strictEqual(live.shownHistory().length, 5);
});

test("Export Query History writes what the view shows, as JSON or a q script", async (t) => {
  const { live, run } = await setUp(t);
  const vscode = require("vscode");
  const written = new Map();
  const fs = vscode.workspace.fs;
  vscode.workspace.fs = { writeFile: async (uri, bytes) => void written.set(uri.fsPath, Buffer.from(bytes).toString("utf8")) };
  t.after(() => (vscode.workspace.fs = fs));
  await run(HISTORY_COMMANDS.filter, { process: "rdb" });
  await run(HISTORY_COMMANDS.export, vscode.Uri.file("/out/h.json"));
  assert.deepStrictEqual(JSON.parse(written.get("/out/h.json")).queries.map((q) => q.code), ["select from trade", "slow 10"]);
  await run(HISTORY_COMMANDS.export, vscode.Uri.file("/out/h.q"));
  assert.match(written.get("/out/h.q"), /^\/ rdb, .*timeout\n\/ 'timed out after 5 s\nslow 10\n\n\/ rdb, .*ok\nselect from trade\n$/);
  assert.match(stub.messages.at(-1)[1], /exported 2 queries to \/out\/h\.q/);
  // Nothing to export says why.
  await run(HISTORY_COMMANDS.filter, { process: "none" });
  await run(HISTORY_COMMANDS.export, vscode.Uri.file("/out/x.json"));
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: no query in the history matches the filter."]);
  assert.ok(!written.has("/out/x.json"));
  assert.strictEqual(live.history().length, 4);
});

test("with q-lint.queryHistory.search.enable off, filter and export refuse, and a filter set is cleared", async (t) => {
  const { live, view, run } = await setUp(t);
  const vscode = require("vscode");
  const written = new Map();
  const fs = vscode.workspace.fs;
  vscode.workspace.fs = { writeFile: async (uri, bytes) => void written.set(uri.fsPath, bytes) };
  t.after(() => (vscode.workspace.fs = fs));
  await run(HISTORY_COMMANDS.filter, { process: "rdb" });
  assert.strictEqual(live.shownHistory().length, 2);
  stub.config.user["queryHistory.search.enable"] = false;
  stub.changeConfig("q-lint.queryHistory.search.enable");
  assert.deepStrictEqual([live.shownHistory().length, view.description], [4, undefined]);
  const off = ["info", "q-lint: Query History search is turned off. Set q-lint.queryHistory.search.enable to true to turn it on."];
  stub.messages = [];
  await run(HISTORY_COMMANDS.filter, { process: "rdb" });
  await run(HISTORY_COMMANDS.export, vscode.Uri.file("/out/h.json"));
  assert.deepStrictEqual(stub.messages, [off, off]);
  assert.deepStrictEqual([live.shownHistory().length, written.size], [4, 0]);
  // On again, without a reload.
  stub.config.user["queryHistory.search.enable"] = true;
  stub.changeConfig("q-lint.queryHistory.search.enable");
  await run(HISTORY_COMMANDS.filter, { process: "rdb" });
  assert.strictEqual(live.shownHistory().length, 2);
});

// Each window kept the history it read at start and wrote that back with
// its new entry: what another window recorded meanwhile was dropped (#1619).
test("two windows recording queries keep each other's, and Clear in one holds in the other", async (t) => {
  const { mergedHistory } = require("../out/history.js");
  stub.reset();
  const one = stub.newContext();
  const two = { ...stub.newContext(), globalState: one.globalState };
  const a = new Live(one);
  const b = new Live(two);
  t.after(() => [...one.subscriptions, ...two.subscriptions].forEach((d) => d.dispose?.()));
  const entry = (code, sec) => ({ process: "p", code, at: `2026-11-24T10:00:${String(sec).padStart(2, "0")}.000Z`, millis: 1, outcome: "ok" });
  assert.deepStrictEqual(b.history(), []);
  await a.record(entry("from a", 1));
  await b.record(entry("from b", 2));
  await a.record(entry("from a again", 3));
  assert.deepStrictEqual(one.globalState.get("q-lint.queryHistory").map((e) => e.code), ["from a again", "from b", "from a"]);
  assert.deepStrictEqual(b.history().map((e) => e.code), ["from a again", "from b", "from a"]);
  // A read just after a write that returns the value before it drops nothing.
  assert.deepStrictEqual(mergedHistory(entry("new", 9), [entry("x", 5)], [], undefined, 200).map((e) => e.code), ["new", "x"]);
  await a.clearHistory();
  await b.record({ ...entry("after clear", 0), at: new Date(Date.now() + 1000).toISOString() });
  assert.deepStrictEqual(one.globalState.get("q-lint.queryHistory").map((e) => e.code), ["after clear"]);
  assert.deepStrictEqual(a.history().map((e) => e.code), ["after clear"]);
});

// Clear run while the clock was ahead stamped a moment still to come: every
// query sent after the clock was put right was "at or before" it (#1882).
test("a Clear stamp from a clock that was ahead does not drop the queries sent since", async (t) => {
  const { clearedStamp } = require("../out/history.js");
  const now = new Date("2026-11-24T10:00:00.000Z");
  // A stamp that is not after now is as stored; none is none.
  assert.strictEqual(clearedStamp("2026-11-24T09:00:00.000Z", "2026-11-24T09:59:59.000Z", now), "2026-11-24T09:00:00.000Z");
  assert.strictEqual(clearedStamp("2026-11-24T10:00:00.000Z", "2026-11-24T09:59:59.000Z", now), "2026-11-24T10:00:00.000Z");
  assert.strictEqual(clearedStamp(undefined, "2026-11-24T09:59:59.000Z", now), undefined);
  assert.strictEqual(clearedStamp(7, "2026-11-24T09:59:59.000Z", now), undefined);
  // One after now is the moment before the entry: it is kept, what was sent before it is not.
  assert.strictEqual(clearedStamp("2027-03-01T10:00:00.000Z", "2026-11-24T09:59:59.000Z", now), "2026-11-24T09:59:58.999Z");
  assert.strictEqual(clearedStamp("2027-03-01T10:00:00.000Z", "not a date", now), "2026-11-24T09:59:59.999Z");
  assert.strictEqual(clearedStamp("2027-03-01T10:00:00.000Z", "2026-12-01T00:00:00.000Z", now), "2026-11-24T09:59:59.999Z");

  stub.reset();
  const context = stub.newContext();
  const live = new Live(context);
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  const entry = (code, ago) => ({ process: "p", code, at: new Date(Date.now() - ago).toISOString(), millis: 1, outcome: "ok" });
  // Cleared "next year"; another window still holds a query from before it.
  await context.globalState.update("q-lint.queryHistoryCleared", new Date(Date.now() + 365 * 86_400_000).toISOString());
  await context.globalState.update("q-lint.queryHistory", [entry("before the clear", 3_600_000)]);
  await live.record(entry("a", 300));
  await live.record(entry("b", 200));
  await live.record(entry("c", 100));
  assert.deepStrictEqual(live.history().map((e) => e.code), ["c", "b", "a"]);
  assert.deepStrictEqual(context.globalState.get("q-lint.queryHistory").map((e) => e.code), ["c", "b", "a"]);
  assert.ok(context.globalState.get("q-lint.queryHistoryCleared") < new Date().toISOString());
  // Clear still clears.
  await live.clearHistory();
  assert.deepStrictEqual(live.history(), []);
});

// The history was capped by count only: 200 runs of a 1 MB file put over
// 200 MB in globalState, written again at every query (#1880).
test("the history keeps the newest queries whose code fits a size between them, each whole", async (t) => {
  const { HISTORY_CHARS, mergedHistory } = require("../out/history.js");
  const entry = (code, sec) => ({ process: "p", code, at: new Date(Date.UTC(2026, 10, 24, 10, 0, sec)).toISOString(), millis: 1, outcome: "ok" });
  const codes = (list) => list.map((e) => (e.code.length > 20 ? `${e.code.slice(0, 2)}x${e.code.length}` : e.code));
  // Newest first until the next does not fit; one too long alone is left out, not cut, and ends nothing.
  const held = [entry("d".repeat(40), 4), entry("c".repeat(101), 3), entry("b".repeat(40), 2), entry("a".repeat(40), 1), entry("old", 0)];
  assert.deepStrictEqual(codes(mergedHistory(undefined, held, [], undefined, 200, 100)), ["ddx40", "bbx40"]);
  assert.deepStrictEqual(codes(mergedHistory(entry("e".repeat(30), 5), held, [], undefined, 200, 100)), ["eex30", "ddx40"]);
  assert.deepStrictEqual(codes(mergedHistory(entry("e".repeat(101), 5), held, [], undefined, 200, 100)), ["ddx40", "bbx40"]);
  assert.deepStrictEqual(codes(mergedHistory(undefined, held, [], undefined, 200)), ["ddx40", "ccx101", "bbx40", "aax40", "old"]);

  stub.reset();
  const context = stub.newContext();
  const live = new Live(context);
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  const file = "t:([]a:til 10);\n".repeat(Math.ceil(HISTORY_CHARS / 4 / 16)).slice(0, HISTORY_CHARS / 4);
  await live.record(entry("select from t", 0));
  for (let i = 1; i <= 12; i++) {
    await live.record(entry(`${file}/${String(i).padStart(2, "0")}`, i));
  }
  const stored = context.globalState.get("q-lint.queryHistory");
  assert.ok(JSON.stringify(stored).length < HISTORY_CHARS * 1.1, `${JSON.stringify(stored).length} characters stored`);
  // The newest three, as they were sent: Run Again runs the whole of each.
  assert.deepStrictEqual(stored.map((e) => e.code.slice(-3)), ["/12", "/11", "/10"]);
  assert.ok(stored.every((e) => e.code.startsWith(file) && e.code.length === file.length + 3));
  assert.deepStrictEqual(live.history(), stored);
  // A query longer than the whole size is not kept, and the rest stay.
  await live.record(entry("x".repeat(HISTORY_CHARS + 1), 20));
  assert.deepStrictEqual(context.globalState.get("q-lint.queryHistory").map((e) => e.code.slice(-3)), ["/12", "/11", "/10"]);
  await live.record(entry("count t", 21));
  assert.deepStrictEqual(live.history().map((e) => e.code.slice(-3)), ["t t", "/12", "/11", "/10"]);
});
