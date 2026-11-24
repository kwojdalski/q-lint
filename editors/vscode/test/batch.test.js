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
