// Generate a test stub (#982): the function at the cursor, the style read
// from the test file, the stub, and the command with the vscode stub - it
// shows what it writes and asks, only adds to an existing file, never writes
// over a new one, and refuses while turned off.
const test = require("node:test");
const assert = require("node:assert");
const { stub, vscode } = require("./vscode_stub");
const { functionAt, detectStyle, testName, stubText, newTestPath, testFilePatterns, TEST_STUB_COMMAND } = require("../out/teststub.js");

const SRC = ["/ lib", "\\d .fx", "mid:{[bid;ask]", "  (bid+ask)%2}", "\\d .", "sq:{x*x}", "now:{[] .z.p}", "test_x:{[] 1b}", ""].join("\n");

test("the function at the cursor, with its parameters; a test is not one", () => {
  assert.deepStrictEqual(functionAt(SRC, 3), { name: ".fx.mid", params: ["bid", "ask"] });
  assert.deepStrictEqual(functionAt(SRC, 5), { name: "sq", params: ["x"] });
  assert.deepStrictEqual(functionAt(SRC, 6), { name: "now", params: [] });
  assert.strictEqual(functionAt(SRC, 7), undefined);
  assert.strictEqual(functionAt(SRC, 0), undefined);
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
  vscode.workspace.findFiles = async (glob) => {
    const re = new RegExp(`^.*/${glob.replace("**/", "").replace(".", "\\.").replace("*", "[^/]*")}$`);
    return Object.keys(files).filter((f) => re.test(f)).map((f) => vscode.Uri.file(f));
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
