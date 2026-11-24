// Instrumenting a function's text (#979, #985), without a q process.
const test = require("node:test");
const assert = require("node:assert");
const { coverageText, localsText } = require("../out/instrument.js");

test("a coverage probe goes in front of a statement that starts with a string (#1421)", () => {
  assert.strictEqual(coverageText('{[x] "a",x}', 0).text, '{[x] .qlint.cov.d[0]+:1;"a",x}');
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
  assert.strictEqual(coverageText("{[x] x+1 / \"note\"\n }", 0).text, "{[x] .qlint.cov.d[0]+:1;x+1 / \"note\"\n }");
});
