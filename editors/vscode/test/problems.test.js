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
