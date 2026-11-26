// Credential commands (#1034): what a command prints read as a user and
// password, the command run with how it ended said but never what it
// printed, Set Credential Command through the stand-in `vscode` module, on
// and off, and - when QLINT_TEST_Q names a q - a connect to a q started
// with `-u` that only the command's credentials open, with nothing kept.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const { Live } = require("../out/live.js");
const { ADMIN_COMMANDS, adminOff, readAdmin } = require("../out/admin.js");
const { credentialCwd, credentialEnv, parseCredentials, runCredentialCommand } = require("../out/credentials.js");
const { CredentialCommands } = require("../out/credentialview.js");
const { parseProcesses } = require("../out/processes.js");
const { readSharedFile } = require("../out/shared.js");
const { fakeQ, SILENT } = require("./fakeq.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "user": "" was taken as the user and then dropped, so the handshake
// went as `:password` instead of as the process's own user.
test("a credential JSON whose user is empty keeps the process's user", () => {
  assert.deepStrictEqual(parseCredentials('{"user":"","password":"s3cret"}', "bob"), { user: "bob", password: "s3cret" });
  assert.deepStrictEqual(parseCredentials('{"user":"","username":"u","password":"p"}', "bob"), { user: "u", password: "p" });
  assert.deepStrictEqual(parseCredentials('{"user":null,"password":"s3cret"}', "bob"), { user: "bob", password: "s3cret" });
});

test("what a command prints: JSON, user:password, a password for the process's user, a token", () => {
  assert.deepStrictEqual(parseCredentials('{"user":"me","password":"pw"}\n'), { user: "me", password: "pw" });
  assert.deepStrictEqual(parseCredentials('{"token":"t0k"}', "svc"), { user: "svc", password: "t0k" });
  assert.deepStrictEqual(parseCredentials('{"username":"u","token":"t"}'), { user: "u", password: "t" });
  assert.deepStrictEqual(parseCredentials("me:pa:ss\nignored"), { user: "me", password: "pa:ss" });
  assert.deepStrictEqual(parseCredentials("pa:ss\r\n", "fixed"), { user: "fixed", password: "pa:ss" });
  assert.deepStrictEqual(parseCredentials("tokenonly"), { password: "tokenonly" });
  assert.deepStrictEqual(parseCredentials("  \n"), { problem: "it printed nothing" });
  assert.deepStrictEqual(parseCredentials('{"user":"me",}'), { problem: "it printed something that starts like JSON but is not" });
  // A password that opens with a brace is a line, not broken JSON (#1376).
  assert.deepStrictEqual(parseCredentials("{s3cret}\n"), { password: "{s3cret}" });
  assert.deepStrictEqual(parseCredentials("{abc", "svc"), { user: "svc", password: "{abc" });
  assert.deepStrictEqual(parseCredentials('{\n  "password": "pw"\n}'), { password: "pw" });
  assert.deepStrictEqual(parseCredentials('{"user":"x"}'), { problem: "its JSON has no password or token string" });
  assert.deepStrictEqual(credentialEnv({ label: "a", host: "h", port: 1 }), { QLINT_PROCESS_LABEL: "a", QLINT_PROCESS_HOST: "h", QLINT_PROCESS_PORT: "1" });
});

test("a JSON list of one object, and a JSON string, are read as JSON; another list says its shape (#3118)", () => {
  const list = '[{"user":"a","password":"p"}]';
  assert.deepStrictEqual(parseCredentials(list), { user: "a", password: "p" });
  // The command's own user, as an object's is taken.
  assert.deepStrictEqual(parseCredentials(list, "svc"), { user: "a", password: "p" });
  assert.deepStrictEqual(parseCredentials('\uFEFF[\n  {\n    "token": "t:1"\n  }\n]\n', "svc"), { user: "svc", password: "t:1" });
  assert.deepStrictEqual(parseCredentials('"s3cret"\n', "svc"), { user: "svc", password: "s3cret" });
  assert.deepStrictEqual(parseCredentials('"a \\"b\\" \\u00e9"'), { password: 'a "b" \u00e9' });
  assert.deepStrictEqual(parseCredentials('"bob:pw"'), { user: "bob", password: "pw" });
  // A shape with no one answer says so, and never what it held.
  assert.deepStrictEqual(parseCredentials('[{"user":"a","password":"hunter2"},{"user":"b","password":"hunter3"}]'), {
    problem: "its JSON is a list of 2 entries, where one object with a password or token is expected",
  });
  assert.deepStrictEqual(parseCredentials("[]", "svc"), { problem: "its JSON is a list of 0 entries, where one object with a password or token is expected" });
  assert.deepStrictEqual(parseCredentials('["hunter2"]', "svc"), { problem: "its JSON is a list whose one entry is not an object" });
  assert.deepStrictEqual(parseCredentials('[{"user":"a"}]'), { problem: "its JSON has no password or token string" });
  assert.deepStrictEqual(parseCredentials('""', "svc"), { problem: "its JSON is an empty string" });
  // What only starts like one is a line still, as {s3cret} is (#1376).
  assert.deepStrictEqual(parseCredentials("[s3cret", "svc"), { user: "svc", password: "[s3cret" });
  assert.deepStrictEqual(parseCredentials('"s3"cret', "svc"), { user: "svc", password: '"s3"cret' });
  assert.deepStrictEqual(parseCredentials("12345", "svc"), { user: "svc", password: "12345" });
});

test("a password keeps the spaces and tabs at its ends; only the line ending goes (#1358)", () => {
  assert.deepStrictEqual(parseCredentials("  pa ss \t\r\n", "fixed"), { user: "fixed", password: "  pa ss \t" });
  assert.deepStrictEqual(parseCredentials("me: pw \n"), { user: "me", password: " pw " });
  assert.deepStrictEqual(parseCredentials(" tok \n"), { password: " tok " });
  // A byte-order mark and blank lines before the line are still not part of it.
  assert.deepStrictEqual(parseCredentials("\uFEFF\r\n\npw \nignored\n", "fixed"), { user: "fixed", password: "pw " });
  assert.deepStrictEqual(parseCredentials(" me:pw"), { user: "me", password: "pw" });
  assert.deepStrictEqual(parseCredentials(' {"password":" p "}\n'), { password: " p " });
});

test("a command's failure says how it ended, never what it printed", async () => {
  assert.strictEqual(await runCredentialCommand("printf 'me:%s' \"$QLINT_PROCESS_LABEL\"", { env: { QLINT_PROCESS_LABEL: "x" } }), "me:x");
  await assert.rejects(runCredentialCommand("echo topsecret; echo topsecret >&2; exit 3"), (e) => e.message === "the credential command failed with exit code 3");
  await assert.rejects(runCredentialCommand("sleep 5", { timeoutMs: 200 }), /did not finish in 0.2 s/);
});

test("a credential command is kept with a saved process, read only where code may run", () => {
  const entry = { label: "a", host: "h", port: 1, credentialCommand: " vault read x ", timeout: 5 };
  assert.deepStrictEqual(parseProcesses([entry], true).processes[0], { label: "a", host: "h", port: 1, tags: [], credentialCommand: "vault read x", timeout: 5 });
  assert.strictEqual(parseProcesses([entry], false).processes[0].credentialCommand, undefined);
  const shared = readSharedFile(JSON.stringify({ processes: [entry] }), false);
  assert.strictEqual(shared.processes[0].credentialCommand, undefined);
  assert.match(shared.problems.join(" "), /not trusted/);
});

test("the switch: on by default, contributed, its command hidden while off", () => {
  assert.strictEqual(readAdmin((_k, f) => f).credentialCommand, true);
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process admin");
  assert.strictEqual(section.properties["q-lint.connection.credentialCommand.enable"].default, true);
  assert.ok(pkg.contributes.commands.some((c) => c.command === ADMIN_COMMANDS.setCredentialCommand && c.category === "q-lint"));
  const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === ADMIN_COMMANDS.setCredentialCommand);
  assert.strictEqual(menus.length, 2);
  for (const m of menus) assert.match(m.when, /config\.q-lint\.connection\.credentialCommand\.enable/);
});

