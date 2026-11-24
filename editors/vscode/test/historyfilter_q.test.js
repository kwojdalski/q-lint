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
