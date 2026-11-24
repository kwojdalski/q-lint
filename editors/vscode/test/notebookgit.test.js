// q notebooks and git: Compare Notebook Cells and the `qnbgit.js` textconv
// (#998), Clear Notebook Outputs and the git clean filter (#999). The pure
// text, diff and strip, the command line, a real `git diff` and `git
// commit` through the textconv and the filter, and the commands under a
// stand-in `vscode`. Needs git and node on PATH, never a q process.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const pkg = require("../package.json");
const { diffCells, diffSummary, fileText, hasOutputs, main, notebookText, stripQnb } = require("../out/qnbgit.js");
const { parseQnb, serializeQnb } = require("../out/qnb.js");

const QNBGIT = path.join(__dirname, "..", "out", "qnbgit.js");

/// A `.qnb` file's text with `cells`, as the extension writes one.
const qnb = (cells, extra = {}) => JSON.stringify({ qnb: 1, cells, ...extra }, null, 1) + "\n";
const code = (source, more = {}) => ({ kind: "code", source: source.split("\n"), ...more });
const md = (source) => ({ kind: "markdown", source: source.split("\n") });
const ran = (n, text) => ({
  execution: { order: n, success: true, start: 1700000000000 + n, end: 1700000000010 + n },
  outputs: [{ items: [{ mime: "text/plain", text }] }],
});

// --- the text

test("a notebook as text is its cells: a %% header and the source, outputs, runs and metadata left out", () => {
  const cells = [md("# Prices"), code("/ @grid\nselect from t", ran(3, "sym px\n------")), code("print(1)", { language: "python" }), code("  ")];
  assert.strictEqual(
    notebookText(cells, "a.qnb"),
    [
      "q notebook a.qnb: cells only; outputs, run numbers and metadata are left out",
      "",
      "%% markdown\n# Prices",
      "",
      "%% code\n/ @grid\nselect from t",
      "",
      "%% code python\nprint(1)",
      "",
      "%% code\n",
    ].join("\n"),
  );
  // The same cells with other outputs, run numbers and metadata read the same.
  const again = [md("# Prices"), { ...code("/ @grid\nselect from t", ran(9, "other")), metadata: { x: 1 } }, code("print(1)", { language: "python" }), code("")];
  assert.strictEqual(notebookText(again), notebookText(cells));
  // `qnb.ts`'s cells, with the source as one string, read the same as the file's.
  assert.strictEqual(notebookText([{ kind: "code", source: "a\nb" }]), notebookText([code("a\nb")]));
});

test("a file that is not a notebook is given back as it is", () => {
  assert.strictEqual(fileText("not json"), "not json");
  assert.strictEqual(fileText('{"cells": []}'), '{"cells": []}');
  assert.strictEqual(fileText(qnb([code("1+1")])), "%% code\n1+1\n");
  assert.strictEqual(fileText("﻿" + qnb([code("1+1")])), "%% code\n1+1\n");
});

test("cells are matched as a diff matches lines; removed and added between matches pair as changed", () => {
  const a = [md("# t"), code("a:1"), code("b:2"), code("c:3")];
  assert.deepStrictEqual(diffCells(a, a), { added: 0, removed: 0, changed: 0, same: 4 });
  // A cell added at the top is one added cell, not four changed ones.
  assert.deepStrictEqual(diffCells(a, [code("new"), ...a]), { added: 1, removed: 0, changed: 0, same: 4 });
  assert.deepStrictEqual(diffCells(a, [md("# t"), code("a:10"), code("b:2")]), { added: 0, removed: 1, changed: 1, same: 2 });
  // The kind and the language count; outputs do not.
  assert.deepStrictEqual(diffCells([code("x")], [md("x")]), { added: 0, removed: 0, changed: 1, same: 0 });
  assert.deepStrictEqual(diffCells([code("x")], [code("x", { language: "python" })]).changed, 1);
  assert.deepStrictEqual(diffCells([code("x", ran(1, "1"))], [code("x", ran(2, "2"))]).same, 1);
  assert.strictEqual(diffSummary({ added: 1, removed: 0, changed: 2, same: 3 }), "2 cells changed, 1 added, 0 removed, 3 the same");
  assert.strictEqual(diffSummary({ added: 0, removed: 0, changed: 0, same: 3 }), "no cell changed (3 the same)");
});

