// How q files relate, as the editor shows it (#842): the server's answers to
// `q-lint/graph` and `q-lint/affectedTests` as rows and lines, and the files
// changed against git HEAD as git is asked for them. Run after `tsc`,
// against `out/relations.js`; nothing here needs an editor or a repository.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const pkg = require("../package.json");
const {
  AFFECTED_TESTS,
  AVAILABLE,
  CHANGED,
  COMMANDS,
  GRAPH,
  VIEW,
  announces,
  asAffectedTests,
  asGraph,
  changedFiles,
  gitBinary,
  isQ,
  names,
  onPath,
  onProcessPath,
  picks,
  rows,
  summary,
  unsavedIn,
} = require("../out/relations.js");

// A file as a test names it: what follows the workspace folder.
const name = (uri) => uri.replace("file:///ws/", "");
const uri = (file) => `file:///ws/${file}`;

test("a request is used only when the server announces it", () => {
  const capabilities = { experimental: { [GRAPH]: true, [AFFECTED_TESTS]: false } };
  assert.strictEqual(announces(capabilities, GRAPH), true);
  assert.strictEqual(announces(capabilities, AFFECTED_TESTS), false);
  // An older server, or one with the graph turned off.
  assert.strictEqual(announces({}, GRAPH), false);
  assert.strictEqual(announces({ experimental: null }, GRAPH), false);
  assert.strictEqual(announces(undefined, GRAPH), false);
});

test("what package.json contributes is what the extension registers", () => {
  const declared = pkg.contributes.commands.map((c) => c.command);
  for (const command of Object.values(COMMANDS)) {
    assert.ok(declared.includes(command), command);
  }
  const [view] = pkg.contributes.views.explorer;
  assert.strictEqual(view.id, VIEW);
  // Hidden until a running server says it has a graph.
  assert.strictEqual(view.when, AVAILABLE);
  for (const item of pkg.contributes.menus["view/title"].filter((i) => i.when.includes(VIEW))) {
    assert.strictEqual(item.command, COMMANDS.refresh);
    assert.strictEqual(item.when, `view == ${VIEW}`);
  }
});

test("an answer that is not a graph is no graph", () => {
  assert.strictEqual(asGraph(null), undefined);
  assert.strictEqual(asGraph(undefined), undefined);
  assert.strictEqual(asGraph("no"), undefined);
  assert.strictEqual(asGraph({ dependencies: ["a"], dependents: [1] }), undefined);
  // What a part is missing from is still a graph; the part is empty.
  assert.deepStrictEqual(asGraph({ dependencies: [], dependents: [uri("a.q")] }), {
    uri: "",
    dependencies: [],
    dependents: [uri("a.q")],
    ambiguous: {},
    dynamic: [],
  });
});

test("a file's rows are what it depends on and what depends on it", () => {
  const graph = asGraph({
    uri: uri("src/main.q"),
    dependencies: [uri("src/lib.q")],
    dependents: [uri("tests/test_main.q"), uri("tests/test_all.q")],
    ambiguous: {},
    dynamic: [],
  });
  assert.deepStrictEqual(rows(graph, name), [
    {
      label: "Depends on",
      description: "1 file",
      tooltip: "The files this one loads or reads a name from.",
      children: [{ label: "src/lib.q", uri: uri("src/lib.q") }],
    },
    {
      label: "Depended on by",
      description: "2 files",
      tooltip: "The files that load this one or read a name it defines.",
      children: [
        { label: "tests/test_main.q", uri: uri("tests/test_main.q") },
        { label: "tests/test_all.q", uri: uri("tests/test_all.q") },
      ],
    },
  ]);
});

test("a file nothing relates to says so instead of showing nothing", () => {
  const graph = asGraph({ uri: uri("a.q"), dependencies: [], dependents: [] });
  assert.deepStrictEqual(
    rows(graph, name).map((row) => [row.label, row.description, row.children.length]),
    [
      ["Depends on", "none", 0],
      ["Depended on by", "none", 0],
    ],
  );
});

test("a dependency that shares a name with another file is marked", () => {
  const graph = asGraph({
    uri: uri("main.q"),
    dependencies: [uri("a.q"), uri("b.q"), uri("c.q")],
    dependents: [],
    ambiguous: { ".u.f": [uri("a.q"), uri("b.q")], ".u.g": [uri("a.q"), uri("b.q")] },
    dynamic: [],
  });
  const [a, b, c] = rows(graph, name)[0].children;
  assert.strictEqual(a.description, "also defined elsewhere: .u.f, .u.g");
  assert.match(a.tooltip, /order the files are loaded in/);
  assert.strictEqual(b.description, "also defined elsewhere: .u.f, .u.g");
  assert.strictEqual(c.description, undefined);
});

