// Drift detection (#933) and hot reload on save (#934) through the
// stand-in `vscode` (vscode_stub.js), with a stand-in for `Live` whose
// connection answers what drift_q.test.js shows a real q answers: the
// diff opened for a drifted function, a save sending only what changed
// after Redefine's confirmation, prod asked about every time, a file bound
// elsewhere left alone, and both turned off sending nothing.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const listeners = { open: [], close: [], save: [] };
const on = (list) => (l) => (listeners[list].push(l), { dispose: () => (listeners[list] = listeners[list].filter((x) => x !== l)) });
vscode.workspace.onDidOpenTextDocument = on("open");
vscode.workspace.onDidCloseTextDocument = on("close");
vscode.workspace.onDidSaveTextDocument = on("save");
vscode.workspace.registerTextDocumentContentProvider = (_scheme, provider) => ((vscode.provider = provider), { dispose() {} });
vscode.workspace.asRelativePath = (uri) => path.basename(uri.fsPath);
vscode.workspace.textDocuments = [];
const diffs = [];
const execute = vscode.commands.executeCommand;
vscode.commands.executeCommand = async (name, ...args) => (name === "vscode.diff" ? void diffs.push(args) : execute(name, ...args));
vscode.Uri.from = ({ scheme, path: p, query }) => ({ scheme, path: p, query, toString: () => `${scheme}:${p}?${query}` });
let status = [];
vscode.window.setStatusBarMessage = (text) => status.push(text);

const { Drift } = require("../out/driftview.js");
const { DRIFT } = require("../out/definitions.js");
const { REDEFINE } = require("../out/funcsource.js");

const dev = { label: "dev", host: "h", port: 1, tags: ["dev"] };
const prod = { label: "prod", host: "h", port: 2, tags: ["prod"] };

/// A stand-in for `Live`, connected to `process`, whose q holds `held`
/// (name -> lambda text) and applies REDEFINE as the real one does.
function fakeLive(process, held, binding) {
  const live = {
    sent: [],
    process: process ?? undefined,
    activeLabel: () => live.process?.label,
    activeProcess: () => live.process,
    fileBinding: () => binding,
    borrow: (use) =>
      live.process === undefined
        ? undefined
        : use(
            {
              call: async (lambda, ...args) => {
                live.sent.push([lambda === DRIFT ? "DRIFT" : lambda === REDEFINE ? "REDEFINE" : "?", ...args]);
                if (lambda === DRIFT) {
                  const names = args[0].split(" ");
                  return {
                    name: names,
                    state: names.map((n) => (n in held ? "lambda" : "missing")),
                    text: names.map((n) => held[n] ?? ""),
                  };
                }
                const [name, was, text] = args;
                if (held[name] !== was) throw new Error("changed on the process since it was opened");
                held[name] = text;
                return name;
              },
            },
            live.process,
          ),
  };
  return live;
}

function documentOf(file, text) {
  return { uri: vscode.Uri.file(file), languageId: "q", isDirty: false, getText: () => text, set text(v) { text = v; } };
}

function setup(held, { process = dev, binding, settings = {} } = {}) {
  stub.reset();
  stub.config.user = { "hotReload.enable": true, "processExplorer.driftDetection.enable": true, ...settings };
  listeners.open = [];
  listeners.close = [];
  listeners.save = [];
  diffs.length = 0;
  status = [];
  const live = fakeLive(process, held, binding);
  const context = stub.newContext();
  const drift = new Drift(context, live);
  return { live, drift, context };
}

