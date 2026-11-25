// Generate a test stub (#982): the function at the cursor, the style read
// from the test file, the stub, and the command with the vscode stub - it
// shows what it writes and asks, only adds to an existing file, never writes
// over a new one, and refuses while turned off.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { functionAt, detectStyle, testName, stubText, newTestPath, testFilePatterns, endContext, TEST_STUB_COMMAND } = require("../out/teststub.js");

const SRC = ["/ lib", "\\d .fx", "mid:{[bid;ask]", "  (bid+ask)%2}", "\\d .", "sq:{x*x}", "now:{[] .z.p}", "test_x:{[] 1b}", ""].join("\n");

test("the function at the cursor, with its parameters; a test is not one", () => {
  assert.deepStrictEqual(functionAt(SRC, 3), { name: ".fx.mid", params: ["bid", "ask"] });
  assert.deepStrictEqual(functionAt(SRC, 5), { name: "sq", params: ["x"] });
  assert.deepStrictEqual(functionAt(SRC, 6), { name: "now", params: [] });
  assert.strictEqual(functionAt(SRC, 7), undefined);
  assert.strictEqual(functionAt(SRC, 0), undefined);
});

test("a typed or pattern parameter list takes one argument per slot (#2332)", () => {
  // KDB-X: `{[(u;v);w] u+v+w}` takes two arguments, `{[n:{x>0}] n}` one.
  assert.deepStrictEqual(functionAt("h:{[(u;v);w] u+v+w}\n", 0), { name: "h", params: ["arg1", "w"] });
  assert.deepStrictEqual(functionAt("k:{[n:{x>0}] n}\n", 0), { name: "k", params: ["n"] });
  assert.deepStrictEqual(functionAt("t:{ [x:`j;y] x+y}\n", 0), { name: "t", params: ["x", "y"] });
});

test("the suite's style decides the name and the assertion", () => {
  const target = { name: ".fx.mid", params: ["bid", "ask"] };
  const qt = detectStyle(".qt.fx.test_spread:{[] .qunit.assertEquals[1;1;\"x\"]}\n");
  assert.deepStrictEqual(qt, { naming: { kind: "qt", suite: ".qt.fx" }, qunitAsserts: true });
  assert.strictEqual(testName(target, qt, ""), ".qt.fx.test_mid");
  assert.strictEqual(testName(target, qt, ".qt.fx.test_mid:{[] 1b}\n"), ".qt.fx.test_mid2");
  assert.strictEqual(
    stubText(target, ".qt.fx.test_mid", qt),
    '.qt.fx.test_mid:{[]\n  bid:(::); ask:(::); / TODO: the arguments\n  expected:(::); / TODO: what .fx.mid[bid;ask] should give\n  .qunit.assertEquals[.fx.mid[bid;ask];expected;".fx.mid"]}\n',
  );
  const qunit = detectStyle("\\d .t\ntestSpread:{ 1b }\n");
  assert.deepStrictEqual(qunit.naming, { kind: "qunit" });
  assert.strictEqual(testName(target, qunit, ""), "testMid");
  const plain = detectStyle("");
  assert.strictEqual(testName({ name: "now", params: [] }, plain, ""), "test_now");
  assert.strictEqual(stubText({ name: "now", params: [] }, "test_now", plain), "test_now:{[]\n  expected:(::); / TODO: what now[] should give\n  now[]~expected}\n");
  assert.strictEqual(newTestPath("/ws/src/lib.q", "/ws", true), "/ws/tests/test_lib.q");
  assert.strictEqual(newTestPath("/ws/src/lib.q", "/ws", false), "/ws/src/test_lib.q");
  assert.deepStrictEqual(testFilePatterns("/ws/src/lib.q"), ["**/test_lib.q", "**/lib_test.q"]);
});

// `[1]` in f[1].q is a character class to a glob: test_f1.q was found
// for it and test_f[1].q never was (#1526).
test("a file name holding glob characters is matched as written", () => {
  const { globLiteral } = require("../out/globliteral.js");
  assert.deepStrictEqual(testFilePatterns("/ws/src/f[1].q"), ["**/test_f[[]1[]].q", "**/f[[]1[]]_test.q"]);
  assert.strictEqual(globLiteral("x{a,b}*?.q"), "x[{]a,b[}][*][?].q");
  let mm;
  try {
    mm = require("minimatch");
  } catch {
    return;
  }
  const match = mm.minimatch ?? mm;
  const [pattern] = testFilePatterns("/ws/src/f[1].q");
  assert.strictEqual(match("tests/test_f[1].q", pattern), true);
  assert.strictEqual(match("tests/test_f1.q", pattern), false);
  assert.strictEqual(match("x{a}.q", `**/${globLiteral("x{a}.q")}`), true);
});

