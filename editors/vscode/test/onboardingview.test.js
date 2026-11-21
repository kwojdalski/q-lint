// The VS Code side of onboarding (src/onboardingview.ts), under the stand-in
// `vscode` module. Run after `tsc`; nothing here needs an editor.
const test = require("node:test");
const assert = require("node:assert");
const { stub } = require("./vscode_stub.js");
const { registerOnboarding } = require("../out/onboardingview.js");

function register(processes = []) {
  stub.reset();
  const context = stub.newContext();
  context.extension = { packageJSON: { publisher: "p", name: "q-lint" } };
  registerOnboarding(context, () => processes);
  return (...args) => stub.commands.get("q-lint.editTagColor")(...args);
}

// A tag named after an Object property read as having a colour set at every
// level, so going back to default wrote both - and a write to the workspace
// settings with no folder open is refused by VS Code, failing the command.
test("Edit Tag Color back to default on a tag named toString writes nothing where nothing is set", async () => {
  const edit = register();
  for (const tag of ["toString", "constructor", "valueOf"]) {
    stub.picks.push(({ items }) => items[0]);
    await edit(tag);
  }
  assert.deepStrictEqual(stub.updates, []);
});

test("Edit Tag Color back to default clears the tag where it is set", async () => {
  const edit = register();
  stub.config.user["processes.tagColors"] = { eu: "charts.purple" };
  stub.picks.push(({ items }) => items[0]);
  await edit("eu");
  assert.deepStrictEqual(stub.updates, [{ key: "processes.tagColors", value: undefined, target: "user" }]);
});