test("hot reload sends a changed definition after Redefine's confirmation, and only it", async () => {
  const held = { f: "{x}", g: "{y}" };
  const { live, drift } = setup(held);
  const doc = documentOf("/w/a.q", "f:{x}\ng:{y}\n");
  listeners.open.forEach((l) => l(doc));
  assert.deepStrictEqual(drift.hotReloadState(), { listening: true, files: ["file:///w/a.q"] });
  doc.text = "f:{x+1}\ng:{y}\n";
  stub.picks = [(o) => (stub.asked = o, "Reload")];
  const out = await drift.reload(doc);
  assert.deepStrictEqual(out.sent, ["f"]);
  assert.match(stub.asked.message, /^Redefine f on dev\?/);
  assert.deepStrictEqual(stub.asked.items.slice(1), ["Reload", "Reload on Every Save"]);
  assert.match(stub.asked.items[0].detail, /Saved in a\.q\./);
  assert.deepStrictEqual(live.sent, [["DRIFT", "f"], ["REDEFINE", "f", "{x}", "{x+1}"]]);
  assert.strictEqual(held.f, "{x+1}");
  // Saved again with no change: nothing is read or sent.
  live.sent.length = 0;
  assert.strictEqual((await drift.reload(doc)).reason, "no definition changed");
  assert.deepStrictEqual(live.sent, []);
  // Reload on Every Save: the next save is not asked about.
  doc.text = "f:{x+2}\ng:{y}\n";
  stub.picks = ["Reload on Every Save"];
  await drift.reload(doc);
  doc.text = "f:{x+3}\ng:{y}\n";
  stub.picks = [];
  stub.messages = [];
  assert.deepStrictEqual((await drift.reload(doc)).sent, ["f"]);
  assert.strictEqual(held.f, "{x+3}");
  assert.ok(!stub.messages.some(([kind, m]) => kind === "warning" && /Redefine/.test(m)));
});

test("declined, nothing is sent and the next save asks again over the same text", async () => {
  const held = { f: "{x}" };
  const { live, drift } = setup(held);
  const doc = documentOf("/w/a.q", "f:{x}\n");
  listeners.open.forEach((l) => l(doc));
  doc.text = "f:{x+1}\n";
  stub.picks = [undefined];
  assert.strictEqual((await drift.reload(doc)).reason, "not confirmed");
  assert.deepStrictEqual(live.sent.map((s) => s[0]), ["DRIFT"]);
  stub.picks = ["Reload"];
  assert.deepStrictEqual((await drift.reload(doc)).sent, ["f"]);
});

test("a production process is asked about on every save, with the warning, and never offered Every Save", async () => {
  const held = { f: "{x}" };
  const { drift } = setup(held, { process: prod });
  const doc = documentOf("/w/a.q", "f:{x}\n");
  listeners.open.forEach((l) => l(doc));
  for (const text of ["f:{x+1}\n", "f:{x+2}\n"]) {
    doc.text = text;
    stub.picks = [(o) => (stub.asked = o, "Reload")];
    stub.asked = undefined;
    await drift.reload(doc);
    assert.ok(stub.asked, "asked");
    assert.deepStrictEqual(stub.asked.items.slice(1), ["Reload"]);
    // The read-only guard (#918) guards prod by default, and its warning
    // takes the production one's place, as in Redefine's confirmation.
    assert.match(stub.asked.items[0].detail, /prod is tagged prod, which q-lint\.processes\.readOnlyGuard\.tags guards/);
    assert.match(stub.asked.items[0].detail, /A production process is asked about on every save\./);
  }
  // With the guard off, the production warning is said.
  stub.config.user["processes.readOnlyGuard.enable"] = false;
  doc.text = "f:{x+3}\n";
  stub.picks = [(o) => (stub.asked = o, "Reload")];
  await drift.reload(doc);
  assert.match(stub.asked.items[0].detail, /prod is a production process/);
  assert.deepStrictEqual(stub.asked.items.slice(1), ["Reload"]);
  assert.strictEqual(held.f, "{x+3}");
});

