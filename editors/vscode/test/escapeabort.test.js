// Escape aborts a running query (#1165): the context key a run sets and
// clears, driven through the stand-in `vscode` module against a socket
// server that answers late, and the keybinding that reads it.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize } = require("node-q/lib/c.js");
const { Live } = require("../out/live.js");
const { COMMANDS, QUERY_RUNNING } = require("../out/liveconfig.js");
const { EDITOR_SETTINGS } = require("../out/editorfeatures.js");
const pkg = require("../package.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A q process played by a socket server that answers each query after `ms`.
async function slowQ(ms) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    socket.on("data", () => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      setTimeout(() => {
        const out = serialize({ ok: true, type: -7, text: ["42"] });
        out.writeUInt8(2, 1);
        if (socket.writable) socket.write(out);
      }, ms);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}

test("Escape is bound to Abort in a q editor only while a query runs and the switch is on", () => {
  const binding = pkg.contributes.keybindings.find((k) => k.key === "escape");
  assert.strictEqual(binding.command, COMMANDS.abort);
  const when = binding.when.split(" && ");
  for (const clause of ["editorTextFocus", "editorLangId == q", QUERY_RUNNING, `config.q-lint.${EDITOR_SETTINGS.escapeAborts.key}`]) {
    assert.ok(when.includes(clause), clause);
  }
  // What Escape already does in an editor goes first.
  for (const clause of ["!suggestWidgetVisible", "!parameterHintsVisible", "!inSnippetMode", "!findWidgetVisible", "!editorHasSelection", "!notebookEditorFocused"]) {
    assert.ok(when.includes(clause), clause);
  }
  // And what it closes outside the text: a notification, the dirty diff, a
  // breakpoint's widget, a message, accessibility help, a rename (#1229).
  for (const clause of ["!notificationToastsVisible", "!notificationCenterVisible", "!dirtyDiffVisible", "!breakpointWidgetVisible", "!messageVisible", "!accessibilityHelpWidgetVisible", "!renameInputVisible"]) {
    assert.ok(when.includes(clause), clause);
  }
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.query.escapeAborts.enable"].default, true);
});

test("the running context key is set while a query runs, and cleared when it ends or is aborted", async (t) => {
  const q = await slowQ(400);
  stub.reset();
  const context = stub.newContext();
  const contexts = [];
  stub.commands.set("setContext", (key, value) => {
    if (key === QUERY_RUNNING) contexts.push(value);
  });
  await context.globalState.update("q-lint.processes", [{ label: "slow", host: "127.0.0.1", port: q.port, tags: [] }]);
  const live = new Live(context);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    q.close();
  });
  const current = () => contexts[contexts.length - 1];
  assert.strictEqual(await live.connectTo("slow"), true);
  assert.strictEqual(current(), false);
  const running = live.run("slow 1");
  await sleep(100);
  assert.strictEqual(current(), true);
  await running;
  assert.strictEqual(current(), false);
  // Aborted, it is cleared at once, before the process answers.
  const again = live.run("slow 1");
  await sleep(100);
  assert.strictEqual(current(), true);
  await stub.commands.get(COMMANDS.abort)();
  assert.strictEqual(current(), false);
  await again;
  assert.strictEqual(current(), false);
});
