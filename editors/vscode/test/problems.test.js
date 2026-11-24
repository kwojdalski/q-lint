// The problems dashboard (#992): findings counted by rule and by folder, the
// trend kept by commit, the findings of a folder and of an earlier commit
// read with the real qlinter in a git repository made for the test - the
// working tree never touched - and, through the stand-in `vscode`, the
// command's life: off, it refuses and lints nothing; on, it shows the
// dashboard and adds the commit to the trend.
const { stub, vscode } = require("./vscode_stub.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readFindings, summarise, folderOf, pointOf, withPoint, readTrend, lintTree, lintCommit, head, history, TREND_LIMIT } = require("../out/problems.js");
const { registerProblemsDashboard, SHOW_PROBLEMS, LINT_HISTORY } = require("../out/problemsview.js");
const pkg = require("../package.json");

const QLINTER = path.resolve(__dirname, "../../../target/release/qlinter");
const noQlinter = fs.existsSync(QLINTER) ? false : "no qlinter built at target/release";

const F = (p, code, severity = "warning") => ({ path: p, code, rule: code.toLowerCase(), severity, category: "c" });

test("a folder opened through a symlink counts its files under their folders, not \".\" (#1288)", () => {
  // qlinter names each file by its real path; the folder is as it was opened.
  const opened = path.resolve("/link");
  const real = path.resolve("/proj");
  const s = summarise([F(path.join(real, "src/a/x.q"), "QE004"), F(path.join(real, "top.q"), "QS001")], [opened, real]);
  assert.deepStrictEqual(s.folders.map((f) => f.folder).sort(), [".", "src/a"]);
  assert.strictEqual(folderOf(path.join(real, "src/a/x.q"), [opened, real]), "src/a");
  assert.strictEqual(folderOf(path.join(opened, "src/x.q"), [opened, real]), "src");
  assert.strictEqual(folderOf(path.resolve("/elsewhere/src/x.q"), [opened, real]), ".");
});

test("findings are counted by rule and by folder, with their files", () => {
  const root = path.resolve("/ws");
  const findings = [
    F(path.join(root, "src/a/x.q"), "QE004", "error"),
    F(path.join(root, "src/a/x.q"), "QE004", "error"),
    F(path.join(root, "src/a/b/c/y.q"), "QF001", "error"),
    F(path.join(root, "top.q"), "QS001"),
  ];
  const s = summarise(findings, root);
  assert.deepStrictEqual([s.total, s.errors, s.warnings, s.files], [4, 3, 1, 3]);
  assert.deepStrictEqual(
    s.rules.map((r) => [r.code, r.count, r.files]),
    [
      ["QE004", 2, 1],
      ["QF001", 1, 1],
      ["QS001", 1, 1],
    ],
  );
  // Folders cut to two parts.
  assert.deepStrictEqual(
    s.folders.map((f) => [f.folder, f.count, f.errors, f.files]),
    [
      ["src/a", 3, 3, 2],
      [".", 1, 0, 1],
    ],
  );
  assert.strictEqual(folderOf(path.join(root, "a/b/c/d.q"), root, 1), "a");
  assert.strictEqual(folderOf(path.resolve("/elsewhere/d.q"), root), ".");
});

test("the trend keeps one point a commit, oldest first, at most the limit", () => {
  const p = (commit, date, total) => ({ commit, date, subject: commit, total, errors: 0, byRule: {} });
  let trend = withPoint([], p("b", "2026-01-02", 5));
  trend = withPoint(trend, p("a", "2026-01-01", 7));
  trend = withPoint(trend, p("b", "2026-01-02", 4));
  assert.deepStrictEqual(trend.map((x) => [x.commit, x.total]), [["a", 7], ["b", 4]]);
  // Dates with different committer offsets are ordered as instants (#1106).
  const zones = withPoint([p("east", "2026-03-01T10:00:00+05:00", 1)], p("utc", "2026-03-01T09:00:00+00:00", 2));
  assert.deepStrictEqual(zones.map((x) => x.commit), ["east", "utc"]);
  for (let i = 0; i < TREND_LIMIT + 5; i++) {
    trend = withPoint(trend, p(`c${i}`, `2027-01-01T00:00:${String(i).padStart(3, "0")}`, i));
  }
  assert.strictEqual(trend.length, TREND_LIMIT);
  assert.strictEqual(trend.at(-1).total, TREND_LIMIT + 4);
  assert.deepStrictEqual(readTrend([{ commit: "x" }, null, p("y", "d", 1)]).map((x) => x.commit), ["y"]);
  assert.deepStrictEqual(readTrend("junk"), []);
  const point = pointOf([F("/a.q", "QE004", "error"), F("/a.q", "QS001")], "c", "d", "s");
  assert.deepStrictEqual([point.total, point.errors, point.byRule], [2, 1, { QE004: 1, QS001: 1 }]);
  assert.throws(() => readFindings("not json"), /other than JSON/);
  assert.deepStrictEqual(readFindings('[{"path":"/a.q","code":"QE004"},{"bad":1}]').map((f) => f.code), ["QE004"]);
});

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qlint-problems-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return { dir, git };
}

