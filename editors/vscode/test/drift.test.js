// The definitions a q file makes, as loading it would make them, and how
// they compare with a process (#933, #934): no q needed. drift_q.test.js
// holds the q side against a real process.
const test = require("node:test");
const assert = require("node:assert");
const {
  definitions,
  normalized,
  readDrift,
  driftRows,
  driftSummary,
  changedSince,
  reloadPlan,
  namesList,
} = require("../out/definitions.js");
const { readAssist, assistOff, ASSIST_SETTINGS } = require("../out/assistconfig.js");
const pkg = require("../package.json");

test("definitions: top-level lambdas, in their context, with their lines", () => {
  const text = [
    "#!/usr/bin/env q",
    "f:{[x]",
    "  y:x+1;",
    "",
    "/ inside",
    "  y}",
    "g: {x} ; / after",
    "p:{x+y}[1]",
    "v:42",
    "w:{x}each 1 2",
    "\\d .ns",
    "h:{a+\"}\"}",
    ".abs.k:{x}",
    "\\d .",
    "/",
    "z:{x}",
    "\\",
    "r:{x}",
    "\\",
    "after:{x}",
  ].join("\r\n");
  const defs = definitions(text);
  assert.deepStrictEqual(
    defs.map((d) => [d.name, d.text, d.line, d.endLine]),
    [
      ["f", "{[x]\r\n  y:x+1;\r\n\r\n/ inside\r\n  y}".replace(/\r/g, ""), 1, 5],
      ["g", "{x}", 6, 6],
      [".ns.h", '{a+"}"}', 11, 11],
      [".abs.k", "{x}", 12, 12],
      ["r", "{x}", 17, 17],
    ],
  );
  // Comment and blank lines after a statement are not part of it.
  assert.deepStrictEqual(definitions("f:{x}\n\n/ c\ng:{y}\n").map((d) => [d.name, d.endLine]), [["f", 0], ["g", 3]]);
  // A block comment inside a lambda does not end it, and is in its text as
  // q keeps it: each line a comment line (#1463).
  assert.deepStrictEqual(
    definitions("f:{x+\n/\nnote\n\\\n  y}\ng:{x}").map((d) => [d.name, d.text, d.line, d.endLine]),
    [["f", "{x+\n/\n/note\n/\n  y}", 0, 4], ["g", "{x}", 5, 5]],
  );
  assert.deepStrictEqual(definitions("f:{x}\n/\nnote\n\\\ng:{y}").map((d) => [d.name, d.endLine]), [["f", 0], ["g", 4]]);
  // An unclosed lambda, or a global assign, is no definition.
  assert.deepStrictEqual(definitions("f:{x\ng::{x}\n"), []);
});

test("texts compare without trailing blanks", () => {
  assert.strictEqual(normalized("{[x]   \n  x \t\n }"), "{[x]\n  x\n }");
});

test("drift rows and their summary", () => {
  const states = readDrift({ name: ["f", "g", "h", "p"], state: ["lambda", "lambda", "missing", "other"], text: ["{x}  ", "{y}", "", ""] });
  const defs = definitions("f:{x}\ng:{x}\nh:{x}\np:{x}\nq:{x}\n").map((def) => ({ file: "a.q", def }));
  const rows = driftRows(defs, states);
  assert.deepStrictEqual(rows.map((r) => r.status), ["same", "differs", "missing", "other", "missing"]);
  assert.strictEqual(rows[1].processText, "{y}");
  assert.strictEqual(driftSummary(rows, "dev"), "5 workspace definitions against dev: 1 differ, 2 not defined there, 1 not a lambda there, 1 the same.");
  // One name: atoms rather than lists.
  assert.deepStrictEqual([...readDrift({ name: "f", state: "lambda", text: "{x}" }).entries()], [["f", { state: "lambda", text: "{x}" }]]);
  assert.throws(() => readDrift(42), /something other/);
});

test("hot reload sends only what the save changed, and only over the text the file had", () => {
  const before = definitions("f:{x}\ng:{x}\nh:{x}\nk:{x}\n");
  const now = definitions("f:{x+1}\ng:{x}   \nh:{x+1}\nk:{x+1}\nn:{x}\no:{x}\nm:{x}\n");
  const changed = changedSince(before, now);
  assert.deepStrictEqual(changed.map((c) => [c.def.name, c.was]), [["f", "{x}"], ["h", "{x}"], ["k", "{x}"], ["n", undefined], ["o", undefined], ["m", undefined]]);
  const states = readDrift({
    name: ["f", "h", "k", "n", "o", "m"],
    state: ["lambda", "lambda", "lambda", "missing", "lambda", "other"],
    text: ["{x} ", "{x+1}", "{x*9}", "", "{x*2}", ""],
  });
  const plan = reloadPlan(changed, states);
  assert.deepStrictEqual(plan.send, [{ name: "f", held: "{x} ", text: "{x+1}" }]);
  assert.deepStrictEqual(plan.already, ["h"]);
  assert.deepStrictEqual(plan.skipped.map((s) => s.name), ["k", "n", "o", "m"]);
  assert.match(plan.skipped[0].why, /other than the file had before the edit/);
  assert.match(plan.skipped[1].why, /not defined on the process/);
  assert.strictEqual(namesList(["f", "g", "h"]), "f, g and h");
});

test("every switch is read with its default, and package.json declares it", () => {
  const defaults = readAssist((_k, fallback) => fallback);
  assert.deepStrictEqual(defaults, { drift: false, hotReload: false, queryTool: true, schemaTool: true, lintTool: true, chat: true, qsql: true });
  assert.deepStrictEqual(readAssist((k, f) => (k === "hotReload.enable" ? "yes" : f)).hotReload, false);
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  for (const [feature, { key, fallback }] of Object.entries(ASSIST_SETTINGS)) {
    const p = props[`q-lint.${key}`];
    assert.ok(p, key);
    assert.strictEqual(p.type, "boolean", key);
    assert.strictEqual(p.default, fallback, key);
    assert.match(assistOff(feature), new RegExp(`q-lint\\.${key.replace(/\./g, "\\.")} to true`));
  }
});
