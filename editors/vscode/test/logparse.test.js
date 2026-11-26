// The log viewer's reading of lines (#1004): TorQ's `.lg.format` lines, its
// -jsonlogs and usage logs, and plain q output, each captured from a real
// process (TorQ v5.2.12 logs of this tree's processes, host renamed; q's
// own error output from KDB-X and PeachQ), and the entries, filters and
// merge built from them.
const test = require("node:test");
const assert = require("node:assert");
const { EntryBuilder, LEVELS, matches, merge, parseLine, processFromFile, readLogViewer, timeOf, timeOfDay, validBound, filterText } = require("../out/logparse.js");

const TORQ_INFO = "2026.11.07D00:00:00.266014000|host1|feed|kafka_feed1|INFO|logging|creating alias using command ln -sf out_kafka_feed1_2026_11_07_00_00_00_254.log out_kafka_feed1.log";
const TORQ_ERROR = "2026.11.07D12:43:29.643228000|host1|etl|kafka|ERROR|kafka|bootstrap stage failed: no broker answered stage=`bootstrap kind=`all_down";
const TORQ_ERR = "2026.11.07D12:43:30.000000000|host1|rdb|rdb1|ERR|fileload|failed to load x.q : 'type";
const TORQ_WARN = "2026.11.07D12:43:31.000000000|host1|rdb|rdb1|WARN|resolveandcheckenvvar|warning, could not resolve environment variable: KDBX";
const USAGE = '2026.11.05D00:00:00.130509000|4238852|68516|`ps|`feed|`kafka_feed1|"c"|2130706433i|`krzysztofwojdalski|0i|"`.usage.rolllogauto`"|183214688 268435456 268435456 0 0|10|""';
const USAGE_E = '2026.11.05D00:00:01.000000000|4238854|12|`pg|`rdb|`rdb1|"e"|2130706433i|`me|7i|"f 1"|1 2 3 0 0|10|"type"';
const JSON_LINE = '{"time":"2026-11-07T12:43:29.643228000","host":"host1","proctype":"rdb","proc":"rdb1","loglevel":"WARN","id":"x","message":"slow"}';
const BANNER = "################################################################################";
// q's own output: KDB-X, then PeachQ, for `f:{x+`a}` called at load.
const KDBX = ["2", "2026.11.21D20:41:03.930014000 INFO starting", "2026.11.21D20:41:03.930024000 WARN low disk", "`hello", "'2026.11.21T20:41:03.930 type", "  [3]  /w/plain.q:4: f:{x+`a}", "                      ^", "  [2]  /w/plain.q:6: f 1", "                    ^"];
const PEACHQ = ["2", "2026.11.21D20:41:03.946016000 INFO starting", "2026.11.21D20:41:03.946027000 WARN low disk", "`hello", "'type", "  [2]  /w/plain.q:4: f:{x+`a}", "                      ^"];

test("TorQ lines give their level, process, time and where those are", () => {
  const p = parseLine(TORQ_INFO);
  assert.deepStrictEqual([p.kind, p.level, p.process, p.time], ["torq", "INFO", "kafka_feed1", Date.UTC(2026, 10, 7, 0, 0, 0, 266)]);
  assert.strictEqual(TORQ_INFO.slice(...p.timeSpan), "2026.11.07D00:00:00.266014000");
  assert.strictEqual(TORQ_INFO.slice(...p.levelSpan), "INFO");
  assert.deepStrictEqual([parseLine(TORQ_ERROR).level, parseLine(TORQ_ERROR).process], ["ERROR", "kafka"]);
  assert.strictEqual(parseLine(TORQ_ERR).level, "ERROR");
  assert.strictEqual(parseLine(TORQ_WARN).level, "WARN");
  assert.strictEqual(TORQ_WARN.slice(...parseLine(TORQ_WARN).levelSpan), "WARN");
  // A banner line is a line of its own, with no level.
  assert.deepStrictEqual(parseLine(BANNER), { kind: "q" });
});

