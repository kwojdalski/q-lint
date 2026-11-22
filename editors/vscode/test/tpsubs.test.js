// The tickerplant subscribers view (#1042): the process's answer read, the
// tree built - and, through the stand-in `vscode` and a fake q, the view's
// life: off, it is gone, Refresh refuses and nothing is sent; on, nothing is
// read until Refresh, which sends the one read-only lambda. The q side is
// tpsubs_q.test.js.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { setUp, heads } = require("./fakeq.js");
const { SUBSCRIBERS, readSubscribers, subscriberTree } = require("../out/tpsubs.js");
const { registerTickerplantSubscribers, SUBSCRIBERS_VIEW } = require("../out/tpsubsview.js");
const { PROCESS_TOOL_COMMANDS, PROCESS_TOOL_SETTINGS } = require("../out/processtools.js");
const pkg = require("../package.json");

const RAW = [["trade", "quote", "quote"], [7, 7, 9], ["hostA", "", ""], [0, 0, 2048], ["", "a b", "c"], ["q", "q", "websocket"]];

test("the answer is read, and one subscriber reads as atoms", () => {
  const subs = readSubscribers(RAW);
  assert.deepStrictEqual(subs[2], { table: "quote", handle: 9, host: "", queue: 2048, syms: "c", protocol: "websocket" });
  assert.deepStrictEqual(readSubscribers(["trade", 7, "", 0, "", ""]), [{ table: "trade", handle: 7, host: "", queue: 0, syms: "", protocol: "" }]);
  assert.deepStrictEqual(readSubscribers([[], [], [], [], [], []]), []);
  assert.throws(() => readSubscribers("junk"), /something other than the subscribers/);
  assert.throws(() => readSubscribers([["a"], [1, 2], [], [], [], []]), /subscribers/);
});

test("the tree groups subscribers by table and says what it cannot know", () => {
  const tree = subscriberTree(readSubscribers(RAW));
  assert.deepStrictEqual(tree.map((t) => [t.label, t.description]), [
    ["quote", "2 subscribers"],
    ["trade", "1 subscriber"],
  ]);
  const [first, second] = tree[0].children;
  assert.match(first.description, /host not recorded .* queue 0 B .* a b/);
  assert.match(second.description, /queue 2\.0 KB .* c/);
  assert.strictEqual(second.icon, "warning");
  assert.match(second.tooltip, /websocket/);
  assert.match(tree[1].children[0].description, /hostA .* all symbols/);
});

test("the switch is declared on, and the view and Refresh only where it is", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props[`q-lint.${PROCESS_TOOL_SETTINGS.tickerplantSubscribers.key}`].default, true);
  const view = pkg.contributes.views["q-lint"].find((v) => v.id === SUBSCRIBERS_VIEW);
  assert.strictEqual(view.when, "config.q-lint.tickerplant.subscribers.enable");
  for (const m of [...pkg.contributes.menus.commandPalette, ...pkg.contributes.menus["view/title"]].filter((m) => m.command === PROCESS_TOOL_COMMANDS.refreshSubscribers)) {
    assert.match(m.when, /config\.q-lint\.tickerplant\.subscribers\.enable/);
  }
});

test("off, the view is gone and Refresh sends nothing; on, only Refresh reads", async (t) => {
  const { q, live, feature } = await setUp(t, { config: { "tickerplant.subscribers.enable": false }, answer: (m) => (Array.isArray(m) && m[0] === SUBSCRIBERS ? RAW : null), register: registerTickerplantSubscribers });
  await live.connectTo("rdb");
  const before = q.sent.length;
  assert.strictEqual(feature.tree().open, false);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.refreshSubscribers)(), /tickerplant subscribers view is turned off\. Set q-lint\.tickerplant\.subscribers\.enable to true/);
  assert.strictEqual(q.sent.length, before);

  stub.config.user["tickerplant.subscribers.enable"] = true;
  stub.changeConfig("q-lint.tickerplant.subscribers.enable");
  assert.strictEqual(feature.tree().open, true);
  // Created, it reads nothing until asked.
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(q.sent.length, before);
  const subs = await stub.commands.get(PROCESS_TOOL_COMMANDS.refreshSubscribers)();
  assert.strictEqual(subs.length, 3);
  assert.deepStrictEqual(heads(q.sent.slice(before)), [SUBSCRIBERS]);
  assert.deepStrictEqual(feature.tree().roots.map((r) => r.label), ["quote", "trade"]);
  assert.match(feature.tree().shownMessage, /rdb: 3 subscriptions/);

  stub.config.user["tickerplant.subscribers.enable"] = false;
  stub.changeConfig("q-lint.tickerplant.subscribers.enable");
  assert.strictEqual(feature.tree().open, false);
  assert.ok(stub.trees.find((v) => v.id === SUBSCRIBERS_VIEW).disposed);
});

test("an answer that is not subscribers is said in the view", async (t) => {
  const { live, feature } = await setUp(t, { answer: (m) => (Array.isArray(m) && m[0] === SUBSCRIBERS ? "junk" : null), register: registerTickerplantSubscribers });
  await live.connectTo("rdb");
  const said = await stub.commands.get(PROCESS_TOOL_COMMANDS.refreshSubscribers)();
  assert.strictEqual(typeof said, "string");
  assert.strictEqual(feature.tree().roots.length, 0);
});
