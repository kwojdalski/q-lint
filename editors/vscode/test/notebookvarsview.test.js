// The Notebook Variables view (#946) under the vscode stand-in: what it
// reads from the notebook's process, and that q-lint.notebook.variables.enable
// off removes it and reads nothing. Run after `tsc`.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { registerNotebookVariables } = require("../out/notebookvarsview.js");

/// A stand-in Live connected to `label`, whose process answers the
/// variables lambda; `calls` counts what was sent.
function fakeLive(label) {
  const live = {
    calls: 0,
    activeLabel: () => label,
    onDidChange: () => ({ dispose() {} }),
    borrow: (use) =>
      use({
        call: async () => {
          live.calls++;
          return { names: ["t", "f"], types: [98, 100], counts: [3, 1], sizes: [138, null], total: 2 };
        },
      }),
  };
  return live;
}

function setup() {
  stub.reset();
  const notebook = { notebookType: "q-lint-notebook" };
  vscode.window.activeNotebookEditor = { notebook };
  const context = stub.newContext();
  const runs = [];
  const live = fakeLive("rdb");
  const api = registerNotebookVariables(context, live, () => "rdb", (l) => (runs.push(l), { dispose() {} }));
  return { api, live, runs, notebook };
}

test("the view lists the globals on the process the notebook ran on, after a cell runs", async () => {
  const { api, live, runs, notebook } = setup();
  runs[0](notebook);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(live.calls, 1);
  assert.deepStrictEqual(api.variables().map((v) => v.name), ["t", "f"]);
  assert.strictEqual(stub.trees.at(-1).description, "rdb");
  await stub.commands.get("q-lint.refreshNotebookVariables")();
  assert.strictEqual(live.calls, 2);
});

test("with q-lint.notebook.variables.enable off, the view is removed, Refresh refuses and nothing is read; on again, it is back", async () => {
  const { api, live } = setup();
  const view = stub.trees.at(-1);
  stub.config.user["notebook.variables.enable"] = false;
  stub.changeConfig("q-lint.notebook.variables.enable");
  assert.strictEqual(view.disposed, true);
  assert.strictEqual(api.registered(), false);
  await stub.commands.get("q-lint.refreshNotebookVariables")();
  assert.strictEqual(live.calls, 0);
  assert.match(stub.messages.at(-1)[1], /The Notebook Variables view is turned off: set q-lint\.notebook\.variables\.enable to true/);
  stub.config.user["notebook.variables.enable"] = true;
  stub.changeConfig("q-lint.notebook.variables.enable");
  assert.strictEqual(api.registered(), true);
  assert.notStrictEqual(stub.trees.at(-1), view);
});

test("off from the start, no view is created", () => {
  stub.reset();
  stub.config.user["notebook.variables.enable"] = false;
  const api = registerNotebookVariables(stub.newContext(), fakeLive("x"), () => undefined, () => ({ dispose() {} }));
  assert.strictEqual(stub.trees.length, 0);
  assert.strictEqual(api.registered(), false);
});

test("a refresh put off by a running query is made when the query is done (#1077)", async () => {
  stub.reset();
  const notebook = { notebookType: "q-lint-notebook" };
  vscode.window.activeNotebookEditor = { notebook };
  const live = fakeLive("rdb");
  const listeners = [];
  live.onDidChange = (l) => (listeners.push(l), { dispose() {} });
  const free = live.borrow;
  live.borrow = () => undefined; // a query is running
  const runs = [];
  const api = registerNotebookVariables(stub.newContext(), live, () => "rdb", (l) => (runs.push(l), { dispose() {} }));
  runs[0](notebook);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(api.message(), /refreshes when it is done/);
  assert.strictEqual(live.calls, 0);
  live.borrow = free;
  for (const l of listeners) l("queried");
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(live.calls, 1);
  assert.deepStrictEqual(api.variables().map((v) => v.name), ["t", "f"]);
  // A query with no refresh put off reads nothing more.
  for (const l of listeners) l("queried");
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(live.calls, 1);
});

test("q-lint.notebookActive follows the active editor with the view off, for Restart and Run All (#1402)", async () => {
  stub.reset();
  stub.config.user["notebook.variables.enable"] = false;
  const contexts = new Map();
  const execute = vscode.commands.executeCommand;
  const watch = vscode.window.onDidChangeActiveNotebookEditor;
  const listeners = [];
  vscode.commands.executeCommand = async (name, ...args) => (name === "setContext" ? void contexts.set(args[0], args[1]) : execute(name, ...args));
  vscode.window.onDidChangeActiveNotebookEditor = (l) => (listeners.push(l), { dispose() {} });
  try {
    vscode.window.activeNotebookEditor = { notebook: { notebookType: "q-lint-notebook" } };
    registerNotebookVariables(stub.newContext(), fakeLive("x"), () => undefined, () => ({ dispose() {} }));
    assert.strictEqual(contexts.get("q-lint.notebookActive"), true);
    vscode.window.activeNotebookEditor = undefined;
    for (const l of listeners) l(undefined);
    assert.strictEqual(contexts.get("q-lint.notebookActive"), false);
  } finally {
    vscode.commands.executeCommand = execute;
    vscode.window.onDidChangeActiveNotebookEditor = watch;
  }
});

