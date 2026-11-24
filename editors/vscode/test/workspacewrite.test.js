// Writes into a workspace folder do not follow a link the repository ships
// (#1830): Write Lint Baseline replaced ~/.zshrc through a committed
// qlinter-baseline.json link, and a dangling link made a file outside.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertWritable, assertWritableIn, folderOf, linkProblem, relativeInside } = require("../out/workspacewrite.js");

test("a file, or a folder on the way to it, that is a symbolic link is not written through", { skip: process.platform === "win32" }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-home-"));
  const victim = path.join(home, ".zshrc");
  fs.writeFileSync(victim, "export PATH=/opt/kx:$PATH\n");
  fs.symlinkSync(victim, path.join(repo, "qlinter-baseline.json"));
  fs.symlinkSync(path.join(home, "made.json"), path.join(repo, "dangling.json"));
  fs.symlinkSync(home, path.join(repo, ".qlint"));
  assert.match(linkProblem(repo, path.join(repo, "qlinter-baseline.json")), /^qlinter-baseline\.json is a symbolic link/);
  assert.match(linkProblem(repo, path.join(repo, "dangling.json")), /^dangling\.json is a symbolic link/);
  assert.match(linkProblem(repo, path.join(repo, ".qlint", "processes.json")), /^\.qlint is a symbolic link/);
  assert.throws(() => assertWritable(repo, path.join(repo, "qlinter-baseline.json")), /symbolic link/);
  assert.strictEqual(fs.readFileSync(victim, "utf8"), "export PATH=/opt/kx:$PATH\n");
  // A plain file, one not there yet, and one in a folder not there yet are.
  fs.writeFileSync(path.join(repo, "plain.json"), "{}");
  assert.strictEqual(linkProblem(repo, path.join(repo, "plain.json")), undefined);
  assert.strictEqual(linkProblem(repo, path.join(repo, "new.json")), undefined);
  assert.strictEqual(linkProblem(repo, path.join(repo, ".devcontainer", "devcontainer.json")), undefined);
  // The folder itself may be reached through a link.
  const via = path.join(home, "via");
  fs.symlinkSync(repo, via);
  assert.strictEqual(linkProblem(via, path.join(via, "plain.json")), undefined);
  assert.match(linkProblem(repo, path.join(home, "x.json")), /is not inside/);
  // A snapshot or test file is checked against the folder holding it.
  assert.strictEqual(folderOf([home, repo], path.join(repo, "a", "b.q")), repo);
  assert.strictEqual(folderOf([repo], path.join(home, "b.q")), undefined);
  assert.throws(() => assertWritableIn([{ uri: { fsPath: repo } }], path.join(repo, "dangling.json")), /symbolic link/);
  assert.doesNotThrow(() => assertWritableIn(undefined, path.join(repo, "dangling.json")));
});

// "Outside the folder" was read off a relative path that starts with two
// dots, which a folder named `..lib` or `...` also gives: a link under one
// was written through unchecked, and a plain file there refused (#2002).
test("a folder whose name starts with two dots is inside: a link under it is not written through", { skip: process.platform === "win32" }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-dots-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-home-"));
  const victim = path.join(home, "victim.q");
  for (const dir of ["lib", "..lib", "...", "..."+path.sep+"deep"]) {
    fs.mkdirSync(path.join(repo, dir));
    const link = path.join(repo, dir, "test_foo.q");
    fs.symlinkSync(victim, link);
    assert.strictEqual(folderOf([home, repo], link), repo, dir);
    assert.throws(() => assertWritableIn([{ uri: { fsPath: repo } }], link), /test_foo\.q is a symbolic link, which q-lint does not write through/, dir);
    assert.match(linkProblem(repo, link), /is a symbolic link/, dir);
    // A plain file there, and one not there yet, are written.
    fs.writeFileSync(path.join(repo, dir, "plain.q"), "");
    assert.strictEqual(linkProblem(repo, path.join(repo, dir, "plain.q")), undefined, dir);
    assert.doesNotThrow(() => assertWritableIn([{ uri: { fsPath: repo } }], path.join(repo, dir, "new.q")), dir);
  }
  assert.ok(!fs.existsSync(victim));
  // Above the folder, beside it, and the folder itself are not inside it.
  for (const file of [path.dirname(repo), path.join(repo, "..", "x.q"), path.join(repo, "..", "..lib", "x.q"), `${repo}..lib`, repo, home]) {
    assert.strictEqual(relativeInside(repo, file), undefined, file);
    assert.match(linkProblem(repo, file), /is not inside/, file);
    assert.strictEqual(folderOf([repo], file), undefined, file);
  }
  assert.strictEqual(relativeInside(repo, path.join(repo, "..lib", "a.q")), path.join("..lib", "a.q"));
  assert.strictEqual(relativeInside(repo, path.join(repo, "a", "..", "..b")), "..b");
});
