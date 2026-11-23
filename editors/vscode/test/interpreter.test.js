// The q interpreter picker (#974) and the licence expiry warning (#975):
// discovery over fake directories, the layout's variables, the probe read
// from what q prints, the picker and the status bar through the stand-in
// `vscode` module with fake q binaries, and - when QLINT_TEST_Q names one -
// the probe against a real q.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const I = require("../out/interpreter.js");
const { nodeFiles } = require("../out/qenvironment.js");
const { Interpreters, probe, resolveBinary } = require("../out/interpreterview.js");

const Q = process.env.QLINT_TEST_Q;
const skipQ = Q ? false : "QLINT_TEST_Q names no q binary";
const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));

/// A file system of `files` (path: "x" executable, "f" plain, "d" folder).
const fake = (files, links = {}) => ({
  executable: (f) => files[f] === "x",
  exists: (f) => f in files || Object.keys(files).some((k) => k.startsWith(`${f}/`)),
  real: (f) => links[f] ?? f,
});

/// A fake q: a shell script printing what the probe would, or failing.
function fakeQ(file, line, code = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\n${line ? `echo '${line}'\n` : ""}exit ${code}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test("discovery finds KDB-X, QHOME's platform folders, PATH and a workspace's PeachQ build, each file once", () => {
  const files = fake(
    {
      "/h/.kx/bin/q": "x",
      "/opt/q/m64/q": "x",
      "/opt/q/l64/q": "x",
      "/opt/q/q.k": "f",
      "/usr/local/bin/q": "x",
      "/usr/bin/q": "f", // not executable
      "/h/.kx/bin": "d",
      "/w/peach/q": "x",
      "/w/other/bin/peachq": "x",
    },
    { "/usr/local/bin/q": "/opt/q/m64/q" },
  );
  const found = I.discover({ env: { QHOME: "/opt/q", PATH: "/h/.kx/bin:/usr/local/bin:/usr/bin:" }, home: "/h", platform: "darwin", folders: ["/w/peach", "/w/other"] }, files);
  assert.deepStrictEqual(
    found.map((i) => [i.path, i.source]),
    [
      ["/h/.kx/bin/q", "kdbx"],
      ["/opt/q/m64/q", "qhome"],
      ["/opt/q/l64/q", "qhome"],
      ["/w/peach/q", "workspace"],
      ["/w/other/bin/peachq", "workspace"],
    ],
    "~/.kx/bin on PATH and a link to m64/q are listed once; a file that cannot be run is not",
  );
  assert.strictEqual(found[1].detail, "QHOME (/opt/q)");
  // Without QHOME, ~/q is where kdb+ looks.
  const bare = I.discover({ env: { PATH: "/nowhere" }, home: "/h", platform: "linux", folders: [] }, fake({ "/h/q/l64/q": "x" }));
  assert.deepStrictEqual(bare.map((i) => [i.path, i.detail]), [["/h/q/l64/q", "kdb+ (~/q)"]]);
  // Windows: q.exe, `;` between PATH's folders.
  const win = I.discover({ env: { Path: "C:\\q\\w64;C:\\bin" }, home: "C:\\Users\\me", platform: "win32", folders: [] }, fake({ "C:\\q\\w64\\q.exe": "x" }));
  assert.deepStrictEqual(win.map((i) => i.path), ["C:\\q\\w64\\q.exe"]);
});

test("discovery reads real directories: fake installs under a temporary home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-interp-"));
  fakeQ(path.join(home, ".kx", "bin", "q"));
  fakeQ(path.join(home, "kdb", "m64arm", "q"));
  fs.writeFileSync(path.join(home, "kdb", "q.k"), "");
  fakeQ(path.join(home, "ws", "q"));
  fs.mkdirSync(path.join(home, "pathdir"));
  fs.symlinkSync(path.join(home, ".kx", "bin", "q"), path.join(home, "pathdir", "q"));
  fs.writeFileSync(path.join(home, "ws", "bin"), ""); // a file, not a folder
  const found = I.discover({ env: { QHOME: path.join(home, "kdb"), PATH: path.join(home, "pathdir") }, home, platform: process.platform, folders: [path.join(home, "ws")] }, nodeFiles);
  assert.deepStrictEqual(found.map((i) => i.source), ["kdbx", "qhome", "workspace"]);
  assert.deepStrictEqual(I.layoutEnv(path.join(home, "kdb", "m64arm", "q"), nodeFiles), { QHOME: path.join(home, "kdb") });
  // KDB-X's layout: bin/q, q/ and a licence beside them.
  assert.deepStrictEqual(I.layoutEnv(path.join(home, ".kx", "bin", "q"), nodeFiles), {}, "no licence there yet");
  fs.mkdirSync(path.join(home, ".kx", "q"));
  fs.writeFileSync(path.join(home, ".kx", "kc.lic"), "not read");
  assert.deepStrictEqual(I.layoutEnv(path.join(home, ".kx", "bin", "q"), nodeFiles), { QHOME: path.join(home, ".kx", "q"), QLIC: path.join(home, ".kx") });
  assert.deepStrictEqual(I.layoutEnv("q", nodeFiles), {}, "a bare name has no layout");
  assert.deepStrictEqual(I.layoutEnv(path.join(home, "ws", "q"), nodeFiles), {});
});

