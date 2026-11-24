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
  const untrusted = readSharedFile(JSON.stringify([{ label: "a", host: "localhost", port: 1, init: "x:1", launch: { script: "s.q" } }]), false);
  assert.deepStrictEqual(untrusted.processes[0], { label: "a", host: "localhost", port: 1, tags: [] });
  assert.deepStrictEqual(untrusted.problems, ["1 entry's connect script, SSH tunnel or launch definition was not read: the workspace is not trusted."]);
  // One reached through a tunnel is not listed: it would be connected to
  // directly, past its tunnel, password and all (#1507).
  const tunnelled = readSharedFile(text, false);
  assert.deepStrictEqual(tunnelled.processes, []);
  assert.deepStrictEqual(tunnelled.problems, [
    "a: reached through an SSH tunnel, which is not read while the workspace is not trusted, so not listed.",
    "1 entry's connect script, SSH tunnel or launch definition was not read: the workspace is not trusted.",
  ]);
  assert.throws(() => readSharedFile("{", true), SyntaxError);
});

test("a process is written into the list in place of its label, with no password", () => {
  const one = withShared(undefined, { label: "rdb", host: "h", port: 1, user: "me", tags: [] });
  assert.deepStrictEqual(JSON.parse(one), { processes: [{ label: "rdb", host: "h", port: 1, user: "me", tags: [] }] });
  const two = withShared('{"note":"kept","processes":[{"label":"rdb","host":"old"},{"label":"x","host":"y","port":2}]}', { label: "rdb", host: "h", port: 1, tags: [] });
  assert.deepStrictEqual(JSON.parse(two), { note: "kept", processes: [{ label: "rdb", host: "h", port: 1, tags: [] }, { label: "x", host: "y", port: 2 }] });
});

// An entry labelled "rdb " is listed as rdb, but was not found by Share:
// a second rdb was appended and skipped as a repeat, the old one kept.
test("sharing a process replaces an entry whose label has spaces around it", () => {
  const file = JSON.stringify({ processes: [{ label: "rdb ", host: "old-host", port: 5000 }] });
  const read = readSharedFile(withShared(file, { label: "rdb", host: "new-host", port: 5001, tags: [] }), true);
  assert.deepStrictEqual(read.processes.map((p) => `${p.label}@${p.host}:${p.port}`), ["rdb@new-host:5001"]);
  assert.deepStrictEqual(read.problems, []);
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
  write(dir, [{ label: "a", host: "localhost", port: 1, init: "evil[]", launch: { command: "rm" } }, { label: "b", host: "10.0.0.5", port: 1, ssh: "jump" }]);
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

// Every field went into the committed file unasked: a launch's env, a
// connect script's password, the credential command (#1528).
test("Add to Shared asks before writing a connect script, credential command, launch or tunnel, and can leave them out", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-shared-"));
  const secret = { label: "s", host: "h", port: 1, tags: [], init: "h:hopen`:auth:5000:svc:S3cr3tPass", credentialCommand: "vault read x", launch: { env: { AWS_SECRET_ACCESS_KEY: "wJal" } } };
  await setUp(t, dir, { saved: [secret] });
  const read = () => fs.readFileSync(path.join(dir, SHARED_FILE), "utf8");
  // Escape: nothing written.
  let asked;
  stub.picks.push((o) => ((asked = o), undefined));
  await stub.commands.get(SHARED_COMMANDS.add)("s");
  assert.match(asked.message, /s has a connect script, credential command, launch definition\. .*committed/);
  assert.ok(asked.items[0].detail.includes("S3cr3tPass"), "what goes in the file is shown");
  assert.ok(!fs.existsSync(path.join(dir, SHARED_FILE)));
  stub.picks.push("Share Without Them");
  await stub.commands.get(SHARED_COMMANDS.add)("s");
  assert.deepStrictEqual(JSON.parse(read()), { processes: [{ label: "s", host: "h", port: 1, tags: [] }] });
  stub.picks.push("Share All");
  await stub.commands.get(SHARED_COMMANDS.add)("s");
  assert.strictEqual(JSON.parse(read()).processes[0].credentialCommand, "vault read x");
});

// Share Without Them dropped the tunnel, so every clone dialled its own
// localhost:5000 with the password typed for prod (#1715).
test("Add to Shared keeps a process's SSH tunnel, with or without what runs on connect", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-shared-"));
  const prod = { label: "prod", host: "localhost", port: 5000, user: "svc", tags: ["prod"], ssh: "bastion.corp" };
  await setUp(t, dir, { saved: [prod, { ...prod, label: "p2", credentialCommand: "vault read x" }] });
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, SHARED_FILE), "utf8")).processes;
  // A tunnel alone is not asked about.
  await stub.commands.get(SHARED_COMMANDS.add)("prod");
  assert.deepStrictEqual(read(), [prod]);
  let asked;
  stub.picks.push((o) => ((asked = o), "Share Without Them"));
  await stub.commands.get(SHARED_COMMANDS.add)("p2");
  assert.match(asked.message, /p2 has a credential command\. /);
  assert.deepStrictEqual(read()[1], { ...prod, label: "p2" });
  assert.deepStrictEqual(readSharedFile(fs.readFileSync(path.join(dir, SHARED_FILE), "utf8"), true).processes.map((p) => p.ssh), ["bastion.corp", "bastion.corp"]);
});

// Written under the open list's unsaved edits, its next save conflicted (#1531).
test("Add to Shared refuses while the list is open with unsaved edits", async (t) => {
  const vscode = require("vscode");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-shared-"));
  await setUp(t, dir, { saved: [{ label: "a", host: "h", port: 1, tags: [] }] });
  vscode.workspace.textDocuments = [{ uri: vscode.Uri.joinPath(vscode.Uri.file(dir), SHARED_FILE), isDirty: true }];
  t.after(() => (vscode.workspace.textDocuments = []));
  await stub.commands.get(SHARED_COMMANDS.add)("a");
  assert.ok(!fs.existsSync(path.join(dir, SHARED_FILE)));
  assert.match(stub.messages.at(-1)[1], /processes\.json has unsaved changes; save it, then share a again/);
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

// Turned off, only the active connection to a shared process closed: a
// stream's own connection kept receiving updates (#1517).
test("turning the shared list off closes a connection apart to one of its processes", async (t) => {
  const q = await someQ(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-shared-"));
  write(dir, [{ label: "a", host: "127.0.0.1", port: q.port }]);
  const { live } = await setUp(t, dir);
  await sleep(50);
  const connection = await live.openSeparate(live.named(".qlint/a"));
  t.after(() => connection.abort());
  assert.strictEqual(connection.isOpen, true);
  stub.config.user["processes.shared.enable"] = false;
  stub.changeConfig("q-lint.processes.shared.enable");
  await sleep(50);
  assert.strictEqual(connection.isOpen, false);
});