test("a process the read-only guard guards (#918) is named in the question on every save, never offered Every Save; declined, nothing is redefined", async () => {
  const held = { f: "{x}" };
  const live1 = { label: "live1", host: "h", port: 3, tags: ["live"] };
  const { live, drift } = setup(held, { process: live1, settings: { "processes.readOnlyGuard.tags": ["live"] } });
  const doc = documentOf("/w/a.q", "f:{x}\n");
  listeners.open.forEach((l) => l(doc));
  doc.text = "f:{x+1}\n";
  stub.picks = [(o) => ((stub.asked = o), undefined)];
  assert.strictEqual((await drift.reload(doc)).reason, "not confirmed");
  assert.match(stub.asked.message, /^Redefine f on the read-only process live1\?/);
  assert.match(stub.asked.items[0].detail, /tagged live, which q-lint\.processes\.readOnlyGuard\.tags guards/);
  assert.match(stub.asked.items[0].detail, /A read-only guarded process is asked about on every save\./);
  assert.deepStrictEqual(stub.asked.items.slice(1), ["Reload"]);
  assert.deepStrictEqual(live.sent.map((s) => s[0]), ["DRIFT"]);
  assert.strictEqual(held.f, "{x}");
  // Confirmed, it is sent; the next save asks again.
  stub.picks = ["Reload"];
  assert.deepStrictEqual((await drift.reload(doc)).sent, ["f"]);
  doc.text = "f:{x+2}\n";
  stub.picks = [(o) => ((stub.asked = o), "Reload")];
  stub.asked = undefined;
  await drift.reload(doc);
  assert.ok(stub.asked, "asked again");
  assert.strictEqual(held.f, "{x+2}");
});

test("a function the process holds otherwise, a new one, a file bound elsewhere and no connection are not sent", async () => {
  const held = { f: "{x*9}", g: "{y}" };
  const { live, drift } = setup(held);
  const doc = documentOf("/w/a.q", "f:{x}\ng:{y}\n");
  listeners.open.forEach((l) => l(doc));
  doc.text = "f:{x+1}\ng:{y}\nn:{z}\n";
  stub.picks = [];
  const out = await drift.reload(doc);
  assert.deepStrictEqual(out.sent, []);
  assert.deepStrictEqual(out.skipped.map((s) => s.name), ["f", "n"]);
  assert.ok(stub.messages.some(([kind, m]) => kind === "warning" && /did not send f \(the process holds a definition other/.test(m)));
  assert.strictEqual(held.f, "{x*9}");
  assert.ok(!live.sent.some((s) => s[0] === "REDEFINE"));

  const bound = setup({ f: "{x}" }, { binding: "uat" });
  const d2 = documentOf("/w/b.q", "f:{x}\n");
  listeners.open.forEach((l) => l(d2));
  d2.text = "f:{x+1}\n";
  assert.strictEqual((await bound.drift.reload(d2)).reason, "bound to uat");
  assert.deepStrictEqual(bound.live.sent, []);

  const none = setup({ f: "{x}" }, { process: null });
  const d3 = documentOf("/w/c.q", "f:{x}\n");
  listeners.open.forEach((l) => l(d3));
  d3.text = "f:{x+1}\n";
  assert.strictEqual((await none.drift.reload(d3)).reason, "not connected");
  assert.match(status[0], /not connected; f not reloaded/);
});

test("hot reload off: no listener, a save sends nothing, and turning it on and off takes effect at once", async () => {
  const held = { f: "{x}" };
  const { live, drift } = setup(held, { settings: { "hotReload.enable": false } });
  assert.deepStrictEqual(drift.hotReloadState(), { listening: false, files: [] });
  assert.strictEqual(listeners.save.length, 0);
  const doc = documentOf("/w/a.q", "f:{x+1}\n");
  assert.strictEqual(await drift.reload(doc), undefined);
  assert.deepStrictEqual(live.sent, []);
  stub.config.user["hotReload.enable"] = true;
  stub.changeConfig("q-lint.hotReload.enable");
  assert.strictEqual(listeners.save.length, 1);
  stub.config.user["hotReload.enable"] = false;
  stub.changeConfig("q-lint.hotReload.enable");
  assert.strictEqual(listeners.save.length, 0);
  assert.deepStrictEqual(drift.hotReloadState(), { listening: false, files: [] });
});

test("Check Drift lists what differs, and a pick opens the diff of the two texts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-drift-"));
  fs.writeFileSync(path.join(dir, "a.q"), "f:{x}\ng:{y}\n\\d .ns\nh:{z}\n");
  const held = { f: "{x}  ", g: "{y*2}" };
  const { live } = setup(held);
  vscode.workspace.findFiles = async () => [vscode.Uri.file(path.join(dir, "a.q"))];
  stub.picks = [(o) => (stub.listed = o, o.items.find((i) => i.label === "g"))];
  const rows = await stub.commands.get("q-lint.checkDrift")();
  assert.deepStrictEqual(rows.map((r) => [r.name, r.status]), [["f", "same"], ["g", "differs"], [".ns.h", "missing"]]);
  assert.strictEqual(stub.listed.title, "3 workspace definitions against dev: 1 differ, 1 not defined there, 1 the same.");
  assert.deepStrictEqual(stub.listed.items.map((i) => [i.label, i.description, i.detail]), [
    ["g", "differs on the process", "a.q:2"],
    [".ns.h", "not defined on the process", "a.q:4"],
  ]);
  assert.deepStrictEqual(live.sent, [["DRIFT", "f g .ns.h"]]);
  const [left, right, title] = diffs[0];
  assert.strictEqual(title, "g: dev ↔ a.q");
  assert.strictEqual(vscode.provider.provideTextDocumentContent(left), "/ g: on dev\n{y*2}\n");
  assert.strictEqual(vscode.provider.provideTextDocumentContent(right), "/ g: in a.q:2\n{y}\n");
});