test("the licence file is located by QLIC, QHOME, a KDB-X install and ~/q, kc.lic first, and never read", () => {
  const files = fake({ "/lic/k4.lic": "f", "/lic/kc.lic": "f", "/opt/q/k4.lic": "f", "/h/.kx/kc.lic": "f", "/h/q/k4.lic": "f" });
  assert.strictEqual(I.licenceFile("/opt/q/m64/q", { QLIC: "/lic", QHOME: "/opt/q" }, "/h", files), "/lic/kc.lic");
  assert.strictEqual(I.licenceFile("/opt/q/m64/q", { QHOME: "/opt/q" }, "/h", files), "/opt/q/k4.lic");
  assert.strictEqual(I.licenceFile("/h/.kx/bin/q", {}, "/h", files), "/h/.kx/kc.lic");
  assert.strictEqual(I.licenceFile("q", {}, "/h", files), "/h/q/k4.lic");
  assert.strictEqual(I.licenceFile("q", {}, "/x", fake({})), undefined);
});

test("the probe's answer: version, release, platform and a real date of expiry, or nothing", () => {
  assert.deepStrictEqual(I.readProbe("noise\nQLINTVER|4.1|2024.10.16|m64|2025.12.31\r\n"), { major: "4.1", release: "2024.10.16", os: "m64", expiry: "2025.12.31" });
  assert.deepStrictEqual(I.readProbe("QLINTVER|5|2026.11.16|m64|"), { major: "5", release: "2026.11.16", os: "m64" }, "an empty .z.l: no expiry");
  assert.deepStrictEqual(I.readProbe("QLINTVER|5|2026.11.16|m64|2026.02.30"), { major: "5", release: "2026.11.16", os: "m64" }, "not a day: no guess");
  assert.strictEqual(I.readProbe("'licence error\n"), undefined);
  assert.strictEqual(I.versionText({ major: "4.1", release: "2024.10.16" }), "q 4.1 2024.10.16");
  // Only .z.l's date is printed: never its banner text, which names the licensee.
  assert.match(I.PROBE, /\.z\.l 1/);
  assert.doesNotMatch(I.PROBE, /\.z\.l [2-9]|\.z\.l\]|-1 \.z\.l/);
});

test("days left and the warning: within the window, on the day, and after", () => {
  const today = new Date(2026, 10, 21);
  assert.strictEqual(I.daysLeft("2026.12.01", today), 10);
  assert.strictEqual(I.daysLeft("2026.11.21", today), 0);
  assert.strictEqual(I.daysLeft("2026.11.01", today), -20);
  assert.strictEqual(I.daysLeft("garbage", today), undefined);
  assert.strictEqual(I.expiryWarning("q", "2027.01.01", 41, 30), undefined);
  assert.match(I.expiryWarning("/x/q", "2026.12.01", 10, 30), /\/x\/q expires on 2026\.12\.01, in 10 days/);
  assert.match(I.expiryWarning("q", "2026.11.22", 1, 30), /in 1 day\.$/);
  assert.match(I.expiryWarning("q", "2026.11.21", 0, 0), /expires today/);
  assert.match(I.expiryWarning("q", "2026.11.01", -20, 0), /expired on 2026\.11\.01/);
  assert.deepStrictEqual(I.readInterpreter((_k, f) => f), { enabled: true, licence: true, warningDays: 30 });
  assert.strictEqual(I.readInterpreter((k, f) => (k === "licence.warningDays" ? 9999 : f)).warningDays, 365);
});

