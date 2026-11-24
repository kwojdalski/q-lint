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
});

test("plain q output: a q error with or without KDB-X's timestamp, levels near the start, and continuations", () => {
  const kx = KDBX.map(parseLine);
  assert.deepStrictEqual(kx.map((p) => p.kind), ["q", "q", "q", "q", "q", "cont", "cont", "cont", "cont"]);
  assert.deepStrictEqual(kx.map((p) => p.level), [undefined, "INFO", "WARN", undefined, "ERROR", undefined, undefined, undefined, undefined]);
  assert.strictEqual(kx[4].time, Date.UTC(2026, 10, 21, 20, 41, 3, 930));
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
  const e = entries([TORQ_INFO, TORQ_ERROR, TORQ_ERR, TORQ_WARN, BANNER]);
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
  const a = entries(["2026.11.07D10:00:00.000000000|h|rdb|rdb1|INFO|x|a1", "no time", "2026.11.07D12:00:00.000000000|h|rdb|rdb1|INFO|x|a2"], "/l/a.log");
  const b = entries(["2026.11.07D11:00:00.000000000|h|hdb|hdb1|INFO|x|b1"], "/l/b.log");
  assert.deepStrictEqual(merge([a, b]).map((x) => x.lines[0].split("|").pop()), ["a1", "no time", "b1", "a2"]);
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
