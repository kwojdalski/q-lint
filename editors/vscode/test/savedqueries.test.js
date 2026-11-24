// Saved queries (#912): the list as data (savedqueries.ts), and the view,
// its commands and its documents through the stand-in `vscode`
// (vscode_stub.js) with a q process played by a socket server. No q and no
// editor needed; queries_q.test.js runs one on a real q.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize, deserialize } = require("node-q/lib/c.js");
const {
  SAVED_QUERIES_KEY,
  nameOfPath,
  nameProblem,
  parseSaved,
  readSavedQueries,
  renamed,
  savedPath,
  suggestedName,
  withQuery,
} = require("../out/savedqueries.js");

test("the setting is on by default, and only false turns it off", () => {
  assert.deepStrictEqual(readSavedQueries((k, f) => f), { enabled: true });
  assert.deepStrictEqual(readSavedQueries((k, f) => (k === "savedQueries.enable" ? false : f)), { enabled: false });
});

test("the list as stored: entries that are not queries dropped, a name taken twice kept once", () => {
  assert.deepStrictEqual(parseSaved(undefined), []);
  assert.deepStrictEqual(
    parseSaved([{ name: "a", code: "1" }, { name: "a", code: "2" }, { name: "", code: "x" }, { name: "b" }, null, 7, { name: "c", code: "3", extra: 1 }]),
    [{ name: "a", code: "1" }, { name: "c", code: "3" }],
  );
});

test("names: needed, one line, unique; a suggestion from the code's first line", () => {
  assert.strictEqual(nameProblem(" ", []), "A name is needed.");
  assert.strictEqual(nameProblem("a\nb", []), "One line.");
  assert.strictEqual(nameProblem(" a ", ["a"]), "A saved query already has that name.");
  assert.strictEqual(nameProblem("b", ["a"]), undefined);
  assert.strictEqual(suggestedName("  select from t\nwhere x"), "select from t");
  assert.strictEqual(suggestedName("x".repeat(50)), `${"x".repeat(37)}...`);
  // Cut by code point, never through an emoji (#1808).
  assert.strictEqual(suggestedName(`${"a".repeat(36)}😀 rest of the line`), `${"a".repeat(36)}😀...`);
});

test("adding, replacing and renaming keep the order", () => {
  const list = [{ name: "a", code: "1" }, { name: "b", code: "2" }];
  assert.deepStrictEqual(withQuery(list, { name: "c", code: "3" }).map((q) => q.name), ["a", "b", "c"]);
  assert.deepStrictEqual(withQuery(list, { name: "a", code: "9" }), [{ name: "a", code: "9" }, { name: "b", code: "2" }]);
  assert.deepStrictEqual(renamed(list, "a", "z").map((q) => q.name), ["z", "b"]);
});

test("a name maps to its document's path and back, whatever it holds", () => {
  for (const name of ["trades", "a/b", "50% ?x#", "ünï", "%2F", "a%25/b"]) {
    assert.strictEqual(nameOfPath(savedPath(name)), name, name);
  }
  // Only a `/` and the `%` escaping it are escaped: the tab reads as the name.
  assert.strictEqual(savedPath("a/b"), "/a%2Fb.q");
  assert.strictEqual(savedPath("px by sym"), "/px by sym.q");
  assert.strictEqual(nameOfPath("/"), undefined);
});

// --- the view and its commands

