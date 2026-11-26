// render() at the size of an unlimited console result (#1853): one line per
// row, so it must not hand every line to push() as spread arguments.
const test = require("node:test");
const assert = require("node:assert");
const { render } = require("../out/query.js");

test("render keeps a 1M-line answer, trace and code without a stack overflow", () => {
  const text = Array.from({ length: 1_000_000 }, (_, i) => `${i} 1.5 abc`);
  const ok = render(
    { process: "p", code: "a\nb", answer: { ok: true, type: 98, text }, millis: 1 },
    { includeQuery: true, ignoreNullReturn: false },
  );
  assert.strictEqual(ok.length, 1 + 2 + text.length);
  assert.deepStrictEqual(ok.slice(0, 4), ["# p (1 ms)", "q) a", "q) b", "0 1.5 abc"]);
  assert.strictEqual(ok[ok.length - 1], "999999 1.5 abc");
  const trace = text.join("\n") + "\n";
  const bad = render(
    { process: "p", code: "x", answer: { ok: false, error: "type", trace }, millis: 2 },
    { includeQuery: false, ignoreNullReturn: false },
  );
  assert.strictEqual(bad.length, 2 + text.length);
  assert.strictEqual(bad[1], "'type");
});

test("a failure under reval is a refusal by its text, or raised where a trap called the code's handler; any other error is the code's own (#3170)", () => {
  const { revalRefusal } = require("../out/query.js");
  // q's own refusals, as they are.
  for (const error of ["noupdate: `. `k3", "access", "sys", "restricted"]) {
    assert.strictEqual(revalRefusal(error, ""), error);
  }
  // Raised by .Q.trp, .Q.trpd or -105! applying the code's handler to what
  // it caught: said with q's own error and where.
  const trap = (name) => `  [6]  (${name})\n\n  [5]  ${name}[{value x};"k3:1";::]\n       ^\n`;
  assert.strictEqual(revalRefusal("type", trap(".Q.trp")), "type, raised where .Q.trp called the code's handler, as it does with what reval refuses");
  assert.strictEqual(revalRefusal("rank", trap(".Q.trpd")), "rank, raised where .Q.trpd called the code's handler, as it does with what reval refuses");
  assert.strictEqual(revalRefusal("type", "  [5]  -105!({k3::1};enlist 0;::)\n           ^\n"), "type, raised where -105! called the code's handler, as it does with what reval refuses");
  // A plain 'type in ordinary code, one inside a lambda a trap runs, a
  // subtraction before !, or no trace at all, is no refusal.
  for (const trace of ["  [5]  1+`a\n        ^\n", "  [6]  {x+1}\n         ^\n  [5]  {x+1}`a\n       ^\n", "  [6]  {x+`a}\n         ^\n  [5]  .Q.trp[{x+`a};1;{[e;b] e}]\n", "  [5]  a-105!x\n           ^\n", ""]) {
    assert.strictEqual(revalRefusal("type", trace), undefined, trace);
  }
});
