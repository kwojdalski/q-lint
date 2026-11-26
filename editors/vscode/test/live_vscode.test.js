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

// A connect elsewhere after Abort waited for the abandoned reconnect's
// handshake to run out - up to the connect timeout, 10 s (#1510).
test("a connect elsewhere after Abort does not wait for the abandoned reconnect", async (t) => {
  let busyUntil = 0;
  const a = await fakeQ(
    (message) => {
      if (isGather(message)) return GATHERED;
      busyUntil = Date.now() + 3000;
      return undefined;
    },
    () => Math.max(0, busyUntil - Date.now()),
  );
  t.after(() => a.close());
  const b = await fakeQ(() => GATHERED);
  t.after(() => b.close());
  const { live } = await setUp(t, [proc("a", a.port), proc("b", b.port)]);
  assert.strictEqual(await live.connectTo("a"), true);
  await sleep(50);
  void live.runOnActive("slow", (c) => c.call("slow")).catch(() => {});
  await sleep(50);
  await live.abort();
  await sleep(100);
  const started = Date.now();
  assert.strictEqual(await live.connectTo("b"), true);
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
  assert.strictEqual(live.activeLabel(), "b");
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

// A process saved before 0.37 with a host 0.37 refuses was not read, so
// any save wrote the list without it: its tags, connect script and tunnel
// were gone, and its password left for the next process of its label (#1881).
test("a saved process whose host is none is shown, kept by a save, and edited to one", async (t) => {
  const { context, live } = await setUp(t, [
    { label: "prod-rdb", host: "rdb.example.com:5000", port: 5000, user: "svc", tags: ["prod"], init: "x:1", ssh: "bastion" },
    proc("dev", 5001),
  ]);
  context.secrets.all.set("q-lint.password.prod-rdb", "its own");
  const tree = stub.trees.find((v) => v.id === "q-lint.processes").options.treeDataProvider;
  const row = () => tree.getTreeItem({ kind: "process", process: live.processes().find((p) => p.label === "prod-rdb") });
  assert.strictEqual(row().description, "[rdb.example.com:5000]:5000 - not a host");
  stub.inputs = ["uat", "localhost", "5002", "", ""];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.addProcess")();
  assert.deepStrictEqual(context.globalState.get("q-lint.processes").map((p) => p.label), ["prod-rdb", "dev", "uat"]);
  // Edited to a host: the rest of it is kept, and the password, given for
  // what was never one, asked for again.
  stub.inputs = ["prod-rdb", "rdb.example.com", "5000", "svc", "", "prod"];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.editProcess")("prod-rdb");
  assert.deepStrictEqual(live.processes()[0], { label: "prod-rdb", host: "rdb.example.com", port: 5000, user: "svc", tags: ["prod"], init: "x:1", ssh: "bastion" });
  assert.strictEqual(row().description, "rdb.example.com:5000");
  assert.strictEqual(context.secrets.all.has("q-lint.password.prod-rdb"), false);
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
  // Taking away a guarded tag is asked first (#1269).
  stub.picks.push("Import as Written");
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/list.json"));
  assert.deepStrictEqual(live.activeProcess().tags, ["uat"]);
});

// A discovered process's password was kept after its server was deleted or
// pointed at another URL: a new server of the same label listing a process
// of the same label - at another host - was sent it without asking.
test("deleting a discovery server, or changing its URL, forgets its processes' passwords", async (t) => {
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ label: "rdb", host: "h", port: 1, user: "u" }, { label: "hdb", host: "h", port: 2 }]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { context } = await setUp(t, []);
  const secrets = context.secrets.all;
  await stub.commands.get("q-lint.addDiscoveryServer")({ label: "desk", url });
  secrets.set("q-lint.discoveredPassword.desk/rdb", "pw");
  stub.picks = ["Delete"];
  await stub.commands.get("q-lint.deleteDiscoveryServer")("desk");
  assert.strictEqual(secrets.has("q-lint.discoveredPassword.desk/rdb"), false);
  await stub.commands.get("q-lint.addDiscoveryServer")({ label: "desk", url });
  secrets.set("q-lint.discoveredPassword.desk/rdb", "pw");
  await stub.commands.get("q-lint.editDiscoveryServer")("desk", { url: `${url}?other` });
  assert.strictEqual(secrets.has("q-lint.discoveredPassword.desk/rdb"), false);
  // A change that keeps the URL keeps them.
  secrets.set("q-lint.discoveredPassword.desk/rdb", "pw");
  await stub.commands.get("q-lint.editDiscoveryServer")("desk", { secret: "Bearer x" });
  assert.strictEqual(secrets.get("q-lint.discoveredPassword.desk/rdb"), "pw");
});

