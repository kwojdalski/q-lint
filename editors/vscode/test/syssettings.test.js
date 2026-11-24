// The system settings view (#1043): values checked and read, the rows built
// - and, through the stand-in `vscode` and a fake q: off, the view is gone
// and its commands send nothing; on, Refresh reads, and an edit is sent
// only once confirmed - asked here on an unguarded process, by the
// read-only guard on a guarded one, and held when declined. The q side is
// syssettings_q.test.js.
const { stub } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const { setUp, heads } = require("./fakeq.js");
const { READ_SETTINGS, SET_SETTING, SYSTEM_SETTINGS, memoryText, readSettings, settingCommand, valueProblem } = require("../out/syssettings.js");
const { registerSystemSettings, settingRows, SYSTEM_SETTINGS_VIEW } = require("../out/syssettingsview.js");
const { PROCESS_TOOL_COMMANDS } = require("../out/processtools.js");
const { guardCheck } = require("../out/guard.js");
const pkg = require("../package.json");

const VALUES = ["25 80", "0", "7", "0", "0", "0N", "0", "473856 67108864 67108864 0 0 19327352832"];
const answer = (m) => (Array.isArray(m) && m[0] === READ_SETTINGS ? ["csPTgozw", VALUES] : Array.isArray(m) && m[0] === SET_SETTING ? m[2] : null);

test("each edit is checked against what the setting takes, and \\w is never edited", () => {
  assert.strictEqual(valueProblem("P", "10"), undefined);
  assert.match(valueProblem("P", "18"), /0 to 17/);
  assert.strictEqual(valueProblem("c", " 30   100 "), undefined);
  assert.match(valueProblem("c", "30"), /two whole numbers/);
  assert.strictEqual(valueProblem("o", "0N"), undefined);
  assert.strictEqual(valueProblem("o", "-5"), undefined);
  assert.match(valueProblem("g", "2"), /0 or 1/);
  assert.match(valueProblem("P", "1;exit 0"), /takes/);
  assert.match(valueProblem("w", "100"), /not a setting this view edits/);
  assert.match(valueProblem("l", "x"), /not a setting/);
  // \s is shown, not edited: q changes it from its own console only, so
  // no value sent over a connection is ever taken (#1916).
  assert.match(valueProblem("s", "0"), /not a setting this view edits/);
  assert.strictEqual(SYSTEM_SETTINGS.find((s) => s.key === "s").readOnly, true);
  assert.match(SYSTEM_SETTINGS.find((s) => s.key === "s").note, /Read only here: q changes it from its own console only/);
  assert.ok(SET_SETTING.includes('enlist each "cPTgoz"'), SET_SETTING);
  assert.strictEqual(settingCommand("c", " 30   100 "), "\\c 30 100");
  assert.ok(SYSTEM_SETTINGS.every((s) => s.note.length > 20));
});

test("the answer is read, \\w is named, and every edit is a write to the guard", () => {
  const values = readSettings(["csPTgozw", VALUES]);
  assert.strictEqual(values.get("o"), "0N");
  assert.throws(() => readSettings(["cs", ["1"]]), /something other than its settings/);
  assert.match(memoryText(VALUES[7]), /^used 0\.5 MB, heap 64\.0 MB, peak 64\.0 MB, limit none$/);
  const rows = settingRows(values);
  // \s and \w have no pencil.
  assert.deepStrictEqual(rows.filter((r) => r.contextValue === "systemSetting.readOnly").map((r) => r.data.key), ["s", "w"]);
  assert.deepStrictEqual(rows.filter((r) => r.contextValue === "systemSetting").length, 6);
  const prod = { label: "p", tags: ["prod"] };
  assert.notStrictEqual(guardCheck(settingCommand("P", "10"), [prod], { enabled: true, tags: ["prod"] }), undefined);
});