test("the settings and commands are declared, on by default, and hidden while off", () => {
  assert.strictEqual(props["q-lint.interpreter.enable"].default, true);
  assert.strictEqual(props["q-lint.licence.expiryWarning.enable"].default, true);
  assert.strictEqual(props["q-lint.licence.warningDays"].default, 30);
  const palette = pkg.contributes.menus.commandPalette;
  assert.match(palette.find((m) => m.command === I.INTERPRETER_COMMANDS.select).when, /config\.q-lint\.interpreter\.enable/);
  assert.match(palette.find((m) => m.command === I.INTERPRETER_COMMANDS.checkLicence).when, /config\.q-lint\.licence\.expiryWarning\.enable/);
  for (const c of Object.values(I.INTERPRETER_COMMANDS)) {
    const declared = pkg.contributes.commands.find((d) => d.command === c);
    assert.ok(declared && declared.category === "q-lint" && declared.title, c);
  }
});

/// The stand-in with a status bar item kept, an active editor of `language`,
/// HOME and PATH pointed at `home`, and an Interpreters on a fresh context.
function setUp(t, home, language = "q") {
  stub.reset();
  const items = [];
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, QHOME: process.env.QHOME, QLIC: process.env.QLIC };
  process.env.HOME = home;
  process.env.PATH = path.join(home, "bin");
  delete process.env.QHOME;
  delete process.env.QLIC;
  vscode.window.createStatusBarItem = (id) => {
    const item = { id, text: "", shown: false, disposed: false, show() { this.shown = true; }, dispose() { this.disposed = true; } };
    items.push(item);
    return item;
  };
  vscode.window.activeTextEditor = language ? { document: { languageId: language } } : undefined;
  const editorListeners = [];
  vscode.window.onDidChangeActiveTextEditor = (l) => (editorListeners.push(l), new vscode.Disposable());
  const context = stub.newContext();
  t.after(() => {
    Object.assign(process.env, saved);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    for (const d of context.subscriptions) d.dispose?.();
  });
  const interpreters = new Interpreters(context);
  return { interpreters, items, context, changeEditor: (lang) => ((vscode.window.activeTextEditor = lang ? { document: { languageId: lang } } : undefined), editorListeners.forEach((l) => l())) };
}

test("the picker lists each q with its version, sets the workspace's qBinary, and the status bar shows it", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-pick-"));
  const kdbx = fakeQ(path.join(home, ".kx", "bin", "q"), "QLINTVER|5|2026.07.23|m64|2035.01.01");
  const broken = fakeQ(path.join(home, "bin", "q"), "", 1);
  const { interpreters, items, context, changeEditor } = setUp(t, home);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(interpreters.status(), "$(terminal) q", "before any probe: the binary's name");
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(path.join(home, "ws")), name: "ws" }];
  t.after(() => (vscode.workspace.workspaceFolders = undefined));
  let shown;
  stub.picks.push((options) => ((shown = options.items), options.items.find((i) => i.file === kdbx)));
  const picked = await stub.commands.get(I.INTERPRETER_COMMANDS.select)();
  assert.strictEqual(picked, kdbx);
  assert.deepStrictEqual(
    shown.map((i) => [i.label, i.description]),
    [
      ["q 5 2026.07.23", kdbx],
      ["$(check) q (did not answer)", broken],
      ["$(folder) Enter a q binary's path...", undefined],
    ],
    "the current one (q on PATH) is checked",
  );
  assert.deepStrictEqual(stub.updates, [{ key: "terminal.qBinary", value: kdbx, target: "workspace" }]);
  assert.strictEqual(interpreters.status(), "$(terminal) q 5 2026.07.23");
  // Kept per binary: what the probe printed, and the licence file located.
  assert.deepStrictEqual(Object.keys(context.globalState.get("q-lint.interpreter.probes")), [kdbx]);
  // Away from q editors the item goes.
  changeEditor("python");
  assert.strictEqual(interpreters.status(), undefined);
  changeEditor("q");
  assert.ok(interpreters.status());
  // Entering a path that cannot be run changes nothing.
  stub.picks.push((o) => o.items.at(-1));
  stub.inputs.push(path.join(home, "nothing"));
  assert.strictEqual(await stub.commands.get(I.INTERPRETER_COMMANDS.select)(), undefined);
  assert.match(stub.messages.at(-1)[1], /is not a program this user can run/);
  assert.strictEqual(stub.updates.length, 1);
});