test("the command line prints the text, and says how it is used", () => {
  assert.deepStrictEqual(main(["--text", "x"], () => qnb([code("1")])), { out: "%% code\n1\n", err: "", code: 0 });
  assert.match(main([]).err, /usage: node qnbgit\.js --text/);
  assert.strictEqual(main([]).code, 2);
  assert.strictEqual(main(["--text", "/nope/x.qnb"]).code, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qnbgit-"));
  fs.writeFileSync(path.join(dir, "a.qnb"), qnb([code("til 3", ran(1, "0 1 2"))]));
  assert.strictEqual(execFileSync(process.execPath, [QNBGIT, "--text", path.join(dir, "a.qnb")], { encoding: "utf8" }), "%% code\ntil 3\n");
});

/// A git repository in a new temporary folder, with `files` committed.
function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qnbgit-repo-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  git("add", ".");
  git("commit", "-qm", "first");
  return { dir, git };
}

test("as git's textconv, git diff shows the cell that changed and nothing of the outputs", () => {
  const { dir, git } = repo({ "a.qnb": qnb([md("# A"), code("x:1", ran(1, "")), code("x+1", ran(2, "2"))]) });
  fs.writeFileSync(path.join(dir, ".gitattributes"), "*.qnb diff=qnb\n");
  const textconv = ["-c", `diff.qnb.textconv=${JSON.stringify(process.execPath)} ${JSON.stringify(QNBGIT)} --text`];
  // Outputs and run numbers only: the cells read the same, so no hunk.
  fs.writeFileSync(path.join(dir, "a.qnb"), qnb([md("# A"), code("x:1", ran(7, "")), code("x+1", ran(8, "2"))]));
  assert.doesNotMatch(git(...textconv, "diff"), /^@@/m);
  // A changed cell is one line of the diff.
  fs.writeFileSync(path.join(dir, "a.qnb"), qnb([md("# A"), code("x:1"), code("x+2", ran(8, "3"))]));
  const diff = git(...textconv, "diff");
  assert.match(diff, /^-x\+1$/m);
  assert.match(diff, /^\+x\+2$/m);
  assert.doesNotMatch(diff, /outputs|execution|text\/plain/);
});

// --- the command

