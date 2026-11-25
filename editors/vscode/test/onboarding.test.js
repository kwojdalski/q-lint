// Process setup and onboarding (#888): TLS choices, tag colours and where
// they are saved, the Help and Feedback links, and the walkthrough, held
// against package.json. Run after `tsc`; nothing here needs an editor.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");
const {
  TAG_COLOURS,
  processThemeColour,
  tagColourTarget,
  tagColours,
  tagThemeColour,
  tlsChoices,
  withTagColour,
} = require("../out/processes.js");
const { readProcessSettings } = require("../out/liveconfig.js");
const { HELP_LINKS, ONBOARDING, walkthroughId } = require("../out/onboarding.js");
const { needsRestart } = require("../out/settings.js");

const root = path.join(__dirname, "..");
const proc = (...tags) => ({ label: "x", host: "h", port: 1, tags });

test("TLS is offered with the current value first, so Enter keeps it", () => {
  assert.deepStrictEqual(
    tlsChoices(undefined).map((c) => [c.label, c.tls, c.description]),
    [
      ["No", false, undefined],
      ["Yes", true, undefined],
    ],
  );
  assert.deepStrictEqual(
    tlsChoices(true).map((c) => [c.label, c.tls, c.description]),
    [
      ["Yes", true, "current"],
      ["No", false, undefined],
    ],
  );
  assert.deepStrictEqual(
    tlsChoices(false).map((c) => [c.label, c.description]),
    [
      ["No", "current"],
      ["Yes", undefined],
    ],
  );
});

test("the tag colour setting keeps colour ids, lower-cases tags, and drops the rest", () => {
  assert.deepStrictEqual(
    tagColours({ EU: "charts.purple", " asia ": " terminal.ansiCyan ", bad: "not a colour", n: 3, "": "charts.red" }),
    { eu: "charts.purple", asia: "terminal.ansiCyan" },
  );
  for (const junk of [undefined, null, "eu", ["charts.red"], 7]) {
    assert.deepStrictEqual(tagColours(junk), {}, String(junk));
  }
});

test("a tag takes the setting's colour, else the built-in one", () => {
  assert.strictEqual(tagThemeColour("prod", {}), "charts.red");
  assert.strictEqual(tagThemeColour("UAT", {}), "charts.blue");
  assert.strictEqual(tagThemeColour("dev", {}), "charts.green");
  assert.strictEqual(tagThemeColour("eu", {}), undefined);
  assert.strictEqual(tagThemeColour("eu", { eu: "charts.purple" }), "charts.purple");
  // The setting overrides a built-in colour too.
  assert.strictEqual(tagThemeColour("Prod", { prod: "charts.orange" }), "charts.orange");
});

test("a tag named like an Object property has no colour unless one is set", () => {
  for (const tag of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.strictEqual(tagThemeColour(tag, {}), undefined, tag);
    assert.strictEqual(tagThemeColour(tag, tagColours({})), undefined, tag);
    assert.strictEqual(processThemeColour(proc(tag), {}), undefined, tag);
  }
  // And one set for it is kept and used.
  assert.strictEqual(tagThemeColour("__proto__", tagColours(JSON.parse('{"__proto__": "charts.purple"}'))), "charts.purple");
  assert.strictEqual(tagThemeColour("constructor", tagColours({ constructor: "charts.blue" })), "charts.blue");
});

test("a process takes its most cautious tag's colour", () => {
  assert.strictEqual(processThemeColour(proc("dev", "prod"), {}), "charts.red");
  assert.strictEqual(processThemeColour(proc("eu", "dev"), { eu: "charts.yellow" }), "charts.yellow");
  assert.strictEqual(processThemeColour(proc("eu", "prod"), { eu: "charts.purple" }), "charts.red");
  // A colour outside the chart colours ranks after them, then by tag order.
  assert.strictEqual(processThemeColour(proc("a", "dev"), { a: "terminal.ansiCyan" }), "charts.green");
  assert.strictEqual(processThemeColour(proc("a", "b"), { a: "x.one", b: "x.two" }), "x.one");
  assert.strictEqual(processThemeColour(proc("eu"), {}), undefined);
  assert.strictEqual(processThemeColour(proc(), {}), undefined);
  assert.deepStrictEqual([...TAG_COLOURS], ["charts.red", "charts.orange", "charts.yellow", "charts.blue", "charts.purple", "charts.green"]);
});

test("Edit Tag Color sets or clears one tag and keeps the rest, sorted", () => {
  const before = { uat: "charts.yellow", eu: "charts.purple" };
  assert.deepStrictEqual(withTagColour(before, "Asia", "charts.green"), {
    asia: "charts.green",
    eu: "charts.purple",
    uat: "charts.yellow",
  });
  assert.deepStrictEqual(withTagColour(before, "eu", "charts.blue"), { eu: "charts.blue", uat: "charts.yellow" });
  assert.deepStrictEqual(withTagColour(before, "eu", undefined), { uat: "charts.yellow" });
  assert.deepStrictEqual(withTagColour({}, "eu", undefined), {});
  // The input is not changed.
  assert.deepStrictEqual(before, { uat: "charts.yellow", eu: "charts.purple" });
});

test("tag colours are saved for the user, unless the workspace already sets them", () => {
  assert.strictEqual(tagColourTarget(undefined), "user");
  assert.strictEqual(tagColourTarget({ globalValue: { eu: "charts.red" } }), "user");
  assert.strictEqual(tagColourTarget({ workspaceValue: {} }), "workspace");
  assert.strictEqual(tagColourTarget({ globalValue: {}, workspaceValue: { eu: "charts.red" } }), "workspace");
});

