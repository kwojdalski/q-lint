// The workspace's shared process list (#955): how `.qlint/processes.json`
// is read (secrets dropped, code only when trusted) and written, and the
// list in the Processes view through the stand-in `vscode` module: watched,
// connected to, and turned off. Against a real q process when QLINT_TEST_Q
// names one; otherwise against a socket server that answers the handshake.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const pkg = require("../package.json");
const { SHARED_COMMANDS, SHARED_FILE, readShared, readSharedFile, withShared } = require("../out/shared.js");
const { children, serverLabelProblem } = require("../out/discovery.js");
const { Live } = require("../out/live.js");

const Q = process.env.QLINT_TEST_Q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a password or secret in the shared list is dropped and said", () => {
  const text = JSON.stringify({
    processes: [
      { label: "rdb", host: "h", port: 5010, user: "me", password: "hunter2", tags: ["dev"] },
      { label: "gw", host: "h", port: 5020, Token: "t", gateway: ["rdb"] },
      { label: "hdb", host: "h", port: 5012 },
    ],
  });
  const read = readSharedFile(text, true);
  assert.deepStrictEqual(read.secrets, ["rdb", "gw"]);
  assert.deepStrictEqual(read.processes, [
    { label: "rdb", host: "h", port: 5010, user: "me", tags: ["dev"] },
    { label: "gw", host: "h", port: 5020, tags: [], gateway: ["rdb"] },
    { label: "hdb", host: "h", port: 5012, tags: [] },
  ]);
  assert.ok(!JSON.stringify(read).includes("hunter2"));
  assert.deepStrictEqual(read.problems, ["rdb, gw: a password or secret was dropped; a shared list holds none."]);
});

test("what runs something is read only in a trusted workspace", () => {
  const text = JSON.stringify([{ label: "a", host: "localhost", port: 1, init: "x:1", ssh: "jump", launch: { script: "s.q" } }]);
  assert.deepStrictEqual(readSharedFile(text, true).processes[0], { label: "a", host: "localhost", port: 1, tags: [], init: "x:1", ssh: "jump", launch: { script: "s.q" } });
  const untrusted = readSharedFile(text, false);
  assert.deepStrictEqual(untrusted.processes[0], { label: "a", host: "localhost", port: 1, tags: [] });
  assert.deepStrictEqual(untrusted.problems, ["1 entry's connect script, SSH tunnel or launch definition was not read: the workspace is not trusted."]);
  assert.throws(() => readSharedFile("{", true), SyntaxError);
});

test("a process is written into the list in place of its label, with no password", () => {
  const one = withShared(undefined, { label: "rdb", host: "h", port: 1, user: "me", tags: [] });
  assert.deepStrictEqual(JSON.parse(one), { processes: [{ label: "rdb", host: "h", port: 1, user: "me", tags: [] }] });
  const two = withShared('{"note":"kept","processes":[{"label":"rdb","host":"old"},{"label":"x","host":"y","port":2}]}', { label: "rdb", host: "h", port: 1, tags: [] });
  assert.deepStrictEqual(JSON.parse(two), { note: "kept", processes: [{ label: "rdb", host: "h", port: 1, tags: [] }, { label: "x", host: "y", port: 2 }] });
});

test("the list is a group beside the saved processes; .qlint names no discovery server", () => {
  const shared = { server: { label: ".qlint", url: "/w/.qlint/processes.json" }, state: { processes: [{ label: "rdb", host: "h", port: 1, tags: [] }], problems: [], loading: false, removed: false, fetchedAt: 1 } };
  const top = children([{ label: "mine", host: "h", port: 2, tags: [] }], [], undefined, shared);
  assert.deepStrictEqual(top.map((r) => r.kind), ["process", "shared"]);
  assert.deepStrictEqual(children([], [], top[1]), [{ kind: "discovered", server: ".qlint", process: shared.state.processes[0] }]);
  assert.strictEqual(serverLabelProblem(".qlint", new Set()), "That label names the workspace's shared process list.");
  assert.deepStrictEqual(readShared((_k, f) => f), { enabled: true });
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process connections");
  assert.strictEqual(section.properties["q-lint.processes.shared.enable"].default, true);
  for (const m of Object.values(pkg.contributes.menus).flat().filter((m) => m.command === SHARED_COMMANDS.add)) {
    assert.match(m.when, /config\.q-lint\.processes\.shared\.enable/);
  }
});