/// A stand-in `vscode` for Compare Notebook Cells: files from disk.
function fakeVscode() {
  const disposable = { dispose() {} };
  const fake = { messages: [], diffs: [], commands: {}, settings: {}, providers: new Map(), configListeners: [], picks: [], opened: [], answers: [], details: [] };
  class Uri {
    constructor(scheme, p, query = "") {
      this.scheme = scheme;
      this.path = p;
      this.fsPath = p;
      this.query = query;
    }
    static file(p) {
      return new Uri("file", p);
    }
    static from({ scheme, path: p, query }) {
      return new Uri(scheme, p, query);
    }
    toString() {
      return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ""}`;
    }
  }
  class EventEmitter {
    constructor() {
      this.event = () => disposable;
    }
    fire() {}
    dispose() {}
  }
  fake.vscode = {
    Uri,
    EventEmitter,
    commands: {
      registerCommand: (id, f) => ((fake.commands[id] = f), disposable),
      executeCommand: async (id, ...args) => void (id === "vscode.diff" ? fake.diffs.push(args) : undefined),
    },
    window: {
      activeNotebookEditor: undefined,
      showInformationMessage: async (m) => void fake.messages.push(m),
      showErrorMessage: async (m) => void fake.messages.push(m),
      showQuickPick: async (items) => {
        fake.offered = items;
        const label = fake.picks.shift();
        return items.find((i) => i.label === label);
      },
      showOpenDialog: async () => fake.opened.shift(),
      showWarningMessage: async (m, options, ...buttons) => {
        fake.messages.push(m);
        fake.details.push(options?.detail);
        const answer = fake.answers.shift();
        return buttons.includes(answer) ? answer : undefined;
      },
    },
    workspace: {
      notebookDocuments: [],
      getConfiguration: () => ({ get: (key, fallback) => (key in fake.settings ? fake.settings[key] : fallback) }),
      onDidChangeConfiguration: (l) => (fake.configListeners.push(l), disposable),
      registerTextDocumentContentProvider: (scheme, provider) => {
        fake.providers.set(scheme, provider);
        return { dispose: () => fake.providers.delete(scheme) };
      },
      fs: { readFile: async (uri) => fs.readFileSync(uri.fsPath), writeFile: async (uri, data) => fs.writeFileSync(uri.fsPath, data) },
    },
  };
  fake.change = (key) => fake.configListeners.forEach((l) => l({ affectsConfiguration: (s) => key === s || key.startsWith(`${s}.`) }));
  return fake;
}

function load(fake) {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    return request === "vscode" ? fake.vscode : original.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (/[\\/]out[\\/]/.test(key)) delete require.cache[key];
    }
    const registered = require("../out/notebookgit.js").registerNotebookGit({ subscriptions: [] });
    fake.strip = registered.strip;
    return registered.diff;
  } finally {
    Module._load = original;
  }
}

test("Compare Notebook Cells with the last commit diffs the cells only, and says what changed", async () => {
  const { dir } = repo({ "a.qnb": qnb([md("# A"), code("x:1", ran(1, "")), code("x+1", ran(2, "2"))]) });
  fs.writeFileSync(path.join(dir, "a.qnb"), qnb([code("new"), md("# A"), code("x:1", ran(5, "")), code("x+2", ran(6, "3"))]));
  const fake = fakeVscode();
  const diff = load(fake);
  const uri = fake.vscode.Uri.file(path.join(dir, "a.qnb"));
  fake.picks.push("The last commit (HEAD)");
  await fake.commands["q-lint.diffNotebook"](uri);
  assert.strictEqual(fake.diffs.length, 1, fake.messages.join("\n"));
  const [left, right, title] = fake.diffs[0];
  const provider = fake.providers.get("q-lint-qnb-cells");
  assert.strictEqual(provider.provideTextDocumentContent(left), "%% markdown\n# A\n\n%% code\nx:1\n\n%% code\nx+1\n");
  assert.strictEqual(provider.provideTextDocumentContent(right), "%% code\nnew\n\n%% markdown\n# A\n\n%% code\nx:1\n\n%% code\nx+2\n");
  assert.match(title, /a\.qnb \(HEAD\) ↔ a\.qnb/);
  assert.match(fake.messages.at(-1), /1 cell changed, 1 added, 0 removed, 2 the same\. Outputs, run numbers and metadata are not compared\./);
  // From Source Control's context menu, by the change's resourceUri, against HEAD.
  await fake.commands["q-lint.diffNotebook"]({ resourceUri: uri }, "HEAD");
  assert.strictEqual(fake.diffs.length, 2);
  assert.strictEqual(diff.last.summary, "1 cell changed, 1 added, 0 removed, 2 the same");
});

test("Compare Notebook Cells with another notebook, and what it says when there is none to compare", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qnbgit-"));
  fs.writeFileSync(path.join(dir, "a.qnb"), qnb([code("1")]));
  fs.writeFileSync(path.join(dir, "b.qnb"), qnb([code("1", ran(1, "1")), code("2")]));
  fs.writeFileSync(path.join(dir, "bad.qnb"), "{");
  const fake = fakeVscode();
  load(fake);
  const { Uri } = fake.vscode;
  // Picked from the open dialog.
  fake.picks.push("Another q notebook...");
  fake.opened.push([Uri.file(path.join(dir, "a.qnb"))]);
  await fake.commands["q-lint.diffNotebook"](Uri.file(path.join(dir, "b.qnb")));
  assert.match(fake.messages.at(-1), /a\.qnb against b\.qnb: 0 cells changed, 1 added, 0 removed, 1 the same/);
  // Given; a file that is not a notebook is refused with why.
  await fake.commands["q-lint.diffNotebook"](Uri.file(path.join(dir, "a.qnb")), Uri.file(path.join(dir, "bad.qnb")));
  assert.match(fake.messages.at(-1), /could not read the notebook to compare with: not a q notebook/);
  // Not a git repository.
  await fake.commands["q-lint.diffNotebook"](Uri.file(path.join(dir, "a.qnb")), "HEAD");
  assert.match(fake.messages.at(-1), /could not read the notebook to compare with: .*(not a git repository|fatal)/i);
  // No notebook.
  await fake.commands["q-lint.diffNotebook"]();
  assert.match(fake.messages.at(-1), /open a q notebook \(\.qnb\) to compare its cells/);
  // From the Explorer: (the file, the selection) - the selection is asked about, not read (#1336).
  fake.picks.push("Another q notebook...");
  fake.opened.push([Uri.file(path.join(dir, "a.qnb"))]);
  await fake.commands["q-lint.diffNotebook"](Uri.file(path.join(dir, "b.qnb")), [Uri.file(path.join(dir, "b.qnb"))]);
  assert.match(fake.messages.at(-1), /a\.qnb against b\.qnb: 0 cells changed, 1 added/);
  // Escape at the pick compares nothing.
  const before = fake.diffs.length;
  await fake.commands["q-lint.diffNotebook"](Uri.file(path.join(dir, "a.qnb")));
  assert.strictEqual(fake.diffs.length, before);
  assert.deepStrictEqual(fake.offered.map((i) => i.label), ["The last commit (HEAD)", "Another q notebook..."]);
});

test("off, Compare Notebook Cells refuses, its provider is gone, and it comes back without a reload", async () => {
  const fake = fakeVscode();
  fake.settings["notebook.diff.enable"] = false;
  const diff = load(fake);
  assert.strictEqual(diff.registered, false);
  assert.strictEqual(fake.providers.size, 0);
  await fake.commands["q-lint.diffNotebook"](fake.vscode.Uri.file("/ws/a.qnb"), "HEAD");
  assert.deepStrictEqual(fake.diffs, []);
  assert.match(fake.messages.at(-1), /Compare Notebook Cells is turned off: set q-lint\.notebook\.diff\.enable to true/);
  fake.settings["notebook.diff.enable"] = true;
  fake.change("q-lint.notebook.diff.enable");
  assert.strictEqual(diff.registered, true);
  fake.settings["notebook.diff.enable"] = false;
  fake.change("q-lint.notebook.diff.enable");
  assert.strictEqual(fake.providers.size, 0);
});

test("Compare Notebook Cells is contributed with its setting in every menu", () => {
  const command = pkg.contributes.commands.find((c) => c.command === "q-lint.diffNotebook");
  assert.strictEqual(command.category, "q-lint");
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: notebook features");
  assert.strictEqual(section.properties["q-lint.notebook.diff.enable"].default, true);
  const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === "q-lint.diffNotebook");
  assert.ok(menus.length >= 4);
  for (const m of menus) assert.match(m.when, /config\.q-lint\.notebook\.diff\.enable/);
});

// --- outputs on commit (#999)

const withOutputs = () =>
  qnb(
    [
      { kind: "markdown", source: ["n is {{q: n}}"], metadata: { "q-lint.liveValues": { n: { ok: true, text: "3" } }, tag: "keep" } },
      code("n:3", { ...ran(1, ""), metadata: { "q-lint.liveValues": "only Markdown has these, but a strip takes them anywhere" } }),
      code("til n", { ...ran(2, "0 1 2"), mine: { kept: true } }),
    ],
    { metadata: { author: "me" } },
  );

test("a strip takes out outputs, runs and live values, keeps the rest, and writes what the extension writes", () => {
  const stripped = stripQnb(withOutputs());
  const json = JSON.parse(stripped);
  assert.deepStrictEqual(json.cells, [
    { kind: "markdown", source: ["n is {{q: n}}"], metadata: { tag: "keep" } },
    { kind: "code", source: ["n:3"] },
    { kind: "code", source: ["til n"], mine: { kept: true } },
  ]);
  assert.deepStrictEqual(json.metadata, { author: "me" });
  // The extension reads it and saves it back as the same file.
  assert.strictEqual(serializeQnb(parseQnb(stripped)), stripped);
  assert.strictEqual(stripQnb(stripped), stripped);
  assert.ok(hasOutputs(withOutputs()));
  assert.ok(!hasOutputs(stripped));
  assert.ok(!hasOutputs("not json"));
  // Not a notebook: given back as it is, so git commits what it has.
  assert.strictEqual(stripQnb("{oops"), "{oops");
  assert.strictEqual(stripQnb('{"a":1}'), '{"a":1}');
});

test("the strip runs from stdin as git's clean filter, and the script needs nothing beside it", () => {
  const out = execFileSync(process.execPath, [QNBGIT, "--strip"], { input: withOutputs(), encoding: "utf8" });
  assert.strictEqual(out, stripQnb(withOutputs()));
  assert.strictEqual(execFileSync(process.execPath, [QNBGIT, "--strip"], { input: "plain", encoding: "utf8" }), "plain");
  // Copied on its own into a repository's git folder, it must still run.
  const requires = [...fs.readFileSync(QNBGIT, "utf8").matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires, ["node:fs"]);
});

test("Set Up Git to Strip Notebook Outputs shows what it writes, writes it on Write, and git commits notebooks without outputs", async () => {
  const { dir, git } = repo({ "README": "r\n" });
  const fake = fakeVscode();
  load(fake);
  const folder = fake.vscode.Uri.file(dir);
  // Declined: nothing is written.
  fake.answers.push(undefined);
  await fake.commands["q-lint.setUpNotebookStripFilter"](folder, "info");
  assert.match(fake.messages.at(-1), /Set up git in .* to strip q notebook outputs on commit\?/);
  const detail = fake.details.at(-1);
  assert.match(detail, /1\. Write .*\.git\/q-lint\/qnbgit\.js/);
  assert.match(detail, /2\. Run: git config --local filter\.qnb-strip\.clean 'node ".*qnbgit\.js" --strip'/);
  assert.match(detail, /3\. Add the line "\*\.qnb filter=qnb-strip" at the end of .*\.git\/info\/attributes/);
  assert.match(detail, /No hook is written/);
  assert.ok(!fs.existsSync(path.join(dir, ".git", "q-lint")));
  assert.throws(() => git("config", "--get", "filter.qnb-strip.clean"));
  // Written.
  fs.mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "info", "attributes"), "*.bin binary");
  fake.answers.push("Write");
  await fake.commands["q-lint.setUpNotebookStripFilter"](folder, "info");
  assert.match(fake.messages.at(-1), /now commits q notebooks without their outputs/);
  assert.strictEqual(fs.readFileSync(path.join(dir, ".git", "info", "attributes"), "utf8"), "*.bin binary\n*.qnb filter=qnb-strip\n");
  assert.strictEqual(fs.readFileSync(path.join(dir, ".git", "q-lint", "qnbgit.js"), "utf8"), fs.readFileSync(QNBGIT, "utf8"));
  assert.match(git("config", "--get", "filter.qnb-strip.clean"), /^node ".*\/\.git\/q-lint\/qnbgit\.js" --strip$/m);
  // Git commits the notebook without its outputs; the file keeps them and is not shown as changed.
  fs.writeFileSync(path.join(dir, "a.qnb"), withOutputs());
  git("add", "a.qnb");
  git("commit", "-qm", "nb");
  assert.strictEqual(git("show", "HEAD:a.qnb"), stripQnb(withOutputs()));
  assert.strictEqual(fs.readFileSync(path.join(dir, "a.qnb"), "utf8"), withOutputs());
  assert.strictEqual(git("status", "--porcelain"), "");
  // Set up already: nothing to ask.
  const asked = fake.details.length;
  await fake.commands["q-lint.setUpNotebookStripFilter"](folder, "info");
  assert.strictEqual(fake.details.length, asked);
  assert.match(fake.messages.at(-1), /strips notebook outputs on commit already/);
});

test("in a linked worktree the setup writes the attributes git reads and the script under the common directory (#1270)", async () => {
  const { dir, git } = repo({ README: "r\n" });
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), "qnbgit-wt-"));
  fs.rmSync(linked, { recursive: true });
  git("worktree", "add", "-q", linked);
  const fake = fakeVscode();
  load(fake);
  fake.answers.push("Write");
  await fake.commands["q-lint.setUpNotebookStripFilter"](fake.vscode.Uri.file(linked), "info");
  assert.match(fake.messages.at(-1), /now commits q notebooks without their outputs/);
  const main = fs.realpathSync(path.join(dir, ".git"));
  assert.strictEqual(fs.readFileSync(path.join(main, "info", "attributes"), "utf8").trim().split("\n").at(-1), "*.qnb filter=qnb-strip");
  assert.ok(fs.existsSync(path.join(main, "q-lint", "qnbgit.js")));
  // The worktree commits without outputs, and the main checkout still can once it is gone.
  const wgit = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: linked, encoding: "utf8" });
  fs.writeFileSync(path.join(linked, "a.qnb"), withOutputs());
  wgit("add", "a.qnb");
  wgit("commit", "-qm", "nb");
  assert.strictEqual(wgit("show", "HEAD:a.qnb"), stripQnb(withOutputs()));
  git("worktree", "remove", "--force", linked);
  fs.writeFileSync(path.join(dir, "b.qnb"), withOutputs());
  git("add", "b.qnb");
  assert.strictEqual(git("show", ":b.qnb"), stripQnb(withOutputs()));
});

test("the setup never changes a filter set otherwise, asks before replacing its script, and can write .gitattributes", async () => {
  const { dir, git } = repo({ ".gitattributes": "*.png binary" });
  const fake = fakeVscode();
  load(fake);
  const folder = fake.vscode.Uri.file(dir);
  git("config", "filter.qnb-strip.clean", "jq .");
  await fake.commands["q-lint.setUpNotebookStripFilter"](folder, "gitattributes");
  assert.match(fake.messages.at(-1), /filter\.qnb-strip\.clean is set already, to jq \., and q-lint does not change it/);
  assert.strictEqual(git("config", "--get", "filter.qnb-strip.clean"), "jq .\n");
  assert.strictEqual(fake.details.length, 0);
  git("config", "--unset", "filter.qnb-strip.clean");
  // A script of another version is replaced only when the user says so.
  fs.mkdirSync(path.join(dir, ".git", "q-lint"));
  fs.writeFileSync(path.join(dir, ".git", "q-lint", "qnbgit.js"), "// old");
  fake.answers.push(undefined);
  await fake.commands["q-lint.setUpNotebookStripFilter"](folder, "gitattributes");
  assert.match(fake.details.at(-1), /Replace, since it differs from this extension's,/);
  assert.strictEqual(fs.readFileSync(path.join(dir, ".git", "q-lint", "qnbgit.js"), "utf8"), "// old");
  fake.answers.push("Write");
  await fake.commands["q-lint.setUpNotebookStripFilter"](folder, "gitattributes");
  assert.strictEqual(fs.readFileSync(path.join(dir, ".gitattributes"), "utf8"), "*.png binary\n*.qnb filter=qnb-strip\n");
  assert.strictEqual(fs.readFileSync(path.join(dir, ".git", "q-lint", "qnbgit.js"), "utf8"), fs.readFileSync(QNBGIT, "utf8"));
  // Not a repository.
  await fake.commands["q-lint.setUpNotebookStripFilter"](fake.vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), "norepo-"))), "info");
  assert.match(fake.messages.at(-1), /is not in a git repository/);
});

test("Clear Notebook Outputs asks, then strips the files picked; one with unsaved edits is left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qnbstrip-"));
  const file = (n, text) => (fs.writeFileSync(path.join(dir, n), text), path.join(dir, n));
  const a = file("a.qnb", withOutputs());
  const b = file("b.qnb", qnb([code("1")]));
  const c = file("c.qnb", withOutputs());
  const fake = fakeVscode();
  load(fake);
  const { Uri } = fake.vscode;
  fake.vscode.workspace.notebookDocuments.push({ uri: Uri.file(c), isDirty: true });
  fake.answers.push(undefined);
  await fake.commands["q-lint.stripNotebookOutputs"](Uri.file(a), [Uri.file(a), Uri.file(b), Uri.file(c)]);
  assert.match(fake.messages.at(-1), /Clear the outputs of a\.qnb\?/);
  assert.strictEqual(fs.readFileSync(a, "utf8"), withOutputs());
  fake.answers.push("Clear Outputs");
  await fake.commands["q-lint.stripNotebookOutputs"](Uri.file(a), [Uri.file(a), Uri.file(b), Uri.file(c)]);
  assert.strictEqual(fs.readFileSync(a, "utf8"), stripQnb(withOutputs()));
  assert.strictEqual(fs.readFileSync(c, "utf8"), withOutputs());
  assert.match(fake.messages.at(-1), /cleared the outputs of 1 notebook; 1 had none\. c\.qnb has unsaved edits: save first\./);
  await fake.commands["q-lint.stripNotebookOutputs"](Uri.file(a));
  assert.match(fake.messages.at(-1), /no outputs to clear/);
  await fake.commands["q-lint.stripNotebookOutputs"]();
  assert.match(fake.messages.at(-1), /pick a saved q notebook/);
});

test("off, Clear Notebook Outputs and the setup refuse and write nothing", async () => {
  const { dir, git } = repo({ "a.qnb": "{}" });
  fs.writeFileSync(path.join(dir, "b.qnb"), withOutputs());
  const fake = fakeVscode();
  fake.settings["notebook.stripOutputs.enable"] = false;
  load(fake);
  const { Uri } = fake.vscode;
  fake.answers.push("Write", "Clear Outputs");
  await fake.commands["q-lint.setUpNotebookStripFilter"](Uri.file(dir), "info");
  assert.match(fake.messages.at(-1), /is turned off: set q-lint\.notebook\.stripOutputs\.enable to true/);
  await fake.commands["q-lint.stripNotebookOutputs"](Uri.file(path.join(dir, "b.qnb")));
  assert.match(fake.messages.at(-1), /is turned off: set q-lint\.notebook\.stripOutputs\.enable to true/);
  assert.strictEqual(fake.details.length, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, "b.qnb"), "utf8"), withOutputs());
  assert.ok(!fs.existsSync(path.join(dir, ".git", "q-lint")));
  assert.throws(() => git("config", "--get", "filter.qnb-strip.clean"));
  // Turned on, it works without a reload: the setting is read when used.
  fake.settings["notebook.stripOutputs.enable"] = true;
  fake.answers.length = 0;
  fake.answers.push("Clear Outputs");
  await fake.commands["q-lint.stripNotebookOutputs"](Uri.file(path.join(dir, "b.qnb")));
  assert.strictEqual(fs.readFileSync(path.join(dir, "b.qnb"), "utf8"), stripQnb(withOutputs()));
});

test("Clear Notebook Outputs and the setup are contributed with their setting in every menu", () => {
  const section = pkg.contributes.configuration.find((c) => c.title === "q-lint: notebook features");
  assert.strictEqual(section.properties["q-lint.notebook.stripOutputs.enable"].default, true);
  for (const command of ["q-lint.stripNotebookOutputs", "q-lint.setUpNotebookStripFilter"]) {
    assert.strictEqual(pkg.contributes.commands.find((c) => c.command === command).category, "q-lint");
    const menus = Object.values(pkg.contributes.menus).flat().filter((m) => m.command === command);
    assert.ok(menus.length >= 2, command);
    for (const m of menus) assert.match(m.when, /config\.q-lint\.notebook\.stripOutputs\.enable/, command);
  }
});

test("the clean filter gives back bytes that are not UTF-8, or not a notebook, as they are (#1560)", () => {
  const { spawnSync } = require("node:child_process");
  for (const input of [Buffer.from("not json caf\xe9 \xff\n", "latin1"), Buffer.from('{"qnb":1,"cells":[],"x":"\xe9"}', "latin1"), Buffer.from("﻿plain\r\n")]) {
    const run = spawnSync(process.execPath, [QNBGIT, "--strip"], { input });
    assert.strictEqual(run.status, 0);
    assert.deepStrictEqual(run.stdout, input);
  }
  // A notebook is still stripped.
  const run = spawnSync(process.execPath, [QNBGIT, "--strip"], { input: qnb([code("1", ran(1, "1"))]) });
  assert.doesNotMatch(run.stdout.toString(), /outputs/);
});

test("the setup asks git whether *.qnb goes through the filter: a later line turning it off is read (#1561)", async () => {
  const { dir, git } = repo({ "README": "r\n" });
  const fake = fakeVscode();
  load(fake);
  const folder = fake.vscode.Uri.file(dir);
  fake.answers.push("Write");
  await fake.commands["q-lint.setUpNotebookStripFilter"](folder, "gitattributes");
  fs.appendFileSync(path.join(dir, ".gitattributes"), "*.qnb -filter\n");
  assert.match(git("check-attr", "filter", "--", "a.qnb"), /filter: unset/);
  fake.answers.push("Write");
  await fake.commands["q-lint.setUpNotebookStripFilter"](folder, "gitattributes");
  assert.doesNotMatch(fake.messages.at(-1), /already/);
  assert.match(git("check-attr", "filter", "--", "a.qnb"), /filter: qnb-strip/);
});
