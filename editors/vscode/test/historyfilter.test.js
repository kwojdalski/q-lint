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

test("the filter is on the view's title bar, and Clear Filter only while filtered", () => {
  const title = pkg.contributes.menus["view/title"];
  const on = (command) => title.filter((m) => m.command === command).map((m) => m.when);
  assert.deepStrictEqual(on(HISTORY_COMMANDS.clearFilter), [`view == q-lint.queryHistory && ${HISTORY_FILTERED}`]);
  assert.ok(on(HISTORY_COMMANDS.filter).includes(`view == q-lint.queryHistory && !${HISTORY_FILTERED}`));
  assert.deepStrictEqual(on(HISTORY_COMMANDS.export), ["view == q-lint.queryHistory"]);
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