test("TorQ usage and JSON logs", () => {
  assert.deepStrictEqual([parseLine(USAGE).kind, parseLine(USAGE).level, parseLine(USAGE).process], ["torq-usage", "INFO", "kafka_feed1"]);
  assert.deepStrictEqual([parseLine(USAGE_E).level, parseLine(USAGE_E).process], ["ERROR", "rdb1"]);
  const j = parseLine(JSON_LINE);
  assert.deepStrictEqual([j.kind, j.level, j.process, j.time], ["torq-json", "WARN", "rdb1", Date.UTC(2026, 10, 7, 12, 43, 29, 643)]);
  assert.strictEqual(parseLine('{"loglevel": broken').kind, "q");
  // A usage log with -jsonlogs, as TorQ's logusage.q format writes it in KDB-X (#2417).
  const usage = (type) => `{"p":"2026-11-25T12:00:00.000000000","id":7,"time":"0D00:00:00.000012000","zcmd":"pg","proctype":"rdb","procname":"rdb1","type":"${type}","ip":2130706433,"user":"bob","handle":12,"txtc":"1+\x60a","meminfo":[0,0,0,0,0,0],"length":5,"errorcheck":"type","level":"USAGE"}`;
  assert.deepStrictEqual(parseLine(usage("e")), { kind: "torq-usage", level: "ERROR", process: "rdb1", time: Date.UTC(2026, 10, 25, 12) });
  assert.deepStrictEqual(parseLine(usage("c")).level, "INFO");
});

test("plain q output: a q error with or without KDB-X's timestamp, levels near the start, and continuations", () => {
  const kx = KDBX.map(parseLine);
  assert.deepStrictEqual(kx.map((p) => p.kind), ["q", "q", "q", "q", "q", "cont", "cont", "cont", "cont"]);
  assert.deepStrictEqual(kx.map((p) => p.level), [undefined, "INFO", "WARN", undefined, "ERROR", undefined, undefined, undefined, undefined]);
  // KDB-X's error stamp is local time (#2595).
  assert.strictEqual(kx[4].time, new Date(2026, 10, 21, 20, 41, 3, 930).getTime());
  assert.strictEqual(KDBX[1].slice(...kx[1].timeSpan), "2026.11.21D20:41:03.930014000");
  assert.strictEqual(KDBX[1].slice(...kx[1].levelSpan), "INFO");
  const pq = PEACHQ.map(parseLine);
  assert.deepStrictEqual([pq[4].kind, pq[4].level, pq[4].time], ["q", "ERROR", undefined]);
  // Level words: in capitals, or bracketed, among the first three words.
  assert.strictEqual(parseLine("2026-11-21 12:00:00 [error] disk").level, "ERROR");
  assert.strictEqual(parseLine("12:00 level=debug x").level, "DEBUG");
  assert.strictEqual(parseLine("2026.11.21T12:00:00.000 the error was fine").level, undefined);
  assert.strictEqual(parseLine("one two three ERROR").level, undefined);
  assert.strictEqual(parseLine("2026.11.21 rdb1 FATAL out of memory").level, "ERROR");
});

test("KDB-X's error stamp is read as local time, beside TorQ's UTC lines (#2595)", (t) => {
  const tz = process.env.TZ;
  t.after(() => (tz === undefined ? delete process.env.TZ : (process.env.TZ = tz)));
  process.env.TZ = "America/New_York";
  const lg = parseLine("2026.11.25D21:24:18.241112000|mac.lan|rdb|rdb1|ERR|init|about to fail");
  const err = parseLine("'2026.11.25T16:24:19.278 type");
  assert.strictEqual(lg.time, Date.UTC(2026, 10, 25, 21, 24, 18, 241));
  assert.strictEqual(err.time, Date.UTC(2026, 10, 25, 21, 24, 19, 278));
  assert.ok(err.time > lg.time);
  // Summer time: four hours behind UTC, not five.
  assert.strictEqual(parseLine("'2026.07.01T12:00:00.000 type").time, Date.UTC(2026, 6, 1, 16));
});

