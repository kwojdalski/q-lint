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
/// `delay` ms (or what `delay()` gives then), then each message with what
/// `answer` gives for it (a value, sent as a response), or nothing when it
/// gives undefined.
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
        setTimeout(() => socket.writable && socket.write(Buffer.from([3])), typeof delay === "function" ? delay() : delay);
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

/// The explorer's call, told apart from a query by what it asks for.
const isGather = (message) => message.includes("`rows`spaces`more");

// Abort closes the connection and opens another, whose handshake q answers
// only once it has finished the query it was left with. That reconnect gave
// up at the connect timeout (10 s), with an error, and left the user
// disconnected from a process that was only busy.
test("a reconnect after Abort waits for a process busy past the connect timeout", async (t) => {
  const qclient = require("../out/qclient.js");
  const timeout = qclient.CONNECT_TIMEOUT_MS;
  qclient.CONNECT_TIMEOUT_MS = 200;
  t.after(() => (qclient.CONNECT_TIMEOUT_MS = timeout));
  let busyUntil = 0;
  const a = await fakeQ(
    (message) => {
      if (isGather(message)) return GATHERED;
      busyUntil = Date.now() + 900;
      return undefined;
    },
    () => Math.max(0, busyUntil - Date.now()),
  );
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)]);
  assert.strictEqual(await live.connectTo("a"), true);
  await sleep(50);
  const query = live.runOnActive("slow", (c) => c.call("slow")).catch((e) => e.message);
  await sleep(50);
  await live.abort();
  assert.match(await query, /closed/);
  for (let i = 0; i < 300 && live.activeLabel() === undefined; i++) await sleep(10);
  assert.strictEqual(live.activeLabel(), "a");
  assert.deepStrictEqual(stub.messages.filter(([level]) => level === "error"), []);
});

// Disconnect while a reconnect after Abort waits for the process: the
// reconnect went on, and connected once the process was free.
test("Disconnect stops a reconnect after Abort", async (t) => {
  let busyUntil = 0;
  const a = await fakeQ(
    (message) => {
      if (isGather(message)) return GATHERED;
      busyUntil = Date.now() + 500;
      return undefined;
    },
    () => Math.max(0, busyUntil - Date.now()),
  );
  t.after(() => a.close());
  const { live, events } = await setUp(t, [proc("a", a.port)]);
  assert.strictEqual(await live.connectTo("a"), true);
  await sleep(50);
  void live.runOnActive("slow", (c) => c.call("slow")).catch(() => {});
  await sleep(50);
  await live.abort();
  await sleep(100);
  await stub.commands.get("q-lint.disconnectProcess")();
  await sleep(800);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.strictEqual(events.filter((e) => e === "connected").length, 1);
});

// Add and Edit read the list before their input boxes and saved it back
// after them: a process saved meanwhile - Download Processes, an import, or
// another window, which shares the list - was lost, and a label taken
// meanwhile was saved twice.
test("Add and Edit Process keep what was saved while they asked", async (t) => {
  const { context, live } = await setUp(t, [proc("old", 1)]);
  const elsewhere = async (more) => context.globalState.update("q-lint.processes", [...live.processes(), ...more]);
  stub.inputs = ["new", "localhost", "5001", "", async () => (await elsewhere([proc("downloaded", 2)]), "")];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.addProcess")();
  assert.deepStrictEqual(live.processes().map((p) => p.label), ["old", "downloaded", "new"]);
  stub.inputs = ["renamed", "localhost", "5002", "", async () => (await elsewhere([proc("again", 3)]), "")];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.editProcess")("old");
  assert.deepStrictEqual(live.processes().map((p) => p.label), ["renamed", "downloaded", "new", "again"]);
  // A label taken while the boxes were open is not saved twice.
  stub.inputs = ["dup", "localhost", "5003", "", async () => (await elsewhere([proc("dup", 4)]), "")];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.addProcess")();
  assert.deepStrictEqual(live.processes().filter((p) => p.label === "dup").map((p) => p.port), [4]);
  assert.ok(stub.messages.some(([, text]) => /dup.*taken/.test(text)), JSON.stringify(stub.messages));
});

// The same for discovery servers: Add and Edit saved the list as it was
// before their input boxes.
test("Add and Edit Discovery Server keep what was saved while they asked", async (t) => {
  const { context, live } = await setUp(t, []);
  const url = `http://127.0.0.1:${await deadPort()}/`;
  await context.globalState.update("q-lint.discoveryServers", [{ label: "old", url }]);
  const elsewhere = async (label) =>
    context.globalState.update("q-lint.discoveryServers", [...live.discovery.servers(), { label, url }]);
  stub.inputs = ["new", url, async () => (await elsewhere("other"), "")];
  await stub.commands.get("q-lint.addDiscoveryServer")();
  assert.deepStrictEqual(live.discovery.servers().map((s) => s.label), ["old", "other", "new"]);
  stub.inputs = ["renamed", url, async () => (await elsewhere("third"), "")];
  await stub.commands.get("q-lint.editDiscoveryServer")("old");
  assert.deepStrictEqual(live.discovery.servers().map((s) => s.label), ["renamed", "other", "new", "third"]);
  stub.inputs = ["dup", url, async () => (await elsewhere("dup"), "")];
  await stub.commands.get("q-lint.addDiscoveryServer")();
  assert.strictEqual(live.discovery.servers().filter((s) => s.label === "dup").length, 1);
  assert.ok(stub.messages.some(([, text]) => /dup.*taken/.test(text)), JSON.stringify(stub.messages));
});

// Tag Process and Import on the connected process left the connection with
// its old tags: an agent's query on it, which warns for a production tag,
// asked without the warning after the process was tagged prod.
test("tagging or importing the connected process gives the connection its tags", async (t) => {
  const a = await fakeQ(() => GATHERED);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)]);
  assert.strictEqual(await live.connectTo("a"), true);
  stub.inputs = ["prod"];
  await stub.commands.get("q-lint.tagProcess")("a");
  assert.deepStrictEqual(live.activeProcess().tags, ["prod"]);
  const { confirmation } = require("../out/agent.js");
  assert.match(confirmation("1+1", live.activeProcess(), { connects: false }).message, /prod/i);
  const { vscode } = require("./vscode_stub.js");
  vscode.workspace.fs = { readFile: async () => Buffer.from(JSON.stringify([proc("a", a.port, { tags: ["uat"] })])) };
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/list.json"));
  assert.deepStrictEqual(live.activeProcess().tags, ["uat"]);
});