function setup(files) {
  stub.reset();
  const edits = [];
  const writes = [];
  vscode.workspace.fs = {
    readFile: async (uri) => {
      if (!(uri.fsPath in files)) throw new Error("ENOENT");
      return Buffer.from(files[uri.fsPath], "utf8");
    },
    writeFile: async (uri, data) => {
      writes.push(uri.fsPath);
      files[uri.fsPath] = Buffer.from(data).toString("utf8");
    },
    stat: async (uri) => {
      if (!Object.keys(files).some((f) => f === uri.fsPath || f.startsWith(`${uri.fsPath}/`))) throw new Error("ENOENT");
      return {};
    },
  };
  // A RelativePattern searches its folder only; a plain glob, every folder.
  vscode.RelativePattern = class {
    constructor(base, pattern) {
      Object.assign(this, { base: base.uri ?? base, pattern });
    }
  };
  vscode.workspace.findFiles = async (glob) => {
    const pattern = typeof glob === "string" ? glob : glob.pattern;
    const within = typeof glob === "string" ? "" : `${glob.base.fsPath}/`;
    const re = new RegExp(`^.*/${pattern.replace("**/", "").replace(".", "\\.").replace("*", "[^/]*")}$`);
    return Object.keys(files).filter((f) => re.test(f) && f.startsWith(within)).map((f) => vscode.Uri.file(f));
  };
  vscode.workspace.openTextDocument = async (uri) => ({ uri, getText: () => files[uri.fsPath] });
  vscode.workspace.getWorkspaceFolder = () => ({ uri: vscode.Uri.file("/ws") });
  vscode.workspace.asRelativePath = (uri) => uri.fsPath.replace("/ws/", "");
  vscode.workspace.applyEdit = async (edit) => {
    for (const [uri, pos, text] of edit.inserts) {
      const lines = files[uri.fsPath].split("\n");
      lines[pos.line] = lines[pos.line].slice(0, pos.character) + text + lines[pos.line].slice(pos.character);
      files[uri.fsPath] = lines.join("\n");
    }
    edits.push(edit);
    return true;
  };
  vscode.WorkspaceEdit = class {
    constructor() {
      this.inserts = [];
    }
    insert(uri, pos, text) {
      this.inserts.push([uri, pos, text]);
    }
  };
  vscode.Position = class {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  };
  vscode.window.showTextDocument = async () => ({ revealRange() {} });
  const { registerTestStubs } = require("../out/teststubview.js");
  return { edits, writes, stubs: registerTestStubs(stub.newContext()) };
}

test("an existing test file is added to, in its style, after asking; Escape writes nothing", async () => {
  const files = {
    "/ws/src/lib.q": SRC,
    "/ws/tests/test_lib.q": ".qt.lib.test_old:{[] 1b}",
  };
  const s = setup(files);
  const run = stub.commands.get(TEST_STUB_COMMAND);
  stub.picks.push(undefined);
  assert.strictEqual(await run(vscode.Uri.file("/ws/src/lib.q"), 5), false);
  assert.match(stub.messages.at(-1)[1], /Add to tests\/test_lib\.q: \.qt\.lib\.test_sq\?/);
  assert.strictEqual(files["/ws/tests/test_lib.q"], ".qt.lib.test_old:{[] 1b}");
  stub.picks.push("Add Test");
  assert.strictEqual(await run(vscode.Uri.file("/ws/src/lib.q"), 5), true);
  assert.strictEqual(
    files["/ws/tests/test_lib.q"],
    ".qt.lib.test_old:{[] 1b}\n\n.qt.lib.test_sq:{[]\n  x:(::); / TODO: the arguments\n  expected:(::); / TODO: what sq[x] should give\n  sq[x]~expected}\n",
  );
  assert.deepStrictEqual(s.writes, [], "added by an edit, not written");
});