// The bounds are the times the user reads off the lines, and were held
// against the error's time in UTC: "16:00 to 17:00" hid the 16:24 error.
test("a time filter's bounds are held against the time a KDB-X error's line writes, its local time (#3043)", (t) => {
  const tz = process.env.TZ;
  t.after(() => (tz === undefined ? delete process.env.TZ : (process.env.TZ = tz)));
  process.env.TZ = "America/New_York";
  const out = [];
  const b = new EntryBuilder("/l/err_rdb1.log", (e) => out.push(e));
  ["2026.11.25D21:24:18.241112000|mac.lan|rdb|rdb1|ERR|init|about to fail", "'2026.11.25T16:24:19.278 type", "  [0] f 1"].forEach((l) => b.push(l));
  b.flush();
  const pass = (filter) => out.filter((x) => matches(x, { levels: [], processes: [], ...filter })).map((x) => x.lines[0].slice(0, 12));
  assert.deepStrictEqual(pass({ from: "16:00", to: "17:00" }), ["'2026.11.25T"]);
  assert.deepStrictEqual(pass({ to: "2026.11.25D16:30" }), ["'2026.11.25T"]);
  assert.deepStrictEqual(pass({ from: "2026.11.25D16:24:19", to: "2026.11.25D16:24:20" }), ["'2026.11.25T"]);
  // TorQ's line is UTC as written, and is filtered as it reads.
  assert.deepStrictEqual(pass({ from: "21:00", to: "22:00" }), ["2026.11.25D2"]);
  // The entries are still ordered by when they happened.
  assert.deepStrictEqual(out.map((x) => [x.time, x.written]), [[Date.UTC(2026, 10, 25, 21, 24, 18, 241), undefined], [Date.UTC(2026, 10, 25, 21, 24, 19, 278), Date.UTC(2026, 10, 25, 16, 24, 19, 278)]]);
  // Where local time is UTC the line's time is the time: nothing more is kept.
  process.env.TZ = "UTC";
  assert.strictEqual("written" in parseLine("'2026.11.25T16:24:19.278 type"), false);
});

test("times and times of day", () => {
  assert.strictEqual(timeOf("2026.11.21"), Date.UTC(2026, 10, 21));
  assert.strictEqual(timeOf("2026-11-21 08:09"), Date.UTC(2026, 10, 21, 8, 9));
  assert.strictEqual(timeOf("2026.11.21D08:09:10.5"), Date.UTC(2026, 10, 21, 8, 9, 10, 500));
  assert.strictEqual(timeOf("21/11/2026"), undefined);
  assert.strictEqual(timeOfDay("08:09:10.25"), ((8 * 60 + 9) * 60 + 10) * 1000 + 250);
  assert.strictEqual(timeOfDay("25:00"), undefined);
  assert.ok(validBound("") && validBound("12:30") && validBound("2026.11.21D12:00:00") && !validBound("noon"));
});

test("a TorQ log file names its process", () => {
  assert.strictEqual(processFromFile("/l/out_kafka_feed1_2026_11_07_00_00_00_254.log"), "kafka_feed1");
  assert.strictEqual(processFromFile("err_rdb1.log"), "rdb1");
  assert.strictEqual(processFromFile("usage_markout1_2026.11.01.log"), "markout1");
  assert.strictEqual(processFromFile("C:\\logs\\server.log"), "server");
  assert.strictEqual(processFromFile("q.out"), "q");
});

/// The entries `lines` make, from `file`.
function entries(lines, file = "/l/rdb1.log") {
  const out = [];
  const b = new EntryBuilder(file, (e) => out.push(e));
  lines.forEach((l) => b.push(l));
  b.flush();
  return out;
}

