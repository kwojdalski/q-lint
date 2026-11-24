// The Connected Clients (#1040) and Timers (#1041) views: their answers
// read, the q their changes send, the views made and disposed with their
// switches through the stand-in `vscode` module, and - when QLINT_TEST_Q
// names a q - the handles and TorQ-shaped timer jobs of a real process
// read, a handle closed, a job turned off and \t set, a handle on a guarded
// process refused, and a job change there held by the guard.
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
const { QConnection } = require("../out/qclient.js");
const { ADMIN_COMMANDS, ADMIN_VIEWS, adminOff, readAdmin } = require("../out/admin.js");
const { clientDescription, closeCode, readClients } = require("../out/clients.js");
const { intervalCode, intervalProblem, readTimers, toggleCode } = require("../out/timers.js");
const { AdminView, registerAdminViews } = require("../out/adminviews.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the clients answer: one handle is an atom, several are lists; described plainly", () => {
  assert.deepStrictEqual(readClients({ handle: 5, queued: 0, self: true, kind: "tcp", user: "", host: "", tracked: false }), {
    rows: [{ handle: 5, queued: 0, self: true, kind: "tcp", user: "", host: "" }],
    tracked: false,
  });
  const { rows, tracked } = readClients({ handle: [5, 6], queued: [0, 120], self: [false, true], kind: ["tcp TLS", "unix"], user: ["alice", ""], host: ["10.0.0.1", ""], tracked: true });
  assert.strictEqual(tracked, true);
  assert.deepStrictEqual(rows.map(clientDescription), ["tcp TLS · alice@10.0.0.1", "unix · 120 B queued · this connection"]);
  assert.deepStrictEqual(readClients({ handle: [], queued: [], self: [], kind: [], user: [], host: [], tracked: false }).rows, []);
  assert.throws(() => readClients(42), /handles/);
  assert.strictEqual(closeCode(7.9), "hclose 7i");
});

test("the timers answer, and the q a change sends", () => {
  assert.deepStrictEqual(readTimers({ interval: 0, ts: "", torq: false, timers: [] }), { interval: 0, ts: "", torq: false, jobs: [] });
  const state = readTimers({
    interval: 200,
    ts: "{x}",
    torq: true,
    timers: { id: [1, 2], active: [true, false], period: ["0D00:00:15", "0D00:01"], nextrun: ["a", "b"], lastrun: ["0Np", "0Np"], description: ["flush", "end of day"], func: ["({x+1};1)", "(`.u.end;`x)"] },
  });
  assert.deepStrictEqual(state.jobs[1], { id: 2, active: false, period: "0D00:01", nextrun: "b", lastrun: "0Np", description: "end of day", func: "(`.u.end;`x)" });
  assert.strictEqual(toggleCode(2, true), "update active:1b from `.timer.timer where id=2i");
  assert.strictEqual(intervalCode(500), 'system "t 500"');
  assert.strictEqual(intervalProblem("0"), undefined);
  assert.ok(intervalProblem("-1") && intervalProblem("1.5") && intervalProblem("x"));
});

test("the switches: on by default; views, commands and menus hidden while off", () => {
  const on = readAdmin((_k, f) => f);
  assert.strictEqual(on.clientsView, true);
  assert.strictEqual(on.timerView, true);
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process admin");
  for (const [view, key, ids] of [
    [ADMIN_VIEWS.clients, "connectedClients.enable", [ADMIN_COMMANDS.refreshClients, ADMIN_COMMANDS.closeClient]],
    [ADMIN_VIEWS.timers, "timers.enable", [ADMIN_COMMANDS.refreshTimers, ADMIN_COMMANDS.toggleTimer, ADMIN_COMMANDS.setTimerInterval]],
  ]) {
    assert.strictEqual(section.properties[`q-lint.${key}`].default, true);
    assert.strictEqual(pkg.contributes.views["q-lint"].find((v) => v.id === view).when, `config.q-lint.${key}`);
    for (const id of ids) {
      const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === id);
      for (const m of menus) assert.ok(m.when === "false" || m.when.includes(`config.q-lint.${key}`), `${id}: ${m.when}`);
    }
  }
});