test("the processes setting is read, with the default package.json declares, and does not restart the server", () => {
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: processes");
  const declared = section.properties;
  const read = new Map();
  const settings = readProcessSettings((key, fallback) => {
    read.set(key, fallback);
    return fallback;
  });
  // The read-only guard's (#918), read at each send.
  const guard = require("../out/guard.js").readGuard((key, fallback) => {
    read.set(key, fallback);
    return fallback;
  });
  assert.deepStrictEqual(guard, { enabled: true, tags: ["prod", "prd", "production"] });
  // Its reval backstop's, read at each send too.
  const enforce = require("../out/guard.js").readEnforce((key, fallback) => {
    read.set(key, fallback);
    return fallback;
  });
  assert.strictEqual(enforce, true);
  for (const [key, spec] of Object.entries(declared)) {
    const short = key.replace(/^q-lint\./, "");
    assert.ok(read.has(short), `${key} is declared but never read`);
    assert.deepStrictEqual(read.get(short), spec.default, key);
    const affects = (s) => key === s || key.startsWith(`${s}.`);
    assert.strictEqual(needsRestart(affects), false, key);
  }
  assert.strictEqual(read.size, Object.keys(declared).length);
  assert.deepStrictEqual(settings, { tagColors: {} });
  const set = (v) => readProcessSettings((key, fallback) => (key === "processes.tagColors" ? v : fallback)).tagColors;
  assert.deepStrictEqual(set({ EU: "charts.purple" }), { eu: "charts.purple" });
  assert.deepStrictEqual(set("charts.red"), {});
  // The schema's pattern is the reader's: what the Settings UI accepts is kept.
  const pattern = new RegExp(declared["q-lint.processes.tagColors"].additionalProperties.pattern);
  for (const id of [...TAG_COLOURS, "terminal.ansiCyan", "not a colour", "charts..red", ".red", "charts.", "1x"]) {
    assert.strictEqual(pattern.test(id), set({ t: id }).t === id, id);
  }
});

test("Edit Tag Color is on a tag row", () => {
  const items = pkg.contributes.menus["view/item/context"].filter((m) => m.command === ONBOARDING.editTagColor);
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.strictEqual(item.when, "view == q-lint.processes && viewItem == tag");
  }
});

test("Help and Feedback links are the q-lint repository's, and the welcome says the same", () => {
  assert.deepStrictEqual(
    HELP_LINKS.map((l) => l.id),
    ["readme", "rules", "bug", "feature", "releases"],
  );
  for (const link of HELP_LINKS) {
    assert.match(link.url, /^https:\/\/github\.com\/kwojdalski\/q-lint\//, link.id);
  }
  // The documents linked are ones the repository has.
  const repo = path.join(root, "..", "..");
  for (const link of HELP_LINKS) {
    const file = link.url.match(/\/blob\/master\/(.+)$/);
    if (file) {
      assert.ok(fs.existsSync(path.join(repo, file[1])), file[1]);
    }
  }
  assert.match(HELP_LINKS.find((l) => l.id === "bug").url, /issues\/new\?labels=bug$/);
  const view = pkg.contributes.views["q-lint"].find((v) => v.id === ONBOARDING.helpView);
  assert.strictEqual(view.name, "Help and Feedback");
  const welcome = pkg.contributes.viewsWelcome.find((w) => w.view === ONBOARDING.helpView);
  for (const id of ["readme", "rules", "bug", "feature"]) {
    assert.ok(welcome.contents.includes(`(${HELP_LINKS.find((l) => l.id === id).url})`), id);
  }
});

test("the walkthrough's steps have media that ships and complete on real events", () => {
  const [walkthrough] = pkg.contributes.walkthroughs;
  assert.strictEqual(walkthrough.id, ONBOARDING.walkthrough);
  assert.strictEqual(walkthrough.title, "Get started with q-lint");
  assert.strictEqual(walkthroughId(pkg.publisher, pkg.name), `${pkg.publisher}.${pkg.name}#${walkthrough.id}`);
  assert.deepStrictEqual(
    walkthrough.steps.map((s) => s.id),
    ["lint", "addProcess", "query", "explorer", "grid", "notebook"],
  );
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  // Commands VS Code itself provides: a view's focus command and opening a file.
  const builtIn = new Set(["workbench.action.files.openFile", "workbench.actions.view.problems", `${EXPLORER_VIEW}.focus`]);
  const views = new Set(Object.values(pkg.contributes.views).flat().map((v) => v.id));
  const settings = new Set(pkg.contributes.configuration.flatMap((c) => Object.keys(c.properties)));
  for (const step of walkthrough.steps) {
    assert.ok(fs.existsSync(path.join(root, step.media.markdown)), step.media.markdown);
    assert.ok(step.completionEvents.length > 0, step.id);
    for (const event of step.completionEvents) {
      const [kind, arg] = [event.slice(0, event.indexOf(":")), event.slice(event.indexOf(":") + 1)];
      if (kind === "onCommand") assert.ok(declared.has(arg), `${step.id}: ${event}`);
      else if (kind === "onView") assert.ok(views.has(arg) || arg === "workbench.panel.markers.view", `${step.id}: ${event}`);
      else if (kind === "onSettingChanged") assert.ok(settings.has(arg), `${step.id}: ${event}`);
      // A walkthrough sees only global context keys: one the extension sets.
      else assert.strictEqual(event, `onContext:${ONBOARDING.sawFinding}`, `${step.id}: ${event}`);
    }
    for (const [, command] of step.description.matchAll(/\(command:([^)?]+)/g)) {
      assert.ok(declared.has(command) || builtIn.has(command), `${step.id}: ${command}`);
    }
  }
});

const EXPLORER_VIEW = "q-lint.processExplorer";