test("a q error and its backtrace are one entry; each entry has a process", () => {
  const e = entries(KDBX, "/l/plain.log");
  assert.deepStrictEqual(e.map((x) => x.lines.length), [1, 1, 1, 1, 5]);
  assert.deepStrictEqual(e.map((x) => x.level), [undefined, "INFO", "WARN", undefined, "ERROR"]);
  assert.ok(e.every((x) => x.process === "plain"));
  const t = entries([TORQ_INFO, TORQ_ERROR, "  continued"]);
  assert.deepStrictEqual(t.map((x) => [x.process, x.lines.length]), [["kafka_feed1", 1], ["kafka", 2]]);
  // A continuation with nothing before it starts an entry of its own.
  assert.deepStrictEqual(entries(["  lone"]).map((x) => x.lines), [["  lone"]]);
});

test("filters by level, process, time and text", () => {
  const e = entries([BANNER, TORQ_INFO, TORQ_ERROR, TORQ_ERR, TORQ_WARN]);
  const pass = (filter) => e.filter((x) => matches(x, { levels: [], processes: [], ...filter })).map((x) => x.lines[0].slice(0, 30));
  assert.strictEqual(pass({}).length, 5);
  assert.deepStrictEqual(pass({ levels: ["ERROR"] }).length, 2);
  assert.deepStrictEqual(pass({ levels: ["WARN", "INFO"] }).length, 2);
  // Two rdb1 lines, and the banner, which names no process: the file's.
  assert.deepStrictEqual(pass({ processes: ["rdb1"] }).length, 3);
  assert.deepStrictEqual(pass({ processes: ["kafka", "kafka_feed1"] }).length, 2);
  assert.strictEqual(entries([BANNER])[0].process, "rdb1");
  // A time of day, and a full time; an entry with no time is left out.
  assert.deepStrictEqual(pass({ from: "12:43:30" }).length, 2);
  assert.deepStrictEqual(pass({ from: "2026.11.07D12:00", to: "2026.11.07D12:43:30" }).length, 2);
  assert.deepStrictEqual(pass({ to: "01:00" }).length, 1);
  assert.deepStrictEqual(pass({ text: "BROKER" }).length, 1);
  assert.strictEqual(filterText({ levels: ["ERROR"], processes: ["rdb1"], from: "12:00", text: "x" }), 'ERROR · rdb1 · 12:00-... · "x"');
  assert.strictEqual(filterText({ levels: [], processes: [] }), "");
});

test("entries of several files are merged by time, each file's order kept", () => {
  const a = entries(["2026.11.07D10:00:00.000000000 INFO a1", "notime", "2026.11.07D12:00:00.000000000 INFO a2"], "/l/a.log");
  const b = entries(["2026.11.07D11:00:00.000000000|h|hdb|hdb1|INFO|x|b1"], "/l/b.log");
  assert.deepStrictEqual(merge([a, b]).map((x) => x.lines[0].split(/[| ]/).pop()), ["a1", "notime", "b1", "a2"]);
  assert.strictEqual(merge([a]), a);
});

test("the switch and the line cap", () => {
  assert.deepStrictEqual(readLogViewer((_k, f) => f), { enabled: true, maxLines: 10000 });
  assert.deepStrictEqual(readLogViewer((k, f) => (k.endsWith("maxLines") ? 50 : f)).maxLines, 10000);
  assert.deepStrictEqual(readLogViewer((k, f) => (k.endsWith("enable") ? false : f)).enabled, false);
  assert.deepStrictEqual(LEVELS, ["ERROR", "WARN", "INFO", "DEBUG"]);
});

test("an impossible date or time is no time, and no filter bound (#1436)", () => {
  assert.strictEqual(timeOf("2026.02.30D25:61:00"), undefined);
  assert.strictEqual(timeOf("2026.02.28D23:59:60"), undefined);
  assert.strictEqual(timeOf("2026.13.01"), undefined);
  assert.strictEqual(validBound("2026.13.45"), false);
  assert.strictEqual(validBound("2026.02.30"), false);
  // A leap day is a day.
  assert.strictEqual(new Date(timeOf("2028.02.29D23:59:59.5")).toISOString(), "2028-02-29T23:59:59.500Z");
  assert.strictEqual(validBound("2026.02.28"), true);
});

