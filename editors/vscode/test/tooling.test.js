// The switches of the profiling and code-quality features (#986-#992), and
// Organise Loads' command (#990): off, it refuses and asks nothing; on, it
// asks the language server for its Organise loads action and applies it. The
// server's side - the action, its kind, and its switch - is tested in the
// Rust LSP suite, as are the suppressions' and the performance rules'.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { TOOLING_SETTINGS, toolingOn, toolingOff } = require("../out/toolingfeatures.js");
const { registerOrganiseLoads, ORGANISE_LOADS } = require("../out/organiseloads.js");
const pkg = require("../package.json");

test("every switch is declared with its default, and read as declared", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  for (const [feature, { key, fallback }] of Object.entries(TOOLING_SETTINGS)) {
    assert.strictEqual(props[`q-lint.${key}`]?.default, fallback, key);
    assert.strictEqual(toolingOn(() => undefined, feature), fallback);
    assert.strictEqual(toolingOn((k, d) => (k === key ? !fallback : d), feature), !fallback);
    // Anything but a boolean is the default.
    assert.strictEqual(toolingOn((k, d) => (k === key ? "yes" : d), feature), fallback);
    assert.match(toolingOff(feature), new RegExp(`Set q-lint\\.${key.replace(/\./g, "\\.")} to true`));
  }
  // The server's own switches, which reach it as options.
  for (const key of ["suppressions.enable", "organiseLoads.enable", "performanceLints.enable", "formatChangedLines.enable"]) {
    assert.ok(`q-lint.${key}` in pkg.contributes.configuration[0].properties, key);
  }
  const organise = pkg.contributes.menus.commandPalette.find((m) => m.command === ORGANISE_LOADS);
  assert.match(organise.when, /config\.q-lint\.organiseLoads\.enable/);
});

test("Organise Loads refuses when off, and applies the server's action when on", async () => {
  stub.reset();
  const context = stub.newContext();
  const ran = [];
  const applied = [];
  const execute = vscode.commands.executeCommand;
  const kind = (value) => ({ value, append: (s) => kind(`${value}.${s}`), contains: (other) => other.value === value || other.value.startsWith(`${value}.`) });
  vscode.CodeActionKind = { SourceOrganizeImports: kind("source.organizeImports") };
  vscode.Range = class {};
  vscode.workspace.applyEdit = async (edit) => (applied.push(edit), true);
  vscode.commands.executeCommand = async (name, ...args) =>
    name === ORGANISE_LOADS
      ? execute(name, ...args)
      : (ran.push([name, args[2]]), [{ title: "Organise loads", kind: kind("source.organizeImports.q-lint"), edit: "the edit" }]);
  try {
    registerOrganiseLoads(context);
    vscode.window.activeTextEditor = { document: { languageId: "q" } };
    stub.config.user["organiseLoads.enable"] = false;
    assert.strictEqual(await stub.commands.get(ORGANISE_LOADS)(), false);
    assert.match(stub.messages.at(-1)[1], /Organise loads is turned off\. Set q-lint\.organiseLoads\.enable to true/);
    assert.deepStrictEqual(ran, []);
    stub.config.user["organiseLoads.enable"] = true;
    assert.strictEqual(await stub.commands.get(ORGANISE_LOADS)(), true);
    assert.deepStrictEqual(ran, [["vscode.executeCodeActionProvider", "source.organizeImports.q-lint"]]);
    assert.deepStrictEqual(applied, ["the edit"]);
    vscode.window.activeTextEditor = { document: { languageId: "python" } };
    assert.strictEqual(await stub.commands.get(ORGANISE_LOADS)(), false);
  } finally {
    vscode.commands.executeCommand = execute;
    vscode.window.activeTextEditor = undefined;
  }
});