test("in a multi-root workspace the picker reads and writes the active file's folder's qBinary (#1333)", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-scope-"));
  const folderQ = fakeQ(path.join(home, "a", "bin", "q"), "QLINTVER|4.1|2024.01.01|m64|2035.01.01");
  const kdbx = fakeQ(path.join(home, ".kx", "bin", "q"), "QLINTVER|5|2026.07.23|m64|2035.01.01");
  const { interpreters, changeEditor } = setUp(t, home);
  const A = { uri: vscode.Uri.file(path.join(home, "A")), name: "A", index: 0 };
  const B = { uri: vscode.Uri.file(path.join(home, "B")), name: "B", index: 1 };
  vscode.workspace.workspaceFolders = [A, B];
  // Folder A's .vscode/settings.json sets its own q binary.
  const folders = { [A.uri.fsPath]: { "terminal.qBinary": folderQ } };
  const plain = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = (section, resource) => {
    const c = plain(section);
    const own = resource && folders[[A, B].find((f) => resource.fsPath.startsWith(f.uri.fsPath))?.uri.fsPath];
    return {
      ...c,
      get: (k, d) => (own && k in own ? own[k] : c.get(k, d)),
      inspect: (k) => ({ ...c.inspect(k), ...(own && k in own ? { workspaceFolderValue: own[k] } : {}) }),
      update: async (k, v, target) => (target === 3 && own ? ((own[k] = v), stub.updates.push({ key: k, value: v, target: "workspaceFolder" })) : c.update(k, v, target)),
    };
  };
  t.after(() => ((vscode.workspace.getConfiguration = plain), (vscode.workspace.workspaceFolders = undefined)));
  vscode.window.activeTextEditor = { document: { languageId: "q", uri: vscode.Uri.file(path.join(home, "A", "x.q")) } };
  assert.strictEqual(interpreters.status(), "$(terminal) q", "the folder's a/bin/q, not yet probed");
  stub.picks.push((o) => o.items.find((i) => i.file === kdbx));
  assert.strictEqual(await stub.commands.get(I.INTERPRETER_COMMANDS.select)(), kdbx);
  assert.deepStrictEqual(stub.updates, [{ key: "terminal.qBinary", value: kdbx, target: "workspaceFolder" }]);
  assert.strictEqual(folders[A.uri.fsPath]["terminal.qBinary"], kdbx);
  assert.strictEqual(interpreters.status(), "$(terminal) q 5 2026.07.23");
  changeEditor("q");
});

test("off: the picker refuses, the item is removed, and no q is started", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-pickoff-"));
  const marker = path.join(home, "ran");
  fs.mkdirSync(path.join(home, ".kx", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".kx", "bin", "q"), `#!/bin/sh\ntouch '${marker}'\n`);
  fs.chmodSync(path.join(home, ".kx", "bin", "q"), 0o755);
  const { interpreters, items } = setUp(t, home);
  assert.ok(interpreters.status());
  stub.config.user["interpreter.enable"] = false;
  stub.changeConfig("q-lint.interpreter.enable");
  assert.strictEqual(interpreters.status(), undefined);
  assert.ok(items[0].disposed);
  assert.strictEqual(await stub.commands.get(I.INTERPRETER_COMMANDS.select)(), undefined);
  assert.match(stub.messages.at(-1)[1], /picker is turned off\. Set q-lint\.interpreter\.enable to true/);
  assert.strictEqual(fs.existsSync(marker), false, "nothing was run");
  // On again, at once.
  stub.config.user["interpreter.enable"] = true;
  stub.changeConfig("q-lint.interpreter.enable");
  assert.ok(interpreters.status());
});