// Definitions past the 20000th, and files past the 5000th, were dropped
// without a word: "0 differ" was shown while a dropped one differed.
test("Check Drift says when it compared only part of the workspace (#2985)", async () => {
  const { DRIFT_DEFINITIONS, DRIFT_FILES } = require("../out/driftview.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-drift-"));
  const n = DRIFT_DEFINITIONS + 5;
  fs.writeFileSync(path.join(dir, "big.q"), Array.from({ length: n }, (_, i) => `f${i}:{x+${i}}\n`).join(""));
  fs.writeFileSync(path.join(dir, "one.q"), "g:{x}\n");
  const held = Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, `{x+${i}}`]));
  // The one that differs is past the cap.
  held[`f${n - 1}`] = "{x+999}";
  setup(held);
  const said = () => stub.messages.map(([, m]) => m).join("\n");
  vscode.workspace.findFiles = async () => [vscode.Uri.file(path.join(dir, "big.q"))];
  const rows = await stub.commands.get("q-lint.checkDrift")();
  assert.strictEqual(rows.length, DRIFT_DEFINITIONS);
  assert.ok(said().includes(`${DRIFT_DEFINITIONS} workspace definitions against dev: 0 differ, 0 not defined there, ${DRIFT_DEFINITIONS} the same. Not the whole workspace: only the first ${DRIFT_DEFINITIONS} definitions found were compared.`), said());

  // As many files as a check reads: there may be more.
  setup({ g: "{x}" });
  let asked;
  vscode.workspace.findFiles = async (_include, _exclude, most) => ((asked = most), Array.from({ length: most }, (_, i) => vscode.Uri.file(path.join(dir, i === 0 ? "one.q" : `gone${i}.q`))));
  await stub.commands.get("q-lint.checkDrift")();
  assert.strictEqual(asked, DRIFT_FILES);
  assert.ok(said().includes(`1 the same. Not the whole workspace: the workspace holds ${DRIFT_FILES} q files or more, and only the first ${DRIFT_FILES} found were read.`), said());

  // The whole workspace read: nothing is added, at the cap exactly too.
  setup({ g: "{x}" });
  vscode.workspace.findFiles = async () => [vscode.Uri.file(path.join(dir, "one.q"))];
  await stub.commands.get("q-lint.checkDrift")();
  assert.strictEqual(said(), "q-lint: 1 workspace definitions against dev: 0 differ, 0 not defined there, 1 the same.");
  fs.writeFileSync(path.join(dir, "big.q"), Array.from({ length: DRIFT_DEFINITIONS }, (_, i) => `f${i}:{x+${i}}\n`).join(""));
  setup(held);
  vscode.workspace.findFiles = async () => [vscode.Uri.file(path.join(dir, "big.q"))];
  await stub.commands.get("q-lint.checkDrift")();
  assert.ok(!/Not the whole workspace/.test(said()), said());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("drift detection off: the command refuses, says how to turn it on, and reads nothing", async () => {
  const { live } = setup({ f: "{x}" }, { settings: { "processExplorer.driftDetection.enable": false } });
  assert.strictEqual(await stub.commands.get("q-lint.checkDrift")(), undefined);
  assert.match(stub.messages[0][1], /Drift detection is turned off\. Set q-lint\.processExplorer\.driftDetection\.enable to true/);
  assert.deepStrictEqual(live.sent, []);
});

