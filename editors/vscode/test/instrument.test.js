// Instrumenting a function's text (#979, #985), without a q process.
const test = require("node:test");
const assert = require("node:assert");
const { coverageText, localsText, restoreApart, restoreExpression, leftInstrumented, guardDeclined } = require("../out/instrument.js");

test("a coverage probe goes in front of a statement that starts with a string (#1421)", () => {
  assert.strictEqual(coverageText('{[x] "a",x}', 0).text, '{[x] qlintcov:.qlint.cov.hit 0;"a",x}');
  // A `;` inside the string does not split the statement.
  assert.strictEqual(coverageText('{[x] "a;b",x}', 0).statements.length, 1);
});

test("a local is captured after a statement that ends with a string (#1421)", () => {
  const text = localsText('{[x] a:"b;c"; a}').text;
  assert.ok(text.includes('a:"b;c";.qlint.err.d.locals[`a]:a;'), text);
  assert.ok(!text.includes("a:;"), text);
  // Escaped quotes stay inside the string.
  assert.ok(localsText('{[x] a:"b\\"c"; a}').text.includes('a:"b\\"c";.qlint.err.d.locals[`a]:a;'));
});

test("a trailing comment is still left out of a statement", () => {
  assert.strictEqual(coverageText("{[x] x+1 / \"note\"\n }", 0).text, "{[x] qlintcov:.qlint.cov.hit 0;x+1 / \"note\"\n }");
  // Only the first probe holds its index as a constant (#2543).
  assert.strictEqual(coverageText("{[x] a:x; a+1}", 7).text, "{[x] qlintcov:.qlint.cov.hit 7;a:x; qlintcov:.qlint.cov.hit qlintcov;a+1}");
});

test("a restore over a connection of its own goes to the process it is given, through the guard, and does not wait for long (#1892)", async () => {
  const opened = [];
  const live = (answer, allowed = true) => ({
    asked: [],
    async guardAllows(code, targets, what) {
      this.asked.push([code, targets.map((p) => p.label), what]);
      return allowed;
    },
    async openSeparate(process) {
      const connection = { sent: [], aborted: false, callOwn: async (code) => (connection.sent.push(code), answer(code)), abort: () => (connection.aborted = true) };
      opened.push([process.label, connection]);
      return connection;
    },
  });
  const dev = { label: "dev", host: "h", port: 1, tags: [] };
  const ok = live(() => ({ kept: ["g"], d: [1, 0] }));
  assert.deepStrictEqual(await restoreApart(ok, dev, "cov", "Putting back"), { kept: ["g"], d: [1, 0] });
  assert.deepStrictEqual(ok.asked, [[restoreExpression("cov"), ["dev"], "Putting back"]]);
  assert.deepStrictEqual(opened.map(([label, c]) => [label, c.sent, c.aborted]), [["dev", [restoreExpression("cov")], true]]);
  // Declined at the guard's question: no connection is opened.
  opened.length = 0;
  await assert.rejects(() => restoreApart(live(() => ({}), false), dev, "err", "Putting back"), /changing the read-only process dev was not confirmed/);
  assert.deepStrictEqual(opened, []);
  // A process that does not answer is not waited for, and a connection it
  // accepts later is closed with nothing sent.
  let accept;
  const busy = { guardAllows: async () => true, openSeparate: () => new Promise((resolve) => (accept = resolve)) };
  await assert.rejects(() => restoreApart(busy, dev, "cov", "Putting back", 20), /dev did not answer within 0\.02 s/);
  const late = { sent: [], aborted: false, callOwn: async (code) => late.sent.push(code), abort: () => (late.aborted = true) };
  accept(late);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual([late.sent, late.aborted], [[], true]);
  const hung = { guardAllows: async () => true, openSeparate: async () => ({ callOwn: () => new Promise(() => {}), abort() {} }) };
  await assert.rejects(() => restoreApart(hung, dev, "cov", "Putting back", 20), /did not answer/);
});

test("what is left instrumented is said by name, with the process and what puts it back (#1892)", () => {
  assert.strictEqual(
    leftInstrumented(["f", ".ns.g"], "dev", "rdb is no longer the active process; nothing was run.", "coverage run"),
    "q-lint: f, .ns.g may still be instrumented on dev: they could not be put back (rdb is no longer the active process; nothing was run). The next coverage run on dev puts them back first.",
  );
  assert.strictEqual(
    leftInstrumented([".ns.m"], "dev", "timed out", "Capture Locals at Last Error"),
    "q-lint: .ns.m may still be instrumented on dev: it could not be put back (timed out). The next Capture Locals at Last Error on dev puts it back first.",
  );
  const many = Array.from({ length: 14 }, (_, i) => `f${i}`);
  assert.match(leftInstrumented(many, "dev", "why", "coverage run"), /^q-lint: f0, f1, .*f9 and 4 more may still/);
  assert.match(leftInstrumented(many, "dev", "why", "coverage run", many.length), /f12, f13 may still/);
  assert.strictEqual(guardDeclined("Not run: changing the read-only process dev was not confirmed."), true);
  assert.strictEqual(guardDeclined("dev is no longer the active process; nothing was run."), false);
});
