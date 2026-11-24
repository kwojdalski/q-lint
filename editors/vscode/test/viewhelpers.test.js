// .qlint.view and .qlint.plot (#960), through the stand-in `vscode` and a
// fake Live: the limits written into their definition follow the settings.
// The q side is interactive_q.test.js.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { registerViewHelpers } = require("../out/viewhelpers.js");

function fakeLive() {
  const sent = [];
  const changed = [];
  const live = {
    active: "rdb",
    sent,
    activeLabel: () => live.active,
    onAsyncMessage: () => ({ dispose() {} }),
    onDidChange: (f) => (changed.push(f), { dispose() {} }),
    fire: (what) => changed.forEach((f) => f(what)),
    runOnActive: async (code, _query, guard, expect) => {
      if (expect !== undefined && expect !== live.active) throw new Error(`moved from ${expect}`);
      sent.push({ code, guard, process: live.active });
      return { process: live.active, value: { ok: true } };
    },
  };
  return live;
}

const settle = () => new Promise((r) => setImmediate(r));

// The limits were baked in when defined, and nothing defined it again: a
// raised gridLimit still sent 10000 rows (#1849).
test("a new gridLimit or consoleSize defines .qlint.view again on the process it was defined on (#1849)", async () => {
  stub.reset();
  const context = stub.newContext();
  const live = fakeLive();
  const view = registerViewHelpers(context, live);
  assert.strictEqual(await view.define(), true);
  assert.match(live.sent[0].code, /;50 160f;10000f\]/);
  stub.config.user["query.gridLimit"] = 50000;
  stub.changeConfig("q-lint.query.gridLimit");
  await settle();
  assert.strictEqual(live.sent.length, 2);
  assert.match(live.sent[1].code, /;50 160f;50000f\]/);
  // Quietly, through the guard: refused, not asked, on a guarded process.
  assert.strictEqual(live.sent[1].guard, "refuse");
  stub.config.user["output.consoleSize"] = "20 80";
  stub.changeConfig("q-lint.output.consoleSize");
  await settle();
  assert.match(live.sent[2].code, /;20 80f;50000f\]/);
  // An unrelated setting sends nothing.
  stub.changeConfig("q-lint.query.mode");
  await settle();
  assert.strictEqual(live.sent.length, 3);
  // Connected elsewhere, where it was never defined: nothing is sent there;
  // back on rdb after another change, it is defined again on connect.
  live.active = "hdb";
  stub.config.user["query.gridLimit"] = 7;
  stub.changeConfig("q-lint.query.gridLimit");
  await settle();
  assert.strictEqual(live.sent.length, 3);
  live.active = "rdb";
  live.fire("connected");
  await settle();
  assert.strictEqual(live.sent.length, 4);
  assert.match(live.sent[3].code, /;20 80f;7f\]/);
  // With view.enable off nothing is sent.
  stub.config.user["view.enable"] = false;
  stub.config.user["query.gridLimit"] = 8;
  stub.changeConfig("q-lint.query.gridLimit");
  await settle();
  assert.strictEqual(live.sent.length, 4);
  for (const d of context.subscriptions) d.dispose?.();
});