/// A q process played by a socket server, answering every query as `RUN`
/// does; `queries()` are the statements each query sent.
async function fakeQ() {
  const sent = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        sent.push(deserialize(message));
        const out = serialize({ ok: true, type: -7, text: ["1"] });
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    queries: () => sent.filter((m) => Array.isArray(m) && Array.isArray(m[1])).map((m) => m[1].join("\n")),
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

const { Live } = require("../out/live.js");
const { SavedQueries } = require("../out/savedqueriesview.js");

async function setUp(t, config = {}, tags = []) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const q = await fakeQ();
  const context = stub.newContext();
  // The workspace's storage, in memory.
  const state = new Map();
  context.workspaceState = { get: (k, d) => (state.has(k) ? structuredClone(state.get(k)) : d), update: async (k, v) => void state.set(k, structuredClone(v)), keys: () => [...state.keys()] };
  await context.globalState.update("q-lint.processes", [{ label: "rdb", host: "127.0.0.1", port: q.port, tags }]);
  const providers = [];
  const register = vscode.workspace.registerFileSystemProvider;
  vscode.workspace.registerFileSystemProvider = (scheme, provider) => {
    const entry = { scheme, provider, disposed: false };
    providers.push(entry);
    return { dispose: () => (entry.disposed = true) };
  };
  let opened;
  vscode.workspace.openTextDocument = async (uri) => ({ uri });
  vscode.window.showTextDocument = async (document) => (opened = document.uri);
  vscode.Uri.from = ({ scheme, path }) => ({ scheme, path, toString: () => `${scheme}:${path}` });
  const live = new Live(context);
  const saved = new SavedQueries(context, live);
  t.after(async () => {
    vscode.workspace.registerFileSystemProvider = register;
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  const editor = (text) => {
    vscode.window.activeTextEditor = {
      document: { uri: vscode.Uri.file("/w/a.q"), lineAt: () => ({ text }), getText: () => text },
      selection: { active: { line: 0 }, isEmpty: true },
    };
  };
  const view = () => stub.trees.filter((v) => v.id === "q-lint.savedQueries").at(-1);
  return { q, live, saved, context, editor, providers, view, opened: () => opened };
}

test("Save Query keeps the statement at the cursor as written, under a name asked for", async (t) => {
  const { saved, editor, context, view } = await setUp(t);
  assert.strictEqual(view().disposed, false);
  editor("select from t where sym={{s}}");
  let box;
  stub.inputs.push((o) => ((box = o), "by sym"));
  await stub.commands.get("q-lint.saveQuery")();
  assert.strictEqual(box.value, "select from t where sym={{s}}");
  assert.strictEqual(box.validateInput(""), "A name is needed.");
  assert.deepStrictEqual(saved.queries(), [{ name: "by sym", code: "select from t where sym={{s}}" }]);
  assert.deepStrictEqual(context.workspaceState.get(SAVED_QUERIES_KEY), saved.queries());
  // A name taken is refused in the box.
  stub.inputs.push((o) => ((box = o), undefined));
  await stub.commands.get("q-lint.saveQuery")();
  assert.strictEqual(box.validateInput("by sym"), "A saved query already has that name.");
  // From a Query History entry, its code; given a name, not asked.
  stub.inputs.push((o) => ((box = o), "counted"));
  await stub.commands.get("q-lint.saveQuery")({ process: "rdb", code: "count t", at: "", millis: 1, outcome: "ok" });
  assert.strictEqual(box.value, "count t");
  await stub.commands.get("q-lint.saveQuery")({ name: "given", code: "1+1" });
  assert.deepStrictEqual(saved.queries().map((q) => `${q.name}: ${q.code}`), ["by sym: select from t where sym={{s}}", "counted: count t", "given: 1+1"]);
  const item = view().options.treeDataProvider.getTreeItem(saved.queries()[0]);
  assert.strictEqual(item.contextValue, "savedQuery");
  assert.strictEqual(item.command.command, "q-lint.editSavedQuery");
});

test("Run Saved Query runs it on the active connection, asking for its placeholders", async (t) => {
  const { q, live } = await setUp(t);
  await stub.commands.get("q-lint.saveQuery")({ name: "s", code: "select from t where sym={{s}}" });
  assert.strictEqual(await live.connectTo("rdb"), true);
  stub.inputs.push("`a");
  await stub.commands.get("q-lint.runSavedQuery")({ name: "s", code: "ignored" });
  assert.deepStrictEqual(q.queries(), ["select from t where sym=`a"]);
  assert.strictEqual(live.history()[0].code, "select from t where sym=`a");
  // Picked when not given; Escape on a placeholder runs nothing.
  stub.picks.push("s");
  stub.inputs.push(undefined);
  await stub.commands.get("q-lint.runSavedQuery")();
  assert.strictEqual(q.queries().length, 1);
});

test("a saved query that would change a read-only process asks first (#918)", async (t) => {
  const { q, live } = await setUp(t, {}, ["prod"]);
  await stub.commands.get("q-lint.saveQuery")({ name: "w", code: "a:1" });
  await live.connectTo("rdb");
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.runSavedQuery")("w");
  assert.ok(stub.messages.some(([k, m]) => k === "warning" && m === "This code would change rdb. Run it anyway?"));
  assert.deepStrictEqual(q.queries(), []);
});

test("Edit Saved Query opens it as a q document; saving the document saves the query", async (t) => {
  const { saved, providers, opened } = await setUp(t);
  await stub.commands.get("q-lint.saveQuery")({ name: "a/b", code: "count t" });
  await stub.commands.get("q-lint.editSavedQuery")("a/b");
  assert.deepStrictEqual([opened().scheme, opened().path], ["q-lint-saved", "/a%2Fb.q"]);
  const [{ scheme, provider }] = providers;
  assert.strictEqual(scheme, "q-lint-saved");
  assert.strictEqual(Buffer.from(provider.readFile(opened())).toString(), "count t");
  const before = provider.stat(opened()).mtime;
  await new Promise((r) => setTimeout(r, 5));
  await provider.writeFile(opened(), Buffer.from("count trade"));
  assert.deepStrictEqual(saved.queries(), [{ name: "a/b", code: "count trade" }]);
  assert.ok(provider.stat(opened()).mtime > before);
  // A document of a query gone is not found, and not saved.
  assert.throws(() => provider.readFile({ path: "/gone.q" }));
  await assert.rejects(provider.writeFile({ path: "/gone.q" }, Buffer.from("x")));
  assert.deepStrictEqual(saved.queries().length, 1);
});

test("Rename and Delete Saved Query", async (t) => {
  const { saved } = await setUp(t);
  await stub.commands.get("q-lint.saveQuery")({ name: "a", code: "1" });
  await stub.commands.get("q-lint.saveQuery")({ name: "b", code: "2" });
  let box;
  stub.inputs.push((o) => ((box = o), "c"));
  await stub.commands.get("q-lint.renameSavedQuery")("a");
  assert.strictEqual(box.validateInput("b"), "A saved query already has that name.");
  assert.strictEqual(box.validateInput("a"), undefined);
  assert.deepStrictEqual(saved.queries().map((q) => q.name), ["c", "b"]);
  await stub.commands.get("q-lint.renameSavedQuery")("c", "d");
  assert.deepStrictEqual(saved.queries().map((q) => q.name), ["d", "b"]);
  // Delete asks; Escape keeps it.
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.deleteSavedQuery")("d");
  assert.strictEqual(saved.queries().length, 2);
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteSavedQuery")("d");
  assert.deepStrictEqual(saved.queries().map((q) => q.name), ["b"]);
});

test("Rename and Delete Saved Query take its scheduled exports with it (#1413)", async (t) => {
  const { context } = await setUp(t);
  const { SCHEDULES_KEY } = require("../out/schedule.js");
  await stub.commands.get("q-lint.saveQuery")({ name: "a", code: "count t" });
  await stub.commands.get("q-lint.saveQuery")({ name: "b", code: "count u" });
  const schedule = (id, query) => ({ id, query, process: "rdb", format: "csv", path: "/o.csv", every: 5, mode: "replace", since: 0 });
  await context.workspaceState.update(SCHEDULES_KEY, [schedule("1", "a"), schedule("2", "b")]);
  await stub.commands.get("q-lint.renameSavedQuery")("a", "c");
  assert.deepStrictEqual(context.workspaceState.get(SCHEDULES_KEY).map((s) => s.query), ["c", "b"]);
  // Delete says so, and the schedule goes with the query.
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteSavedQuery")("c");
  assert.ok(stub.messages.some(([, m]) => /Delete the saved query "c"\? Its 1 scheduled export\(s\) are deleted with it\./.test(m)));
  assert.deepStrictEqual(context.workspaceState.get(SCHEDULES_KEY).map((s) => s.id), ["2"]);
});

test("Rename and Delete Saved Query take its dashboard tiles with it (#1616)", async (t) => {
  const { context } = await setUp(t);
  const { DASHBOARDS_KEY } = require("../out/dashboard.js");
  await stub.commands.get("q-lint.saveQuery")({ name: "vwap", code: "count t" });
  await stub.commands.get("q-lint.saveQuery")({ name: "b", code: "count u" });
  const tile = (id, query) => ({ id, query, process: "rdb", view: "table", refresh: 0 });
  await context.workspaceState.update(DASHBOARDS_KEY, [{ name: "Desk", columns: 2, tiles: [tile("1", "vwap"), tile("2", "b"), tile("3", "vwap")] }]);
  await stub.commands.get("q-lint.renameSavedQuery")("vwap", "vwap daily");
  assert.deepStrictEqual(context.workspaceState.get(DASHBOARDS_KEY)[0].tiles.map((x) => x.query), ["vwap daily", "b", "vwap daily"]);
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteSavedQuery")("vwap daily");
  assert.ok(stub.messages.some(([, m]) => /Its 2 dashboard tile\(s\) are removed with it\./.test(m)));
  assert.deepStrictEqual(context.workspaceState.get(DASHBOARDS_KEY)[0].tiles.map((x) => x.id), ["2"]);
});

test("turned off, the view and its documents are gone, the commands refuse and send nothing; on again, they are back", async (t) => {
  const { q, live, saved, providers, view } = await setUp(t);
  await stub.commands.get("q-lint.saveQuery")({ name: "a", code: "count t" });
  await live.connectTo("rdb");
  stub.config.user["savedQueries.enable"] = false;
  stub.changeConfig("q-lint.savedQueries.enable");
  assert.strictEqual(view().disposed, true);
  assert.strictEqual(providers[0].disposed, true);
  stub.messages = [];
  for (const command of ["saveQuery", "runSavedQuery", "editSavedQuery", "renameSavedQuery", "deleteSavedQuery"]) {
    await stub.commands.get(`q-lint.${command}`)("a");
  }
  assert.deepStrictEqual(
    stub.messages,
    Array(5).fill(["info", "q-lint: Saved queries are turned off. Set q-lint.savedQueries.enable to true to turn them on."]),
  );
  assert.deepStrictEqual(q.queries(), []);
  await assert.rejects(providers[0].provider.writeFile({ path: "/a.q" }, Buffer.from("x")));
  // The queries are kept.
  assert.strictEqual(saved.queries().length, 1);
  stub.config.user["savedQueries.enable"] = true;
  stub.changeConfig("q-lint.savedQueries.enable");
  assert.strictEqual(view().disposed, false);
  assert.strictEqual(providers.at(-1).disposed, false);
  await stub.commands.get("q-lint.runSavedQuery")("a");
  assert.deepStrictEqual(q.queries(), ["count t"]);
});
