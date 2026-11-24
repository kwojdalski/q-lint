// The help pages' and hovers' examples against a real q (#971, #972): every
// example in help/examples.json runs, and gives the value its stated result
// gives (`~`), so what a page shows and what Try it prints agree on both
// interpreters. The cheat sheet's entries (#973) are held the same way:
// each runs as inserted, or with the example it carries. Needs QLINT_TEST_Q,
// as the other real-q tests.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stringLiteral } = require("../out/qliteral.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const root = path.join(__dirname, "..");

/// Run `checks` (q expressions that should give 1b) in one q, and the ones
/// that did not.
function runChecks(checks) {
  const lines = ['ck:{[i;e] r:@[value;e;{`$"error ",x}]; if[not 1b~r; -1 "FAIL ",string[i]," -> ",-3!r]}'];
  checks.forEach((c, i) => lines.push(`ck[${i};${stringLiteral(c)}]`));
  lines.push('-1 "DONE";', "exit 0");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-help-"));
  const script = path.join(dir, "help.q");
  fs.writeFileSync(script, `${lines.join("\n")}\n`);
  const run = spawnSync(`${Q} ${script} -q`, { shell: true, encoding: "utf8", timeout: 60000, cwd: dir });
  const out = `${run.stdout}${run.stderr}`;
  assert.match(out, /DONE/, out.slice(0, 2000));
  return out.split("\n").filter((l) => l.startsWith("FAIL")).map((l) => `${l}\n  ${checks[Number(l.split(" ")[1])]}`);
}

test("every builtin example gives its stated result", { skip }, () => {
  const examples = JSON.parse(fs.readFileSync(path.join(root, "help", "examples.json"), "utf8"));
  const checks = [];
  for (const entry of Object.values(examples)) {
    for (const e of entry.examples) {
      checks.push(`(value ${stringLiteral(e.code)})~value ${stringLiteral(e.result)}`);
    }
  }
  assert.deepStrictEqual(runChecks(checks), []);
  assert.ok(checks.length >= 190, `${checks.length} examples`);
});

test("every cheat sheet entry runs, and an example gives its result", { skip }, () => {
  const sheet = JSON.parse(fs.readFileSync(path.join(root, "help", "cheatsheet.json"), "utf8"));
  const checks = [];
  for (const section of sheet) {
    for (const item of section.items) {
      if (item.result !== undefined) {
        checks.push(`(value ${stringLiteral(item.example ?? item.insert)})~value ${stringLiteral(item.result)}`);
      } else {
        // An entry with no result is a form to fill in: it parses.
        checks.push(`0<count parse ${stringLiteral(item.insert)}`);
      }
    }
  }
  assert.deepStrictEqual(runChecks(checks), []);
});

// Eight examples left the tables t, q and kt behind, so Try it replaced the
// ones a session had under those names (#1991). q is asked what is defined:
// `insert` and `set` name what they write in a symbol no reading of the text
// is sure of.
test("no example or cheat sheet entry leaves a global behind", { skip }, () => {
  const examples = JSON.parse(fs.readFileSync(path.join(root, "help", "examples.json"), "utf8"));
  const sheet = JSON.parse(fs.readFileSync(path.join(root, "help", "cheatsheet.json"), "utf8"));
  const codes = [...Object.values(examples).flatMap((entry) => entry.examples.map((e) => e.code)), ...sheet.flatMap((s) => s.items.filter((i) => i.result !== undefined).map((i) => i.example ?? i.insert))];
  // The root namespace and the namespaces, but the one kept for the examples: insert's table is there.
  const defined = "(key `.;(key `) except `qlintex)";
  assert.deepStrictEqual(runChecks(codes.map((code) => `{[e] was:${defined}; value e; was~${defined}} ${stringLiteral(code)}`)), []);
  assert.ok(codes.length >= 230, `${codes.length} examples`);
  // And one that does is found.
  assert.strictEqual(runChecks(["{[e] was:key `.; value e; was~key `.} \"t:([] a:1 2); `t insert 3; t\""]).length, 1);
});
