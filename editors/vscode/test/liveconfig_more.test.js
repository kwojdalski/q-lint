// The live half's settings read when settings.json gives them the wrong
// type: VS Code warns there, and passes the value on as it is.
const test = require("node:test");
const assert = require("node:assert");
const { readLive, readTerminal } = require("../out/liveconfig.js");
const { readExplorer } = require("../out/explorer.js");

const reading = (values) => (key, fallback) => (key in values ? values[key] : fallback);

// `"q-lint.output.consoleSize": 50` (a number, not "50 160") threw
// `text.trim is not a function` from every query, which then failed with
// only VS Code's "command resulted in an error"; `"terminal.qBinary": 5`
// or `"terminal.envPath": null` failed every terminal command the same
// way. A string "false" for autoClear cleared the output, being truthy.
test("a setting of the wrong type is its default, not a failed query", () => {
  const live = readLive(reading({ "output.consoleSize": 50, "output.autoClear": "false", "output.includeQuery": 1, "output.ignoreNullReturn": "yes" }));
  assert.deepStrictEqual(
    [live.consoleSize, live.autoClear, live.includeQuery, live.ignoreNullReturn],
    [[50, 160], false, false, false],
  );
  assert.deepStrictEqual(readTerminal(reading({ "terminal.qBinary": 5, "terminal.envPath": null })), { qBinary: "q", envPath: "" });
  assert.deepStrictEqual(readLive(reading({ "output.autoClear": true })).autoClear, true);
  // The same for the explorer's: a "false" string read the process after
  // every query.
  assert.strictEqual(readExplorer(reading({ "processExplorer.autoRefresh": "false" })).autoRefresh, false);
});
