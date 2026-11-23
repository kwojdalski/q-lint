// Scheduled exports (#1039): times and intervals, when a run is due, the
// file each run writes, read-only queries only; Add and Manage through the
// stand-in `vscode` module; off by default with no timer; and, when
// QLINT_TEST_Q names a q, due schedules run on a process and written as
// CSV, Parquet and Excel, and a write refused without being sent.
const { stub, vscode } = require("./vscode_stub.js");
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
const { SCHEDULES_KEY, isDue, outputPath, parseSchedules, parseTimes, parseWhen, scheduleProblem, scheduleText } = require("../out/schedule.js");
const { ScheduledExports } = require("../out/scheduleview.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("times and intervals as typed", () => {
  assert.deepStrictEqual(parseTimes("17:30, 9:00 09:00"), ["09:00", "17:30"]);
  assert.deepStrictEqual(parseTimes("25:00"), { problem: "25:00 is not a time of day, HH:MM." });
  assert.deepStrictEqual(parseTimes(" "), { problem: "Give at least one time, HH:MM." });
  assert.deepStrictEqual(parseWhen("+15"), { every: 15 });
  assert.deepStrictEqual(parseWhen("+0"), { problem: "Whole minutes, 1 to 1440." });
  assert.deepStrictEqual(parseWhen("08:05"), { times: ["08:05"] });
});

test("a run is due once a time has come since the last, or the interval has passed", () => {
  const at = (h, m, s = 0) => new Date(2026, 10, 22, h, m, s);
  const daily = { times: ["09:00", "17:30"], since: at(8, 0).getTime() };
  assert.strictEqual(isDue(daily, at(8, 59)), false);
  assert.strictEqual(isDue(daily, at(9, 0)), true);
  assert.strictEqual(isDue({ ...daily, since: at(9, 0, 10).getTime() }, at(12, 0)), false);
  assert.strictEqual(isDue({ ...daily, since: at(9, 0, 10).getTime() }, at(17, 31)), true);
  const every = { every: 15, since: at(9, 0).getTime() };
  assert.strictEqual(isDue(every, at(9, 14, 59)), false);
  assert.strictEqual(isDue(every, at(9, 15)), true);
});

test("the file a run writes, and which queries may be scheduled", () => {
  const now = new Date(2026, 0, 2, 3, 4, 5);
  assert.strictEqual(outputPath("/x/out.csv", "replace", now), "/x/out.csv");
  assert.strictEqual(outputPath("/x/out.csv", "timestamped", now), "/x/out-20260102-030405.csv");
  assert.strictEqual(outputPath("/x.d/out", "timestamped", now), "/x.d/out-20260102-030405");
  assert.strictEqual(scheduleProblem("select from trade where date=.z.d"), undefined);
  assert.match(scheduleProblem("t:select from trade"), /not read-only: it assigns t/);
  assert.match(scheduleProblem("`:f set 1"), /not read-only/);
  assert.match(scheduleProblem("select from t where sym={{sym}}"), /asks for \{\{sym\}\}/);
  assert.strictEqual(scheduleText({ query: "q", process: "p", format: "csv", every: 5 }), "q on p, every 5 min, as csv");
  assert.deepStrictEqual(parseSchedules([{ id: "a" }, 3, { id: "b", query: "q", process: "p", format: "csv", path: "/f", times: ["9:00"], since: 1 }]).map((s) => [s.id, s.times, s.mode]), [["b", ["09:00"], "replace"]]);
});

test("the switch: off by default, contributed, commands hidden while off", () => {
  assert.strictEqual(readAdmin((_k, f) => f).scheduledExports, false);
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process admin");
  assert.strictEqual(section.properties["q-lint.export.schedule.enable"].default, false);
  for (const id of [ADMIN_COMMANDS.addSchedule, ADMIN_COMMANDS.manageSchedules]) {
    assert.ok(pkg.contributes.commands.some((c) => c.command === id && c.category === "q-lint"));
    const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === id);
    assert.strictEqual(menus.length, 2);
    for (const m of menus) assert.match(m.when, /config\.q-lint\.export\.schedule\.enable/);
  }
});