test("a folder and an earlier commit are linted, the working tree left as it is", { skip: noQlinter }, async (t) => {
  const { dir, git } = repo(t);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/a.q"), "f:{[x] x==1}\ng:{[x] x==2}\n");
  git("add", ".");
  git("commit", "-qm", "two foreign operators");
  const first = git("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(dir, "src/a.q"), "f:{[x] x=1}\ng:{[x] x==2}\n");
  git("commit", "-qam", "one fixed");
  const now = await lintTree(QLINTER, [], dir);
  assert.deepStrictEqual(now.map((f) => f.code), ["QE004"]);
  const at = await head(dir);
  assert.strictEqual(at.clean, true);
  assert.strictEqual(at.subject, "one fixed");
  const commits = await history(dir, 5);
  assert.deepStrictEqual(commits.map((c) => c.subject), ["one fixed", "two foreign operators"]);
  const then = await lintCommit(QLINTER, [], dir, first);
  assert.deepStrictEqual(then.map((f) => f.code), ["QE004", "QE004"]);
  assert.strictEqual(fs.readFileSync(path.join(dir, "src/a.q"), "utf8"), "f:{[x] x=1}\ng:{[x] x==2}\n");
  assert.strictEqual(git("status", "--porcelain"), "");
  // A q file changed since the commit: not clean.
  fs.writeFileSync(path.join(dir, "src/a.q"), "a:1\n");
  assert.strictEqual((await head(dir)).clean, false);
  await assert.rejects(lintCommit(QLINTER, [], dir, "not-a-commit"), /not a commit/);
});

test("a qlinter that fails or is stopped is an error, not an empty dashboard (#1399)", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qlint-problems-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Stand-ins run as `node <script> --format json .`.
  const linter = (name, body) => {
    const file = path.join(dir, `${name}.js`);
    fs.writeFileSync(file, body);
    return file;
  };
  const config = linter("config", 'process.stderr.write("No such file or directory"); process.exit(2);');
  await assert.rejects(lintTree(process.execPath, [config], dir), /exited with 2: No such file or directory/);
  const killed = linter("killed", 'process.kill(process.pid, "SIGKILL");');
  await assert.rejects(lintTree(process.execPath, [killed], dir), /stopped before it finished/);
  // An unreadable file (exit 2) with the rest read still gives the findings.
  const partial = linter("partial", 'console.log(JSON.stringify([{ path: "a.q", code: "QE004" }])); process.exit(2);');
  assert.deepStrictEqual((await lintTree(process.execPath, [partial], dir)).map((f) => f.code), ["QE004"]);
});

test("an earlier commit git cannot export is an error, not 0 findings (#1400)", async (t) => {
  const { dir, git } = repo(t);
  fs.writeFileSync(path.join(dir, "a.q"), "a:1\n");
  git("add", ".");
  git("commit", "-qm", "one");
  // The linter is never reached: a stand-in that would report nothing.
  const linter = path.join(dir, "none.js");
  fs.writeFileSync(linter, 'console.log("[]");');
  await assert.rejects(lintCommit(process.execPath, [linter], dir, "deadbeefdeadbeef"), /git archive deadbeefdeadbeef failed/);
  const at = git("rev-parse", "HEAD").trim();
  assert.deepStrictEqual(await lintCommit(process.execPath, [linter], dir, at), []);
});

