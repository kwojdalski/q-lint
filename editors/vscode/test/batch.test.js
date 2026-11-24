// A Windows batch wrapper is started through a shell (#1610).
const test = require("node:test");
const assert = require("node:assert");
const { isBatch, launchable } = require("../out/batch.js");

test("a .cmd or .bat on Windows goes through a shell, quoted; anything else as it is (#1610)", () => {
  assert.strictEqual(isBatch("C:\\tools\\qlinter.CMD", "win32"), true);
  assert.strictEqual(isBatch("C:\\tools\\qlinter.bat", "win32"), true);
  assert.strictEqual(isBatch("C:\\tools\\qlinter.exe", "win32"), false);
  assert.strictEqual(isBatch("/opt/qlinter.cmd", "linux"), false);
  assert.deepStrictEqual(launchable("C:\\my tools\\qlinter.cmd", ["--config", "C:\\a b\\q.toml"], "win32"), {
    command: '"C:\\my tools\\qlinter.cmd"',
    args: ['"--config"', '"C:\\a b\\q.toml"'],
    shell: true,
  });
  assert.deepStrictEqual(launchable("qlinter", ["--lsp"], "win32"), { command: "qlinter", args: ["--lsp"], shell: false });
});

// cmd expands %NAME% inside quotes: C:\src\100%OS%rates became
// C:\src\100Windows_NTrates, the wrong folder linted (#1835).
test("a .cmd given a word with a % is refused, not passed to cmd to expand", () => {
  assert.throws(() => launchable("C:\\tools\\qlinter.cmd", ["--format", "json", "C:\\src\\100%OS%rates"], "win32"), /cmd cannot pass "C:\\\\src\\\\100%OS%rates" to C:\\tools\\qlinter\.cmd as written: it reads a % in it itself/);
  assert.throws(() => launchable("C:\\100%\\qlinter.cmd", [], "win32"), /reads a %/);
  // An .exe takes it as it is: no shell reads it.
  assert.deepStrictEqual(launchable("C:\\tools\\qlinter.exe", ["C:\\src\\100%OS%rates"], "win32").args, ["C:\\src\\100%OS%rates"]);
});
