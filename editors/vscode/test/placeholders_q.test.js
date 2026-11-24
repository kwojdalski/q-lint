// What q takes a system command's line to be (#1984), from a real q: the
// text after a blank and a slash is the command's argument, so a
// placeholder there has to be found and given its value. Needs
// QLINT_TEST_Q.
const test = require("node:test");
const assert = require("node:assert");
const { connect, skip } = require("./qserver.js");
const { RUN, readAnswer } = require("../out/query.js");
const { placeholderNames, substitute } = require("../out/placeholders.js");

test("a system command's absolute path is its argument to q, and its placeholder is filled (#1984)", { skip }, async (t) => {
  const { connection: c, dir } = await connect(t, "a:1\n", { "part.q": "loaded:42\n" });
  const run = async (code) => readAnswer(await c.call(RUN, [code], [25, 200]));
  // `dir` is absolute: the path starts with a slash after the blank.
  const template = `\\l ${dir}/{{name}}.q`;
  assert.ok(template.startsWith("\\l /"), template);
  assert.deepStrictEqual(placeholderNames(template), ["name"]);
  // As typed, q is given the braces and fails on them.
  const typed = await run(template);
  assert.strictEqual(typed.ok, false);
  assert.match(typed.error, /\{\{name\}\}\.q/);
  const filled = await run(substitute(template, { name: "part" }));
  assert.strictEqual(filled.ok, true, filled.error);
  assert.deepStrictEqual((await run("loaded")).text, ["42"]);
  // No comment is read off a command's line: q takes all of it.
  const all = await run("\\a / c");
  assert.strictEqual(all.ok, false);
  assert.match(all.error, /\/ c/);
  // \t times q code, and a comment there is one.
  assert.strictEqual((await run("\\t 1+1 / {{c}}")).ok, true);
  assert.deepStrictEqual(placeholderNames("\\t 1+1 / {{c}}"), []);
});