async function someQ(t) {
  if (Q) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-shared-q-"));
    fs.writeFileSync(path.join(dir, "s.q"), "answer:42\n");
    const port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    const child = spawn(`${Q} ${path.join(dir, "s.q")} -p ${port}`, { shell: true, stdio: "ignore", detached: true });
    t.after(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    });
    for (let i = 0; i < 100; i++) {
      const up = await new Promise((resolve) => {
        const s = net.connect(port, "127.0.0.1", () => (s.end(), resolve(true)));
        s.on("error", () => resolve(false));
      });
      if (up) return { port, real: true };
      await sleep(100);
    }
    throw new Error("q did not start");
  }
  const server = net.createServer((socket) => socket.once("data", () => socket.write(Buffer.from([3]))));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { port: server.address().port, real: false };
}

/// A Live over a workspace folder `dir`, the file system real, the watcher
/// faked so a test fires it, and the workspace trusted unless `trusted` is
/// false.
async function setUp(t, dir, { trusted = true, saved = [], config = {} } = {}) {
  stub.reset();
  Object.assign(stub.config.user, config);
  const vscode = require("vscode");
  const watchers = [];
  const reads = [];
  const restore = { fs: vscode.workspace.fs, folders: vscode.workspace.workspaceFolders, trusted: vscode.workspace.isTrusted, watch: vscode.workspace.createFileSystemWatcher };
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(dir), name: "w", index: 0 }];
  vscode.workspace.isTrusted = trusted;
  vscode.workspace.fs = {
    readFile: async (uri) => (reads.push(uri.fsPath), fs.promises.readFile(uri.fsPath)),
    writeFile: async (uri, bytes) => {
      await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.promises.writeFile(uri.fsPath, bytes);
    },
  };
  vscode.workspace.createFileSystemWatcher = () => {
    const w = { listeners: [], disposed: false, onDidCreate: (f) => w.listeners.push(f), onDidChange: (f) => w.listeners.push(f), onDidDelete: (f) => w.listeners.push(f), dispose: () => (w.disposed = true) };
    watchers.push(w);
    return w;
  };
  const context = stub.newContext();
  const state = new Map();
  context.workspaceState = { get: (k, d) => (state.has(k) ? structuredClone(state.get(k)) : d), update: async (k, v) => void state.set(k, v), keys: () => [...state.keys()] };
  await context.globalState.update("q-lint.processes", saved);
  const live = new Live(context);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
    Object.assign(vscode.workspace, { fs: restore.fs, workspaceFolders: restore.folders, isTrusted: restore.trusted, createFileSystemWatcher: restore.watch });
  });
  const changed = async () => {
    for (const f of watchers.at(-1).listeners.slice(0, 1)) f();
    await sleep(50);
  };
  const tree = stub.trees.find((v) => v.id === "q-lint.processes").options.treeDataProvider;
  return { live, context, watchers, reads, changed, tree };
}

const write = (dir, json) => {
  fs.mkdirSync(path.join(dir, ".qlint"), { recursive: true });
  fs.writeFileSync(path.join(dir, SHARED_FILE), typeof json === "string" ? json : JSON.stringify(json));
};

test("the shared list is listed, watched, and its processes connect like a discovered one", async (t) => {
  const q = await someQ(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-shared-"));
  write(dir, { processes: [{ label: "rdb", host: "127.0.0.1", port: q.port, user: "me", password: "in the repo", tags: ["dev"] }] });
  const { live, context, changed, tree } = await setUp(t, dir, { saved: [{ label: "rdb", host: "elsewhere", port: 1, tags: [] }] });
  await sleep(50);
  const shared = live.api().sharedProcesses();
  assert.deepStrictEqual(shared.processes, [{ label: "rdb", host: "127.0.0.1", port: q.port, user: "me", tags: ["dev"] }]);
  assert.match(stub.messages.find(([k]) => k === "warning")[1], /\.qlint\/processes\.json holds a password or secret for rdb, which was ignored/);
  // A group beside the saved processes, its rows connecting under .qlint/.
  const top = tree.getChildren();
  assert.deepStrictEqual(top.map((r) => r.kind), ["process", "shared"]);
  const item = tree.getTreeItem(top[1]);
  assert.strictEqual(item.label, "Workspace: .qlint/processes.json");
  assert.strictEqual(item.description, "1 process");
  // The password is asked for on connect, never taken from the file.
  stub.inputs.push((o) => (assert.match(o.title, /password of me/), "pw"));
  assert.strictEqual(await live.connectTo(".qlint/rdb"), true);
  assert.strictEqual(live.activeLabel(), ".qlint/rdb");
  assert.strictEqual(context.secrets.all.get("q-lint.discoveredPassword..qlint/rdb"), "pw");
  if (q.real) {
    assert.deepStrictEqual((await live.borrow((c) => c.query(["answer"], [10, 80]))).text, ["42"]);
  }
  // The file changes to another host: the password given is forgotten.
  write(dir, { processes: [{ label: "rdb", host: "localhost", port: q.port, user: "me", tags: [] }, { label: "hdb", host: "h", port: 2 }] });
  await changed();
  assert.deepStrictEqual(live.api().sharedProcesses().processes.map((p) => p.label), ["rdb", "hdb"]);
  assert.strictEqual(context.secrets.all.has("q-lint.discoveredPassword..qlint/rdb"), false);
  // Not JSON: said under the group.
  write(dir, "{");
  await changed();
  assert.match(live.api().sharedProcesses().error, /^not JSON/);
  // Deleted: the group goes.
  fs.rmSync(path.join(dir, SHARED_FILE));
  await changed();
  assert.strictEqual(live.api().sharedProcesses(), undefined);
  assert.deepStrictEqual(tree.getChildren().map((r) => r.kind), ["process"]);
});

test("a shared list that turns TLS off, or adds or drops a tunnel, forgets the password (#1269)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-shared-"));
  write(dir, [{ label: "a", host: "h", port: 1, tls: true }, { label: "b", host: "h", port: 2, ssh: "jump" }, { label: "c", host: "h", port: 3 }]);
  const { context, changed } = await setUp(t, dir);
  await sleep(50);
  for (const l of ["a", "b", "c"]) context.secrets.all.set(`q-lint.discoveredPassword..qlint/${l}`, "pw");
  write(dir, [{ label: "a", host: "h", port: 1 }, { label: "b", host: "h", port: 2 }, { label: "c", host: "h", port: 3 }]);
  await changed();
  assert.deepStrictEqual(["a", "b", "c"].map((l) => context.secrets.all.has(`q-lint.discoveredPassword..qlint/${l}`)), [false, false, true]);
});