test("where a file reaches a name at run time is a row that opens the line", () => {
  const graph = asGraph({
    uri: uri("main.q"),
    dependencies: [],
    dependents: [],
    ambiguous: {},
    dynamic: [
      { line: 3, kind: "value" },
      { line: 5, kind: "namespace" },
      { line: 9, kind: "something new" },
    ],
  });
  const all = rows(graph, name);
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[2].label, "Reached at run time");
  assert.strictEqual(all[2].description, "3 places");
  assert.deepStrictEqual(all[2].children, [
    { label: "line 3", description: "value of a string", uri: uri("main.q"), line: 3 },
    // `system "d ",x`, which the server has listed since #3158.
    {
      label: "line 5",
      description: "a switch to a computed context",
      uri: uri("main.q"),
      line: 5,
    },
    // A kind this client has no words for is shown as the server named it.
    { label: "line 9", description: "something new", uri: uri("main.q"), line: 9 },
  ]);
});

test("an answer that is not a list of tests is none", () => {
  assert.strictEqual(asAffectedTests(null), undefined);
  assert.strictEqual(asAffectedTests({ tests: [] }), undefined);
  assert.deepStrictEqual(asAffectedTests({ tests: [], changed: [] }), {
    tests: [],
    changed: [],
    unindexed: [],
    dynamic: [],
  });
  // A test that does not say what it reaches is left out, not guessed at.
  const answer = asAffectedTests({
    tests: [{ uri: uri("t.q") }, { uri: uri("u.q"), reaches: [0] }],
    changed: [uri("a.q")],
  });
  assert.deepStrictEqual(answer.tests, [{ uri: uri("u.q"), reaches: [0] }]);
  // Its own place among the changed files is kept where it is one.
  const placed = asAffectedTests({
    tests: [
      { uri: uri("t.q"), reaches: [0], self: 0 },
      { uri: uri("u.q"), reaches: [0], self: null },
      { uri: uri("v.q"), reaches: [0], self: "0" },
    ],
    changed: [uri("t.q")],
  });
  assert.deepStrictEqual(placed.tests, [
    { uri: uri("t.q"), reaches: [0], self: 0 },
    { uri: uri("u.q"), reaches: [0] },
    { uri: uri("v.q"), reaches: [0] },
  ]);
});

