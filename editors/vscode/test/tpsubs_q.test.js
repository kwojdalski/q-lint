// The tickerplant subscribers view's q against a real process (#1042): a
// process without `.u.w` is refused; with one, each subscription is
// answered with its handle, output queue, symbols and protocol, and the
// host where TorQ's `.clients.clients` records one. Needs QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { SUBSCRIBERS, readSubscribers } = require("../out/tpsubs.js");

test("a process without .u.w is no tickerplant", { skip }, async (t) => {
  const { connection } = await connect(t, "a:1\n");
  await assert.rejects(connection.call(SUBSCRIBERS, 0), /not a tickerplant/);
});

test("each subscription is answered, this connection's with its protocol", { skip }, async (t) => {
  const { connection } = await connect(
    t,
    [
      ".u.w:`trade`quote!(();());",
      // Every connection subscribes to all trades and to quotes of `a`b.
      ".z.po:{.u.w[`trade],:enlist(x;`); .u.w[`quote],:enlist(x;`a`b)};",
      "",
    ].join("\n"),
  );
  const subs = readSubscribers(await connection.call(SUBSCRIBERS, 0));
  assert.strictEqual(subs.length, 2);
  assert.deepStrictEqual(subs.map((s) => [s.table, s.syms, s.host]), [
    ["trade", "", ""],
    ["quote", "a b", ""],
  ]);
  assert.ok(subs.every((s) => s.handle > 0 && s.queue >= 0));
  // -38! names the protocol on kdb+ 4.x; PeachQ cannot say.
  assert.ok(subs.every((s) => s.protocol === "q" || s.protocol === ""));
  // Nothing was assigned by the read.
  assert.deepStrictEqual(await connection.call("{[x] key `.}", 0), []);
});

test("TorQ's .clients.clients gives each handle's host", { skip }, async (t) => {
  const { connection } = await connect(
    t,
    [".u.w:enlist[`trade]!enlist ();", ".clients.clients:([w:`int$()] hostname:`symbol$());", ".z.po:{.u.w[`trade],:enlist(x;`); `.clients.clients upsert (x;`desk1)};", ""].join("\n"),
  );
  const [sub] = readSubscribers(await connection.call(SUBSCRIBERS, 0));
  assert.strictEqual(sub.host, "desk1");
});

// TorQ's STP and chained tickerplant replace u.q with pubsub.q, which keeps
// no .u.w (#2585): its subscriptions as pubsub.q's add, selfiltered and
// addfiltered store them.
test("a TorQ STP's subscribers, to all of a table and filtered, are read from .stpps", { skip }, async (t) => {
  const { connection } = await connect(
    t,
    [
      ".stpps.subrequestall:enlist[`]!enlist ();",
      ".stpps.subrequestfiltered:([]tbl:`$();handle:`int$();filts:();columns:());",
      ".z.po:{.stpps.subrequestall[`trade],:x;",
      " `.stpps.subrequestfiltered upsert (`quote;x;enlist enlist (in;`sym;enlist`a`b);());",
      ' `.stpps.subrequestfiltered upsert (`trade;x;(parse"select from t where sym in `a`b,px>1")2;last parse"select sym,px from t")};',
      "",
    ].join("\n"),
  );
  const subs = readSubscribers(await connection.call(SUBSCRIBERS, 0));
  assert.deepStrictEqual(
    subs.map((s) => [s.table, s.syms]).sort(),
    [
      ["quote", "a b"],
      ["trade", ""],
      ["trade", "where (in;`sym;,`a`b), (>;`px;1), columns sym, px"],
    ],
  );
  assert.ok(subs.every((s) => s.handle > 0));
});