async function setUp(t, processes) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  new CredentialCommands(context, live);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, context };
}

test("Set Credential Command sets, keeps the rest, and clears", async (t) => {
  const { live } = await setUp(t, [{ label: "a", host: "h", port: 1, tags: ["dev"], ssh: "bastion" }]);
  stub.inputs.push("get-creds a");
  await stub.commands.get(ADMIN_COMMANDS.setCredentialCommand)("a");
  assert.deepStrictEqual(live.processes(), [{ label: "a", host: "h", port: 1, tags: ["dev"], ssh: "bastion", credentialCommand: "get-creds a" }]);
  await stub.commands.get(ADMIN_COMMANDS.setCredentialCommand)("a", null);
  assert.deepStrictEqual(live.processes(), [{ label: "a", host: "h", port: 1, tags: ["dev"], ssh: "bastion" }]);
  // Escape changes nothing.
  stub.inputs.push(undefined);
  await stub.commands.get(ADMIN_COMMANDS.setCredentialCommand)("a");
  assert.strictEqual(live.processes()[0].credentialCommand, undefined);
});

test("turned off, Set Credential Command refuses; on again without a reload", async (t) => {
  const { live } = await setUp(t, [{ label: "a", host: "h", port: 1, tags: [] }]);
  stub.config.user["connection.credentialCommand.enable"] = false;
  stub.changeConfig("q-lint.connection.credentialCommand.enable");
  await stub.commands.get(ADMIN_COMMANDS.setCredentialCommand)("a", "x");
  assert.deepStrictEqual(stub.messages.at(-1), ["info", adminOff("credentialCommand")]);
  assert.strictEqual(live.processes()[0].credentialCommand, undefined);
  stub.config.user["connection.credentialCommand.enable"] = true;
  await stub.commands.get(ADMIN_COMMANDS.setCredentialCommand)("a", "x");
  assert.strictEqual(live.processes()[0].credentialCommand, "x");
});