/// A stand-in Live on rdb whose reads are held: `release[i](names)` answers
/// the i-th one.
function heldLive() {
  const live = fakeLive("rdb");
  live.release = [];
  live.borrow = (use) =>
    use({
      call: () =>
        new Promise((resolve) => {
          live.calls++;
          live.release.push((names) => resolve({ names, types: names.map(() => 98), counts: names.map(() => 3), sizes: names.map(() => 138), total: names.length }));
        }),
    });
  return live;
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test("a read that lands after another notebook became active is not shown under it, and what was asked for meanwhile is read (#1952)", async () => {
  stub.reset();
  const a = { notebookType: "q-lint-notebook" };
  const b = { notebookType: "q-lint-notebook" };
  vscode.window.activeNotebookEditor = { notebook: a };
  const editors = [];
  const watch = vscode.window.onDidChangeActiveNotebookEditor;
  vscode.window.onDidChangeActiveNotebookEditor = (l) => (editors.push(l), { dispose() {} });
  try {
    const live = heldLive();
    const runs = [];
    // A ran on rdb; B has run no cell.
    const api = registerNotebookVariables(stub.newContext(), live, (n) => (n === a ? "rdb" : undefined), (l) => (runs.push(l), { dispose() {} }));
    runs[0](a);
    await tick();
    assert.strictEqual(live.calls, 1);
    vscode.window.activeNotebookEditor = { notebook: b };
    for (const l of editors) l();
    await tick();
    live.release[0](["onlyInA"]);
    await tick();
    assert.deepStrictEqual(api.variables(), []);
    assert.match(api.message(), /Run a cell of this notebook/);
    // Back on A, a cell that finishes while its globals are being read is
    // read for when that read ends: its names are the view's.
    vscode.window.activeNotebookEditor = { notebook: a };
    for (const l of editors) l();
    await tick();
    assert.strictEqual(live.calls, 2);
    runs[0](a);
    runs[0](a);
    await tick();
    assert.strictEqual(live.calls, 2);
    live.release[1](["before"]);
    await tick();
    assert.strictEqual(live.calls, 3);
    live.release[2](["before", "after"]);
    await tick();
    assert.deepStrictEqual(api.variables().map((v) => v.name), ["before", "after"]);
    assert.strictEqual(live.calls, 3);
  } finally {
    vscode.window.onDidChangeActiveNotebookEditor = watch;
  }
});

test("connected again to the notebook's process, the view reads its globals without a cell run (#1953)", async () => {
  stub.reset();
  const notebook = { notebookType: "q-lint-notebook" };
  vscode.window.activeNotebookEditor = { notebook };
  let label = "rdb";
  const live = fakeLive("rdb");
  live.activeLabel = () => label;
  const listeners = [];
  live.onDidChange = (l) => (listeners.push(l), { dispose() {} });
  const runs = [];
  const api = registerNotebookVariables(stub.newContext(), live, () => "rdb", (l) => (runs.push(l), { dispose() {} }));
  runs[0](notebook);
  await tick();
  assert.deepStrictEqual(api.variables().map((v) => v.name), ["t", "f"]);
  label = undefined;
  for (const l of listeners) l("disconnected");
  await tick();
  assert.deepStrictEqual(api.variables(), []);
  assert.match(api.message(), /ran on rdb, which is not the active connection/);
  label = "rdb";
  for (const l of listeners) l("connected");
  await tick();
  assert.deepStrictEqual(api.variables().map((v) => v.name), ["t", "f"]);
  assert.strictEqual(api.message(), undefined);
  assert.strictEqual(live.calls, 2);
  // A switch to another process, which closes no connection first, says so too.
  label = "hdb";
  for (const l of listeners) l("connected");
  await tick();
  assert.deepStrictEqual(api.variables(), []);
  assert.match(api.message(), /ran on rdb, which is not the active connection/);
  // What changes nothing the view shows reads nothing.
  for (const l of listeners) l("edited");
  for (const l of listeners) l("queried");
  await tick();
  assert.strictEqual(live.calls, 2);
});