async function setUp(t, processes, saved, on = true) {
  stub.reset();
  const context = stub.newContext();
  const state = new Map();
  context.workspaceState = { get: (k, d) => (state.has(k) ? structuredClone(state.get(k)) : d), update: async (k, v) => void state.set(k, structuredClone(v)), keys: () => [...state.keys()] };
  await context.globalState.update("q-lint.processes", processes);
  await context.workspaceState.update("q-lint.savedQueries", saved);
  if (on) stub.config.user["export.schedule.enable"] = true;
  const live = new Live(context);
  const schedules = new ScheduledExports(context, live);
  t.after(() => {
    for (const d of context.subscriptions) d.dispose?.();
  });
  return { live, schedules, context };
}

test("off (the default): no timer, nothing runs, and the commands refuse; on again without a reload", async (t) => {
  const { live, schedules, context } = await setUp(t, [{ label: "p", host: "h", port: 1, tags: [] }], [{ name: "q", code: "1+1" }], false);
  let ran = 0;
  live.runApart = async () => (ran++, { ok: true, type: -7, text: ["2"] });
  await context.workspaceState.update(SCHEDULES_KEY, [{ id: "a", query: "q", process: "p", format: "csv", path: "/dev/null", every: 1, mode: "replace", since: 0 }]);
  assert.strictEqual(schedules.ticking, false);
  assert.deepStrictEqual(await schedules.tick(), []);
  assert.strictEqual(await stub.commands.get(ADMIN_COMMANDS.addSchedule)(), undefined);
  await stub.commands.get(ADMIN_COMMANDS.manageSchedules)();
  assert.deepStrictEqual(stub.messages, [["info", adminOff("scheduledExports")], ["info", adminOff("scheduledExports")]]);
  assert.strictEqual(ran, 0);
  stub.config.user["export.schedule.enable"] = true;
  stub.changeConfig("q-lint.export.schedule.enable");
  assert.strictEqual(schedules.ticking, true);
  stub.config.user["export.schedule.enable"] = false;
  stub.changeConfig("q-lint.export.schedule.enable");
  assert.strictEqual(schedules.ticking, false);
});

test("Add Scheduled Export asks each part; a write query cannot be scheduled", async (t) => {
  const { schedules } = await setUp(t, [{ label: "p", host: "h", port: 1, tags: [] }], [
    { name: "trades", code: "select from trade" },
    { name: "writer", code: "x:1" },
  ]);
  stub.picks.push("writer");
  assert.strictEqual(await schedules.add(), undefined);
  assert.match(stub.messages.at(-1)[1], /writer cannot be scheduled: it is not read-only/);
  vscode.window.showSaveDialog = async () => vscode.Uri.file("/tmp/out.parquet");
  stub.picks.push("trades", "p", "Parquet", "Write a new file each run, named with its time");
  stub.inputs.push((options) => {
    assert.strictEqual(options.validateInput("9"), "9 is not a time of day, HH:MM.");
    return "+30";
  });
  const made = await schedules.add();
  assert.deepStrictEqual({ ...made, id: undefined, since: undefined }, { id: undefined, query: "trades", process: "p", format: "parquet", path: "/tmp/out.parquet", every: 30, mode: "timestamped", since: undefined });
  assert.deepStrictEqual(schedules.list().map((s) => s.id), [made.id]);
  // Manage: remove it.
  stub.picks.push(scheduleText(made), "Remove");
  await schedules.manage();
  assert.deepStrictEqual(schedules.list(), []);
});

