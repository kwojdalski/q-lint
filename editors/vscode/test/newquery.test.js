// New Query for Process (#1002): an untitled q editor bound to the process
// picked, through the stand-in `vscode` module. The binding is checked with
// no q; a query from the editor reaching that process, while another is
// connected, and the read-only guard holding a write there, need a q, so
// those run only when QLINT_TEST_Q names one.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const { Live } = require("../out/live.js");
const { NEW_QUERY_COMMAND, NEW_QUERY_OFF, readNewQuery } = require("../out/newquery.js");
const { NewQuery } = require("../out/newqueryview.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-newquery-"));
  const script = path.join(dir, "server.q");
  fs.writeFileSync(script, `me:\`${port}\n`);
  const child = spawn(`${Q} ${script} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (up) return { port, stop };
    await sleep(100);
  }
  stop();
  throw new Error("q did not start listening");
}

const proc = (label, port, tags = []) => ({ label, host: "127.0.0.1", port, tags });

/// A Live and New Query over `processes`. Opening a document gives an
/// untitled one holding `text`, which showing makes the active editor.
async function setUp(t, processes, text = "") {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const newQuery = new NewQuery(context, live);
  const opened = [];
  let n = 0;
  vscode.workspace.openTextDocument = async (options) => {
    n += 1;
    const name = `Untitled-${n}`;
    const document = {
      uri: { scheme: "untitled", fsPath: name, toString: () => `untitled:${name}` },
      languageId: options.language,
      lineAt: () => ({ text }),
      getText: () => text,
    };
    opened.push({ options, document });
    return document;
  };
  vscode.window.showTextDocument = async (document) => {
    vscode.window.activeTextEditor = { document, selection: { active: { line: 0 }, isEmpty: true } };
    return vscode.window.activeTextEditor;
  };
  t.after(async () => {
    vscode.window.activeTextEditor = undefined;
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, newQuery, opened };
}

test("the command is on by default, contributed, and hidden while off", () => {
  assert.deepStrictEqual(readNewQuery((_k, f) => f), { enabled: true });
  assert.deepStrictEqual(readNewQuery(() => false), { enabled: false });
  assert.ok(pkg.contributes.commands.some((c) => c.command === NEW_QUERY_COMMAND && c.title === "New Query for Process" && c.category === "q-lint"));
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process connections");
  assert.strictEqual(section.properties["q-lint.processes.newQuery.enable"].default, true);
  const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === NEW_QUERY_COMMAND);
  assert.strictEqual(menus.length, 2);
  for (const m of menus) assert.match(m.when, /config\.q-lint\.processes\.newQuery\.enable/);
});

test("New Query for Process opens an untitled q editor bound to the process picked", async (t) => {
  const { live, opened } = await setUp(t, [proc("a", 1), proc("b", 2)]);
  // From the palette: picked.
  stub.picks.push("b");
  const result = await stub.commands.get(NEW_QUERY_COMMAND)();
  assert.strictEqual(result.label, "b");
  assert.deepStrictEqual(opened.map((o) => o.options), [{ language: "q", content: "" }]);
  assert.strictEqual(live.fileBinding(opened[0].document.uri), "b");
  // From a process row, by its label: nothing asked.
  await stub.commands.get(NEW_QUERY_COMMAND)("a");
  assert.strictEqual(live.fileBinding(opened[1].document.uri), "a");
  // The first editor keeps its own.
  assert.strictEqual(live.fileBinding(opened[0].document.uri), "b");
  // Escape at the pick: no editor.
  stub.picks.push(undefined);
  assert.strictEqual(await stub.commands.get(NEW_QUERY_COMMAND)(), undefined);
  assert.strictEqual(opened.length, 2);
});

test("turned off, the command refuses, opens nothing and binds nothing; on again, without a reload", async (t) => {
  const { opened } = await setUp(t, [proc("a", 1)]);
  stub.config.user["processes.newQuery.enable"] = false;
  stub.changeConfig("q-lint.processes.newQuery.enable");
  assert.strictEqual(await stub.commands.get(NEW_QUERY_COMMAND)("a"), undefined);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", NEW_QUERY_OFF]);
  assert.match(NEW_QUERY_OFF, /q-lint\.processes\.newQuery\.enable/);
  assert.strictEqual(opened.length, 0);
  stub.config.user["processes.newQuery.enable"] = true;
  stub.changeConfig("q-lint.processes.newQuery.enable");
  assert.strictEqual((await stub.commands.get(NEW_QUERY_COMMAND)("a")).label, "a");
  assert.strictEqual(opened.length, 1);
});

test("a query from the new editor goes to its process while another is connected (real q)", { skip }, async (t) => {
  const qa = await startQ(await freePort());
  const qb = await startQ(await freePort());
  t.after(() => (qa.stop(), qb.stop()));
  const { live } = await setUp(t, [proc("a", qa.port), proc("b", qb.port)], "me");
  assert.strictEqual(await live.connectTo("b"), true);
  await stub.commands.get(NEW_QUERY_COMMAND)("a");
  await stub.commands.get("q-lint.queryCurrentLine")();
  const [entry] = live.history();
  assert.strictEqual(entry.process, "a");
  assert.strictEqual(entry.outcome, "ok");
});

test("a write from the new editor to a guarded process is held for confirmation (real q)", { skip }, async (t) => {
  const qa = await startQ(await freePort());
  t.after(() => qa.stop());
  const { live } = await setUp(t, [proc("prod1", qa.port, ["prod"])], "x:1");
  await stub.commands.get(NEW_QUERY_COMMAND)("prod1");
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.queryCurrentLine")();
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && /would change prod1/.test(text)), JSON.stringify(stub.messages));
  assert.strictEqual(live.history().length, 0);
});