test("with no test file, a new one is made in tests/, never over one made meanwhile; off, nothing", async () => {
  const files = { "/ws/src/lib.q": SRC, "/ws/tests/other.q": "" };
  const s = setup(files);
  const run = stub.commands.get(TEST_STUB_COMMAND);
  stub.picks.push("Add Test");
  assert.strictEqual(await run(vscode.Uri.file("/ws/src/lib.q"), 3), true);
  assert.deepStrictEqual(s.writes, ["/ws/tests/test_lib.q"]);
  assert.match(files["/ws/tests/test_lib.q"], /^\/ Tests for src\/lib\.q\n\ntest_mid:\{\[\]\n/);
  // A file that appears while the question is open is left alone.
  delete files["/ws/tests/test_lib.q"];
  stub.picks.push(() => ((files["/ws/tests/test_lib.q"] = "mine"), "Add Test"));
  assert.strictEqual(await run(vscode.Uri.file("/ws/src/lib.q"), 3), false);
  assert.strictEqual(files["/ws/tests/test_lib.q"], "mine");
  // The cursor not in a function.
  assert.strictEqual(await run(vscode.Uri.file("/ws/src/lib.q"), 0), false);
  // Off: the provider goes and the command refuses.
  assert.strictEqual(s.stubs.registered(), true);
  stub.config.user["testStub.enable"] = false;
  stub.changeConfig("q-lint.testStub.enable");
  assert.strictEqual(s.stubs.registered(), false);
  assert.strictEqual(await run(vscode.Uri.file("/ws/src/lib.q"), 3), false);
  assert.match(stub.messages.at(-1)[1], /q-lint\.testStub\.enable to true/);
});

// An untitled file's stub went to /test_Untitled-1.q, a notebook cell's
// beside the notebook (#1525): only a file on disk gets one.
test("an untitled file or a notebook cell is asked to be saved, and nothing is written", async () => {
  const files = { "/ws/src/lib.q": SRC };
  const s = setup(files);
  const run = stub.commands.get(TEST_STUB_COMMAND);
  for (const uri of [{ scheme: "untitled", fsPath: "Untitled-1" }, { scheme: "vscode-notebook-cell", fsPath: "/ws/nb.qnb" }]) {
    assert.strictEqual(await run(uri, 3), false);
    assert.match(stub.messages.at(-1)[1], /save the file first/);
  }
  assert.deepStrictEqual(s.writes, []);
});

// A write that fails escaped as a raw command error (#1536).
test("a test file that cannot be written is said, and the command ends", async () => {
  const files = { "/ws/src/lib.q": SRC, "/ws/tests/other.q": "" };
  setup(files);
  vscode.workspace.fs.writeFile = async () => {
    throw new Error("EACCES: permission denied");
  };
  stub.picks.push("Add Test");
  assert.strictEqual(await stub.commands.get(TEST_STUB_COMMAND)(vscode.Uri.file("/ws/src/lib.q"), 3), false);
  assert.deepStrictEqual(stub.messages.at(-1), ["error", "q-lint: could not write /ws/tests/test_lib.q: EACCES: permission denied"]);
});

test("a new test file's path on Windows keeps the folder and the separator (#1094)", () => {
  const { win32, posix } = require("node:path");
  const src = win32.join("C:\\proj", "src", "a.q");
  assert.strictEqual(newTestPath(src, "C:\\proj", true), win32.join("C:\\proj", "tests", "test_a.q"));
  assert.strictEqual(newTestPath(src, "C:\\proj\\", true), win32.join("C:\\proj", "tests", "test_a.q"));
  assert.strictEqual(newTestPath(src, "C:\\proj", false), win32.join("C:\\proj", "src", "test_a.q"));
  assert.strictEqual(newTestPath(src, undefined, true), win32.join("C:\\proj", "src", "test_a.q"));
  const psrc = posix.join("/ws", "src", "a.q");
  assert.strictEqual(newTestPath(psrc, "/ws/", true), posix.join("/ws", "tests", "test_a.q"));
  assert.strictEqual(newTestPath("a.q", undefined, false), "test_a.q");
});

test("the stub goes at the end of the open test file, unsaved edits included (#1076)", async () => {
  const files = { "/ws/src/lib.q": SRC, "/ws/tests/test_lib.q": "a:1\nb:{[]\n  2}\nc:3\n" };
  setup(files);
  // files is the open document; the disk still has the first line only.
  const fromDisk = vscode.workspace.fs.readFile;
  vscode.workspace.fs.readFile = async (uri) => (uri.fsPath === "/ws/tests/test_lib.q" ? Buffer.from("a:1", "utf8") : fromDisk(uri));
  stub.picks.push("Add Test");
  assert.strictEqual(await stub.commands.get(TEST_STUB_COMMAND)(vscode.Uri.file("/ws/src/lib.q"), 6), true);
  assert.strictEqual(files["/ws/tests/test_lib.q"], "a:1\nb:{[]\n  2}\nc:3\n\ntest_now:{[]\n  expected:(::); / TODO: what now[] should give\n  now[]~expected}\n");
});

test("a parameter named expected is not overwritten by the expected value (#1601)", () => {
  const target = functionAt("g:{[actual;expected] actual~expected}\n", 0);
  assert.strictEqual(
    stubText(target, "test_g", detectStyle("")),
    "test_g:{[]\n  actual:(::); expected:(::); / TODO: the arguments\n  expected_:(::); / TODO: what g[actual;expected] should give\n  g[actual;expected]~expected_}\n",
  );
});

test("a parameter named like the function does not take its place in the call (#2004)", () => {
  const target = functionAt("scale:{[scale;v] v*scale}\n", 0);
  assert.deepStrictEqual(target, { name: "scale", params: ["scale", "v"] });
  assert.strictEqual(
    stubText(target, "test_scale", detectStyle("")),
    "test_scale:{[]\n  scale:(::); v:(::); / TODO: the arguments\n  expected:(::); / TODO: what `.[`scale][scale;v] should give\n  `.[`scale][scale;v]~expected}\n",
  );
  assert.match(stubText(target, "testScale", detectStyle(".qunit.assertEquals[1;1;\"a\"]"), ".tests"), /assertEquals\[`\.\[`scale\]\[scale;v\];expected;"scale"\]/);
  // A qualified name is no local, and another parameter's name no callee.
  assert.match(stubText({ name: ".fx.scale", params: ["scale"] }, "test_scale", detectStyle("")), /\n  \.fx\.scale\[scale\]~expected\}/);
  assert.match(stubText({ name: "scale", params: ["scaled"] }, "test_scale", detectStyle("")), /\n  scale\[scaled\]~expected\}/);
});