async function setUp(t, processes) {
  stub.reset();
  const context = stub.newContext();
  await context.globalState.update("q-lint.processes", processes);
  const live = new Live(context);
  const views = registerAdminViews(context, live);
  t.after(async () => {
    await stub.commands.get("q-lint.disconnectProcess")?.();
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, views };
}

test("turned off, a view is disposed and its commands refuse, reading nothing; on again without a reload", async (t) => {
  const { live, views } = await setUp(t, []);
  const tree = (id) => stub.trees.filter((v) => v.id === id).at(-1);
  assert.strictEqual(tree(ADMIN_VIEWS.clients).disposed, false);
  let borrowed = 0;
  live.borrow = () => (borrowed++, undefined);
  stub.config.user["connectedClients.enable"] = false;
  stub.config.user["timers.enable"] = false;
  stub.changeConfig("q-lint.connectedClients.enable");
  assert.strictEqual(tree(ADMIN_VIEWS.clients).disposed, true);
  assert.strictEqual(tree(ADMIN_VIEWS.timers).disposed, true);
  await stub.commands.get(ADMIN_COMMANDS.refreshClients)();
  await stub.commands.get(ADMIN_COMMANDS.closeClient)({ handle: 5, contextValue: "client" });
  await stub.commands.get(ADMIN_COMMANDS.toggleTimer)({ job: { id: 1, active: true } });
  await stub.commands.get(ADMIN_COMMANDS.setTimerInterval)(undefined, 5);
  assert.deepStrictEqual(stub.messages.map((m) => m[1]), [adminOff("clientsView"), adminOff("clientsView"), adminOff("timerView"), adminOff("timerView")]);
  assert.strictEqual(borrowed, 0);
  assert.deepStrictEqual(views.clients(), []);
  stub.config.user["connectedClients.enable"] = true;
  stub.changeConfig("q-lint.connectedClients.enable");
  assert.strictEqual(tree(ADMIN_VIEWS.clients).disposed, false);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const TORQ_TIMER = [
  ".timer.timer:([id:`int$()] timerchange:`timestamp$();periodstart:`timestamp$();periodend:`timestamp$();period:`timespan$();funcparam:();lastrun:`timestamp$();nextrun:`timestamp$();active:`boolean$();nextschedule:`short$();description:())",
  "`.timer.timer upsert (1i;.z.p;.z.p;0Wp;0D00:00:15;({x+1};1);0Np;.z.p+0D00:00:15;1b;2h;\"flush\")",
  "`.timer.timer upsert (2i;.z.p;.z.p;0Wp;0D00:01;(`.u.end;`x);0Np;.z.p+0D00:01;0b;2h;\"end of day\")",
].join("\n");

async function startQ(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-admin-"));
  fs.writeFileSync(path.join(dir, "server.q"), `${TORQ_TIMER}\n`);
  const child = spawn(`${Q} ${path.join(dir, "server.q")} -p ${port}`, { shell: true, stdio: ["ignore", "ignore", "pipe"], detached: true });
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
    if (up) return { stop };
    await sleep(100);
  }
  stop();
  throw new Error("q did not start listening");
}

const viewOf = (id) => stub.trees.filter((v) => v.id === id).at(-1).options.treeDataProvider;

test("Connected Clients lists the handles; one is closed after asking; on a guarded process it is refused (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const { live, views } = await setUp(t, [
    { label: "a", host: "127.0.0.1", port, tags: [] },
    { label: "p", host: "127.0.0.1", port, tags: ["prod"] },
  ]);
  const other = await QConnection.open({ host: "127.0.0.1", port });
  t.after(() => other.abort());
  assert.strictEqual(await live.connectTo("a"), true);
  await stub.commands.get(ADMIN_COMMANDS.refreshClients)();
  let rows = views.clients();
  assert.strictEqual(rows.length, 2);
  const self = rows.find((r) => r.contextValue === "clientSelf");
  const theirs = rows.find((r) => r.contextValue === "client");
  assert.match(self.description, /^tcp · this connection$|^this connection$/);
  // Its own handle is not closed from here.
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.closeClient)(self), false);
  // Asked, declined: nothing closed.
  stub.picks.push(undefined);
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.closeClient)(theirs), false);
  assert.strictEqual(other.isOpen, true);
  // On a guarded process: refused without asking.
  assert.strictEqual(await live.connectTo("p"), true);
  await viewOf(ADMIN_VIEWS.clients).refresh(true);
  rows = views.clients();
  const theirsThere = rows.find((r) => r.contextValue === "client");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.closeClient)(theirsThere), false);
  assert.match(stub.messages.at(-1)[1], /p is read-only \(tagged prod\)/);
  assert.strictEqual(other.isOpen, true);
  // Asked and confirmed, on the unguarded one: closed.
  assert.strictEqual(await live.connectTo("a"), true);
  await viewOf(ADMIN_VIEWS.clients).refresh(true);
  const again = views.clients().find((r) => r.contextValue === "client");
  stub.picks.push("Close Handle");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.closeClient)(again), true);
  for (let i = 0; i < 40 && other.isOpen; i++) await sleep(50);
  assert.strictEqual(other.isOpen, false);
  assert.strictEqual(views.clients().length, 1);
});

