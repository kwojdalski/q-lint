// The snippet file as VS Code will read it: it parses, it is contributed for
// q and packaged, and every snippet has what the completion list shows - a
// prefix to type, a body, and a description beside it. That each body is q
// the linter accepts is `tests/snippets.rs`, which needs no binary built.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");

const root = path.join(__dirname, "..");
const contributed = pkg.contributes.snippets;
const snippets = JSON.parse(fs.readFileSync(path.join(root, "snippets", "q.json"), "utf8"));

const list = (value) => (Array.isArray(value) ? value : [value]);

test("package.json contributes the snippet file for q, and the file is there", () => {
  assert.deepStrictEqual(contributed, [{ language: "q", path: "./snippets/q.json" }]);
  assert.ok(fs.statSync(path.join(root, contributed[0].path)).isFile());
});

// A .vscodeignore pattern as a test of a path: `**` is any run of
// directories, `*` any run within one name, and a directory named takes
// everything under it.
function ignores(pattern, file) {
  const literal = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const glob = pattern
    .replace(/\/$/, "")
    .split("**")
    .map((part) => part.split("*").map(literal).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${glob}(/.*)?$`).test(file);
}

test("the snippet file is not left out of the package", () => {
  // .vscodeignore names what does not ship; a pattern that took in the
  // snippets would leave the contribution pointing at nothing.
  assert.ok(ignores("test/**", "test/snippets.test.js"));
  assert.ok(ignores("**/*.map", "out/extension.js.map"));
  assert.ok(!ignores("**/*.map", "snippets/q.json"));
  const patterns = fs
    .readFileSync(path.join(root, ".vscodeignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const pattern of patterns) {
    assert.ok(!ignores(pattern, "snippets/q.json"), `.vscodeignore leaves it out: ${pattern}`);
  }
});

test("every snippet has a prefix, a body and a description", () => {
  const names = Object.keys(snippets);
  assert.ok(names.length >= 20, `expected the snippet file, found ${names.length}`);
  for (const name of names) {
    const { prefix, body, description } = snippets[name];
    const prefixes = list(prefix);
    assert.ok(prefix !== undefined && prefixes.length > 0, `${name}: no prefix`);
    for (const p of prefixes) {
      // A word, so it completes as one is typed: VS Code matches a prefix
      // against the word before the cursor.
      assert.match(p, /^[a-z][a-z0-9]*$/, `${name}: prefix ${JSON.stringify(p)}`);
    }
    const lines = list(body);
    assert.ok(body !== undefined && lines.length > 0, `${name}: no body`);
    for (const line of lines) assert.strictEqual(typeof line, "string", `${name}: body`);
    assert.ok(lines.join("").trim().length > 0, `${name}: an empty body`);
    assert.ok(
      typeof description === "string" && description.trim().length > 0,
      `${name}: no description`,
    );
  }
});

test("no prefix is claimed by two snippets", () => {
  const owner = new Map();
  for (const [name, { prefix }] of Object.entries(snippets)) {
    for (const p of list(prefix)) {
      assert.ok(!owner.has(p), `${JSON.stringify(p)} is the prefix of ${owner.get(p)} and ${name}`);
      owner.set(p, name);
    }
  }
});

test("the forms q is mostly written in each have a snippet", () => {
  // qSQL, protected evaluation, the each family, the conditional, the
  // control words, a documented function and a namespace block (#839).
  const prefixes = new Set(Object.values(snippets).flatMap(({ prefix }) => list(prefix)));
  for (const p of [
    "select", "update", "exec", "delete", "trap", "trapn", "each", "eachleft", "eachright",
    "eachboth", "eachprior", "peach", "cond", "if", "do", "while", "fn", "namespace",
  ]) {
    assert.ok(prefixes.has(p), `no snippet for ${p}`);
  }
});