// Escape on the new auth header, after Change it, saved the new label and
// URL as if Keep had been picked, and forgot the processes' passwords.
test("Escape on Edit Discovery Server's new auth header changes nothing (#1780)", async (t) => {
  const { context, live } = await setUp(t, []);
  const url = `http://127.0.0.1:${await deadPort()}/`;
  await context.globalState.update("q-lint.discoveryServers", [{ label: "desk", url }]);
  const secrets = context.secrets.all;
  secrets.set("q-lint.discovery.auth.desk", "Bearer old");
  secrets.set("q-lint.discoveredPassword.desk/rdb", "pw");
  stub.inputs = ["desk2", `${url}b`, undefined];
  stub.picks = ["Change it"];
  await stub.commands.get("q-lint.editDiscoveryServer")("desk");
  assert.deepStrictEqual(live.discovery.servers(), [{ label: "desk", url }]);
  assert.strictEqual(secrets.get("q-lint.discovery.auth.desk"), "Bearer old");
  assert.strictEqual(secrets.get("q-lint.discoveredPassword.desk/rdb"), "pw");
});

// A discovery server that lists a process elsewhere kept its password, and
// the next connect sent it there unasked - after a reload too (#1503).
test("a discovered process listed at another host or port forgets its password, after a reload too", async (t) => {
  const http = require("node:http");
  const q = await fakeQ(() => GATHERED);
  t.after(() => q.close());
  let port = q.port;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ label: "rdb", host: "127.0.0.1", port, user: "u" }, { label: "hdb", host: "127.0.0.1", port: q.port, user: "u" }]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { context, live } = await setUp(t, []);
  const secrets = context.secrets.all;
  await stub.commands.get("q-lint.addDiscoveryServer")({ label: "desk", url: `http://127.0.0.1:${server.address().port}/` });
  for (const l of ["rdb", "hdb"]) {
    stub.inputs.push(() => "pw");
    assert.strictEqual(await live.connectTo(`desk/${l}`), true);
  }
  // Listed at another port: rdb's password is forgotten, hdb's kept.
  port = q.port + 1;
  await stub.commands.get("q-lint.reloadDiscoveryServer")("desk");
  assert.strictEqual(secrets.has("q-lint.discoveredPassword.desk/rdb"), false);
  assert.strictEqual(secrets.get("q-lint.discoveredPassword.desk/hdb"), "pw");
  // Back where it was, a password given, then a reload: nothing is in
  // memory of where it was, and a move still forgets it.
  port = q.port;
  await stub.commands.get("q-lint.reloadDiscoveryServer")("desk");
  stub.inputs.push(() => "pw");
  assert.strictEqual(await live.connectTo("desk/rdb"), true);
  await stub.commands.get("q-lint.disconnectProcess")();
  for (const d of context.subscriptions.splice(0)) d.dispose?.();
  port = q.port + 1;
  const again = new Live(context);
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
  });
  await stub.commands.get("q-lint.reloadDiscoveryServer")("desk");
  assert.strictEqual(secrets.has("q-lint.discoveredPassword.desk/rdb"), false);
  assert.strictEqual(secrets.get("q-lint.discoveredPassword.desk/hdb"), "pw");
  void again;
});

// Deleting a server, or removing its processes, left the connection to one
// of them open, and reconnected to it after a drop (#2565).
test("deleting a discovery server, or removing its processes, disconnects from its process", async (t) => {
  const http = require("node:http");
  const q = await fakeQ(() => GATHERED);
  t.after(() => q.close());
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ label: "A", host: "127.0.0.1", port: q.port }]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { live } = await setUp(t, []);
  const url = `http://127.0.0.1:${server.address().port}/`;
  await stub.commands.get("q-lint.addDiscoveryServer")({ label: "srv", url });
  assert.strictEqual(await live.connectTo("srv/A"), true);
  await stub.commands.get("q-lint.removeDiscoveredProcesses")("srv");
  assert.strictEqual(live.activeLabel(), undefined);
  await stub.commands.get("q-lint.reloadDiscoveryServer")("srv");
  assert.strictEqual(await live.connectTo("srv/A"), true);
  stub.picks.push("Delete");
  await stub.commands.get("q-lint.deleteDiscoveryServer")("srv");
  assert.deepStrictEqual(live.discovery.servers(), []);
  assert.strictEqual(live.activeLabel(), undefined);
});

