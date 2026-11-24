// The texts @q chat's DESCRIBE, the Timers view, the Process Monitor and
// Explain aj read from a real q process, against one whose console is
// narrow (#1908): `-3!` and `.Q.s1` there cut every text at `\c`, short of
// the 200 or 300 characters each promises, and none may touch `\c`.
// Needs a q binary, so it runs only when QLINT_TEST_Q names one.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { DESCRIBE, readDescribed } = require("../out/assist.js");
const { TIMERS, readTimers } = require("../out/timers.js");
const { MONITOR } = require("../out/monitor.js");
const { EXPLAIN_AJ, readMatch } = require("../out/ajexplain.js");
const { asCode } = require("../out/processtools.js");

const SERVER = [
  "proj:{[a;b;c;d] (a+b+c+d;`aaaaaaaaaaaaaaaaaaaaaaaa;`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;`cccccccccccccccccccccccccccccc)}[1]",
  "stamps:10#2026.11.24D16:17:25.941369000",
  "syms:`$10#enlist 20#\"abcdefghij\"",
  ".z.ts:{[x] a:1+2+3+4+5+6+7+8+9+10; b:a*2+3+4+5+6+7+8+9+10; c:b*2+3+4+5+6+7+8+9+10; d:c*2+3+4+5+6+7+8+9+10; a+b+c+d}",
  ".timer.timer:([] id:1 2; active:11b; period:2#0D00:01:00.000000000; nextrun:2#2026.11.24D16:17:25.941369000; lastrun:2#2026.11.24D16:16:25.941369000; description:(\"a\";250#\"long description \"); funcparam:({[x] `aaaaaaaaaaaaaaaaaaaaaaaa`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`cccccccccccccccccccccccccccccc};`f))",
  "W:([] sym:`a`b; time:2#2026.11.24D16:17:25.941369000; c1:`aaaaaaaaaaaaaaaaaaaa`b; c2:`bbbbbbbbbbbbbbbbbbbb`b; c3:`cccccccccccccccccccc`b; c4:`dddddddddddddddddddd`b; c5:`eeeeeeeeeeeeeeeeeeee`b)",
  "R:([] sym:`a`a; time:2026.11.24D16:17:25.941369000 2026.11.24D16:18:25.941369000; c1:`aaaaaaaaaaaaaaaaaaaa`b; c2:`bbbbbbbbbbbbbbbbbbbb`b; c3:`cccccccccccccccccccc`b; c4:`dddddddddddddddddddd`b; y:1 2)",
  "",
].join("\n");

// Each console the texts are read under: q's own, and one 30 wide.
for (const width of ["25 80", "10 30"]) {
  test(`texts are whole on a process whose \\c is ${width}`, { skip }, async (t) => {
    const { connection: c } = await connect(t, `${SERVER}\\c ${width}\n`);
    const console_ = async () => (await c.evaluate('-3!system"c"')).value;
    const before = await console_();

    const d = Object.fromEntries(readDescribed(await c.call(DESCRIBE, asCode("proj stamps syms"))).map((x) => [x.name, x.text]));
    assert.strictEqual(d.proj, "{[a;b;c;d] (a+b+c+d;`aaaaaaaaaaaaaaaaaaaaaaaa;`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;`cccccccccccccccccccccccccccccc)}[1]");
    assert.strictEqual(d.stamps, Array(10).fill("2026.11.24D16:17:25.941369000").join(" "));
    assert.strictEqual(d.syms, "`abcdefghijabcdefghij".repeat(10));

    const timers = readTimers(await c.call(TIMERS, null));
    const ts = (await c.evaluate("last value .z.ts")).value;
    assert.strictEqual(ts.length, 109);
    assert.strictEqual(timers.ts, ts);
    assert.deepStrictEqual(timers.jobs.map((j) => j.nextrun), Array(2).fill("2026.11.24D16:17:25.941369000"));
    assert.strictEqual(timers.jobs[0].func, "{[x] `aaaaaaaaaaaaaaaaaaaaaaaa`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`cccccccccccccccccccccccccccccc}");
    assert.strictEqual(timers.jobs[1].description, "long description ".repeat(15).slice(0, 250));

    const m = await c.call(MONITOR, null);
    assert.strictEqual(m.ts, ts);
    assert.deepStrictEqual(m.torq.map((r) => r.nextrun), Array(2).fill("2026.11.24D16:17:25.941369000"));
    assert.match(m.process.value[6], /^\d{4}\.\d\d\.\d\dD\d\d:\d\d:\d\d\.\d{9}$/);
    assert.strictEqual(m.settings.value[m.settings.key.indexOf("c")], `${width}i`);

    const aj = readMatch(await c.call(EXPLAIN_AJ, asCode("`sym`time"), asCode("W"), asCode("R"), 0));
    assert.strictEqual(aj.row, "`sym`time`c1`c2`c3`c4`c5!(`a;2026.11.24D16:17:25.941369000;`aaaaaaaaaaaaaaaaaaaa;`bbbbbbbbbbbbbbbbbbbb;`cccccccccccccccccccc;`dddddddddddddddddddd;`eeeeeeeeeeeeeeeeeeee)");
    assert.strictEqual(aj.matchedRow, "`sym`time`c1`c2`c3`c4`y!(`a;2026.11.24D16:17:25.941369000;`aaaaaaaaaaaaaaaaaaaa;`bbbbbbbbbbbbbbbbbbbb;`cccccccccccccccccccc;`dddddddddddddddddddd;1)");
    assert.deepStrictEqual([aj.time, aj.earliest], Array(2).fill("2026.11.24D16:17:25.941369000"));

    assert.strictEqual(await console_(), before);
  });
}
