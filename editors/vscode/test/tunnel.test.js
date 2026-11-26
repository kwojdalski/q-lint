// SSH tunnels (#908): the arguments ssh is given, and the tunnel's life
// through the stand-in `vscode` module with a stand-in `ssh` on PATH, which
// forwards as `ssh -L` would. Against a real q process when QLINT_TEST_Q
// names one; otherwise against a socket server that answers the handshake.
// `ssh localhost` asks for a password on the machine this was written on, so
// no test runs the real ssh.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const { spawn, spawnSync } = require("node:child_process");
const pkg = require("../package.json");
const { SshTunnel, TUNNEL_COMMANDS, readTunnel, shownError, sshArgs } = require("../out/tunnel.js");
const { parseProcesses, readProcessFile, sshDestination, withExtras } = require("../out/processes.js");
const { Live } = require("../out/live.js");

const Q = process.env.QLINT_TEST_Q;
/// The forward's end as ssh is given it: a socket in a private directory,
/// or on Windows a loopback port (#1823).
const FORWARD = process.platform === "win32" ? "127\\.0\\.0\\.1:\\d+" : "/[^:]*/qlint-ssh-[^/:]+/s";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in ssh: records its arguments, then forwards the -L port to the
// target until it is killed; with STUB_SSH_FAIL set, it says so and exits 255.
// STUB_SSH_REACHES names the host the target's address is, seen from the jump
// host: a process at an address this machine does not have.
const STUB = `#!/usr/bin/env node
const fs = require("fs");
const net = require("net");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_SSH_LOG, JSON.stringify({ pid: process.pid, args }) + "\\n");
if (process.env.STUB_SSH_NEVER) {
  // A forward that never opens: ssh still connecting to a far jump host.
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
  return;
}
if (process.env.STUB_SSH_FAIL) {
  process.stderr.write("banner\\nme@bastion: Permission denied (publickey).\\n");
  process.exit(255);
}
// The forward's end is a unix socket's path, or a loopback port (Windows).
const [, local, host, port] = /^(?:127\\.0\\.0\\.1:)?(\\d+|\\/[^:]+):\\[?([^\\]]*?)\\]?:(\\d+)$/.exec(args[args.indexOf("-L") + 1]);
const server = net.createServer((client) => {
  const upstream = net.connect(Number(port), process.env.STUB_SSH_REACHES || host);
  client.pipe(upstream).pipe(client);
  upstream.on("error", () => {
    // As ssh does when the far end refuses the forward.
    process.stderr.write("channel 2: open failed: connect failed: Connection refused\\n");
    client.destroy();
  });
  client.on("error", () => upstream.destroy());
});
setTimeout(() => (local.startsWith("/") ? server.listen(local) : server.listen(Number(local), "127.0.0.1")), 200);
process.on("SIGTERM", () => process.exit(0));
`;

