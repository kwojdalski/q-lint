// Temporal conversion against a real q (#969): for values of every temporal
// type - the ends of each range, the 2000.01.01 epoch, values before it,
// random ones, every null and infinity - the literal temporal.ts writes is
// the one q writes for that value, the integer it gives is q's `"j"$` or
// `"i"$` of it, and each conversion (timestamp, date, month, Unix
// nanoseconds, timespan) evaluates in q to the same value. A number read as
// a long or a Unix epoch converts as q's `"p"$` and 1970.01.01D+ do. The
// checks run as one q script; needs QLINT_TEST_Q, as the other real-q tests.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const t = require("../out/temporal.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";

/// A seeded generator, so a failure can be run again.
function rng(seed) {
  let s = BigInt(seed);
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return s;
  };
}

const LONG_MAX = 9223372036854775807n;

/// Values of `type` from `lo` to `hi` inclusive: both ends, zero, -1, 1 and
/// `count` random ones.
function values(type, lo, hi, next, count = 60) {
  const out = [lo, hi, 0n, -1n, 1n].filter((n) => n >= lo && n <= hi);
  const span = hi - lo + 1n;
  for (let i = 0; i < count; i++) {
    out.push(lo + (next() % span));
  }
  // Small values near the epoch, where a sign or a floor goes wrong.
  for (let i = 0; i < 10; i++) {
    const small = (next() % 2000001n) - 1000000n;
    if (small >= lo && small <= hi) {
      out.push(small);
    }
  }
  return out.map((n) => ({ type, n }));
}

function cases() {
  const next = rng(969);
  const day = 86400000000000n;
  return [
    // Timestamps from 1707.09.22 to 2292.04.10, and whole days, which a
    // date-only part writes.
    ...values("timestamp", -LONG_MAX + 1n, LONG_MAX - 1n, next),
    ...values("timestamp", -106000n, 106000n, next, 20).map((v) => ({ ...v, n: v.n * day })),
    ...values("date", -730119n, 2921939n, next),
    ...values("month", -23988n, 95999n, next),
    // A datetime from 1709 to 2290, as timestamp literals: further from 2000
    // its float of days no longer holds a millisecond.
    ...values("datetime", BigInt(t.daysFrom(1709, 1, 1)) * 86400000n, BigInt(t.daysFrom(2291, 1, 1)) * 86400000n - 1n, next),
    ...values("timespan", -LONG_MAX + 1n, LONG_MAX - 1n, next),
    ...values("time", -359999999n, 359999999n, next),
    ...values("second", -359999n, 359999n, next),
    ...values("minute", -5999n, 5999n, next),
  ];
}

const SPECIALS = ["timestamp", "month", "date", "datetime", "timespan", "minute", "second", "time"].flatMap((type) =>
  ["null", "inf", "-inf"].map((special) => ({ type, special, n: 0n })),
);

/// A long as q reads it: 0N and 0W are the nulls and infinities.
const long = (n) => (n === -LONG_MAX - 1n ? "0N" : n === LONG_MAX ? "0W" : n === -LONG_MAX ? "-0W" : `${n}`);

