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