test("a process connected while Redefine was asked is not redefined: the reload names the one asked about (#1289)", async () => {
  const held = { f: "{x}" };
  const { live, drift } = setup(held);
  const doc = documentOf("/w/a.q", "f:{x}\n");
  listeners.open.forEach((l) => l(doc));
  doc.text = "f:{x+1}\n";
  stub.picks = [(o) => ((live.process = prod), "Reload")];
  const out = await drift.reload(doc);
  assert.strictEqual(out.process, "dev");
  assert.deepStrictEqual(out.sent, []);
  assert.match(out.failed[0].why, /dev is no longer the active process; nothing was run/);
  assert.deepStrictEqual(live.sent.map((s) => s[0]), ["DRIFT"]);
  assert.strictEqual(held.f, "{x}");
});

test("Check Drift switched to another process between batches reads nothing more and reports nothing (#1378)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-drift-"));
  fs.writeFileSync(path.join(dir, "a.q"), Array.from({ length: 501 }, (_, i) => `f${i}:{x}\n`).join(""));
  const { live } = setup({});
  vscode.workspace.findFiles = async () => [vscode.Uri.file(path.join(dir, "a.q"))];
  const call = live.borrow;
  live.borrow = (use) => {
    const got = call(use);
    // Another process is made active once the first batch is asked.
    live.process = prod;
    return got;
  };
  assert.strictEqual(await stub.commands.get("q-lint.checkDrift")(), undefined);
  assert.deepStrictEqual(live.sent.map((s) => s[0]), ["DRIFT"]);
  assert.ok(stub.messages.some(([, m]) => /could not compare with dev: dev is no longer the active process/.test(m)), JSON.stringify(stub.messages));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("turned off at the Reload question, nothing is sent, kept or remembered as always (#1452)", async () => {
  const held = { f: "{x}" };
  const { live, drift } = setup(held);
  const doc = documentOf("/w/a.q", "f:{x}\n");
  listeners.open.forEach((l) => l(doc));
  doc.text = "f:{x+1}\n";
  stub.picks = [
    () => {
      stub.config.user["hotReload.enable"] = false;
      stub.changeConfig("q-lint.hotReload.enable");
      return "Reload on Every Save";
    },
  ];
  assert.strictEqual((await drift.reload(doc)).reason, "hot reload was turned off");
  assert.deepStrictEqual(live.sent.map((s) => s[0]), ["DRIFT"]);
  assert.strictEqual(held.f, "{x}");
  assert.deepStrictEqual(drift.hotReloadState(), { listening: false, files: [], last: drift.hotReloadState().last });
  // On again, the next save asks rather than reloading on its own.
  stub.config.user["hotReload.enable"] = true;
  stub.changeConfig("q-lint.hotReload.enable");
  listeners.open.forEach((l) => l(documentOf("/w/a.q", "f:{x}\n")));
  doc.text = "f:{x+2}\n";
  stub.picks = [undefined];
  assert.strictEqual((await drift.reload(doc)).reason, "not confirmed");
});