// Before 0.37 nothing was kept of where a discovered process's password was
// given. The first listing after the upgrade was taken as that place, so a
// process moved while VS Code was closed was sent the password (#1878).
test("a discovered process's password kept with no record of where it was given is forgotten at the first listing", async (t) => {
  const http = require("node:http");
  const listed = [{ label: "rdb", host: "10.0.0.9", port: 6001, user: "u" }, { label: "hdb", host: "10.0.0.9", port: 6002, user: "u" }];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listed));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  stub.reset();
  const context = stub.newContext();
  const secrets = context.secrets.all;
  // As 0.36 left it: passwords given for rdb, hdb and one not listed now,
  // and of where, only what a later version kept for hdb.
  await context.globalState.update("q-lint.discoveryServers", [{ label: "desk", url: `http://127.0.0.1:${server.address().port}/` }]);
  await context.globalState.update("q-lint.discoveredPasswords", { desk: ["rdb", "hdb", "gone"] });
  await context.globalState.update("q-lint.discoveredSeen", { desk: [{ label: "hdb", host: "10.0.0.9", port: 6002, tags: [], user: "u" }] });
  for (const l of ["rdb", "hdb", "gone"]) secrets.set(`q-lint.discoveredPassword.desk/${l}`, "pw");
  const live = new Live(context);
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
  });
  await stub.commands.get("q-lint.reloadDiscoveryServer")("desk");
  assert.deepStrictEqual([...secrets.keys()].sort(), ["q-lint.discoveredPassword.desk/gone", "q-lint.discoveredPassword.desk/hdb"]);
  assert.deepStrictEqual(context.globalState.get("q-lint.discoveredPasswords"), { desk: ["hdb", "gone"] });
  assert.deepStrictEqual(context.globalState.get("q-lint.discoveredSeen").desk.map((p) => p.label), ["hdb"]);
  // The one not listed then is forgotten when it is listed again, wherever.
  listed.push({ label: "gone", host: "10.0.0.9", port: 6003, user: "u" });
  await stub.commands.get("q-lint.reloadDiscoveryServer")("desk");
  assert.deepStrictEqual([...secrets.keys()], ["q-lint.discoveredPassword.desk/hdb"]);
  assert.deepStrictEqual(context.globalState.get("q-lint.discoveredPasswords"), { desk: ["hdb"] });
  void live;
});

// Up to 0.26 a discovered process's password was kept under the key a saved
// process of that label has, and nothing took it away since: a process
// saved as `desk/rdb` afterwards, with no password, connected with it (#1887).
test("a process new to the saved list starts with no password but the one given with it", async (t) => {
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ label: "hdb", host: "10.0.0.9", port: 6002, user: "u" }, { label: "tp", host: "10.0.0.9", port: 6003, user: "u" }]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { context, live } = await setUp(t, [proc("old", 1, { user: "me" })]);
  const secrets = context.secrets.all;
  const stale = ["desk/rdb", "renamed", "imported", "hdb", "tp", "bulk"];
  const left = () => stale.filter((l) => secrets.has(`q-lint.password.${l}`));
  for (const l of stale) secrets.set(`q-lint.password.${l}`, "another's");
  secrets.set("q-lint.password.old", "its own");
  // Added with no password: what was under its key is not sent for it.
  stub.inputs = ["desk/rdb", "localhost", "5001", "me", "", ""];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.addProcess")();
  assert.deepStrictEqual(left(), ["renamed", "imported", "hdb", "tp", "bulk"]);
  // Renamed with no password: its own goes with it, over what was there.
  stub.inputs = ["renamed", "127.0.0.1", "1", "me", "", ""];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.editProcess")("old");
  assert.strictEqual(secrets.get("q-lint.password.renamed"), "its own");
  // Renamed to another host, its own is forgotten (#1109), and none is left.
  secrets.set("q-lint.password.old", "another's");
  stub.inputs = ["old", "elsewhere", "1", "me", "", ""];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.editProcess")("renamed");
  assert.deepStrictEqual([secrets.has("q-lint.password.old"), secrets.has("q-lint.password.renamed")], [false, false]);
  // Imported, which brings no password.
  const { vscode } = require("./vscode_stub.js");
  const fs = vscode.workspace.fs;
  t.after(() => (vscode.workspace.fs = fs));
  vscode.workspace.fs = { readFile: async () => Buffer.from(JSON.stringify([proc("imported", 2, { user: "me" }), proc("desk/rdb", 5001, { user: "me" })])) };
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/x.json"));
  assert.deepStrictEqual(left(), ["hdb", "tp", "bulk"]);
  // Downloaded: the one given for it as a discovered process, or none.
  await stub.commands.get("q-lint.addDiscoveryServer")({ label: "desk", url: `http://127.0.0.1:${server.address().port}/` });
  secrets.set("q-lint.discoveredPassword.desk/hdb", "given");
  await stub.commands.get("q-lint.downloadDiscoveredProcesses")("desk");
  assert.strictEqual(secrets.get("q-lint.password.hdb"), "given");
  assert.deepStrictEqual(left(), ["hdb", "bulk"]);
  // Saved by a view around this one.
  await live.saveProcesses([...live.processes(), proc("bulk", 3, { user: "me" })]);
  assert.deepStrictEqual(left(), ["hdb"]);
  // And one given at Add is kept.
  stub.inputs = ["added", "localhost", "5004", "me", "given", ""];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.addProcess")();
  assert.strictEqual(secrets.get("q-lint.password.added"), "given");
  assert.deepStrictEqual(live.processes().map((p) => p.label), ["old", "desk/rdb", "imported", "hdb", "tp", "bulk", "added"]);
});