test("a date alone as a time bound is that whole day (#2418)", () => {
  const e = entries(["2026.11.21D09:00:00.000000000|h|rdb|rdb1|INFO|x|a", "2026.11.21D17:30:00.000000000|h|rdb|rdb1|INFO|x|b", "2026.11.22D09:00:00.000000000|h|rdb|rdb1|INFO|x|c"]);
  const pass = (filter) => e.filter((x) => matches(x, { levels: [], processes: [], ...filter })).map((x) => x.lines[0].split("|").pop());
  assert.deepStrictEqual(pass({ from: "2026.11.21", to: "2026.11.21" }), ["a", "b"]);
  assert.deepStrictEqual(pass({ to: "2026.11.21" }), ["a", "b"]);
  assert.deepStrictEqual(pass({ from: "2026.11.22" }), ["c"]);
  assert.deepStrictEqual(pass({ to: "2026-11-20" }), []);
  // A full time is still that instant.
  assert.deepStrictEqual(pass({ to: "2026.11.21D09:00" }), ["a"]);
});

test("a multi-line TorQ message is one entry, its unindented lines too (#2419)", () => {
  // `.lg.format` in KDB-X with the message
  // "failed to insert: 'type\n  [2]  upd:{x insert y}\n               ^\nrolled back".
  const e = entries([
    "2026.11.21D09:00:00.000000000|h|rdb|rdb1|INFO|x|a",
    "2026.11.21D17:30:00.000000000|h|rdb|rdb1|ERROR|upd|failed to insert: 'type",
    "  [2]  upd:{x insert y}",
    "               ^",
    "rolled back",
    "'type",
    "2026.11.21D17:31:00.000000000|h|rdb|rdb1|INFO|x|c",
  ]);
  assert.deepStrictEqual(e.map((x) => [x.level, x.lines.length]), [["INFO", 1], ["ERROR", 5], ["INFO", 1]]);
  const errors = e.filter((x) => matches(x, { levels: ["ERROR"], processes: [] }));
  assert.deepStrictEqual(errors[0].lines.slice(3), ["rolled back", "'type"]);
  // A line with a time of its own is an entry of its own, and so is a
  // line before any TorQ line.
  const k = entries(["`hello", "2026.11.21D17:30:00.000000000|h|rdb|rdb1|ERROR|upd|x", "'2026.11.21T17:30:01.000 type"]);
  assert.deepStrictEqual(k.map((x) => x.lines.length), [1, 1, 1]);
});

// A file's last line with no newline after it is not pushed - it may still
// grow - and was never shown: `pending` gives it as the entries it makes.
test("a line not yet ended continues the open entry or starts one, and is not kept (#3041)", () => {
  const done = [];
  const b = new EntryBuilder("/l/out_rdb1.log", (e) => done.push(e));
  assert.deepStrictEqual(b.pending(""), { entries: [] });
  assert.deepStrictEqual(b.pending(TORQ_ERR).entries.map((e) => [e.level, e.process, e.lines]), [["ERROR", "rdb1", [TORQ_ERR]]]);
  b.push(TORQ_INFO);
  // A line that starts an entry: the open one, then it.
  const two = b.pending(TORQ_ERR);
  assert.deepStrictEqual(two.entries.map((e) => e.lines), [[TORQ_INFO], [TORQ_ERR]]);
  assert.strictEqual(two.started, two.entries[1]);
  assert.strictEqual(two.entries[0], b.open);
  // One that continues it: the open entry with it, and none started. A
  // carriage return whose newline is still to come is no part of the line.
  const more = b.pending("  rolled back\r");
  assert.deepStrictEqual([more.entries.map((e) => e.lines), more.started], [[[TORQ_INFO, "  rolled back"]], undefined]);
  // Nothing was kept: the open entry is as it was, and none is done.
  assert.deepStrictEqual([b.open.lines, done], [[TORQ_INFO], []]);
});
