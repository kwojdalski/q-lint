// What grammar_tokens.json holds, read again from q: each line's tokens as
// `-4!` splits it and the class of each (string, symbol, comment, file verb,
// a number or temporal `value` takes, or anything else), and whether each
// generated literal is one token of a number or temporal type. Needs
// QLINT_TEST_Q, as the other real-q tests. With QLINT_GRAMMAR_WRITE=1 it
// writes the file instead of comparing with it, after an input changes.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { lines, literals } = require("./grammar_tokens_inputs.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const saved = path.join(__dirname, "grammar_tokens.json");


/// q's reading of `inputs.lines` and `inputs.literals`, as the file keeps it.
function read(inputs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-grammar-"));
  const file = (name) => path.join(dir, name);
  fs.copyFileSync(path.join(__dirname, "grammar_tokens.q"), file("tokens.q"));
  fs.writeFileSync(file("lines.txt"), `${inputs.lines.join("\n")}\n`);
  fs.writeFileSync(file("literals.txt"), `${inputs.literals.join("\n")}\n`);
  const run = spawnSync(`${Q} tokens.q -q lines.txt literals.txt rows.txt verdicts.txt`, { shell: true, encoding: "utf8", timeout: 60000, cwd: dir });
  assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`.slice(0, 2000));
  const rows = fs.readFileSync(file("rows.txt"), "utf8").split("\n");
  const verdicts = fs.readFileSync(file("verdicts.txt"), "utf8").split("\n");
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    lines: inputs.lines.map((line, i) => [line, rows[i]]),
    literals: inputs.literals.map((literal, i) => [literal, verdicts[i]]),
  };
}

test("the saved tokens and literal verdicts are q's", { skip, timeout: 120000 }, () => {
  const got = read({ lines: lines(), literals: literals() });
  if (process.env.QLINT_GRAMMAR_WRITE === "1") {
    fs.writeFileSync(saved, `${JSON.stringify(got, null, 0).replace(/\],\[/g, "],\n[")}\n`);
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(saved, "utf8")), got);
});