test("a stub appended under a trailing \\d calls a root function at the root (#1599)", () => {
  const file = "\\d .tests\ntestA:{[] .qunit.assertEquals[1;1;\"a\"]}\n";
  assert.strictEqual(endContext(file), ".tests");
  assert.strictEqual(endContext("\\d .tests\nx:1\n\\d .\n"), ".");
  const f = functionAt("f:{[a;b] a+b}\n", 0);
  assert.match(stubText(f, "testF", detectStyle(file), endContext(file)), /\.qunit\.assertEquals\[`\.\[`f\]\[a;b\];expected;"f"\]/);
  // A qualified one, or under the root, as before.
  assert.match(stubText(f, "testF", detectStyle(file), "."), /assertEquals\[f\[a;b\]/);
  assert.match(stubText({ name: ".fx.mid", params: [] }, "testMid", detectStyle(file), ".tests"), /assertEquals\[\.fx\.mid\[\]/);
});

test("an untitled editor is offered no stub, and the command writes none at the filesystem's root (#1600)", async () => {
  const files = { "Untitled-1": "f:{x}\n" };
  const s = setup(files);
  const untitled = { scheme: "untitled", fsPath: "Untitled-1", toString: () => "untitled:Untitled-1" };
  stub.picks.push("Add Test");
  assert.strictEqual(await stub.commands.get(TEST_STUB_COMMAND)(untitled, 0), false);
  assert.deepStrictEqual(s.writes, []);
  assert.match(stub.messages.at(-1)[1], /save the file first/);
});

test("in a multi-root workspace the test file is looked for in the source's own folder (#1837)", async () => {
  const files = {
    "/a/t/test_lib.q": "/ A's tests of A's lib.q",
    "/ws/src/lib.q": SRC,
  };
  setup(files);
  // The source is in /ws; /a is another folder, its test_lib.q not this one's.
  vscode.workspace.getWorkspaceFolder = (uri) => ({ uri: vscode.Uri.file(uri.fsPath.startsWith("/a/") ? "/a" : "/ws") });
  const run = stub.commands.get(TEST_STUB_COMMAND);
  stub.picks.push("Add Test");
  assert.strictEqual(await run(vscode.Uri.file("/ws/src/lib.q"), 3), true);
  assert.strictEqual(files["/a/t/test_lib.q"], "/ A's tests of A's lib.q", "the other folder's file is left alone");
  assert.match(files["/ws/test_lib.q"] ?? files["/ws/src/test_lib.q"], /test_mid/);
});