function stubSsh(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-ssh-"));
  fs.writeFileSync(path.join(dir, "ssh"), STUB, { mode: 0o755 });
  const log = path.join(dir, "log");
  const saved = { PATH: process.env.PATH, STUB_SSH_LOG: process.env.STUB_SSH_LOG, STUB_SSH_FAIL: process.env.STUB_SSH_FAIL, STUB_SSH_REACHES: process.env.STUB_SSH_REACHES, STUB_SSH_NEVER: process.env.STUB_SSH_NEVER };
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  process.env.STUB_SSH_LOG = log;
  delete process.env.STUB_SSH_FAIL;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return { runs: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/// A q process: real when QLINT_TEST_Q names one, else a socket server
/// that answers the handshake and nothing more.
async function someQ(t) {
  if (Q) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tunnel-q-"));
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

test("ssh is run with no command, in batch mode, the destination after --", () => {
  assert.deepStrictEqual(sshArgs("me@bastion", 5001, "rdb.internal", 5010), [
    "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
    "-L", "127.0.0.1:5001:rdb.internal:5010", "--", "me@bastion",
  ]);
  // A port on the destination is ssh's -p; an IPv6 target is bracketed.
  const args = sshArgs("bastion:2222", 5001, "::1", 5010);
  assert.deepStrictEqual(args.slice(-5), ["127.0.0.1:5001:[::1]:5010", "-p", "2222", "--", "bastion"]);
});

// The last `:digits` was taken as a port: 2001:db8::1 became -p 1 to
// 2001:db8:, and user@fe80::1 -p 1 to user@fe80:.
test("a bare IPv6 jump host is not split into a host and a port (#1068)", () => {
  const tail = (d) => sshArgs(d, 5001, "h", 5010).slice(-4);
  assert.deepStrictEqual(tail("2001:db8::1"), ["-L", "127.0.0.1:5001:h:5010", "--", "2001:db8::1"]);
  assert.deepStrictEqual(tail("user@fe80::1"), ["-L", "127.0.0.1:5001:h:5010", "--", "user@fe80::1"]);
  assert.deepStrictEqual(tail("[2001:db8::1]:2222"), ["-p", "2222", "--", "2001:db8::1"]);
  assert.deepStrictEqual(tail("me@[2001:db8::1]:2222"), ["-p", "2222", "--", "me@2001:db8::1"]);
  assert.deepStrictEqual(tail("me@[2001:db8::1]"), ["-L", "127.0.0.1:5001:h:5010", "--", "me@2001:db8::1"]);
  assert.deepStrictEqual(tail("me@bastion:2222"), ["-p", "2222", "--", "me@bastion"]);
});

test("a destination that ssh would read as an option, or as two words, is refused", () => {
  assert.strictEqual(sshDestination(" me@bastion "), "me@bastion");
  assert.strictEqual(sshDestination("bastion:2222"), "bastion:2222");
  for (const bad of ["-oProxyCommand=evil", "a b", "a;b", "", "`x`", "$(x)", 5]) {
    assert.strictEqual(sshDestination(bad), undefined, String(bad));
  }
  // Read from the saved list and an import; never from a discovery server.
  assert.strictEqual(parseProcesses([{ label: "a", host: "h", port: 1, ssh: "bastion" }], true).processes[0].ssh, "bastion");
  assert.strictEqual(parseProcesses([{ label: "a", host: "h", port: 1, ssh: "bastion" }]).processes[0].ssh, undefined);
  // One that is none skips its process: it is not dialled without a tunnel (#3095).
  assert.deepStrictEqual(readProcessFile('{"processes":[{"label":"a","host":"h","port":1,"ssh":"-oX"}]}').processes, []);
  // Edit keeps it.
  assert.deepStrictEqual(withExtras({ label: "a", host: "h", port: 1, tags: [] }, { ssh: "b" }), { label: "a", host: "h", port: 1, tags: [], ssh: "b" });
});

test("the setting is on by default, and hides Set SSH Tunnel when off", () => {
  assert.deepStrictEqual(readTunnel((_k, f) => f), { enabled: true });
  assert.deepStrictEqual(readTunnel(() => false), { enabled: false });
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process connections");
  assert.strictEqual(section.properties["q-lint.connection.sshTunnel.enable"].default, true);
  const when = "config.q-lint.connection.sshTunnel.enable";
  assert.ok(pkg.contributes.menus.commandPalette.some((m) => m.command === TUNNEL_COMMANDS.set && m.when === when));
  for (const m of pkg.contributes.menus["view/item/context"].filter((m) => m.command === TUNNEL_COMMANDS.set)) {
    assert.ok(m.when.endsWith(when), m.when);
  }
});

// The forward was a loopback port, named in ssh's argv for `ps` to show:
// another local user who bound it before ssh had authenticated was taken
// for the tunnel and sent the q handshake, user and password (#1823).
test("the forward is a socket only this user can reach, and nothing else is taken for it", { skip: process.platform === "win32" }, async (t) => {
  const ssh = stubSsh(t);
  process.env.STUB_SSH_NEVER = "1";
  const opened = SshTunnel.open({ destination: "bastion", host: "rdb", port: 5010, timeoutMs: 1500 });
  let run;
  for (let i = 0; i < 50 && (run = ssh.runs()[0]) === undefined; i++) await sleep(20);
  const forward = run.args[run.args.indexOf("-L") + 1];
  const sock = forward.slice(0, forward.indexOf(":"));
  assert.strictEqual(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
  assert.ok(!/127\.0\.0\.1/.test(forward), forward);
  // A listener anyone else could start is on some port; no port is dialled.
  const seen = [];
  const other = net.createServer((s) => seen.push(s.remoteAddress)).listen(0, "127.0.0.1");
  t.after(() => other.close());
  await assert.rejects(opened, /did not open in 1\.5 s/);
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(fs.existsSync(path.dirname(sock)), false, "the directory is removed with ssh");
  delete process.env.STUB_SSH_NEVER;
});

test("a tunnel that ssh cannot open says what ssh said, and leaves nothing running", async (t) => {
  const ssh = stubSsh(t);
  process.env.STUB_SSH_FAIL = "1";
  // ssh's words can name hosts: they are kept apart from the message, which
  // a history keeps, for the one message shown at once (#1508).
  const failure = await SshTunnel.open({ destination: "me@bastion", host: "rdb", port: 5010, timeoutMs: 5000 }).catch((e) => e);
  assert.strictEqual(failure.message, "the SSH tunnel through me@bastion did not open");
  assert.match(failure.shown().message, /the SSH tunnel through me@bastion did not open\. ssh said: banner me@bastion: Permission denied \(publickey\)\./);
  assert.strictEqual(alive(ssh.runs()[0].pid), false);
  // Stream Table, Diff Function and Find in Processes show it at once (#1721).
  assert.strictEqual(shownError(failure), failure.shown().message);
  assert.strictEqual(shownError(new Error("plain")), "plain");
  assert.strictEqual(shownError("text"), "text");
  delete process.env.STUB_SSH_FAIL;
  await assert.rejects(SshTunnel.open({ destination: "x", host: "h", port: 1, ssh: "/nonexistent/ssh" }), /no ssh program \(\/nonexistent\/ssh\) on PATH/);
});

async function setUp(t, processes) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, context };
}

test("a process with a jump host is connected to through ssh, which stops when it disconnects", async (t) => {
  const q = await someQ(t);
  const ssh = stubSsh(t);
  const { live } = await setUp(t, [{ label: "far", host: "127.0.0.1", port: q.port, tags: [], ssh: "me@bastion:2222" }]);
  assert.strictEqual(await live.connectTo("far"), true);
  const [run] = ssh.runs();
  assert.deepStrictEqual(run.args.slice(-6), ["-L", run.args.at(-5), "-p", "2222", "--", "me@bastion"]);
  assert.match(run.args.at(-5), new RegExp(`^${FORWARD}:127\\.0\\.0\\.1:${q.port}$`));
  assert.ok(alive(run.pid));
  if (q.real) {
    const answer = await live.borrow((c) => c.query(["answer"], [10, 80]));
    assert.deepStrictEqual(answer.text, ["42"]);
  }
  await stub.commands.get("q-lint.disconnectProcess")();
  for (let i = 0; i < 50 && alive(run.pid); i++) await sleep(50);
  assert.strictEqual(alive(run.pid), false, "ssh stopped with the connection");
});

test("a run apart cancelled while its tunnel opens stops at once, and stops ssh (#1459)", async (t) => {
  const ssh = stubSsh(t);
  process.env.STUB_SSH_NEVER = "1";
  const far = { label: "far", host: "127.0.0.1", port: 1, tags: [], ssh: "bastion" };
  const { live } = await setUp(t, [far]);
  const stop = new AbortController();
  const run = live.runApart(far, "1", stop.signal);
  // Cancel while ssh runs: under load the stub can take longer than a fixed
  // wait to start, and a cancel before then leaves no ssh to look at.
  for (let i = 0; i < 100 && ssh.runs().length === 0; i++) await sleep(50);
  assert.strictEqual(ssh.runs().length, 1, "ssh was started");
  const started = Date.now();
  stop.abort();
  await assert.rejects(run, /the SSH tunnel through bastion was cancelled/);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  for (let i = 0; i < 50 && alive(ssh.runs()[0].pid); i++) await sleep(50);
  assert.strictEqual(alive(ssh.runs()[0].pid), false);
});

test("ssh dying closes the connection over it", async (t) => {
  const q = await someQ(t);
  const ssh = stubSsh(t);
  const { live } = await setUp(t, [{ label: "far", host: "127.0.0.1", port: q.port, tags: [], ssh: "bastion" }]);
  assert.strictEqual(await live.connectTo("far"), true);
  process.kill(ssh.runs()[0].pid, "SIGTERM");
  for (let i = 0; i < 50 && live.activeLabel() !== undefined; i++) await sleep(50);
  assert.strictEqual(live.activeLabel(), undefined);
});

// The forward opens and reaches nothing: ssh closes the local socket, which
// is also how a process refuses a user (#1355).
test("no q behind the tunnel is said so, with the process's address and what ssh said", async (t) => {
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const ssh = stubSsh(t);
  const { live, context } = await setUp(t, [{ label: "far", host: "127.0.0.1", port, tags: [], ssh: "me@bastion" }]);
  assert.strictEqual(await live.connectTo("far"), false);
  const [kind, text] = stub.messages.at(-1);
  const local = new RegExp(`^(${FORWARD}):`).exec(ssh.runs()[0].args.at(-3))[1];
  assert.strictEqual(kind, "error");
  assert.strictEqual(
    text,
    `q-lint: could not connect to far (127.0.0.1:${port}): the connection through the SSH tunnel via me@bastion closed before the handshake: ` +
      `no q process answers at 127.0.0.1:${port} as me@bastion reaches it, or the user or password was refused. ` +
      "ssh said: channel 2: open failed: connect failed: Connection refused",
  );
  assert.ok(!text.includes(local), "the tunnel's own end is not named");
  for (let i = 0; i < 50 && alive(ssh.runs()[0].pid); i++) await sleep(50);
  assert.strictEqual(alive(ssh.runs()[0].pid), false, "ssh stopped with the failed connect");
  // What ssh said is in the message shown, and in nothing that is kept.
  await assert.rejects(live.openSeparate(live.processes()[0]), (e) => /closed before the handshake/.test(e.message) && !/channel 2/.test(e.message));
  assert.ok(!JSON.stringify([...context.globalState.keys()].map((k) => context.globalState.get(k))).includes("channel 2"));
});

// A process addressed by IP, over TLS, through a tunnel: the socket goes to
// the loopback end, and the certificate is for the process's address (#1356).
// The certificate is made by openssl, and trusted by adding it to what
// `tls.connect` is given; nothing turns the check off.
const noOpenssl = spawnSync("openssl", ["version"]).status === 0 ? false : "no openssl on PATH to make a certificate";
test("TLS through a tunnel checks the certificate against the process's own address", { skip: noOpenssl }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-tls-"));
  const made = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "cert.pem", "-days", "2", "-subj", "/CN=q", "-addext", "subjectAltName=IP:10.0.0.5"],
    { cwd: dir },
  );
  assert.strictEqual(made.status, 0, String(made.stderr));
  const cert = fs.readFileSync(path.join(dir, "cert.pem"));
  const server = tls.createServer({ key: fs.readFileSync(path.join(dir, "key.pem")), cert }, (socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.write(Buffer.from([3])));
  });
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connect = tls.connect;
  let trusted = true;
  let checked = 0;
  tls.connect = (options) => (checked++, connect({ ...options, ...(trusted ? { ca: cert } : {}) }));
  const ssh = stubSsh(t);
  process.env.STUB_SSH_REACHES = "127.0.0.1";
  t.after(() => {
    tls.connect = connect;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const far = (label, host) => ({ label, host, port: server.address().port, tags: [], tls: true, ssh: "bastion" });
  const { live } = await setUp(t, [far("far", "10.0.0.5"), far("other", "10.0.0.6")]);
  assert.strictEqual(await live.connectTo("far"), true, String(stub.messages.at(-1)));
  assert.match(ssh.runs()[0].args.at(-3), new RegExp(`^${FORWARD}:10\\.0\\.0\\.5:${server.address().port}$`));
  // The check is still made: the same certificate is not another address's,
  await stub.commands.get("q-lint.disconnectProcess")();
  assert.strictEqual(await live.connectTo("other"), false);
  assert.match(stub.messages.at(-1)[1], /IP: 10\.0\.0\.6 is not in the cert's list: 10\.0\.0\.5/);
  // and one nothing vouches for is refused.
  trusted = false;
  assert.strictEqual(await live.connectTo("far"), false);
  assert.match(stub.messages.at(-1)[1], /self[- ]signed certificate/);
  assert.strictEqual(checked, 3);
});

test("with q-lint.connection.sshTunnel.enable off, no ssh runs and Set SSH Tunnel refuses", async (t) => {
  const q = await someQ(t);
  const ssh = stubSsh(t);
  const { live } = await setUp(t, [{ label: "far", host: "127.0.0.1", port: q.port, tags: [], ssh: "bastion" }]);
  stub.config.user["connection.sshTunnel.enable"] = false;
  assert.strictEqual(await live.connectTo("far"), false);
  assert.match(stub.messages.at(-1)[1], /SSH tunnels are turned off\. Set q-lint\.connection\.sshTunnel\.enable to true/);
  assert.deepStrictEqual(ssh.runs(), []);
  await stub.commands.get(TUNNEL_COMMANDS.set)("far", "other");
  assert.deepStrictEqual(stub.messages.at(-1), ["info", "q-lint: SSH tunnels is turned off. Set q-lint.connection.sshTunnel.enable to true to turn it on."]);
  assert.strictEqual(live.processes()[0].ssh, "bastion");
  // Turned off while connected through one: the connection closes.
  stub.config.user["connection.sshTunnel.enable"] = true;
  assert.strictEqual(await live.connectTo("far"), true);
  const pid = ssh.runs()[0].pid;
  stub.config.user["connection.sshTunnel.enable"] = false;
  stub.changeConfig("q-lint.connection.sshTunnel.enable");
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(50);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.strictEqual(alive(pid), false);
});

test("Set SSH Tunnel sets and clears a saved process's jump host, and Edit keeps it", async (t) => {
  const { live } = await setUp(t, [{ label: "a", host: "h", port: 1, tags: [] }]);
  stub.inputs.push("-oProxyCommand=x");
  await stub.commands.get(TUNNEL_COMMANDS.set)("a");
  // The box refuses it; the stub returns it anyway, and it is refused again.
  assert.match(stub.messages.at(-1)[1], /is not an SSH destination/);
  stub.inputs.push((o) => (assert.strictEqual(o.validateInput("a b"), "A destination ssh takes: no spaces or quotes, and not starting with -."), "me@jump"));
  await stub.commands.get(TUNNEL_COMMANDS.set)("a");
  assert.strictEqual(live.processes()[0].ssh, "me@jump");
  stub.inputs.push("a", "h2", "1", "", "");
  stub.picks.push("No");
  await stub.commands.get("q-lint.editProcess")("a");
  assert.deepStrictEqual(live.processes()[0], { label: "a", host: "h2", port: 1, tags: [], ssh: "me@jump" });
  await stub.commands.get(TUNNEL_COMMANDS.set)("a", null);
  assert.strictEqual(live.processes()[0].ssh, undefined);
});

// Turned off, only the active connection through a tunnel closed: a
// stream's own connection and its ssh kept running (#1517).
test("turning tunnels off closes a connection apart through one, and its ssh", async (t) => {
  const q = await someQ(t);
  const ssh = stubSsh(t);
  const { live } = await setUp(t, [{ label: "far", host: "127.0.0.1", port: q.port, tags: [], ssh: "bastion" }]);
  const connection = await live.openSeparate(live.processes()[0]);
  t.after(() => connection.abort());
  const [run] = ssh.runs();
  assert.ok(alive(run.pid));
  stub.config.user["connection.sshTunnel.enable"] = false;
  stub.changeConfig("q-lint.connection.sshTunnel.enable");
  assert.strictEqual(connection.isOpen, false);
  for (let i = 0; i < 50 && alive(run.pid); i++) await sleep(50);
  assert.strictEqual(alive(run.pid), false);
});

// ssh was stopped only from the socket's later close: an extension host
// that exited first left ssh running, reparented, its forward open (#1518).
test("deactivating stops ssh at once, not on the connection's later close", async (t) => {
  const q = await someQ(t);
  stubSsh(t);
  const { live, context } = await setUp(t, [{ label: "far", host: "127.0.0.1", port: q.port, tags: [], ssh: "bastion" }]);
  assert.strictEqual(await live.connectTo("far"), true);
  const closes = [];
  const close = SshTunnel.prototype.close;
  SshTunnel.prototype.close = function () {
    closes.push(this.pid);
    return close.call(this);
  };
  t.after(() => (SshTunnel.prototype.close = close));
  for (const d of context.subscriptions) d.dispose?.();
  assert.strictEqual(closes.length, 1);
});