// The connection kept the entry captured at connect, so the reconnect q-lint
// makes itself after Abort went without the command set since (#1988).
test("a credential command set on the connected process runs at the reconnect after Abort, and what it prints is not kept", async (t) => {
  const q = await fakeQ((message) => (JSON.stringify(message).includes("slow") ? SILENT : 1));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-creds-"));
  t.after(() => (q.close(), fs.rmSync(dir, { recursive: true, force: true })));
  const marker = path.join(dir, "ran");
  const { live, context } = await setUp(t, [{ label: "a", host: "127.0.0.1", port: q.port, tags: [] }]);
  assert.strictEqual(await live.connectTo("a"), true);
  await stub.commands.get(ADMIN_COMMANDS.setCredentialCommand)("a", `echo ran >> '${marker}'; echo svc:s3cr3t`);
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: a runs its credential command at each connect."]);
  assert.strictEqual(fs.existsSync(marker), false);
  const running = live.run("slow");
  for (let i = 0; i < 50 && !live.isBusy(); i++) await sleep(20);
  await stub.commands.get("q-lint.abortQuery")();
  await running;
  for (let i = 0; i < 100 && live.activeLabel() === undefined; i++) await sleep(20);
  assert.strictEqual(live.activeLabel(), "a");
  assert.strictEqual(fs.readFileSync(marker, "utf8"), "ran\n");
  assert.strictEqual(context.secrets.all.size, 0);
  assert.ok(!JSON.stringify(stub.messages).includes("s3cr3t"));
  // Cleared, the next reconnect runs none.
  await stub.commands.get(ADMIN_COMMANDS.setCredentialCommand)("a", null);
  assert.strictEqual(live.activeProcess().credentialCommand, undefined);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(port, users) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-creds-"));
  fs.writeFileSync(path.join(dir, "server.q"), "x:42\n");
  fs.writeFileSync(path.join(dir, "users.txt"), users);
  const child = spawn(`${Q} ${path.join(dir, "server.q")} -p ${port} -u ${path.join(dir, "users.txt")}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
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
    if (up) return { stop, dir };
    await sleep(100);
  }
  stop();
  throw new Error("q did not start listening");
}

test("a process whose command prints the right credentials connects, and nothing of them is kept (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port, "svc:s3cr3t\n");
  t.after(() => q.stop());
  // The secret is in a file the command reads, so that the command kept
  // with the process does not hold it.
  fs.writeFileSync(path.join(q.dir, "creds.json"), '{"user":"svc","password":"s3cr3t"}');
  const { live, context } = await setUp(t, [
    { label: "good", host: "127.0.0.1", port, tags: [], credentialCommand: `cat '${path.join(q.dir, "creds.json")}'` },
    { label: "bad", host: "127.0.0.1", port, tags: [], credentialCommand: "printf 'svc:wrong'" },
    { label: "fails", host: "127.0.0.1", port, tags: [], credentialCommand: `cat '${path.join(q.dir, "creds.json")}'; exit 7` },
  ]);
  assert.strictEqual(await live.connectTo("good"), true);
  assert.strictEqual(live.activeLabel(), "good");
  assert.strictEqual(await live.connectTo("bad"), false);
  assert.match(stub.messages.at(-1)[1], /refused/);
  assert.strictEqual(await live.connectTo("fails"), false);
  assert.match(stub.messages.at(-1)[1], /exit code 7/);
  // Nothing of what was printed is kept or said.
  assert.strictEqual(context.secrets.all.size, 0);
  const state = JSON.stringify(context.globalState.keys().map((k) => context.globalState.get(k)));
  assert.ok(!state.includes("s3cr3t"), state);
  assert.ok(!JSON.stringify(stub.messages).includes("s3cr3t"));
  // Turned off, the command is not run: the stored password (none) is sent.
  stub.config.user["connection.credentialCommand.enable"] = false;
  assert.strictEqual(await live.connectTo("good"), false);
});

// A saved process's credential command ran in the opened folder even when
// it was not trusted: `./creds.sh`, or on Windows a bare `vault`, was the
// repository's (#1537).
test("a credential command runs in the workspace folder only when it is trusted, else in the home directory", () => {
  assert.strictEqual(credentialCwd(true, "/ws", "/home/u"), "/ws");
  assert.strictEqual(credentialCwd(false, "/ws", "/home/u"), "/home/u");
  assert.strictEqual(credentialCwd(true, undefined, "/home/u"), "/home/u");
});

// The command ran with no way to stop it: a connect elsewhere waited for it
// to finish, and Disconnect or the timeout left what it started running (#2127).
// The first folder's fsPath, a vscode-vfs one's /acme/desk, is not on disk:
// the spawn failed, and the connect said the command could not run (#2514).
test("a credential command runs in the first folder on disk, not a virtual first folder's path", { skip: process.platform === "win32" }, async (t) => {
  const vscode = require("vscode");
  const q = await fakeQ(1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-creds-"));
  const plain = vscode.workspace.workspaceFolders;
  t.after(() => (q.close(), fs.rmSync(dir, { recursive: true, force: true }), (vscode.workspace.workspaceFolders = plain)));
  const marker = path.join(dir, "cwd");
  const { live } = await setUp(t, [{ label: "a", host: "127.0.0.1", port: q.port, tags: [], credentialCommand: `pwd -P > '${marker}'; echo svc:pw` }]);
  const virtual = { scheme: "vscode-vfs", authority: "github", path: "/acme/desk", fsPath: "/acme/desk", toString: () => "vscode-vfs://github/acme/desk" };
  vscode.workspace.workspaceFolders = [{ uri: virtual, name: "desk", index: 0 }, { uri: vscode.Uri.file(dir), name: path.basename(dir), index: 1 }];
  assert.strictEqual(await live.connectTo("a"), true, JSON.stringify(stub.messages));
  assert.strictEqual(fs.readFileSync(marker, "utf8").trim(), fs.realpathSync(dir));
});

test("a credential command stopped or timed out is ended with everything it started (#2127)", { skip: process.platform === "win32" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-creds-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const late = (name) => `sh -c "sleep 1; echo ran > '${path.join(dir, name)}'"; echo pw`;
  await assert.rejects(runCredentialCommand(late("timeout"), { timeoutMs: 200 }), (e) => e.message === "the credential command did not finish in 0.2 s");
  const stop = new AbortController();
  const started = Date.now();
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(runCredentialCommand(late("aborted"), { signal: stop.signal }), (e) => e.message === "the credential command was cancelled");
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(runCredentialCommand("echo pw", { signal: stop.signal }), /cancelled/);
  await sleep(1500);
  assert.deepStrictEqual(fs.readdirSync(dir), [], "nothing it started ran on");
});

// A command that printed its password and exited 0, leaving a child of its
// own holding stdout, was waited on until the timeout and refused (#2191).
// It settles at the exit with what it printed by then, and the child is
// ended with it. Only whether the value matched is said, never the value.
test("a credential command that exits 0 behind a child holding its stdout settles at the exit (#2191)", { skip: process.platform === "win32" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-creds-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "ran");
  const started = Date.now();
  const printed = await runCredentialCommand(`echo pw; (sleep 1; echo ran > '${marker}') &`, { timeoutMs: 3000 });
  const took = Date.now() - started;
  assert.ok(printed === "pw\n", "the command's output was not what it printed before it exited");
  assert.ok(took < 1000, `it settled after ${took} ms`);
  await sleep(1500);
  assert.strictEqual(fs.existsSync(marker), false, "the child it left behind ran on");
});

test("a connect elsewhere, or Disconnect, does not wait for a slow credential command (#2127)", { skip: process.platform === "win32" }, async (t) => {
  const q = await fakeQ(1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-creds-"));
  t.after(() => (q.close(), fs.rmSync(dir, { recursive: true, force: true })));
  const marker = path.join(dir, "ran");
  const slow = `sh -c "sleep 2; echo ran > '${marker}'"; echo svc:pw`;
  const { live } = await setUp(t, [
    { label: "slow", host: "127.0.0.1", port: q.port, tags: [], credentialCommand: slow },
    { label: "plain", host: "127.0.0.1", port: q.port, tags: [] },
  ]);
  const first = live.connectTo("slow");
  await sleep(200);
  const started = Date.now();
  assert.strictEqual(await live.connectTo("plain"), true);
  assert.ok(Date.now() - started < 1000, `the connect waited ${Date.now() - started} ms`);
  assert.strictEqual(await first, false);
  assert.strictEqual(live.activeLabel(), "plain");
  const again = live.connectTo("slow");
  await sleep(200);
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.strictEqual(await again, false);
  await sleep(2300);
  assert.strictEqual(fs.existsSync(marker), false, "the command was left running");
});