test("a changed test is told by its place, however each side spells it", () => {
  // The server names a test it read from disk by the path's own URI; the
  // client sent the same file as its editor spells it. As text they differ.
  const answer = asAffectedTests({
    tests: [{ uri: "file:///C:/ws/tests/test_a.q", reaches: [0, 1], self: 1 }],
    changed: ["file:///c%3A/ws/src/a.q", "file:///c%3A/ws/tests/test_a.q"],
  });
  const [pick] = picks(answer, (u) => u.replace(/^file:\/\/\/[cC](%3A|:)\/ws\//, ""));
  assert.strictEqual(pick.label, "tests/test_a.q");
  assert.strictEqual(pick.description, "changed; reaches src/a.q");
});

test("a test is listed with the changed files it reaches", () => {
  const answer = asAffectedTests({
    tests: [
      { uri: uri("tests/test_a.q"), reaches: [0] },
      { uri: uri("tests/test_b.q"), reaches: [0, 1, 2] },
    ],
    changed: [uri("src/a.q"), uri("src/b.q"), uri("tests/test_b.q")],
    unindexed: [],
  });
  assert.deepStrictEqual(picks(answer, name), [
    { label: "tests/test_a.q", description: "reaches src/a.q", uri: uri("tests/test_a.q") },
    {
      label: "tests/test_b.q",
      // It reaches itself by having changed, which is said as that.
      description: "changed; reaches src/a.q, src/b.q",
      uri: uri("tests/test_b.q"),
    },
  ]);
  assert.strictEqual(summary(answer), "2 test files reach the 3 changed q files.");
});

test("a test that only changed itself, and one reaching many, read plainly", () => {
  const changed = ["a", "b", "c", "d", "e"].map((f) => uri(`${f}.q`));
  const answer = asAffectedTests({
    tests: [
      { uri: uri("test_new.q"), reaches: [5] },
      { uri: uri("test_all.q"), reaches: [0, 1, 2, 3, 4, 99] },
    ],
    changed: [...changed, uri("test_new.q")],
  });
  const [alone, many] = picks(answer, name);
  assert.strictEqual(alone.description, "changed");
  // A place the list does not have is passed over.
  assert.strictEqual(many.description, "reaches a.q, b.q, c.q and 2 more");
});

test("a test that loads at run time is listed as one that may be affected", () => {
  // No edge places it, so it was left out and nothing said so (#1364).
  const answer = asAffectedTests({
    tests: [{ uri: uri("tests/test_a.q"), reaches: [0] }],
    changed: [uri("src/a.q")],
    unindexed: [],
    dynamic: [uri("tests/test_dyn.q")],
  });
  assert.deepStrictEqual(picks(answer, name), [
    { label: "tests/test_a.q", description: "reaches src/a.q", uri: uri("tests/test_a.q") },
    {
      label: "tests/test_dyn.q",
      description: "loads by a path computed at run time: may be affected",
      uri: uri("tests/test_dyn.q"),
    },
  ]);
  assert.strictEqual(
    summary(answer),
    "1 test file reaches the 1 changed q file. 1 more test file loads by a path computed " +
      "at run time and may be affected too.",
  );
  // What is not a list of URIs is none.
  assert.deepStrictEqual(asAffectedTests({ tests: [], changed: [], dynamic: [1] }).dynamic, []);
});

test("the summary says what the list could not follow", () => {
  const one = {
    tests: [{ uri: uri("t.q"), reaches: [0] }],
    changed: [uri("a.q")],
    unindexed: [],
    dynamic: [],
  };
  assert.strictEqual(summary(one), "1 test file reaches the 1 changed q file.");
  assert.strictEqual(
    summary({ tests: [], changed: [uri("a.q"), uri("b.q")], unindexed: [], dynamic: [] }),
    "No test file reaches the 2 changed q files.",
  );
  assert.strictEqual(
    summary({ ...one, unindexed: [uri("gone.q")] }),
    "1 test file reaches the 1 changed q file. 1 changed q file is not in the index " +
      "(deleted or excluded): what depended on it is not listed.",
  );
  assert.strictEqual(
    summary({ tests: [], changed: [], unindexed: [uri("x.q"), uri("y.q")], dynamic: [] }),
    "No indexed q file changed. 2 changed q files are not in the index " +
      "(deleted or excluded): what depended on them is not listed.",
  );
});

test("git's names are split on NUL, whatever a file is called", () => {
  assert.deepStrictEqual(names(""), []);
  assert.deepStrictEqual(names("a.q\0dir/b c.q\0with\nnewline.q\0"), [
    "a.q",
    "dir/b c.q",
    "with\nnewline.q",
  ]);
});

test("the changed files are those differing from HEAD and those untracked", async () => {
  const folder = path.resolve("/ws");
  const asked = [];
  const git = async (args, cwd) => {
    asked.push([args, cwd]);
    return args[0] === "diff" ? "src/a.q\0src/b.q\0" : "src/b.q\0tests/test_new.q\0";
  };
  assert.deepStrictEqual(await changedFiles(git, folder), [
    path.join(folder, "src/a.q"),
    path.join(folder, "src/b.q"),
    path.join(folder, "tests/test_new.q"),
  ]);
  assert.deepStrictEqual(asked, CHANGED.map((args) => [args, folder]));
});

test("git is asked without a shell's help and told where revisions end", () => {
  const [diff, untracked] = CHANGED;
  assert.deepStrictEqual(diff.slice(0, 2), ["diff", "--name-only"]);
  // NUL-separated on both, or a name with a space or a quote is not a name.
  assert.ok(diff.includes("-z") && untracked.includes("-z"));
  assert.deepStrictEqual(diff.slice(-2), ["HEAD", "--"]);
  assert.ok(untracked.includes("--exclude-standard"));
});

test("a folder git cannot answer for is an error, not an empty list", async () => {
  const git = async () => {
    throw new Error("fatal: not a git repository");
  };
  await assert.rejects(changedFiles(git, "/ws"), /not a git repository/);
});

test("the git that runs is VS Code's when one is set", () => {
  assert.strictEqual(gitBinary(undefined), "git");
  assert.strictEqual(gitBinary(null), "git");
  assert.strictEqual(gitBinary("  "), "git");
  assert.strictEqual(gitBinary(" /opt/git/bin/git "), "/opt/git/bin/git");
  assert.strictEqual(gitBinary(["/first/git", "/second/git"]), "/first/git");
  assert.strictEqual(gitBinary([]), "git");
});

test("git, tar and node are spawned as this process's PATH finds them (#1407)", () => {
  assert.strictEqual(onProcessPath("git", "linux"), "git");
  assert.strictEqual(onProcessPath("/usr/bin/tar", "win32"), "/usr/bin/tar");
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.strictEqual(onProcessPath("git", "win32"), undefined);
  } finally {
    process.env.PATH = saved;
  }
});

test("on Windows a bare git is found on PATH, never in the folder it runs in", () => {
  const on = (...files) => (file) => files.includes(file);
  const path = ".;;bin;C:\\Tools;C:\\Program Files\\Git\\cmd";
  // The folder git is started in is not asked at all: only what PATH names
  // by an absolute directory, in its order.
  assert.strictEqual(
    onPath("git", path, on("git.exe", "bin\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe"), "win32"),
    "C:\\Program Files\\Git\\cmd\\git.exe",
  );
  assert.strictEqual(
    onPath("git", path, on("C:\\Tools\\git.com", "C:\\Tools\\git.exe"), "win32"),
    "C:\\Tools\\git.com",
  );
  // A name with its ending is looked for as it is.
  assert.strictEqual(
    onPath("git.exe", path, on("C:\\Tools\\git.exe"), "win32"),
    "C:\\Tools\\git.exe",
  );
  assert.strictEqual(onPath("git", path, on("C:\\Tools\\git.cmd"), "win32"), undefined);
  assert.strictEqual(onPath("git", undefined, on(), "win32"), undefined);
  // A PATH entry may be quoted, as the installer of a program under
  // C:\Program Files can write it; libuv, which spawns git otherwise,
  // reads such an entry without its quotes, and so does this.
  assert.strictEqual(
    onPath("git", '"C:\\Program Files\\Git\\cmd";C:\\Tools', on("C:\\Program Files\\Git\\cmd\\git.exe"), "win32"),
    "C:\\Program Files\\Git\\cmd\\git.exe",
  );
  // A path names its file, and elsewhere a bare name is PATH's alone.
  const never = () => assert.fail("nothing is looked for");
  assert.strictEqual(onPath("C:\\git\\git.exe", path, never, "win32"), "C:\\git\\git.exe");
  assert.strictEqual(onPath("tools/git", path, never, "win32"), "tools/git");
  assert.strictEqual(onPath("git", "/usr/bin", never, "linux"), "git");
  assert.strictEqual(onPath("git", "/usr/bin", never, "darwin"), "git");
});

test("only a q file is sent to the server", () => {
  assert.strictEqual(isQ("/ws/a.q"), true);
  assert.strictEqual(isQ("/ws/A.Q"), true);
  assert.strictEqual(isQ("/ws/a.py"), false);
  assert.strictEqual(isQ("/ws/q"), false);
});

test("an unsaved q file counts as changed only in a folder git answered for", () => {
  // A scratch q file open from outside the workspace, edited and not
  // saved, was sent as changed, and the list said a changed q file was
  // "not in the index (deleted or excluded)" though nothing had changed.
  const sep = path.sep;
  const ws = `${sep}ws`;
  const other = `${sep}other`;
  const dirty = [`${ws}${sep}a.q`, `${sep}tmp${sep}scratch.q`, `${other}${sep}b.q`, `${sep}wsx${sep}c.q`];
  assert.deepStrictEqual(unsavedIn(dirty, [ws]), [`${ws}${sep}a.q`]);
  assert.deepStrictEqual(unsavedIn(dirty, [ws, other]), [`${ws}${sep}a.q`, `${other}${sep}b.q`]);
  assert.deepStrictEqual(unsavedIn(dirty, []), []);
});

test("an unsaved file whose name starts with .. is inside its folder (#1101)", () => {
  const sep = path.sep;
  const ws = `${sep}ws`;
  const dirty = [`${ws}${sep}..scratch.q`, `${ws}${sep}..${sep}up.q`, `${ws}${sep}sub${sep}...q`];
  assert.deepStrictEqual(unsavedIn(dirty, [ws]), [`${ws}${sep}..scratch.q`, `${ws}${sep}sub${sep}...q`]);
});

test("the graph's commands leave the palette with the graph (#1335)", () => {
  for (const command of ["q-lint.showDependencies", "q-lint.refreshDependencies", "q-lint.listAffectedTests"]) {
    const entry = pkg.contributes.menus.commandPalette.find((m) => m.command === command);
    assert.strictEqual(entry?.when, "q-lint.hasGraph", command);
  }
});
