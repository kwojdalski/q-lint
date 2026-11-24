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
const { SCHEDULES_KEY, incomplete, isDue, outputPath, parseSchedules, parseTimes, parseWhen, scheduleProblem, scheduleText } = require("../out/schedule.js");
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
  // Last run while the clock was a day ahead: due once now (#1625).
  const ahead = at(12, 0).getTime() + 86_400_000;
  assert.strictEqual(isDue({ every: 15, since: ahead }, at(12, 0)), true);
  assert.strictEqual(isDue({ times: ["09:00"], since: ahead }, at(12, 0)), true);
});

// Only today's times were looked at, so a time missed before midnight -
// the laptop asleep, VS Code closed - was never run, while one missed
// earlier the same day was.
test("a time missed overnight is due the next day, once (#1928)", () => {
  const day = (d, h, m, s = 0) => new Date(2026, 10, d, h, m, s);
  const nightly = { times: ["23:30"], since: day(23, 18, 0).getTime() };
  assert.strictEqual(isDue(nightly, day(23, 23, 29)), false);
  assert.strictEqual(isDue(nightly, day(23, 23, 45)), true);
  assert.strictEqual(isDue(nightly, day(24, 0, 0, 20)), true);
  assert.strictEqual(isDue(nightly, day(24, 8, 0)), true);
  // Days missed, a weekend asleep: still due, and once it has run, not again until tonight.
  assert.strictEqual(isDue(nightly, day(27, 8, 0)), true);
  const ran = { ...nightly, since: day(27, 8, 0).getTime() };
  assert.strictEqual(isDue(ran, day(27, 8, 0, 30)), false);
  assert.strictEqual(isDue(ran, day(27, 23, 29)), false);
  assert.strictEqual(isDue(ran, day(27, 23, 30)), true);
  // A time before the schedule was made is not one it missed.
  assert.strictEqual(isDue({ times: ["23:30"], since: day(24, 0, 10).getTime() }, day(24, 8, 0)), false);
  // The month's first day looks back into the month before.
  assert.strictEqual(isDue({ times: ["23:30"], since: new Date(2026, 10, 30, 18, 0).getTime() }, new Date(2026, 11, 1, 7, 0)), true);
});