test("Timers lists \\t and the TorQ jobs; a job is turned off and \\t set; on a guarded process the guard asks (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const { live, views } = await setUp(t, [
    { label: "a", host: "127.0.0.1", port, tags: [] },
    { label: "p", host: "127.0.0.1", port, tags: ["prod"] },
  ]);
  assert.strictEqual(await live.connectTo("p"), true);
  await stub.commands.get(ADMIN_COMMANDS.refreshTimers)();
  let rows = views.timers();
  assert.deepStrictEqual(rows.map((r) => [r.label, r.contextValue]), [["q timer (\\t)", "qTimer"], ["flush", "torqTimerOn"], ["end of day", "torqTimerOff"]]);
  assert.strictEqual(rows[0].description, "off");
  assert.match(rows[1].description, /^every 0D00:00:15\.000000000 · next /);
  // Guarded: the guard asks; declined, unchanged.
  stub.picks.push(undefined);
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.toggleTimer)(rows[1]), false);
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && /would change p/.test(text)), JSON.stringify(stub.messages));
  assert.strictEqual(views.timers()[1].contextValue, "torqTimerOn");
  stub.picks.push(undefined);
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.setTimerInterval)(rows[0], 500), false);
  assert.strictEqual(views.timers()[0].description, "off");
  // Unguarded: done.
  assert.strictEqual(await live.connectTo("a"), true);
  await viewOf(ADMIN_VIEWS.timers).refresh(true);
  rows = views.timers();
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.toggleTimer)(rows[1]), true);
  assert.strictEqual(views.timers()[1].contextValue, "torqTimerOff");
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.setTimerInterval)(views.timers()[0], 500), true);
  assert.match(views.timers()[0].description, /^every 500 ms, no \.z\.ts$/);
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.setTimerInterval)(views.timers()[0], 0), true);
  assert.strictEqual(views.timers()[0].description, "off");
});

test("closing a handle and setting \\t send nothing when another process became active while asked (#1259)", async (t) => {
  const { fakeQ, setUp } = require("./fakeq.js");
  const { q, live, context } = await setUp(t, { answer: null, register: (c, l) => registerAdminViews(c, l) });
  const other = await fakeQ(null);
  t.after(() => other.close());
  await context.globalState.update("q-lint.processes", [
    { label: "dev-a", host: "127.0.0.1", port: q.port, tags: [] },
    { label: "dev-b", host: "127.0.0.1", port: other.port, tags: [] },
  ]);
  live.refreshProcesses();
  const sentCode = (fake) => fake.sent.filter((m) => typeof m === "string" || (Array.isArray(m) && typeof m[0] === "string")).map(String).join("\n");
  await live.connectTo("dev-a");
  stub.picks.push(async () => (await live.connectTo("dev-b"), "Close Handle"));
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.closeClient)({ label: "handle 7", handle: 7, contextValue: "client" }), false);
  assert.ok(stub.messages.some((m) => /dev-a is no longer the active process; nothing was run/.test(m.join(" "))), JSON.stringify(stub.messages));
  await live.connectTo("dev-a");
  stub.inputs.push(async () => (await live.connectTo("dev-b"), "500"));
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.setTimerInterval)({ label: "q timer", interval: 0 }), false);
  for (const fake of [q, other]) {
    assert.doesNotMatch(sentCode(fake), /hclose|system "t/);
  }
});

