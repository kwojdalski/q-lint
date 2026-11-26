// The exported history script, loaded by a real q (#1924): each entry
// defines what it defined when it ran on its own, also one that starts with
// an indented comment or an indented `/` alone. Needs a q binary, so it
// runs only when QLINT_TEST_Q names one.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { connect, skip } = require("./qserver.js");
const { historyScript } = require("../out/historyfilter.js");

const entry = (code) => ({ process: "p", at: "t", millis: 1, outcome: "ok", code });

test("an exported script loads every entry, whatever comment an entry starts with", { skip }, async (t) => {
  const { connection: c, dir } = await connect(t, "");
  const load = async (name, codes, names) => {
    // Newest first, as kept; each ran on its own, oldest first.
    for (const code of [...codes].reverse()) {
      await c.call("{value x}", code);
    }
    const ran = (await c.evaluate(`all ${names} in key \`.`)).value;
    await c.evaluate(`![\`.;();0b;${names}]`);
    const file = path.join(dir, name);
    fs.writeFileSync(file, historyScript(codes.map(entry)));
    const error = (await c.evaluate(`@[system;"l ${file}";{x}]`)).value;
    return { ran, error, defined: (await c.evaluate(`${names} in key \`.`)).value };
  };
  assert.deepStrictEqual(await load("plain.q", ["  hw:hv+1", "hv:2"], "`hv`hw"), { ran: true, error: null, defined: [true, true] });
  assert.deepStrictEqual(await load("comment.q", ["hz:hy+hx", "  / note\n  hy:hx+1", "hx:2"], "`hx`hy`hz"), { ran: true, error: null, defined: [true, true, true] });
  assert.deepStrictEqual(await load("slash.q", ["hs3:3", "  /\n  hs2:1", "hs1:2"], "`hs1`hs2`hs3"), { ran: true, error: null, defined: [true, true, true] });
  assert.deepStrictEqual(await load("both.q", ["hb3:3", "\t/ one\n  /\n  / two\n  hb2:hb1", "hb1:2"], "`hb1`hb2`hb3"), { ran: true, error: null, defined: [true, true, true] });
});

test("an exported script loads past an entry whose first line is an indented \\ or \\\\, which q did not run as one (#3000)", { skip }, async (t) => {
  const { connection: c, dir } = await connect(t, "");
  for (const [name, first] of [["end.q", "  \\"], ["exit.q", "  \\\\"], ["more.q", "  \\\\\n  hn:1"]]) {
    // Newest first, as kept; each ran on its own, oldest first.
    const codes = ["hq2:2", first, "hq1:1"];
    for (const code of [...codes].reverse()) {
      await c.call("{@[value;x;{x}]}", code);
    }
    const ran = (await c.evaluate("`hq1`hq2`hn in key `.")).value;
    await c.evaluate("![`.;();0b;`hq1`hq2]");
    const file = path.join(dir, name);
    fs.writeFileSync(file, historyScript(codes.map(entry)));
    assert.strictEqual((await c.evaluate(`@[system;"l ${file}";{x}]`)).value, null, name);
    assert.deepStrictEqual((await c.evaluate("`hq1`hq2`hn in key `.")).value, ran, name);
    assert.deepStrictEqual(ran, [true, true, false], name);
    await c.evaluate("![`.;();0b;`hq1`hq2]");
  }
});

test("an exported script defines an entry's names where it ran, after an entry that left a \\d set (#2383)", { skip }, async (t) => {
  const { connection: c, dir } = await connect(t, "");
  const file = path.join(dir, "ns.q");
  // Newest first, as kept: the \d ran first, and q reset it after.
  fs.writeFileSync(file, historyScript(["htotal:sum 1 2 3", "\\d .hcfg\nhlimit:10", 'system "d .hsys";hn:1'].map(entry)));
  assert.strictEqual((await c.evaluate(`@[system;"l ${file}";{x}]`)).value, null);
  assert.deepStrictEqual((await c.evaluate("(`htotal in key `.;`hlimit in key `.hcfg;`htotal in key `.hcfg)")).value, [true, true, false]);
});