test("q writes, casts and converts every temporal value as temporal.ts does", { skip }, () => {
  const lines = [
    // PeachQ casts an infinite timestamp, month or datetime to another type
    // as a finite value; KDB-X keeps it infinite.
    'peachq:2292.04.10~"d"$0Wp',
    'ck:{[i;e] r:@[value;e;{`$"error ",x}]; if[not 1b~r; -1 "FAIL ",string[i]," ",e," -> ",-3!r]}',
  ];
  const checks = [];
  const check = (expr) => {
    checks.push(expr);
    lines.push(`ck[${checks.length - 1};${JSON.stringify(expr)}]`);
  };
  const all = [...cases(), ...SPECIALS];
  for (const v of all) {
    const lit = t.format(v);
    assert.ok(lit !== undefined, `${v.type} ${v.n} has a literal`);
    // temporal.ts reads its own literal back as the same value.
    assert.deepStrictEqual(t.parse(lit), v.special === undefined ? { type: v.type, n: v.n } : v, lit);
    // Where KDB-X writes a timestamp it does not read back, `"p"$` of its long.
    const readable = t.timestampText(v);
    check(`(-3!${readable})~${JSON.stringify(lit)}`);
    for (const c of t.conversions(v)) {
      if (/^long/.test(c.label)) {
        check(`("j"$${readable})~${c.text}`);
      } else if (/^int/.test(c.label)) {
        check(`("i"$${readable})~${/^-?\d+$/.test(c.text) ? `${c.text}i` : c.text}`);
      } else if (/^timestamp \(/.test(c.label)) {
        check(v.special === undefined ? `("p"$${readable})~${c.text}` : `peachq or ("p"$${readable})~${c.text}`);
      } else if (c.label === "timestamp of the same millisecond") {
        // KDB-X's cast of a float of days lands within microseconds of it.
        check(`10000>abs ("j"$"p"$${readable})-"j"$${c.text}`);
      } else if (/^date/.test(c.label)) {
        check(v.special === undefined ? `("d"$${readable})~${c.text}` : `peachq or ("d"$${readable})~${c.text}`);
      } else if (/^month/.test(c.label)) {
        check(`("m"$${readable})~${c.text}`);
      } else if (/^timespan/.test(c.label)) {
        check(`("n"$${readable})~${c.text}`);
      } else if (c.label === "Unix nanoseconds" && BigInt(c.text) < LONG_MAX && BigInt(c.text) > -LONG_MAX) {
        check(v.type === "datetime" ? `10000>abs ("j"$"p"$${readable})-"j"$1970.01.01D00:00:00+${c.text}` : `("p"$${readable})~1970.01.01D00:00:00+${c.text}`);
      } else if (c.label === "ISO 8601, UTC") {
        // A Date holds milliseconds: the ISO text names the same one.
        const ms = BigInt(t.conversions(v).find((x) => x.label === "Unix nanoseconds").text);
        const floorMs = ms >= 0n ? ms / 1000000n : -((-ms + 999999n) / 1000000n);
        if (floorMs > -8640000000000000n && floorMs < 8640000000000000n) {
          assert.strictEqual(BigInt(Date.parse(c.text.replace(/(\.\d{3})\d*Z$/, "$1Z"))), floorMs, c.text);
        }
      } else if (c.label === "seconds") {
        check(`("j"$"n"$${readable})~${long(t.scaled(c.text, 9))}`);
      } else if (c.label === "milliseconds") {
        check(`("j"$${readable})~${long(t.scaled(c.text, 6))}`);
      } else {
        assert.match(c.label, /^Unix /, c.label);
      }
    }
  }
  // Numbers: a long as a q timestamp, and Unix epochs in each unit.
  const next = rng(64);
  const numbers = ["0", "1", "-1", "757479845123456789", "-757479845123456789", "9223372036854775806", "-9223372036854775806", "9223372036854775807", "-9223372036854775808", "1704164645", "1704164645.5", "1704164645123", "1704164645123.25", "1704164645123456", "1704164645123456789", "946684800", "-946684800"];
  for (let i = 0; i < 40; i++) {
    numbers.push(String(next() % 4102444800n), String(next() % 4102444800000n), String(next() % 4102444800000000n), String(next() % 4102444800000000000n));
  }
  for (const text of numbers) {
    for (const c of t.numberConversions(text)) {
      if (c.label.startsWith("q timestamp")) {
        check(`("p"$${long(BigInt(text))})~${c.text}`);
      } else if (!c.label.endsWith("ISO 8601")) {
        const unit = c.label.replace("from Unix ", "");
        const places = t.UNIX_UNITS.find((u) => u.name === unit).places;
        check(`(1970.01.01D00:00:00+${t.scaled(text, places)})~${c.text}`);
      }
    }
  }
  lines.push('-1 "DONE";', "exit 0");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-temporal-"));
  const script = path.join(dir, "temporal.q");
  fs.writeFileSync(script, `${lines.join("\n")}\n`);
  const run = spawnSync(`${Q} ${script} -q`, { shell: true, encoding: "utf8", timeout: 60000 });
  const out = `${run.stdout}${run.stderr}`;
  assert.match(out, /DONE/, out.slice(0, 2000));
  const failed = out.split("\n").filter((l) => l.startsWith("FAIL"));
  assert.deepStrictEqual(failed, [], `${failed.length} of ${checks.length} checks failed`);
  assert.ok(checks.length > 2500, `${checks.length} checks`);
});
