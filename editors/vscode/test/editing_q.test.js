// The dotted-names word pattern against q's own tokens (#1992): a word is
// one token as `-4!` reads the line, so a name after a drop written without
// spaces (`1_til`) is a word of its own, and a number is one with the dot
// it starts with. Held over the help pages' examples and their results,
// which are q as it is written. Needs QLINT_TEST_Q, as the other real-q
// tests.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stringLiteral } = require("../out/qliteral.js");
const { WORD } = require("../out/editing.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";
const root = path.join(__dirname, "..");

/// The tokens q reads each of `lines` as, in one q.
function tokens(lines) {
  const source = [...lines.map((l) => `-1 " " sv string count each -4!(),${stringLiteral(l)};`), '-1 "DONE";', "exit 0"];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-words-"));
  const script = path.join(dir, "words.q");
  fs.writeFileSync(script, `${source.join("\n")}\n`);
  const run = spawnSync(`${Q} ${script} -q`, { shell: true, encoding: "utf8", timeout: 60000, cwd: dir });
  const out = `${run.stdout}${run.stderr}`.split("\n");
  assert.strictEqual(out[lines.length], "DONE", out.join("\n").slice(0, 2000));
  return lines.map((line, i) => {
    let at = 0;
    const read = out[i].split(" ").map((n) => line.slice(at, (at += Number(n))));
    assert.strictEqual(read.join(""), line);
    return read;
  });
}

/// The words of `lines` that are not one token of q's, a number's sign
/// aside; a word inside a string, a symbol or a comment is no token.
function notTokens(lines) {
  const bad = [];
  tokens(lines).forEach((read, i) => {
    let at = 0;
    const spans = read.map((t) => ({ t, from: at, to: (at += t.length) }));
    for (const m of lines[i].matchAll(new RegExp(WORD.source, "g"))) {
      const over = spans.filter((s) => s.from < m.index + m[0].length && s.to > m.index && s.t.trim() !== "");
      if (over.some((s) => /^[`"]|^\s*\//.test(s.t))) {
        continue;
      }
      if (!(over.length === 1 && (over[0].t === m[0] || over[0].t === `-${m[0]}`))) {
        bad.push(`${lines[i]}: ${m[0]} is ${over.map((s) => s.t).join(" ")}`);
      }
    }
  });
  return bad;
}

test("a word is one token of q's: a name after n_ is its own, a float keeps its dot", { skip }, () => {
  const examples = JSON.parse(fs.readFileSync(path.join(root, "help", "examples.json"), "utf8"));
  const sheet = JSON.parse(fs.readFileSync(path.join(root, "help", "cheatsheet.json"), "utf8"));
  const lines = [
    ...Object.values(examples).flatMap((entry) => entry.examples.flatMap((e) => [e.code, e.result])),
    ...sheet.flatMap((s) => s.items.flatMap((i) => [i.insert, i.example, i.result])),
    ...["r:1_til 5", "last -1_trades", "x:.5+y", "0x00_x", "(.5;.25e3)", "1f_x", "2_'x", "1_.z.p", "x:1__y", "0Nj_x 12i_y", "2024.01.02_x", "0D00:00:01_x", "a1_b+x_1", ".ns.util.f[x.y]"],
  ].filter((l) => typeof l === "string" && !l.includes("\n"));
  assert.ok(lines.length >= 480, `${lines.length} lines`);
  assert.deepStrictEqual(notTokens(lines), []);
});
