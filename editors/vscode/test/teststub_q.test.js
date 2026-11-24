// A generated test stub against a real q (#982): it loads, fails until its
// TODOs are filled in, and passes once they are, in each style. Needs
// QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { functionAt, detectStyle, testName, stubText } = require("../out/teststub.js");
const { TEST_RUN, readTestResult } = require("../out/testing.js");
const { statements } = require("../out/statements.js");

const SRC = "\\d .fx\nmid:{[bid;ask]\n  (bid+ask)%2}\n\\d .\n";
const QUNIT = "\\d .qunit\nassertEquals:{[actual;expected;msg] if[not actual~expected;'`assertThatFAIL]; actual}\n\\d .\n";

test("a stub runs, fails as written, and passes once filled in, in each style", { skip }, async (t) => {
  const { connection: c } = await connect(t, `${SRC}${QUNIT}`);
  const target = functionAt(SRC, 2);
  for (const file of ["", ".qt.fx.test_a:{[] .qunit.assertEquals[1;1;\"a\"]}\n", "testA:{ 1b }\n"]) {
    const style = detectStyle(file);
    const name = testName(target, style, file);
    const stub = stubText(target, name, style);
    const run = async (text) => readTestResult(await c.call(TEST_RUN, [...statements(text), `${name}[]`], "test"));
    assert.strictEqual((await run(stub)).passed, false, stub);
    const filled = stub.replace("bid:(::); ask:(::);", "bid:1f; ask:2f;").replace("expected:(::);", "expected:1.5;");
    assert.deepStrictEqual(await run(filled), { passed: true, text: style.qunitAsserts ? "1.5" : "1b", errored: false }, filled);
  }
});

// The stub's arguments are locals of the test: one named like the function
// was what the bare name then called, and the filled-in test indexed a
// number (#2004).
test("a stub for a function with a parameter of its own name calls the function", { skip }, async (t) => {
  const src = "scale:{[scale;v] v*scale}\n";
  const { connection: c } = await connect(t, `${src}${QUNIT}`);
  const target = functionAt(src, 0);
  for (const file of ["", ".qt.fx.test_a:{[] .qunit.assertEquals[1;1;\"a\"]}\n", "testA:{ 1b }\n"]) {
    const style = detectStyle(file);
    const name = testName(target, style, file);
    const stub = stubText(target, name, style);
    const run = async (text) => readTestResult(await c.call(TEST_RUN, [...statements(text), `${name}[]`], "test"));
    assert.strictEqual((await run(stub)).passed, false, stub);
    const filled = stub.replace("scale:(::); v:(::);", "scale:2; v:3;").replace("expected:(::);", "expected:6;");
    assert.deepStrictEqual(await run(filled), { passed: true, text: style.qunitAsserts ? "6" : "1b", errored: false }, filled);
  }
});