// A view's switch was read on entry only: turned off while Close Handle's
// question, the interval's box or the guard's question was open, the change
// was still sent, and the view gone was read for again (#2005).
test("turned off while asked, closing a handle, setting \\t and toggling a timer send nothing (#2005)", async (t) => {
  const { setUp } = require("./fakeq.js");
  const { q, live, context } = await setUp(t, { answer: null, register: (c, l) => registerAdminViews(c, l) });
  await context.globalState.update("q-lint.processes", [
    { label: "rdb", host: "127.0.0.1", port: q.port, tags: [] },
    { label: "prd", host: "127.0.0.1", port: q.port, tags: ["prod"] },
  ]);
  live.refreshProcesses();
  const turn = (key, on) => {
    stub.config.user[key] = on;
    stub.changeConfig(`q-lint.${key}`);
  };
  const offThen = (key, answer) => (options) => (turn(key, false), typeof answer === "function" ? answer(options) : answer);
  const yes = "Run Anyway";
  for (const [key, feature, process, run, answers] of [
    ["connectedClients.enable", "clientsView", "rdb", () => stub.commands.get(ADMIN_COMMANDS.closeClient)({ label: "handle 7", handle: 7, contextValue: "client" }), (k) => ({ picks: [offThen(k, "Close Handle")] })],
    ["timers.enable", "timerView", "rdb", () => stub.commands.get(ADMIN_COMMANDS.setTimerInterval)({ label: "q timer", interval: 0 }), (k) => ({ inputs: [offThen(k, "500")] })],
    // On a guarded process the guard asks: turned off at its question.
    ["timers.enable", "timerView", "prd", () => stub.commands.get(ADMIN_COMMANDS.setTimerInterval)(undefined, 500), (k) => ({ picks: [offThen(k, yes)] })],
    ["timers.enable", "timerView", "prd", () => stub.commands.get(ADMIN_COMMANDS.toggleTimer)({ label: "flush", job: { id: 1, active: true } }), (k) => ({ picks: [offThen(k, yes)] })],
  ]) {
    turn(key, true);
    assert.strictEqual(await live.connectTo(process), true);
    await sleep(30);
    const before = q.sent.length;
    stub.messages = [];
    const { picks = [], inputs = [] } = answers(key);
    stub.picks.push(...picks);
    stub.inputs.push(...inputs);
    assert.strictEqual(await run(), false, key);
    assert.deepStrictEqual([stub.picks.length, stub.inputs.length], [0, 0], key);
    assert.deepStrictEqual(q.sent.slice(before), [], key);
    assert.deepStrictEqual(stub.messages.filter(([k]) => k === "info"), [["info", adminOff(feature)]], key);
  }
  // On, the same answers send the change.
  turn("timers.enable", true);
  stub.inputs.push("500");
  assert.strictEqual(await live.connectTo("rdb"), true);
  await stub.commands.get(ADMIN_COMMANDS.setTimerInterval)({ label: "q timer", interval: 0 });
  assert.match(JSON.stringify(q.sent), /system \\"t 500/);
});

test("disconnected while asked, closing a handle connects to nothing and asks for no process (#1259)", async (t) => {
  const { setUp } = require("./fakeq.js");
  const { q, live } = await setUp(t, { register: (c, l) => registerAdminViews(c, l) });
  await live.connectTo("rdb");
  stub.picks.push(async () => (await stub.commands.get("q-lint.disconnectProcess")(), "Close Handle"));
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.closeClient)({ label: "handle 7", handle: 7, contextValue: "client" }), false);
  assert.strictEqual(stub.picks.length, 0);
  assert.strictEqual(live.activeLabel(), undefined);
  assert.ok(stub.messages.some((m) => /rdb is no longer the active process; nothing was run/.test(m.join(" "))), JSON.stringify(stub.messages));
  assert.ok(!q.sent.some((m) => String(m).includes("hclose")));
});

test("a view connected to another process mid-read reads that one, not the first's answer (#1390)", async () => {
  stub.reset();
  let active = "dev-a";
  const pending = new Map();
  const live = {
    activeLabel: () => active,
    borrow: (use) => use({}, { label: active }),
    onDidChange: () => ({ dispose() {} }),
  };
  const read = (_connection, process) => new Promise((resolve, reject) => pending.set(process.label, { resolve, reject }));
  const view = new AdminView("q-lint.test", live, read);
  // dev-a's read is in flight when dev-b connects.
  active = "dev-b";
  const second = view.refresh();
  pending.get("dev-a").reject(new Error("closed"));
  await new Promise((r) => setImmediate(r));
  assert.ok(pending.has("dev-b"), "dev-b is read once dev-a's read is done");
  pending.get("dev-b").resolve({ nodes: [{ label: "handle 9" }] });
  await second;
  assert.deepStrictEqual(view.rows().map((n) => n.label), ["handle 9"]);
  assert.strictEqual(view.view.description, "dev-b");
  assert.strictEqual(view.view.message, undefined);
  view.dispose();
});