// A discovery server labelled `.qlint`, as could be up to 0.28, was not
// read: gone from the view unsaid, its auth header left in secret storage,
// and the next change of the servers wrote the list without it (#1889).
test("a discovery server with the shared list's label is given another at activation, and said", async (t) => {
  stub.reset();
  stub.config.user["discovery.refreshInterval"] = 0;
  const context = stub.newContext();
  const secrets = context.secrets.all;
  await context.globalState.update("q-lint.discoveryServers", [{ label: ".qlint", url: "http://127.0.0.1:9/" }, { label: "desk", url: "http://127.0.0.1:9/d" }]);
  await context.globalState.update("q-lint.discoveredPasswords", { ".qlint": ["rdb"], desk: ["hdb"] });
  secrets.set("q-lint.discovery.auth..qlint", "Bearer t");
  secrets.set("q-lint.discoveredPassword..qlint/rdb", "pw");
  secrets.set("q-lint.discoveredPassword.desk/hdb", "pw");
  const live = new Live(context);
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
  });
  for (let i = 0; i < 50 && stub.messages.length === 0; i++) await sleep(10);
  assert.deepStrictEqual(live.discovery.servers().map((s) => s.label), [".qlint server", "desk"]);
  assert.deepStrictEqual(context.globalState.get("q-lint.discoveryServers")[0], { label: ".qlint server", url: "http://127.0.0.1:9/" });
  // Its auth header goes with it, to the URL it was given for; the passwords
  // given for its processes are forgotten, as when a server is renamed.
  assert.deepStrictEqual([...secrets.keys()].sort(), ["q-lint.discoveredPassword.desk/hdb", "q-lint.discovery.auth..qlint server"]);
  assert.deepStrictEqual(context.globalState.get("q-lint.discoveredPasswords"), { desk: ["hdb"] });
  assert.deepStrictEqual(stub.messages, [["info", 'q-lint: the discovery server ".qlint" is now ".qlint server": .qlint names the workspace\'s shared process list. The passwords given for its processes are asked for again.']]);
});

// Any failed connect forgot the password just given - a host down or
// restarting as well as a refused one (#1511).
test("a discovered process's password is forgotten when it is refused, not when the host is down", async (t) => {
  const http = require("node:http");
  const down = await deadPort();
  // Closes the socket on the handshake, as q refuses a user.
  const refusing = net.createServer((s) => s.on("data", () => s.destroy()));
  await new Promise((r) => refusing.listen(0, "127.0.0.1", r));
  t.after(() => refusing.close());
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ label: "down", host: "127.0.0.1", port: down, user: "u" }, { label: "refused", host: "127.0.0.1", port: refusing.address().port, user: "u" }]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { context, live } = await setUp(t, []);
  await stub.commands.get("q-lint.addDiscoveryServer")({ label: "desk", url: `http://127.0.0.1:${server.address().port}/` });
  for (const l of ["down", "refused"]) {
    stub.inputs.push(() => "pw");
    assert.strictEqual(await live.connectTo(`desk/${l}`), false);
  }
  assert.strictEqual(context.secrets.all.get("q-lint.discoveredPassword.desk/down"), "pw");
  assert.strictEqual(context.secrets.all.has("q-lint.discoveredPassword.desk/refused"), false);
});