test("the switch is declared on, and the view and its commands only where it is", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.processes.systemSettings.enable"].default, true);
  assert.strictEqual(pkg.contributes.views["q-lint"].find((v) => v.id === SYSTEM_SETTINGS_VIEW).when, "config.q-lint.processes.systemSettings.enable");
  const menus = Object.values(pkg.contributes.menus).flat();
  for (const id of [PROCESS_TOOL_COMMANDS.refreshSystemSettings, PROCESS_TOOL_COMMANDS.editSystemSetting]) {
    const entries = menus.filter((m) => m.command === id);
    assert.ok(entries.length > 0, id);
    assert.ok(entries.every((m) => /config\.q-lint\.processes\.systemSettings\.enable/.test(m.when)), id);
  }
});

test("off, nothing is sent; on, Refresh reads and a confirmed edit is sent", async (t) => {
  const { q, live, feature } = await setUp(t, { config: { "processes.systemSettings.enable": false }, answer, register: registerSystemSettings });
  await live.connectTo("rdb");
  const before = q.sent.length;
  assert.strictEqual(feature.tree().open, false);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.refreshSystemSettings)(), /system settings view is turned off/);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.editSystemSetting)("P", "10"), /turned off/);
  assert.strictEqual(q.sent.length, before);

  stub.config.user["processes.systemSettings.enable"] = true;
  stub.changeConfig("q-lint.processes.systemSettings.enable");
  const values = await stub.commands.get(PROCESS_TOOL_COMMANDS.refreshSystemSettings)();
  assert.strictEqual(values.get("c"), "25 80");
  assert.strictEqual(feature.tree().roots.length, 8);
  // Declined, nothing is sent.
  stub.picks.push(undefined);
  assert.strictEqual(await stub.commands.get(PROCESS_TOOL_COMMANDS.editSystemSetting)("P", "10"), "not confirmed");
  assert.deepStrictEqual(heads(q.sent.slice(before)), [READ_SETTINGS]);
  // Confirmed, it is set and the view read again.
  stub.picks.push("Set");
  assert.strictEqual(await stub.commands.get(PROCESS_TOOL_COMMANDS.editSystemSetting)("P", "10"), "10");
  assert.deepStrictEqual(q.sent.slice(before + 1, before + 2), [[SET_SETTING, "P", "10"]]);
  assert.deepStrictEqual(heads(q.sent.slice(before + 2)), [READ_SETTINGS]);
  // A value it does not take is refused before anything is sent, and so
  // is \s, whatever the value.
  const sent = q.sent.length;
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.editSystemSetting)("s", "0"), /\\s is not a setting this view edits/);
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.editSystemSetting)("P", "1;exit 0"), /takes a whole number/);
  assert.strictEqual(q.sent.length, sent);
});

test("on a guarded process the guard asks, and a decline holds the edit", async (t) => {
  const { q, live } = await setUp(t, { tags: ["prod"], answer, register: registerSystemSettings });
  await live.connectTo("rdb");
  const before = q.sent.length;
  stub.picks.push(undefined);
  await stub.commands.get(PROCESS_TOOL_COMMANDS.editSystemSetting)("T", "5");
  assert.strictEqual(q.sent.length, before);
  assert.ok(stub.messages.some(([kind, text]) => kind === "warning" && /would change rdb/.test(text)));
  assert.ok(stub.messages.some(([, text]) => /\\T was not set: .*not confirmed/.test(text)));
  stub.picks.push("Run Anyway");
  assert.strictEqual(await stub.commands.get(PROCESS_TOOL_COMMANDS.editSystemSetting)("T", "5"), "5");
  // Set, and the view (on by default) read again.
  assert.deepStrictEqual(q.sent[before], [SET_SETTING, "T", "5"]);
  assert.deepStrictEqual(heads(q.sent.slice(before + 1)), [READ_SETTINGS]);
});

test("an edit is not set when another process became active while it was asked (#1291)", async (t) => {
  const { q, live } = await setUp(t, { answer, register: registerSystemSettings, more: [{ label: "other" }] });
  await live.connectTo("rdb");
  stub.picks.push(async () => (await live.connectTo("other"), "Set"));
  assert.match(await stub.commands.get(PROCESS_TOOL_COMMANDS.editSystemSetting)("T", "30"), /\\T was not set: rdb is no longer the active process; nothing was run/);
  assert.ok(!heads(q.sent).includes(SET_SETTING));
});