test("the switches are declared, and the commands only where they can run", () => {
  const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
  assert.strictEqual(props["q-lint.problemsDashboard.enable"].default, true);
  for (const id of [SHOW_PROBLEMS, LINT_HISTORY]) {
    const palette = pkg.contributes.menus.commandPalette.find((m) => m.command === id);
    assert.match(palette.when, /config\.q-lint\.problemsDashboard\.enable/);
  }
});

function fakePanels() {
  const panels = [];
  vscode.window.createWebviewPanel = (id, title) => {
    const panel = {
      id,
      title,
      disposed: false,
      posted: [],
      listeners: [],
      webview: {
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (u) => u,
        postMessage: async (m) => void panel.posted.push(m),
        onDidReceiveMessage: (l) => void panel.listeners.push(l),
      },
      onDidDispose: () => {},
      reveal: () => {},
      dispose() {
        this.disposed = true;
      },
    };
    panels.push(panel);
    return panel;
  };
  return panels;
}

test("the dashboard of a folder opened through a symlink, and with no qlinter to run", { skip: noQlinter }, async (t) => {
  stub.reset();
  fakePanels();
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-dash-"));
  fs.mkdirSync(path.join(real, "src", "x"), { recursive: true });
  fs.writeFileSync(path.join(real, "src", "x", "a.q"), "f:{[x] x==1}\n");
  const link = `${real}-link`;
  fs.symlinkSync(real, link, "dir");
  t.after(() => fs.rmSync(link, { force: true }));
  const context = stub.newContext();
  let command = QLINTER;
  registerProblemsDashboard(context, () => ({ command, args: [] }));
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  const view = await stub.commands.get(SHOW_PROBLEMS)(link);
  assert.deepStrictEqual(view.summary.folders.map((f) => f.folder), ["src/x"]);
  // None configured, bundled or on PATH (#1251): said, nothing run.
  command = undefined;
  assert.strictEqual(await stub.commands.get(SHOW_PROBLEMS)(link), "q-lint: no qlinter to run: set q-lint.serverPath, or put qlinter on PATH.");
});

test("off, the dashboard refuses and lints nothing; on, it shows the folder and keeps the commit", { skip: noQlinter }, async (t) => {
  stub.reset();
  const panels = fakePanels();
  const { dir, git } = repo(t);
  fs.writeFileSync(path.join(dir, "a.q"), "f:{[x] x==1}\n");
  git("add", ".");
  git("commit", "-qm", "one");
  const context = stub.newContext();
  const state = new Map();
  context.workspaceState = { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => void state.set(k, v), keys: () => [...state.keys()] };
  let linted = 0;
  stub.config.user["problemsDashboard.enable"] = false;
  const dashboard = registerProblemsDashboard(context, () => (linted++, { command: QLINTER, args: [] }));
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  assert.match(await stub.commands.get(SHOW_PROBLEMS)(dir), /The problems dashboard is turned off\. Set q-lint\.problemsDashboard\.enable to true/);
  assert.match(await stub.commands.get(LINT_HISTORY)(5, dir), /turned off/);
  assert.strictEqual(linted, 0);
  assert.strictEqual(panels.length, 0);

  stub.config.user["problemsDashboard.enable"] = true;
  stub.changeConfig("q-lint.problemsDashboard.enable");
  const view = await stub.commands.get(SHOW_PROBLEMS)(dir);
  assert.strictEqual(view.summary.total, 1);
  assert.strictEqual(view.clean, true);
  assert.strictEqual(view.trend.length, 1);
  assert.strictEqual(panels.length, 1);
  panels[0].listeners.forEach((l) => l({ type: "ready" }));
  assert.strictEqual(panels[0].posted.at(-1).type, "problems");
  assert.match(panels[0].webview.html, /Content-Security-Policy/);
  // A second commit, linted from history: two points.
  fs.writeFileSync(path.join(dir, "a.q"), "f:{[x] x=1}\n");
  git("commit", "-qam", "fixed");
  const later = await stub.commands.get(LINT_HISTORY)(5, dir);
  assert.deepStrictEqual(later.trend.map((p) => [p.subject, p.total]), [["one", 1], ["fixed", 0]]);
  // Off: the panel closes and nothing more is linted.
  const before = linted;
  stub.config.user["problemsDashboard.enable"] = false;
  stub.changeConfig("q-lint.problemsDashboard.enable");
  assert.strictEqual(panels[0].disposed, true);
  assert.strictEqual(dashboard.panelOpen(), false);
  await stub.commands.get(SHOW_PROBLEMS)(dir);
  assert.strictEqual(linted, before);
});

