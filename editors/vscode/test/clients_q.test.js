// The Connected Clients view's q against a real process (#1040): the open
// handles are listed whatever the process keeps under `.clients.clients` -
// TorQ's table gives each its user and address, a table of another making
// gives none (#1905). Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { CLIENTS, readClients } = require("../out/clients.js");

test("the handles are listed, with the user and address TorQ's .clients.clients records", { skip }, async (t) => {
  const bare = await connect(t, "a:1\n");
  const plain = readClients(await bare.connection.call(CLIENTS, null));
  assert.strictEqual(plain.tracked, false);
  assert.deepStrictEqual(plain.rows.filter((r) => r.self).map((r) => [r.user, r.host]), [["", ""]]);
  const torq = await connect(t, [".clients.clients:([w:`int$()] ipa:`symbol$();u:`symbol$();a:`int$());", '.z.po:{`.clients.clients upsert (x;`$"10.0.0.1";`bob;0Ni)};', ""].join("\n"));
  const tracked = readClients(await torq.connection.call(CLIENTS, null));
  assert.strictEqual(tracked.tracked, true);
  assert.deepStrictEqual(tracked.rows.filter((r) => r.self).map((r) => [r.user, r.host]), [["bob", "10.0.0.1"]]);
});

test("a .clients.clients that is not TorQ's lists the handles all the same (#1905)", { skip }, async (t) => {
  for (const table of ["([w:98 99i] u:`bob`al;a:1 2i)", "([] x:1 2)", '([w:98 99i] u:("bob";"al");ipa:`x`y)', "`w`u`ipa!1 2 3", "([w:`p`q] u:`bob`al;ipa:`x`y)"]) {
    const { connection } = await connect(t, `.clients.clients:${table};\n`);
    const { rows, tracked } = readClients(await connection.call(CLIENTS, null));
    assert.strictEqual(tracked, false, table);
    assert.deepStrictEqual(rows.filter((r) => r.self).map((r) => [r.user, r.host]), [["", ""]], table);
    // Nothing was assigned by the read.
    assert.deepStrictEqual(await connection.call("{[x] key `.}", 0), [], table);
  }
});