test("in an untrusted workspace, a shared process brings no connect script, tunnel or launch", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-shared-"));
  write(dir, [{ label: "a", host: "localhost", port: 1, init: "evil[]", ssh: "jump", launch: { command: "rm" } }]);
  const { live } = await setUp(t, dir, { trusted: false });
  await sleep(50);
  assert.deepStrictEqual(live.api().sharedProcesses().processes, [{ label: "a", host: "localhost", port: 1, tags: [] }]);
});

test("Add to Shared Process List writes a saved process there, without its password", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-shared-"));
  const { live, context } = await setUp(t, dir, { saved: [{ label: "gw", host: "h", port: 5020, user: "me", tags: ["uat"], gateway: ["rdb"] }] });
  await context.secrets.store("q-lint.password.gw", "secret-pw");
  await stub.commands.get(SHARED_COMMANDS.add)("gw");
  const text = fs.readFileSync(path.join(dir, SHARED_FILE), "utf8");
  assert.deepStrictEqual(JSON.parse(text), { processes: [{ label: "gw", host: "h", port: 5020, user: "me", tags: ["uat"], gateway: ["rdb"] }] });
  assert.ok(!text.includes("secret-pw"));
  assert.deepStrictEqual(live.api().sharedProcesses().processes.map((p) => p.label), ["gw"]);
  assert.match(stub.messages.at(-1)[1], /gw is in \.qlint\/processes\.json, without its password: each user is asked for me's on connect\./);
});

test("with q-lint.processes.shared.enable off, the file is not read, nor listed, and the command refuses", async (t) => {
  const q = await someQ(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-shared-"));
  write(dir, [{ label: "a", host: "127.0.0.1", port: q.port }]);
  const { live, reads, watchers, tree } = await setUp(t, dir, { config: { "processes.shared.enable": false } });
  await sleep(50);
  assert.deepStrictEqual(reads, []);
  assert.deepStrictEqual(watchers, []);
  assert.strictEqual(live.api().sharedProcesses(), undefined);
  assert.deepStrictEqual(tree.getChildren(), []);
  await stub.commands.get(SHARED_COMMANDS.add)("a");
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: The shared process list is turned off. Set q-lint.processes.shared.enable to true to turn it on."]);
  // Its processes cannot be connected to.
  assert.strictEqual(await live.connectTo(".qlint/a"), false);
  assert.match(stub.messages.at(-1)[1], /no q process is labelled "\.qlint\/a"/);
  assert.deepStrictEqual(reads, []);
  // On: read, listed, connected to; off again: the watcher goes, the group
  // goes, and the connection to its process closes.
  stub.config.user["processes.shared.enable"] = true;
  stub.changeConfig("q-lint.processes.shared.enable");
  await sleep(50);
  assert.deepStrictEqual(live.api().sharedProcesses().processes.map((p) => p.label), ["a"]);
  assert.strictEqual(await live.connectTo(".qlint/a"), true);
  stub.config.user["processes.shared.enable"] = false;
  stub.changeConfig("q-lint.processes.shared.enable");
  await sleep(50);
  assert.ok(watchers.every((w) => w.disposed));
  assert.strictEqual(live.api().sharedProcesses(), undefined);
  assert.strictEqual(live.activeLabel(), undefined);
});