/// A stand-in for qlinter, run as `node <script> --format json .`: one
/// finding for each q file under the directory it is run in.
function everyFile(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qlint-linter-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "every.js");
  fs.writeFileSync(
    file,
    `const fs = require("node:fs"), path = require("node:path");
const out = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".q")) out.push({ path: p, code: "QE004", rule: "foreign-operator", severity: "warning", category: "c" });
  }
};
walk(process.cwd());
console.log(JSON.stringify(out));
process.exit(out.length > 0 ? 1 : 0);
`,
  );
  return file;
}

function dashboardOf(t, linter) {
  stub.reset();
  fakePanels();
  const context = stub.newContext();
  const state = new Map();
  context.workspaceState = { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => void state.set(k, v), keys: () => [...state.keys()] };
  registerProblemsDashboard(context, () => ({ command: process.execPath, args: [linter] }));
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
}

test("the trend's point for HEAD is of the commit, as an earlier commit's is: a q file git ignores is not in it (#1896)", async (t) => {
  const { dir, git } = repo(t);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/a.q"), "a:1\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n");
  git("add", ".");
  git("commit", "-qm", "one");
  fs.writeFileSync(path.join(dir, "src/b.q"), "b:1\n");
  git("add", ".");
  git("commit", "-qm", "two");
  // Build output: q files no commit holds.
  fs.mkdirSync(path.join(dir, "build"));
  fs.writeFileSync(path.join(dir, "build/c.q"), "c:1\n");
  fs.writeFileSync(path.join(dir, "build/d.q"), "d:1\n");
  dashboardOf(t, everyFile(t));
  const view = await stub.commands.get(SHOW_PROBLEMS)(dir);
  // The folder as it is, and the commit as git has it.
  assert.strictEqual(view.clean, true);
  assert.strictEqual(view.summary.total, 4);
  assert.deepStrictEqual(view.trend.map((p) => [p.subject, p.total]), [["two", 2]]);
  const later = await stub.commands.get(LINT_HISTORY)(5, dir);
  // (Commits of one second keep the order they were added in.)
  assert.deepStrictEqual(later.trend.map((p) => [p.subject, p.total]).sort(), [["one", 1], ["two", 2]]);
});

test("a virtual workspace folder is no directory to lint: the dashboard asks for a folder, and runs nothing (#1843)", async (t) => {
  stub.reset();
  fakePanels();
  stub.config.user["problemsDashboard.enable"] = true;
  // A GitHub Remote Repositories folder: not on disk.
  const vfs = { uri: Object.assign(vscode.Uri.file("/kwojdalski/q-lint"), { scheme: "vscode-vfs" }), name: "q-lint", index: 0 };
  vscode.workspace.workspaceFolders = [vfs];
  t.after(() => (vscode.workspace.workspaceFolders = undefined));
  const context = stub.newContext();
  let linted = 0;
  const dashboard = registerProblemsDashboard(context, () => (linted++, { command: "/bin/echo", args: [] }));
  t.after(() => context.subscriptions.forEach((d) => d.dispose?.()));
  assert.strictEqual(await dashboard.show(), "q-lint: open a folder first: the dashboard lints a workspace folder.");
  assert.strictEqual(linted, 0);
});