test("a missed export is run once when noticed, and not when deleted or turned off meanwhile (#1928)", async (t) => {
  const { live, schedules, context } = await setUp(t, [{ label: "p", host: "h", port: 1, tags: [] }], [{ name: "q", code: "1+1" }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-schedule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let runs = 0;
  // The first to run deletes the other, as the user might while it runs.
  live.runApart = async () => {
    runs++;
    await context.workspaceState.update(SCHEDULES_KEY, parseSchedules(context.workspaceState.get(SCHEDULES_KEY)).filter((x) => x.id !== "gone"));
    return { ok: true, type: -7, text: ["2"] };
  };
  const nightly = (id) => ({ id, query: "q", process: "p", format: "csv", path: path.join(dir, `${id}.csv`), times: ["23:30"], mode: "timestamped", since: new Date(2026, 10, 20, 18, 0).getTime() });
  await context.workspaceState.update(SCHEDULES_KEY, [nightly("s1"), nightly("gone")]);
  // Asleep from the 20th to the 24th: four nights missed, one run.
  const woke = new Date(2026, 10, 24, 8, 0);
  assert.deepStrictEqual(await schedules.tick(woke), ["s1"]);
  assert.deepStrictEqual(await schedules.tick(new Date(woke.getTime() + 30_000)), []);
  assert.deepStrictEqual(await schedules.tick(new Date(2026, 10, 24, 23, 29)), []);
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(fs.readdirSync(dir), ["s1-20261124-080000.csv"]);
  // Turned off, a missed one waits.
  await context.workspaceState.update(SCHEDULES_KEY, [nightly("s2")]);
  stub.config.user["export.schedule.enable"] = false;
  stub.changeConfig("q-lint.export.schedule.enable");
  assert.deepStrictEqual(await schedules.tick(woke), []);
  assert.strictEqual(runs, 1);
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

test("a timestamped file in the hour clocks go back is not overwritten by the repeat (#1626)", (t) => {
  const was = process.env.TZ;
  process.env.TZ = "America/New_York";
  t.after(() => (was === undefined ? delete process.env.TZ : (process.env.TZ = was)));
  const first = outputPath("/x/out.csv", "timestamped", new Date("2026-11-01T05:30:00Z"));
  const second = outputPath("/x/out.csv", "timestamped", new Date("2026-11-01T06:30:00Z"));
  assert.deepStrictEqual([first, second], ["/x/out-20261101-013000-0400.csv", "/x/out-20261101-013000-0500.csv"]);
  assert.strictEqual(outputPath("/x/out.csv", "timestamped", new Date("2026-07-01T12:00:00Z")), "/x/out-20260701-080000.csv");
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

test("a saved query's and a process's $(name) are text in the picks, and the schedule keeps their own names (#1314)", async (t) => {
  const { schedules } = await setUp(t, [{ label: "p$(zap)", host: "h", port: 1, tags: [] }], [{ name: "t$(bug)", code: "select from trade" }]);
  vscode.window.showSaveDialog = async () => vscode.Uri.file("/tmp/out.csv");
  const seen = [];
  const pick = (want) => (o) => (seen.push(o.items.map((i) => (typeof i === "string" ? i : i.label))), o.items.find((i) => (typeof i === "string" ? i : i.label) === want));
  stub.picks.push(pick("t\\$(bug)"), pick("p\\$(zap)"), "CSV", "Write a new file each run, named with its time");
  stub.inputs.push("+30");
  const made = await schedules.add();
  assert.deepStrictEqual(seen, [["t\\$(bug)"], ["p\\$(zap)"]]);
  assert.strictEqual(made.query, "t$(bug)");
  assert.strictEqual(made.process, "p$(zap)");
});

// A quick pick draws $(name) in a detail as it does in a label: the two
// file paths of step 6 and a schedule's last outcome went in as written.
test("a path's and a last outcome's $(name) are text in the picks' details (#1929)", async (t) => {
  const { schedules, context } = await setUp(t, [{ label: "p", host: "h", port: 1, tags: [] }], [{ name: "trades", code: "select from trade" }]);
  vscode.window.showSaveDialog = async () => vscode.Uri.file("/data/$(pwd)/out.csv");
  let details;
  stub.picks.push("trades", "p", "CSV", (o) => ((details = o.items.map((i) => i.detail)), o.items[0]));
  stub.inputs.push("+30");
  const made = await schedules.add();
  assert.strictEqual(made.path, "/data/$(pwd)/out.csv");
  assert.strictEqual(details[0], "/data/\\$(pwd)/out.csv");
  assert.match(details[1], /^\/data\/\\\$\(pwd\)\/out-\d{8}-\d{6}.*\.csv$/);
  await context.workspaceState.update(SCHEDULES_KEY, [{ ...made, last: "failed at 09:00: p answered '$(flame) is not a table" }]);
  let listed;
  stub.picks.push((o) => ((listed = o.items.map((i) => i.detail)), undefined));
  await schedules.manage();
  assert.deepStrictEqual(listed, ["failed at 09:00: p answered '\\$(flame) is not a table"]);
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

test("a scheduled export asks for the whole result, and writes nothing when rows are missing (#1613)", async (t) => {
  const { live, schedules, context } = await setUp(t, [{ label: "p", host: "h", port: 1, tags: [] }], [{ name: "q", code: "select from t" }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-schedule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asked = [];
  const grid = { count: 250000, keys: 0, names: ["a"], types: [7], cells: [["1", "2"]], raw: [[1, 2]], rank: [[0, 1]] };
  live.runApart = async (_p, _code, _signal, options) => (asked.push(options), { ok: true, type: 98, text: [], grid });
  const file = path.join(dir, "out.csv");
  await context.workspaceState.update(SCHEDULES_KEY, [{ id: "s1", query: "q", process: "p", format: "csv", path: file, every: 1, mode: "replace", since: 0 }]);
  await schedules.tick(new Date(2026, 10, 22, 9, 30));
  assert.deepStrictEqual(asked, [{ whole: true, unattended: true }]);
  assert.strictEqual(fs.existsSync(file), false);
  assert.match(parseSchedules(context.workspaceState.get(SCHEDULES_KEY))[0].last, /failed .*nothing was written: only 2 of its 250000 rows came back/);
  assert.strictEqual(incomplete({ count: 2, cells: [["1", "2"]] }), undefined);
  assert.strictEqual(incomplete({ count: 0, cells: [] }), undefined);
});

test("turned off while a tick runs, the schedules still due wait (#1296)", async (t) => {
  const { live, schedules, context } = await setUp(t, [{ label: "p", host: "h", port: 1, tags: [] }], [{ name: "q", code: "1+1" }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-schedule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let runs = 0;
  live.runApart = async () => {
    runs++;
    stub.config.user["export.schedule.enable"] = false;
    stub.changeConfig("q-lint.export.schedule.enable");
    return { ok: true, type: -7, text: ["2"] };
  };
  const every = (id) => ({ id, query: "q", process: "p", format: "csv", path: path.join(dir, `${id}.csv`), every: 1, mode: "replace", since: 0 });
  await context.workspaceState.update(SCHEDULES_KEY, [every("s1"), every("s2"), every("s3")]);
  assert.deepStrictEqual(await schedules.tick(new Date(2026, 10, 22, 9, 30)), ["s1"]);
  assert.strictEqual(runs, 1);
  assert.strictEqual(schedules.ticking, false);
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
    // Made this morning: its time has not come since (one never run is owed yesterday's, #1928).
    { id: "later", query: "trades", process: "p", format: "csv", path: out("later.csv"), times: ["10:00"], mode: "replace", since: new Date(2026, 10, 22, 8).getTime() },
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

// Replaced in place, a reader saw an empty or half export, and a write that
// failed lost the last good one (#1539).
test("an export is written whole beside the file and renamed over it; a failed write leaves the old one", async () => {
  const { writeWhole } = require("../out/schedule.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-whole-"));
  const file = path.join(dir, "out.csv");
  fs.writeFileSync(file, "old\n");
  await writeWhole(file, Buffer.from("new\n"));
  assert.strictEqual(fs.readFileSync(file, "utf8"), "new\n");
  assert.deepStrictEqual(fs.readdirSync(dir), ["out.csv"], "no file left beside it");
  // The rename fails (a folder where the file is): the old one stays, the
  // temporary file goes.
  const blocked = path.join(dir, "blocked.csv");
  fs.mkdirSync(path.join(blocked, "x"), { recursive: true });
  await assert.rejects(writeWhole(blocked, Buffer.from("x")));
  assert.ok(fs.statSync(blocked).isDirectory());
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["blocked.csv", "out.csv"]);
});

// v0.36 deleted a saved query or a process and left what ran it: the next
// one given the name was then run on a timer nobody set for it (#1879).
test("a schedule and a tile left by a deleted saved query go when another takes its name", async (t) => {
  const { SavedQueries } = require("../out/savedqueriesview.js");
  if (!vscode.Uri.from) vscode.Uri.from = (c) => ({ ...c, toString: () => `${c.scheme}:${c.path}` });
  const { live, schedules, context } = await setUp(t, [{ label: "p", host: "h", port: 1, tags: [] }], [{ name: "kept", code: "1+1" }, { name: "other", code: "3" }]);
  const sent = [];
  live.runApart = async (_p, code) => (sent.push(code), { ok: true, type: -7, text: ["2"] });
  const schedule = (id, query) => ({ id, query, process: "p", format: "csv", path: "/dev/null", times: ["23:59"], mode: "replace", since: Date.now() });
  const tile = (id, query) => ({ id, query, process: "p", view: "table", refresh: 30 });
  await context.workspaceState.update(SCHEDULES_KEY, [schedule("a", "daily"), schedule("b", "kept"), schedule("c", "weekly")]);
  await context.workspaceState.update("q-lint.dashboards", [{ name: "Desk", columns: 2, tiles: [tile("t1", "daily"), tile("t2", "kept"), tile("t3", "weekly")] }]);
  const saved = new SavedQueries(context, live);
  await saved.save({ name: "daily", code: "select count i from trade" });
  assert.deepStrictEqual(schedules.list().map((s) => s.id), ["b", "c"]);
  assert.deepStrictEqual(context.workspaceState.get("q-lint.dashboards")[0].tiles.map((x) => x.id), ["t2", "t3"]);
  assert.deepStrictEqual(stub.messages.at(-1), [
    "info",
    'q-lint: saved the query "daily". The 1 scheduled export(s) and 1 dashboard tile(s) an earlier query of that name left were deleted.',
  ]);
  // A rename takes a name as a save does; what the renamed query had moves with it.
  await context.workspaceState.update(SCHEDULES_KEY, [...schedules.list(), schedule("d", "other")]);
  await saved.renameQuery({ name: "other", code: "3" }, "weekly");
  assert.deepStrictEqual(schedules.list().map((s) => [s.id, s.query]), [["b", "kept"], ["d", "weekly"]]);
  assert.deepStrictEqual(context.workspaceState.get("q-lint.dashboards")[0].tiles.map((x) => x.id), ["t2"]);
  assert.match(stub.messages.at(-1)[1], /1 scheduled export\(s\) and 1 dashboard tile\(s\) an earlier query of that name left were deleted/);
  // A name nothing was left under says nothing more.
  await saved.save({ name: "fresh", code: "4" });
  assert.deepStrictEqual(stub.messages.at(-1), ["info", 'q-lint: saved the query "fresh".']);
  assert.deepStrictEqual(sent, []);
});

test("a schedule and a tile left by a deleted process go when another takes its label", async (t) => {
  const { live, schedules, context } = await setUp(t, [{ label: "p", host: "h", port: 1, tags: [] }], [{ name: "daily", code: "1+1" }]);
  const sent = [];
  live.runApart = async (process, code) => (sent.push([process.label, code]), { ok: true, type: -7, text: ["2"] });
  const schedule = (id, process) => ({ id, query: "daily", process, format: "csv", path: "/dev/null", every: 1, mode: "replace", since: 0 });
  const tile = (id, process) => ({ id, query: "daily", process, view: "table", refresh: 30 });
  await context.workspaceState.update(SCHEDULES_KEY, [schedule("a", "prod"), schedule("b", "p"), schedule("c", "uat")]);
  await context.workspaceState.update("q-lint.dashboards", [{ name: "Desk", columns: 2, tiles: [tile("t1", "prod"), tile("t2", "p"), tile("t3", "uat")] }]);
  stub.inputs.push("prod", "prod.example.com", "5010", "", "");
  stub.picks.push("No");
  await stub.commands.get("q-lint.addProcess")();
  assert.deepStrictEqual(live.processes().map((p) => p.label), ["p", "prod"]);
  assert.deepStrictEqual(schedules.list().map((s) => s.id), ["b", "c"]);
  assert.deepStrictEqual(context.workspaceState.get("q-lint.dashboards")[0].tiles.map((x) => x.id), ["t2", "t3"]);
  assert.deepStrictEqual(stub.messages.at(-1), [
    "info",
    'q-lint: the 1 scheduled export(s) and 1 dashboard tile(s) an earlier process labelled "prod" left were deleted.',
  ]);
  // A workspace not open drops its own when it opens, as for a deleted process (#1749).
  assert.deepStrictEqual(context.globalState.get("q-lint.processRelabels"), [{ n: 1, from: "prod", to: null }]);
  // A rename takes a label as Add Process does; what the renamed process had moves with it.
  stub.inputs.push("uat", "h", "1", "", "");
  stub.picks.push("No");
  await stub.commands.get("q-lint.editProcess")("p");
  assert.deepStrictEqual(schedules.list().map((s) => [s.id, s.process]), [["b", "uat"]]);
  assert.deepStrictEqual(context.workspaceState.get("q-lint.dashboards")[0].tiles.map((x) => [x.id, x.process]), [["t2", "uat"]]);
  // Only what is left is run.
  await schedules.tick(new Date());
  assert.deepStrictEqual(sent, [["uat", "1+1"]]);
});
