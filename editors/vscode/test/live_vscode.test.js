// The VS Code around the process list, connections and the explorer (#901),
// driven by node through a stand-in `vscode` module (vscode_stub.js) and q
// processes played by socket servers. No q and no editor needed.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { serialize } = require("node-q/lib/c.js");
const { Live } = require("../out/live.js");
const { ProcessExplorer } = require("../out/explorerview.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A q process played by a socket server: it answers the handshake after
/// `delay` ms, then each message with what `answer` gives for it (a value,
/// sent as a response), or nothing when it gives undefined.
async function fakeQ(answer = () => null, delay = 0) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let shook = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        setTimeout(() => socket.writable && socket.write(Buffer.from([3])), delay);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= buffer.readUInt32LE(4)) {
        const message = buffer.subarray(0, buffer.readUInt32LE(4));
        buffer = buffer.subarray(message.length);
        const value = answer(message);
        if (value !== undefined) {
          const out = serialize(value);
          out.writeUInt8(2, 1);
          socket.write(out);
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    connections: () => sockets.size,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/// A port nothing listens on.
async function deadPort() {
  const s = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

const GATHERED = { rows: [{ ns: ".", name: "x", kind: "variable", type: -7, count: 1, cols: [], keys: [], params: [], partitioned: false }], spaces: [{ ns: ".", total: 1 }], more: 0 };

/// A Live and a ProcessExplorer over a fresh context holding `processes`.
async function setUp(t, processes) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const explorer = new ProcessExplorer(context, live);
  const events = [];
  live.onDidChange((what) => events.push(what));
  let treeChanges = 0;
  explorer.onDidChangeTreeData(() => treeChanges++);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { context, live, explorer, events, view: stub.trees.find((v) => v.id === "q-lint.processExplorer"), treeChanges: () => treeChanges };
}

const proc = (label, port, extra = {}) => ({ label, host: "127.0.0.1", port, tags: [], ...extra });

// Connect closes the connection there was before it opens the new one, and
// said nothing of it: when the new one failed, the explorer went on showing
// the old process's names, with the status bar saying not connected.
test("switching to a process that cannot be reached empties the explorer", async (t) => {
  const a = await fakeQ(() => GATHERED);
  t.after(() => a.close());
  const { live, explorer, events, treeChanges } = await setUp(t, [proc("a", a.port), proc("b", await deadPort())]);
  assert.strictEqual(await live.connectTo("a"), true);
  for (let i = 0; i < 50 && explorer.rows().length === 0; i++) await sleep(10);
  assert.strictEqual(explorer.rows().length, 1);
  const before = treeChanges();
  assert.strictEqual(await live.connectTo("b"), false);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.deepStrictEqual(events, ["connected", "disconnected"]);
  assert.ok(treeChanges() > before, "the explorer's tree was not told to redraw");
});

// Toggle wrote the user setting, and the workspace's, when it has one, wins
// over it: the toggle did nothing, every time.
test("Toggle Auto Refresh turns it over where it is set", async (t) => {
  const { view } = await setUp(t, []);
  const toggle = () => stub.commands.get("q-lint.toggleProcessExplorerAutoRefresh")();
  const effective = () => require("vscode").workspace.getConfiguration("q-lint").get("processExplorer.autoRefresh", false);
  await toggle();
  assert.deepStrictEqual([effective(), stub.updates.at(-1).target], [true, "user"]);
  stub.config.workspace["processExplorer.autoRefresh"] = false;
  await toggle();
  assert.deepStrictEqual([effective(), stub.updates.at(-1).target], [true, "workspace"]);
  assert.strictEqual(view.description, "auto refresh");
  await toggle();
  assert.strictEqual(effective(), false);
});