test("the licence warning: from what a probe kept, once a day, not after the licence file changed, and never while off", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-lic-"));
  const q = fakeQ(path.join(home, "bin", "q"), "QLINTVER|4.1|2024.10.16|m64|2026.12.01");
  fs.mkdirSync(path.join(home, "q"));
  fs.writeFileSync(path.join(home, "q", "k4.lic"), "binary, never read");
  const { interpreters, context } = setUp(t, home);
  const today = new Date(2026, 10, 21);
  assert.strictEqual(await interpreters.warnFromKept(today), undefined, "never probed: nothing is said, nothing started");
  const said = await stub.commands.get(I.INTERPRETER_COMMANDS.checkLicence)();
  assert.match(said, new RegExp(`${q.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} expires on 2026\\.12\\.01`));
  const kept = context.globalState.get("q-lint.interpreter.probes")[q];
  assert.strictEqual(kept.expiry, "2026.12.01");
  assert.strictEqual(kept.licence.file, path.join(home, "q", "k4.lic"));
  assert.doesNotMatch(JSON.stringify(context.globalState.get("q-lint.interpreter.probes")), /never read/);
  stub.messages = [];
  assert.match(await interpreters.warnFromKept(today), /in 10 days/);
  assert.strictEqual(await interpreters.warnFromKept(today), undefined, "once a day");
  assert.match(await interpreters.warnFromKept(new Date(2026, 10, 22)), /in 9 days/);
  stub.config.user["licence.warningDays"] = 5;
  assert.strictEqual(await interpreters.warnFromKept(new Date(2026, 10, 23)), undefined, "outside the window");
  delete stub.config.user["licence.warningDays"];
  // A replaced licence file: the kept date is no longer trusted.
  fs.utimesSync(path.join(home, "q", "k4.lic"), new Date(), new Date(Date.now() + 60_000));
  assert.strictEqual(await interpreters.warnFromKept(new Date(2026, 10, 24)), undefined);
  // Off: no warning, and the command refuses without starting q.
  stub.config.user["licence.expiryWarning.enable"] = false;
  fs.writeFileSync(q, `#!/bin/sh\ntouch '${path.join(home, "ran")}'\n`);
  assert.strictEqual(await interpreters.warnFromKept(new Date(2026, 10, 25)), undefined);
  assert.strictEqual(await stub.commands.get(I.INTERPRETER_COMMANDS.checkLicence)(), undefined);
  assert.match(stub.messages.at(-1)[1], /licence expiry warning is turned off\. Set q-lint\.licence\.expiryWarning\.enable/);
  assert.strictEqual(fs.existsSync(path.join(home, "ran")), false);
});

test("a q reporting no expiry date is not guessed at", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-nolic-"));
  fakeQ(path.join(home, "bin", "q"), "QLINTVER|5|2026.11.16|m64|");
  const { interpreters } = setUp(t, home);
  assert.match(await stub.commands.get(I.INTERPRETER_COMMANDS.checkLicence)(), /reports no licence expiry date/);
  assert.strictEqual(await interpreters.warnFromKept(new Date()), undefined);
});

test("the probe against a real q prints its version and, where .z.l has one, a date", { skip: skipQ }, async () => {
  const words = Q.trim().split(/\s+/);
  if (words[0] === "env") words.shift();
  const env = {};
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const [key, ...value] = words.shift().split("=");
    env[key] = value.join("=");
  }
  const answer = await probe(words[0], env);
  assert.ok(answer, "q answered the probe");
  assert.match(answer.major, /^\d+(\.\d+)?$/);
  assert.match(answer.release, /^\d{4}\.\d{2}\.\d{2}$/);
  if (answer.expiry !== undefined) {
    assert.ok(I.daysLeft(answer.expiry, new Date()) !== undefined);
  }
});

test("a relative q binary is resolved against the workspace folder, not the extension host's cwd (#1132)", () => {
  const folder = path.join(os.tmpdir(), "ws");
  assert.strictEqual(resolveBinary(path.join(".", "bin", "q"), folder), path.join(folder, "bin", "q"));
  assert.strictEqual(resolveBinary(path.join("..", "kx", "q"), folder), path.join(os.tmpdir(), "kx", "q"));
  const absolute = path.join(os.tmpdir(), "elsewhere", "q");
  assert.strictEqual(resolveBinary(absolute, folder), absolute);
  // With no folder open, the working directory is all there is.
  assert.strictEqual(resolveBinary(path.join(".", "bin", "q"), undefined), path.resolve("bin", "q"));
});
