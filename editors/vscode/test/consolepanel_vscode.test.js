// The Interactive Window and REPL pane's run list (src/consolepanel.ts)
// through the stand-in `vscode` (vscode_stub.js): what it tells the page.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { ConsolePanel, ENTRY_LIMIT } = require("../out/consolepanel.js");

test("a run dropped past ENTRY_LIMIT is removed from the page too (#1238)", () => {
  const pane = new ConsolePanel(stub.newContext(), { viewType: "t", title: "t", input: false });
  const posted = [];
  pane.post = (m) => posted.push(m);
  for (let i = 0; i < ENTRY_LIMIT + 2; i++) {
    pane.add({ code: String(i) });
  }
  assert.strictEqual(pane.entries().length, ENTRY_LIMIT);
  assert.deepStrictEqual(posted.filter((m) => m.type === "remove"), [{ type: "remove", id: 1 }, { type: "remove", id: 2 }]);
  // Each drop is posted before the add that caused it.
  const at = posted.findIndex((m) => m.type === "remove");
  assert.strictEqual(posted[at + 1].entry.id, ENTRY_LIMIT + 1);
});

test("Clear keeps a run still running, and its answer is drawn when it comes (#2501)", () => {
  const pane = new ConsolePanel(stub.newContext(), { viewType: "t", title: "t", input: false });
  const posted = [];
  pane.post = (m) => posted.push(m);
  const done = pane.add({ code: "1+1" });
  pane.update(done, { ok: true, lines: ["2"] });
  const running = pane.add({ code: "sleep 3" });
  posted.length = 0;
  pane.clear();
  assert.deepStrictEqual(pane.entries().map((e) => e.code), ["sleep 3"]);
  assert.deepStrictEqual(posted.map((m) => [m.type, m.entry?.id]), [["clear", undefined], ["add", running]]);
  pane.update(running, { ok: true, lines: ["done"] });
  assert.deepStrictEqual(posted.at(-1), { type: "update", entry: { id: running, code: "sleep 3", ok: true, lines: ["done"] } });
  pane.clear();
  assert.deepStrictEqual(pane.entries(), []);
});
