// The Process Monitor and HDB browser views (infoview.ts) through the
// stand-in `vscode` (vscode_stub.js), with a stand-in for `Live`: a refresh
// for another process waits for the read in flight, then reads its own.
const { stub, EventEmitter } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { registerInfoViews } = require("../out/infoview.js");

test("connected to another process mid-read, the view reads that one, not the first one's failure (#1455)", async () => {
  stub.reset();
  stub.config.user["hdbBrowser.enable"] = false;
  const changed = new EventEmitter();
  let active = "A";
  const reads = [];
  const pending = [];
  const live = {
    activeLabel: () => active,
    onDidChange: changed.event,
    borrow: (use) =>
      use(
        {
          call: async () => {
            const who = active;
            reads.push(who);
            if (who === "A") {
              await new Promise((r) => pending.push(r));
              throw new Error("closed");
            }
            return { memory: { used: 1 }, settings: { port: 5010 } };
          },
        },
        { label: active },
      ),
  };
  const context = stub.newContext();
  registerInfoViews(context, live);
  const view = stub.trees.find((t) => t.id === "q-lint.processMonitor");
  await new Promise((r) => setImmediate(r));
  active = "B";
  changed.fire("disconnected");
  changed.fire("connected");
  pending.forEach((r) => r());
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(reads, ["A", "B"]);
  assert.strictEqual(view.message, undefined);
  assert.strictEqual(view.description, "B");
  for (const d of context.subscriptions) d.dispose?.();
});