// A click on the connected row ran Connect again, which closed the
// connection and dropped the query running on it as aborted (#1506).
test("clicking the connected process's row does not reconnect", async (t) => {
  const a = await fakeQ(() => GATHERED);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port), proc("b", a.port)]);
  assert.strictEqual(await live.connectTo("a"), true);
  const tree = stub.trees.find((v) => v.id === "q-lint.processes").options.treeDataProvider;
  const items = tree.getChildren().map((r) => tree.getTreeItem(r));
  assert.deepStrictEqual(items.map((i) => [i.label, i.command?.command]), [["a", undefined], ["b", "q-lint.connectProcess"]]);
});

// Delete during a connect disconnected only a process already connected:
// the connect went on, and the deleted process became the active one (#1519).
test("deleting a process while it is being connected to stops the connect", async (t) => {
  const a = await fakeQ(() => GATHERED, 300);
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port)]);
  const connecting = live.connectTo("a");
  await sleep(50);
  stub.picks = ["Delete"];
  await stub.commands.get("q-lint.deleteProcess")("a");
  assert.strictEqual(await connecting, false);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.deepStrictEqual(live.processes(), []);
});

// A file Export cannot write (a read-only folder, a full disk) rejected the
// command: VS Code said only that running it failed.
test("Export Processes says why it could not write the file", async (t) => {
  const { vscode } = require("./vscode_stub.js");
  await setUp(t, [proc("a", 1)]);
  vscode.window.showSaveDialog = async () => vscode.Uri.file("/ro/q-processes.json");
  vscode.workspace.fs = { writeFile: async () => { throw new Error("EACCES: permission denied, open '/ro/q-processes.json'"); } };
  await stub.commands.get("q-lint.exportProcesses")();
  assert.deepStrictEqual(stub.messages.at(-1), ["error", "q-lint: could not write /ro/q-processes.json: EACCES: permission denied, open '/ro/q-processes.json'"]);
});

// Edit a server's auth header while a fetch with the old one is out: the
// Edit's fetch was taken for that one, as its URL was the same, so the
// server went on showing the old header's 401 until the next refresh.
test("changing a server's auth header during a fetch fetches again with it", async (t) => {
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      if (req.headers.authorization !== "Bearer good") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ label: "rdb", host: "h", port: 1 }]));
    }, 300);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { live } = await setUp(t, []);
  const added = stub.commands.get("q-lint.addDiscoveryServer")({ label: "desk", url, secret: "Bearer bad" });
  await sleep(100);
  await stub.commands.get("q-lint.editDiscoveryServer")("desk", { secret: "Bearer good" });
  await added;
  const [state] = live.api().discovered();
  assert.deepStrictEqual([state.error, state.processes.map((p) => p.label)], [undefined, ["rdb"]]);
});

// Edit Process with the password left empty kept the stored one even when
// the user, host or port changed: bob was sent alice's password, or it went
// to another host.
test("Edit Process forgets the password when the user, host or port change (#1109)", async (t) => {
  const { context, live } = await setUp(t, [proc("a", 1, { user: "alice" })]);
  const secrets = context.secrets.all;
  const edit = async (label, host, port, user) => {
    stub.inputs = [label, host, port, user, "", ""];
    stub.picks = ["No"];
    await stub.commands.get("q-lint.editProcess")(live.processes()[0].label);
  };
  // The same user and address keep it, under a new label too.
  secrets.set("q-lint.password.a", "pw");
  await edit("a", "127.0.0.1", "1", "alice");
  assert.strictEqual(secrets.get("q-lint.password.a"), "pw");
  await edit("a2", "127.0.0.1", "1", "alice");
  assert.deepStrictEqual([...secrets], [["q-lint.password.a2", "pw"]]);
  await edit("a2", "127.0.0.1", "1", "bob");
  assert.deepStrictEqual([...secrets], []);
  secrets.set("q-lint.password.a2", "pw");
  await edit("a3", "elsewhere", "1", "bob");
  assert.deepStrictEqual([...secrets], []);
  secrets.set("q-lint.password.a3", "pw");
  await edit("a3", "elsewhere", "2", "bob");
  assert.deepStrictEqual([...secrets], []);
});