// tick built its due list once: a run longer than the tick let the next
// tick start a schedule the first then ran again, both writing one file;
// Run Now never asked whether it was running.
test("a schedule never runs twice at once (#1089)", async (t) => {
  const { live, schedules, context } = await setUp(t, [{ label: "p", host: "h", port: 1, tags: [] }], [{ name: "q", code: "1+1" }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-schedule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let out = 0;
  let most = 0;
  const runs = [];
  live.runApart = async (_p, code) => {
    runs.push(code);
    most = Math.max(most, ++out);
    await sleep(60);
    out--;
    return { ok: true, type: -7, text: ["2"] };
  };
  const every = (id, minutes) => ({ id, query: "q", process: "p", format: "csv", path: path.join(dir, `${id}.csv`), every: minutes, mode: "replace", since: 0 });
  await context.workspaceState.update(SCHEDULES_KEY, [every("s1", 1), every("s2", 2)]);
  const at = new Date(2026, 10, 22, 9, 30);
  const first = schedules.tick(at);
  await sleep(20);
  const second = schedules.tick(new Date(at.getTime() + 30_000));
  // Run Now on a schedule that is running says so and runs nothing.
  stub.picks.push(scheduleText(every("s2", 2)), "Run Now");
  await sleep(50);
  await schedules.manage();
  assert.deepStrictEqual([await first, await second], [["s1"], ["s2"]]);
  assert.strictEqual(runs.length, 2);
  assert.strictEqual(most, 2);
  assert.ok(stub.messages.some(([, text]) => /is running/.test(text)), JSON.stringify(stub.messages));
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startQ(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-schedule-"));
  fs.writeFileSync(path.join(dir, "server.q"), "trade:([] sym:`a`b`c; px:1.5 2.5 3.5; n:1 2 3)\n");
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
    if (up) return { stop, dir };
    await sleep(100);
  }
  stop();
  throw new Error("q did not start listening");
}

test("due schedules run on their process and write CSV, Parquet and Excel; a write is refused unsent (real q)", { skip }, async (t) => {
  const port = await freePort();
  const q = await startQ(port);
  t.after(() => q.stop());
  const { live, schedules, context } = await setUp(t, [{ label: "p", host: "127.0.0.1", port, tags: [] }], [
    { name: "trades", code: "select from trade" },
    { name: "sneaky", code: "update px:0 from `trade" },
  ]);
  const out = (f) => path.join(q.dir, "out", f);
  const now = new Date(2026, 10, 22, 9, 30);
  await context.workspaceState.update(SCHEDULES_KEY, [
    { id: "csv", query: "trades", process: "p", format: "csv", path: out("t.csv"), times: ["09:00"], mode: "replace", since: new Date(2026, 10, 22, 8).getTime() },
    { id: "pq", query: "trades", process: "p", format: "parquet", path: out("t.parquet"), every: 5, mode: "timestamped", since: 0 },
    { id: "xl", query: "trades", process: "p", format: "xlsx", path: out("t.xlsx"), every: 5, mode: "replace", since: 0 },
    { id: "later", query: "trades", process: "p", format: "csv", path: out("later.csv"), times: ["10:00"], mode: "replace", since: 0 },
    { id: "bad", query: "sneaky", process: "p", format: "csv", path: out("bad.csv"), every: 1, mode: "replace", since: 0 },
  ]);
  assert.deepStrictEqual(await schedules.tick(now), ["csv", "pq", "xl", "bad"]);
  assert.strictEqual(fs.readFileSync(out("t.csv"), "utf8").trim(), "sym,px,n\na,1.5,1\nb,2.5,2\nc,3.5,3");
  assert.strictEqual(fs.readFileSync(out("t-20261122-093000.parquet")).subarray(0, 4).toString(), "PAR1");
  assert.strictEqual(fs.readFileSync(out("t.xlsx")).subarray(0, 2).toString(), "PK");
  assert.ok(!fs.existsSync(out("later.csv")) && !fs.existsSync(out("bad.csv")));
  const last = Object.fromEntries(schedules.list().map((s) => [s.id, s.last ?? ""]));
  assert.match(last.csv, /^wrote /);
  assert.match(last.bad, /sneaky was not run: it is not read-only/);
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && /not read-only/.test(text)));
  // Not due again until the next time or interval.
  assert.deepStrictEqual(await schedules.tick(new Date(2026, 10, 22, 9, 30, 30)), []);
  // The table was not changed.
  const answer = await live.runApart({ label: "p", host: "127.0.0.1", port, tags: [] }, "sum exec px from trade");
  assert.deepStrictEqual(answer.text, ["7.5"]);
});
