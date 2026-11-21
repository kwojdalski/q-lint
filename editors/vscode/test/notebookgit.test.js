// q notebooks and git: Compare Notebook Cells and the `qnbgit.js` textconv
// (#998). The pure text and diff, the command line, a real `git diff`
// through the textconv, and the command under a stand-in `vscode`. Needs
// git on PATH, never a q process.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const pkg = require("../package.json");
const { diffCells, diffSummary, fileText, main, notebookText } = require("../out/qnbgit.js");

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
  const fake = { messages: [], diffs: [], commands: {}, settings: {}, providers: new Map(), configListeners: [], picks: [], opened: [] };
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
    },
    workspace: {
      notebookDocuments: [],
      getConfiguration: () => ({ get: (key, fallback) => (key in fake.settings ? fake.settings[key] : fallback) }),
      onDidChangeConfiguration: (l) => (fake.configListeners.push(l), disposable),
      registerTextDocumentContentProvider: (scheme, provider) => {
        fake.providers.set(scheme, provider);
        return { dispose: () => fake.providers.delete(scheme) };
      },
      fs: { readFile: async (uri) => fs.readFileSync(uri.fsPath) },
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
    return require("../out/notebookgit.js").registerNotebookGit({ subscriptions: [] }).diff;
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
