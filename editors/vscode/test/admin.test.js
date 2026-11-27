// The connection and process-admin switches (#1032-#1041) held against
// package.json and the docs: each feature's own enable setting, declared
// with the default admin.ts reads, in the switch table of
// docs/vscode/processes.md (which the README links), its commands all
// declared, and none restarting the language server.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");
const { ADMIN_COMMANDS, ADMIN_SETTINGS, ADMIN_VIEWS, adminOff, readAdmin } = require("../out/admin.js");
const { needsRestart } = require("../out/settings.js");

const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: process admin");
const doc = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docs", "vscode", "processes.md"), "utf8");
const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

test("each feature has its own boolean switch, declared with the default it is read with", () => {
  const read = new Map();
  readAdmin((key, fallback) => (read.set(key, fallback), fallback));
  for (const { key, fallback } of Object.values(ADMIN_SETTINGS)) {
    const spec = section.properties[`q-lint.${key}`];
    assert.ok(spec, key);
    assert.strictEqual(spec.type, "boolean", key);
    assert.strictEqual(spec.default, fallback, key);
    assert.strictEqual(read.get(key), fallback, key);
  }
  // The section holds the switches and the environment colours, no more.
  const extra = Object.keys(section.properties).filter((k) => !Object.values(ADMIN_SETTINGS).some((s) => `q-lint.${s.key}` === k));
  assert.deepStrictEqual(extra, ["q-lint.processes.environmentColor.colors"]);
  // What acts on its own, or recolours the window, is off unless turned on.
  assert.deepStrictEqual(Object.entries(ADMIN_SETTINGS).filter(([, s]) => !s.fallback).map(([f]) => f), ["environmentColor", "scheduledExports"]);
  // Anything but a boolean is the default.
  assert.deepStrictEqual(readAdmin(() => "false"), readAdmin((_k, f) => f));
});

test("every setting is in the process docs' switch table, which the README links, and none restarts the server", () => {
  assert.ok(readme.includes("https://github.com/kwojdalski/q-lint/blob/master/docs/vscode/processes.md"), "the README does not link docs/vscode/processes.md");
  for (const key of Object.keys(section.properties)) {
    assert.ok(doc.includes(`| \`${key}\` |`), `${key} is not in docs/vscode/processes.md's switch table`);
    const affects = (s) => key === s || key.startsWith(`${s}.`);
    assert.strictEqual(needsRestart(affects), false, key);
  }
});

test("every command and view is declared, and each off message names its switch", () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const id of Object.values(ADMIN_COMMANDS)) assert.ok(declared.has(id), id);
  const views = new Set(Object.values(pkg.contributes.views).flat().map((v) => v.id));
  for (const id of Object.values(ADMIN_VIEWS)) assert.ok(views.has(id), id);
  for (const [feature, { key }] of Object.entries(ADMIN_SETTINGS)) assert.ok(adminOff(feature).endsWith(`Set q-lint.${key} to true to turn it on.`), feature);
});