// runApart (Query a Tag, dashboards, scheduled queries) opened the process's
// internal address directly, past its SSH tunnel, and even with tunnels
// turned off, where a connect refuses.
test("a query apart goes through the process's SSH tunnel, and refuses when tunnels are off (#1070)", async (t) => {
  let reached = 0;
  const a = await fakeQ(() => (reached++, 1));
  t.after(() => a.close());
  const { live } = await setUp(t, [proc("a", a.port, { ssh: "bastion" })]);
  stub.config.user["connection.sshTunnel.enable"] = false;
  await assert.rejects(live.runApart(live.processes()[0], "1"), /SSH tunnels are turned off/);
  assert.strictEqual(reached, 0);
});

// A tunnel set, changed or cleared reaches another q at host:port: the
// password stored for the old way was sent there at the next connect (#2371).
test("Set SSH Tunnel forgets the stored password when the way changes, and keeps it when it does not (#2371)", async (t) => {
  const { context, live } = await setUp(t, [proc("rdb", 5010, { user: "bob" })]);
  const secrets = context.secrets.all;
  secrets.set("q-lint.password.rdb", "s3cret");
  await stub.commands.get("q-lint.setSshTunnel")("rdb", "me@bastion");
  assert.strictEqual(live.processes()[0].ssh, "me@bastion");
  assert.strictEqual(secrets.has("q-lint.password.rdb"), false);
  secrets.set("q-lint.password.rdb", "s3cret");
  await stub.commands.get("q-lint.setSshTunnel")("rdb", "me@bastion");
  assert.strictEqual(secrets.get("q-lint.password.rdb"), "s3cret");
  await stub.commands.get("q-lint.setSshTunnel")("rdb", null);
  assert.strictEqual(live.processes()[0].ssh, undefined);
  assert.strictEqual(secrets.has("q-lint.password.rdb"), false);
});

// Disconnect while a connect waits for the handshake: the connect went on,
// and the process - perhaps a production one - became the active one.
test("Disconnect during a connect stops it (#1073)", async (t) => {
  const a = await fakeQ(() => GATHERED, 300);
  t.after(() => a.close());
  const { live, events } = await setUp(t, [proc("a", a.port)]);
  const connecting = live.connectTo("a");
  await sleep(50);
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.strictEqual(await connecting, false);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.strictEqual(events.filter((e) => e === "connected").length, 0);
  for (let i = 0; i < 50 && a.connections() > 0; i++) await sleep(10);
  assert.strictEqual(a.connections(), 0);
  assert.deepStrictEqual(stub.messages.filter(([level]) => level === "error"), []);
  // A connect after it is not stopped.
  assert.strictEqual(await live.connectTo("a"), true);
});

// A drill-down, wrangle or cell edit on a discovered or shared process (a
// label `server/label`) that was not the active one found no process for the
// production question, and went to it unasked (#1425).
test("a query on a discovered production process asks before it connects (#1425)", async () => {
  stub.reset();
  const prod = { label: "desk/rdb", host: "h", port: 1, tags: ["prod"] };
  const did = [];
  const self = {
    processes: () => [],
    active: undefined,
    named: (label) => (label === prod.label ? prod : undefined),
    activeLabel: () => undefined,
    connection: undefined,
    connectTo: async (label) => (did.push(`connect ${label}`), true),
    run: async (code) => void did.push(`run ${code}`),
  };
  stub.picks.push(undefined);
  await Live.prototype.runOnProcess.call(self, "select from t", "desk/rdb");
  assert.match(stub.messages.at(-1)?.[1] ?? "", /desk\/rdb is a production process/);
  assert.deepStrictEqual(did, []);
});

// Edit Process on the connected process, its label kept, fired nothing: the
// environment colour went on showing the tag it had (#1460).
test("editing the connected process's tags says so, and it takes them", async (t) => {
  const a = await fakeQ();
  t.after(() => a.close());
  const { live, events } = await setUp(t, [proc("a", a.port, { tags: ["prod"] })]);
  assert.strictEqual(await live.connectTo("a"), true);
  events.length = 0;
  stub.inputs = ["a", "127.0.0.1", String(a.port), "", "dev"];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.editProcess")("a");
  assert.deepStrictEqual(live.activeProcess().tags, ["dev"]);
  assert.deepStrictEqual(events, ["edited"]);
  // Saved again as it is: nothing to redraw.
  stub.inputs = ["a", "127.0.0.1", String(a.port), "", "dev"];
  stub.picks = ["No"];
  await stub.commands.get("q-lint.editProcess")("a");
  assert.deepStrictEqual(events, ["edited"]);
});
